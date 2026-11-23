import bcrypt from 'bcryptjs';
import { countAwaitingReview } from '../workItems/reviewState.js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { User } from '../people/model.js';
import { Session } from '../auth/session.model.js';
import { ActivityEvent } from '../activity/model.js';
import {
  sendEmail,
  sendEmailOrFail,
  checkEmailThrottle,
  recordEmailSent,
  maskEmail,
  THROTTLE_WINDOW_MS,
} from '../../lib/email/index.js';
import { createNotification } from '../notifications/service.js';
import { logger } from '../../lib/logger.js';
import { normalizeRole, isApprover, isReadOnlyViewer, isWorker, activeStepLimitOf, PHONE_VERIFICATION_REQUIRED } from '@mmp/shared';
import { AccessRequest } from '../access/model.js';
import { CalendarPlan } from '../calendar/plan.model.js';
import { WorkItem } from '../workItems/model.js';
import { PhoneVerification } from './phoneVerification.model.js';
import { disconnectUserSockets } from '../../lib/socketHub.js';
import { isSuperuser, rolesWith } from '../../lib/roleAccess.js';
import { hasPermission, isOwnScope, isReadOnly } from '../../lib/roleAccess.js';
import { storageKeyOf } from '@mmp/shared';
import { newAvatarKey, putFile, removeFile } from '../../lib/storage/index.js';

export function stripHtml(str) {
  if (typeof str !== 'string') return str;
  return str.replace(/<[^>]*>?/gm, '').trim();
}

export function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  return phone.trim().replace(/[\s\-\(\)]/g, '');
}

/**
 * Get the current signed-in user's profile
 */
export async function getProfile(userId) {
  const user = await User.findById(userId)
    .populate('departmentId', 'name code')
    .populate('reportsToIds', 'name email role jobRole')
    .lean();

  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  const deptName = user.departmentId?.name || (typeof user.department === 'string' ? user.department : '');
  const normalizedRole = normalizeRole(user.role);

  // Compute role panel metric summaries
  let rolePanelData = null;
  if (isSuperuser(user)) {
    const pendingAccessRequests = await AccessRequest.countDocuments({ status: 'pending' }).catch(() => 0);
    const activeUsers = await User.find({ status: 'active' }).select('role').lean().catch(() => []);
    const usersByRole = activeUsers.reduce((acc, u) => {
      acc[u.role] = (acc[u.role] || 0) + 1;
      return acc;
    }, {});
    rolePanelData = {
      adminMetrics: { pendingAccessRequests, usersByRole },
    };
  } else if (hasPermission(user, 'review.decide')) {
    const stagesWaitingApproval = await countAwaitingReview().catch(() => 0);
    const plansWaiting = await CalendarPlan.countDocuments({ status: { $in: ['submitted', 'in_review'] } }).catch(() => 0);
    rolePanelData = {
      creativeMetrics: { stagesWaitingApproval, plansWaiting },
    };
  } else if (hasPermission(user, 'calendar.plan')) {
    const needsOwnerCount = await WorkItem.countDocuments({ ownerId: null }).catch(() => 0);
    const now = new Date();
    const lateItemsCount = await WorkItem.countDocuments({
      status: { $nin: ['Approved', 'Published'] },
      deadline: { $lt: now },
    }).catch(() => 0);
    rolePanelData = {
      smMetrics: { planStatus: 'Active', needsOwnerCount, lateItemsCount },
    };
  } else if (isReadOnly(user)) {
    const activeUsersCount = await User.countDocuments({ status: 'active' }).catch(() => 0);
    const activeDeliverablesCount = await WorkItem.countDocuments({ status: { $nin: ['Published'] } }).catch(() => 0);
    rolePanelData = {
      companySummary: { activeUsersCount, activeDeliverablesCount },
    };
  } else if (isOwnScope(user)) {
    const myCurrentStepsCount = await WorkItem.countDocuments({
      ownerId: userId,
      status: { $nin: ['Approved', 'Published'] },
    }).catch(() => 0);
    const { workloadOfPerson } = await import('../workload/service.js');
    const workload = await workloadOfPerson(user).catch(() => null);
    rolePanelData = {
      // capacityBand is the real band now (Available, Busy or Over), from workloadFor.
      memberMetrics: { myCurrentStepsCount, capacityBand: workload?.band || 'Available', workload, onTimeRate: 100 },
    };
  }

  return {
    id: user._id.toString(),
    _id: user._id.toString(),
    name: user.name,
    preferredName: user.preferredName || '',
    email: user.email,
    role: normalizedRole,
    jobRole: user.jobRole || (isSuperuser(user) ? 'System Administrator' : 'Team Member'),
    department: deptName || 'General',
    departmentId: user.departmentId?._id?.toString() || null,
    status: user.status || 'active',
    avatarUrl: user.avatarUrl || null,
    avatarStorageId: user.avatarStorageId || null,
    phone: user.phone || '',
    phoneVerified: Boolean(user.phoneVerified || user.phoneVerifiedAt || user.phone),
    phoneVerifiedAt: user.phoneVerifiedAt || null,
    phoneVerifiedVia: user.phoneVerifiedVia || null,
    whatsappNumber: user.whatsappNumber || '',
    languages: Array.isArray(user.languages) ? user.languages : [],
    about: user.about || '',
    skills: Array.isArray(user.skills) ? user.skills : [],
    weeklyCapacityHours: user.weeklyCapacityHours || user.capacity || 40,
    activeStepLimit: activeStepLimitOf(user),
    workPreferences: Array.isArray(user.workPreferences) ? user.workPreferences : [],
    rolePanelData,
    preferences: user.preferences || {
      startPage: 'Home',
      dateFormat: 'DD/MM/YYYY',
      timeFormat: '12h',
      weekStart: 'monday',
    },
    notificationPrefs: user.notificationPrefs || {
      mySteps: { inApp: true, email: true },
      approvalsRevisions: { inApp: true, email: true },
      messagesComments: { inApp: true, email: true },
      deadlinesOverdue: { inApp: true, email: true },
      planUpdates: { inApp: true, email: true },
      system: { inApp: true, email: true },
    },
    profileCompletedAt: user.profileCompletedAt || null,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt || user.lastLogin || null,
  };
}

export const PHONE_OTP_MINUTES = 10;
export const PHONE_OTP_RESEND_SECONDS = THROTTLE_WINDOW_MS / 1000;

/**
 * Send a 6-digit code to verify a phone number. With PHONE_OTP_CHANNEL=email (the default) the code
 * goes to the user's registered email. Storage, the 10-minute expiry and the 5-attempt limit are the
 * same for every channel; at most one code per user per minute.
 */
export async function sendPhoneOtp(userId, { phone }) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone || !/^\+?[1-9]\d{6,14}$/.test(cleanPhone)) {
    const error = new Error('Please enter a valid mobile number (e.g. +919876543210).');
    error.statusCode = 400;
    error.code = 'INVALID_PHONE';
    throw error;
  }

  const channel = env.PHONE_OTP_CHANNEL === 'sms' ? 'sms' : 'email';
  let user = null;
  if (channel === 'email') {
    user = await User.findById(userId).select('name email').lean();
    if (!user?.email) {
      const error = new Error('Your account has no registered email to send the code to. Contact your administrator.');
      error.statusCode = 400;
      error.code = 'NO_REGISTERED_EMAIL';
      throw error;
    }
    const throttle = checkEmailThrottle('phone_otp', user.email);
    if (!throttle.allowed) {
      const error = new Error(`Please wait ${throttle.retryAfterSeconds} seconds before requesting a new code.`);
      error.statusCode = 429;
      error.code = 'OTP_COOLDOWN';
      error.details = { retryAfterSeconds: throttle.retryAfterSeconds };
      throw error;
    }
  }

  // Generate 6-digit numeric OTP
  const otp = env.NODE_ENV === 'test' ? '123456' : crypto.randomInt(100000, 1000000).toString();
  const expiresAt = new Date(Date.now() + PHONE_OTP_MINUTES * 60 * 1000);

  // Invalidate any existing OTP requests for this user & phone
  await PhoneVerification.deleteMany({ userId, phone: cleanPhone });

  await PhoneVerification.create({
    userId,
    phone: cleanPhone,
    otp,
    channel,
    expiresAt,
    attempts: 0,
    verified: false,
  });

  if (channel === 'sms') return sendPhoneOtpBySms({ phone: cleanPhone, otp, expiresAt });

  try {
    await sendEmailOrFail({
      to: user.email,
      template: 'phoneVerificationCode',
      data: { name: user.name, code: otp, phone: cleanPhone, minutes: PHONE_OTP_MINUTES },
    });
  } catch (err) {
    // Not sent: drop the code so nothing is left waiting, and let the user try again at once.
    await PhoneVerification.deleteMany({ userId, phone: cleanPhone });
    throw err;
  }
  recordEmailSent('phone_otp', user.email);

  const sentTo = maskEmail(user.email);
  return {
    success: true,
    channel: 'email',
    sentTo,
    message: `We sent a 6-digit code to ${sentTo}`,
    expiresAt,
    resendAfterSeconds: PHONE_OTP_RESEND_SECONDS,
    testOtp: env.NODE_ENV === 'test' ? otp : undefined,
  };
}

/**
 * The SMS path, kept for when an SMS provider is added (PHONE_OTP_CHANNEL=sms). Unused today:
 * startup refuses PHONE_OTP_CHANNEL=sms. There is no provider, so it only logs the code.
 */
function sendPhoneOtpBySms({ phone, otp, expiresAt }) {
  logger.info({ phone, otp }, '📱 [SMS OTP] Mobile verification code generated');

  const maskedPhone = phone.length > 4
    ? `${phone.slice(0, 3)}****${phone.slice(-4)}`
    : phone;

  return {
    success: true,
    channel: 'sms',
    message: `Verification code sent to ${maskedPhone}`,
    expiresAt,
    resendAfterSeconds: PHONE_OTP_RESEND_SECONDS,
    testOtp: env.NODE_ENV === 'test' ? otp : undefined,
  };
}

/**
 * Verify 6-digit OTP code and generate verification token
 */
export async function verifyPhoneOtp(userId, { phone, otp }) {
  const cleanPhone = normalizePhone(phone);
  if (!cleanPhone) {
    const error = new Error('Mobile number is required.');
    error.statusCode = 400;
    error.code = 'INVALID_PHONE';
    throw error;
  }

  if (!otp || typeof otp !== 'string' || !/^\d{6}$/.test(otp.trim())) {
    const error = new Error('Verification code must be exactly 6 digits.');
    error.statusCode = 400;
    error.code = 'INVALID_OTP_FORMAT';
    throw error;
  }

  const record = await PhoneVerification.findOne({
    userId,
    phone: cleanPhone,
    expiresAt: { $gt: new Date() },
  });

  if (!record) {
    const error = new Error('Verification code has expired or was not requested. Please request a new OTP.');
    error.statusCode = 400;
    error.code = 'OTP_EXPIRED';
    throw error;
  }

  if (record.attempts >= 5) {
    const error = new Error('Too many invalid attempts. Please request a new OTP.');
    error.statusCode = 400;
    error.code = 'MAX_ATTEMPTS_EXCEEDED';
    throw error;
  }

  const isMatch = record.otp === otp.trim() || (env.NODE_ENV === 'test' && otp.trim() === '123456');
  if (!isMatch) {
    record.attempts += 1;
    await record.save();
    const error = new Error('Invalid verification code. Please check and try again.');
    error.statusCode = 400;
    error.code = 'INVALID_OTP';
    throw error;
  }

  const token = crypto.randomUUID();
  record.verified = true;
  record.token = token;
  await record.save();

  return {
    success: true,
    verified: true,
    verificationToken: token,
    verifiedVia: record.channel || 'email',
    message: 'Mobile number verified successfully!',
  };
}

/**
 * Update allowed profile fields for current user
 */
export async function updateProfile(userId, data) {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    error.code = 'USER_NOT_FOUND';
    throw error;
  }

  // Registered & accepted email cannot be changed by the user (only by admin)
  if (data.email !== undefined && data.email.toLowerCase().trim() !== user.email.toLowerCase().trim()) {
    const error = new Error('Registered and accepted email address cannot be changed by the user. Only an administrator can update email addresses.');
    error.statusCode = 403;
    error.code = 'EMAIL_CHANGE_ADMIN_ONLY';
    throw error;
  }

  const changedFields = [];

  if (data.name !== undefined && data.name.trim().length >= 2) {
    user.name = stripHtml(data.name).trim();
    changedFields.push('name');
  }

  if (data.preferredName !== undefined) {
    user.preferredName = stripHtml(data.preferredName);
    changedFields.push('preferredName');
  }

  if (data.phone !== undefined) {
    const cleanPhone = normalizePhone(data.phone);
    if (cleanPhone && cleanPhone !== user.phone) {
      // A code is needed only while PHONE_VERIFICATION_REQUIRED is on (off for now: the number is
      // entered directly). A verification token, when sent, is still checked.
      const codeRequired = PHONE_VERIFICATION_REQUIRED && (data.enforceOtp || env.NODE_ENV !== 'test');
      user.phoneVerified = false;
      user.phoneVerifiedAt = null;
      user.phoneVerifiedVia = null;
      if (data.phoneVerificationToken || codeRequired) {
        const verification = await PhoneVerification.findOne({
          userId: user._id,
          phone: cleanPhone,
          verified: true,
          token: data.phoneVerificationToken,
        });

        if (!verification) {
          const error = new Error('Mobile number must be verified with OTP before adding or updating it.');
          error.statusCode = 400;
          error.code = 'PHONE_OTP_REQUIRED';
          throw error;
        }

        await PhoneVerification.deleteOne({ _id: verification._id });
        user.phoneVerified = true;
        user.phoneVerifiedAt = new Date();
        user.phoneVerifiedVia = verification.channel || 'email';
      }

      user.phone = cleanPhone;
      changedFields.push('phone');
    } else if (!cleanPhone && user.phone) {
      user.phone = '';
      user.phoneVerified = false;
      user.phoneVerifiedAt = null;
      user.phoneVerifiedVia = null;
      changedFields.push('phone');
    }
  }

  if (data.whatsappNumber !== undefined) {
    user.whatsappNumber = normalizePhone(data.whatsappNumber);
    changedFields.push('whatsappNumber');
  }

  if (data.languages !== undefined) {
    user.languages = (Array.isArray(data.languages) ? data.languages : [])
      .slice(0, 5)
      .map((l) => stripHtml(String(l)).slice(0, 40));
    changedFields.push('languages');
  }

  if (data.about !== undefined) {
    user.about = stripHtml(data.about).slice(0, 200);
    changedFields.push('about');
  }

  if (data.skills !== undefined) {
    user.skills = (Array.isArray(data.skills) ? data.skills : [])
      .slice(0, 10)
      .map((s) => stripHtml(String(s)).slice(0, 30));
    changedFields.push('skills');
  }

  // Mark profile completed if name and phone exist
  if (!user.profileCompletedAt && user.name && user.phone) {
    user.profileCompletedAt = new Date();
    changedFields.push('profileCompletedAt');
  }

  await user.save();

  // Record ActivityEvent with field names only
  if (changedFields.length > 0) {
    try {
      await ActivityEvent.create({
        entityType: 'person',
        entityId: user._id,
        actorId: user._id,
        actingAs: user.role,
        action: 'profile.updated',
        metadata: { changedFields },
      });
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to record ActivityEvent for profile update');
    }
  }

  return getProfile(userId);
}

/**
 * Direct file upload handler for avatar
 */
export async function processAvatarUpload(userId, file) {
  if (!file) {
    const error = new Error('No avatar file provided');
    error.statusCode = 400;
    error.code = 'NO_FILE_PROVIDED';
    throw error;
  }

  const allowedMimes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];
  if (!allowedMimes.includes(file.mimetype)) {
    // Clean up uploaded file
    if (file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }
    const error = new Error('Invalid file type. Allowed formats: PNG, JPG, WEBP.');
    error.statusCode = 400;
    error.code = 'INVALID_FILE_TYPE';
    throw error;
  }

  const maxBytes = 5 * 1024 * 1024; // 5 MB
  if (file.size > maxBytes) {
    if (file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }
    const error = new Error('Avatar file size exceeds maximum limit of 5 MB.');
    error.statusCode = 400;
    error.code = 'FILE_TOO_LARGE';
    throw error;
  }

  const user = await User.findById(userId);
  if (!user) {
    if (file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  // Into storage (local folder or Bunny) under a new key; the temp file is then removed.
  const key = newAvatarKey(file.allowedType?.ext || path.extname(file.filename).toLowerCase());
  try {
    await putFile(key, file.path, { contentType: file.mimetype });
  } finally {
    if (file.path && fs.existsSync(file.path)) {
      try { fs.unlinkSync(file.path); } catch {}
    }
  }
  const previous = user.avatarStorageId || user.avatarUrl;
  user.avatarUrl = key;
  user.avatarStorageId = key;
  await user.save();
  // The replaced photo is deleted once the new one is saved.
  if (previous && storageKeyOf(previous) !== key) await deleteAvatarFile(previous);

  try {
    await ActivityEvent.create({
      entityType: 'person',
      entityId: user._id,
      actorId: user._id,
      actingAs: user.role,
      action: 'avatar.updated',
      metadata: { changedFields: ['avatarUrl', 'avatarStorageId'] },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to record ActivityEvent for avatar update');
  }

  return {
    avatarUrl: user.avatarUrl,
    avatarStorageId: user.avatarStorageId,
  };
}

/**
 * Deletes a profile photo from storage. Accepts the stored key, an older "/uploads/..." value, or
 * an older bare file name (avatarStorageId before storage keys). Never throws.
 */
export async function deleteAvatarFile(value) {
  if (!value) return;
  const key = storageKeyOf(value) || storageKeyOf(`uploads/${path.basename(String(value))}`);
  if (!key) return;
  try {
    await removeFile(key);
  } catch (err) {
    logger.warn({ code: err.code }, 'Could not delete the old profile photo from storage');
  }
}

/**
 * Remove avatar for user
 */
export async function removeAvatar(userId, actor = null) {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const previous = user.avatarStorageId || user.avatarUrl;
  user.avatarUrl = null;
  user.avatarStorageId = null;
  await user.save();
  await deleteAvatarFile(previous);

  try {
    const actorId = actor ? actor._id : user._id;
    const actorRole = actor ? actor.role : user.role;
    await ActivityEvent.create({
      entityType: 'person',
      entityId: user._id,
      actorId,
      actingAs: actorRole,
      action: 'avatar.removed',
      metadata: { changedFields: ['avatarUrl', 'avatarStorageId'] },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to record ActivityEvent for avatar removal');
  }

  return { success: true, message: 'Avatar removed successfully' };
}

/**
 * Get settings for user
 */
export async function getSettings(userId) {
  const user = await User.findById(userId).lean();
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  return {
    preferences: user.preferences || {
      startPage: 'Home',
      dateFormat: 'DD/MM/YYYY',
      timeFormat: '12h',
      weekStart: 'monday',
    },
    notificationPrefs: user.notificationPrefs || {
      mySteps: { inApp: true, email: true },
      approvalsRevisions: { inApp: true, email: true },
      messagesComments: { inApp: true, email: true },
      deadlinesOverdue: { inApp: true, email: true },
      planUpdates: { inApp: true, email: true },
      system: { inApp: true, email: true },
    },
  };
}

/**
 * Update user settings
 */
export async function updateSettings(userId, data, userRole) {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const changedFields = [];

  if (data.preferences) {
    user.preferences = {
      startPage: data.preferences.startPage || user.preferences?.startPage || 'Home',
      dateFormat: data.preferences.dateFormat || user.preferences?.dateFormat || 'DD/MM/YYYY',
      timeFormat: data.preferences.timeFormat || user.preferences?.timeFormat || '12h',
      weekStart: data.preferences.weekStart || user.preferences?.weekStart || 'monday',
    };
    changedFields.push('preferences');
  }

  if (data.notificationPrefs) {
    const isAdmin = isSuperuser(userRole);
    const current = user.notificationPrefs || {};

    user.notificationPrefs = {
      mySteps: data.notificationPrefs.mySteps || current.mySteps || { inApp: true, email: true },
      approvalsRevisions: data.notificationPrefs.approvalsRevisions || current.approvalsRevisions || { inApp: true, email: true },
      messagesComments: data.notificationPrefs.messagesComments || current.messagesComments || { inApp: true, email: true },
      deadlinesOverdue: data.notificationPrefs.deadlinesOverdue || current.deadlinesOverdue || { inApp: true, email: true },
      planUpdates: data.notificationPrefs.planUpdates || current.planUpdates || { inApp: true, email: true },
      system: isAdmin
        ? (data.notificationPrefs.system || current.system || { inApp: true, email: true })
        : (current.system || { inApp: true, email: true }),
    };
    changedFields.push('notificationPrefs');
  }

  await user.save();

  if (changedFields.length > 0) {
    try {
      await ActivityEvent.create({
        entityType: 'person',
        entityId: user._id,
        actorId: user._id,
        actingAs: user.role,
        action: 'settings.updated',
        metadata: { changedFields },
      });
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to record ActivityEvent for settings update');
    }
  }

  return {
    preferences: user.preferences,
    notificationPrefs: user.notificationPrefs,
  };
}

const passwordAttempts = new Map();

/**
 * Change user password
 */
export async function changePassword(userId, { currentPassword, newPassword, confirmPassword }) {
  const userIdStr = userId.toString();
  const now = Date.now();
  const attemptRecord = passwordAttempts.get(userIdStr);

  if (attemptRecord && attemptRecord.resetAt > now) {
    if (attemptRecord.count >= 5) {
      const error = new Error('Too many password change attempts. Please wait 15 minutes.');
      error.code = 'PASSWORD_RATE_LIMITED';
      error.statusCode = 429;
      throw error;
    }
  } else {
    passwordAttempts.set(userIdStr, { count: 0, resetAt: now + 15 * 60 * 1000 });
  }

  const recordAttempt = () => {
    const cur = passwordAttempts.get(userIdStr) || { count: 0, resetAt: now + 15 * 60 * 1000 };
    cur.count += 1;
    passwordAttempts.set(userIdStr, cur);
  };

  if (newPassword !== confirmPassword) {
    recordAttempt();
    const error = new Error('New password and confirm password must match');
    error.code = 'PASSWORD_MISMATCH';
    error.statusCode = 400;
    throw error;
  }

  if (newPassword === currentPassword) {
    recordAttempt();
    const error = new Error('New password must be different from current password');
    error.code = 'PASSWORD_MUST_BE_DIFFERENT';
    error.statusCode = 400;
    throw error;
  }

  const user = await User.findById(userId).select('+passwordHash');
  if (!user) {
    recordAttempt();
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const isMatch = await bcrypt.compare(currentPassword, user.passwordHash || '');
  if (!isMatch) {
    recordAttempt();
    const error = new Error('Current password is incorrect');
    error.code = 'INVALID_CURRENT_PASSWORD';
    error.statusCode = 400;
    throw error;
  }

  passwordAttempts.delete(userIdStr);

  const salt = await bcrypt.genSalt(10);
  user.passwordHash = await bcrypt.hash(newPassword, salt);
  await user.save();

  // Send mandatory security email notice
  try {
    const result = await sendEmail({
      to: user.email,
      template: 'passwordChanged',
      data: { name: user.name, time: new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' },
    });
    if (!result.ok) throw new Error(result.error);
  } catch (err) {
    logger.error({ err: err.message }, 'Failed to dispatch password change security email');
  }

  // Create mandatory security in-app notification
  try {
    await createNotification({
      recipient: user._id,
      type: 'security_alert',
      title: 'Security Alert: Password Changed',
      message: 'Your account password was successfully updated.',
      link: '/settings',
    });
  } catch (err) {
    logger.warn({ err: err.message }, 'Failed to create password change notification');
  }

  try {
    await ActivityEvent.create({
      entityType: 'person',
      entityId: user._id,
      actorId: user._id,
      actingAs: user.role,
      action: 'password.changed',
      metadata: { changedFields: ['password'] },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to record ActivityEvent for password change');
  }

  return { success: true, message: 'Password changed successfully' };
}

/**
 * Helper to identify current session ID from refresh token
 */
export function extractSessionId(refreshToken) {
  if (!refreshToken) return null;
  try {
    const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET);
    return decoded.sessionId || null;
  } catch {
    return null;
  }
}

/**
 * List active sessions for user
 */
export async function listSessions(userId, currentRefreshToken = null) {
  const currentSessionId = extractSessionId(currentRefreshToken);

  const sessions = await Session.find({
    userId,
    revokedAt: null,
  })
    .sort({ lastUsedAt: -1 })
    .lean();

  return sessions.map((s) => ({
    id: s._id.toString(),
    _id: s._id.toString(),
    deviceLabel: s.deviceLabel,
    createdAt: s.createdAt,
    lastUsedAt: s.lastUsedAt,
    isCurrent: Boolean(currentSessionId && s._id.toString() === currentSessionId),
  }));
}

/**
 * Revoke specific session
 */
export async function revokeSession(userId, sessionId, currentRefreshToken = null) {
  const currentSessionId = extractSessionId(currentRefreshToken);
  const session = await Session.findOne({
    _id: sessionId,
    userId,
    revokedAt: null,
  });

  if (!session) {
    const error = new Error('Session not found or already revoked');
    error.code = 'SESSION_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  session.revokedAt = new Date();
  await session.save();

  try {
    await ActivityEvent.create({
      entityType: 'session',
      entityId: session._id,
      actorId: userId,
      action: 'session.revoked',
      metadata: { deviceLabel: session.deviceLabel },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to record ActivityEvent for session revocation');
  }

  const isCurrent = Boolean(currentSessionId && sessionId === currentSessionId);
  disconnectUserSockets(userId);
  return { success: true, isCurrent };
}

/**
 * Revoke all other sessions except current
 */
export async function revokeOtherSessions(userId, currentRefreshToken = null) {
  const currentSessionId = extractSessionId(currentRefreshToken);

  const query = {
    userId,
    revokedAt: null,
  };

  if (currentSessionId) {
    query._id = { $ne: currentSessionId };
  }

  const result = await Session.updateMany(query, {
    revokedAt: new Date(),
  });

  try {
    await ActivityEvent.create({
      entityType: 'session',
      entityId: userId,
      actorId: userId,
      action: 'sessions.revoked_others',
      metadata: { count: result.modifiedCount },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to record ActivityEvent for revoke other sessions');
  }

  disconnectUserSockets(userId);
  return { success: true, revokedCount: result.modifiedCount };
}

/**
 * Submit role / capacity / department change request
 */
export async function submitChangeRequest(userId, { requestedChanges }) {
  const user = await User.findById(userId);
  if (!user) {
    const error = new Error('User not found');
    error.statusCode = 404;
    throw error;
  }

  const sanitizedChanges = stripHtml(requestedChanges);

  // Find all active admins
  const admins = await User.find({
    role: { $in: rolesWith('user.manage') },
    status: 'active',
  }).select('_id email name');

  for (const admin of admins) {
    // 1. Create in-app notification
    try {
      await createNotification({
        recipient: admin._id,
        type: 'change_request',
        title: `Change Request from ${user.preferredName || user.name}`,
        message: `${user.name} (${user.role}) submitted a work details update request: "${sanitizedChanges.slice(0, 100)}..."`,
        link: '/people',
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to dispatch in-app notification for change request');
    }

    // 2. Dispatch email
    try {
      const result = await sendEmail({
        to: admin.email,
        template: 'changeRequest',
        data: {
          requesterName: user.name,
          requesterEmail: user.email,
          requesterRole: user.role,
          requestedChanges: sanitizedChanges,
        },
      });
      if (!result.ok) throw new Error(result.error);
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to dispatch email for change request');
    }
  }

  try {
    await ActivityEvent.create({
      entityType: 'change_request',
      entityId: user._id,
      actorId: user._id,
      actingAs: user.role,
      action: 'profile.change_requested',
      metadata: { changedFields: ['requestedChanges'] },
    });
  } catch (e) {
    logger.warn({ err: e.message }, 'Failed to record ActivityEvent for change request');
  }

  return {
    success: true,
    message: 'Your change request has been submitted to system administrators.',
  };
}

