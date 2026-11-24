import { eligiblePreferencesForUpdate } from './eligibility.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Person } from './model.js';
import { resolveScope } from '../../lib/scope.js';
import { logActivity } from '../activity/service.js';
import { syncUserTeamChatMembership } from '../chat/service.js';
import { normalizeRole, APPROVER_ROLES, READ_ONLY_VIEWER_ROLES, WORKER_ROLE, isApprover, isReadOnlyViewer, isWorker, canSeeContactDetails } from '@mmp/shared';
import { canSeeContacts, hasPermission, isOperationalManager, isOwnScope, isProtectedAccount, isSuperuser, rolesOutsidePools, seesAll } from '../../lib/roleAccess.js';
import { savePersonChange } from '../accessConfig/accessAdmin.service.js';

/** Active-step limit (workload): a whole number from 1 to 20, else 400. */
function validLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    const error = new Error('The limit must be a whole number from 1 to 20.');
    error.code = 'INVALID_LIMIT';
    error.statusCode = 400;
    throw error;
  }
  return limit;
}

export async function listPeople({ actor, filters = {}, excludeAdmin = false }) {
  const scope = await resolveScope(actor, filters);
  if (!scope.isAllowed) {
    return [];
  }

  const query = {};

  // Person visibility scoping
  if (scope.allowedPersonIds !== null) {
    query._id = { $in: scope.allowedPersonIds };
  }

  // Department filter
  if (filters.departmentId) {
    query.departmentId = filters.departmentId;
  }

  // Status filter (default to active and invited unless specified)
  if (filters.status) {
    query.status = filters.status;
  }

  // Role filter
  if (filters.role) {
    query.role = filters.role;
  }

  // Exclude admin and creative_head/production_head from auto-assignment candidate pools, workload calculations, and performance metrics
  if (excludeAdmin) {
    query.role = { $nin: rolesOutsidePools() };
  }

  const people = await Person.find(query)
    .populate('departmentId', 'name code')
    .populate('reportsToIds', 'name email role jobRole')
    .sort({ name: 1 })
    .lean();

  // Contact details: hidden only from workers (the REST filter does the same).
  if (!canSeeContacts(actor)) {
    return people.map((p) => {
      const sanitized = { ...p };
      delete sanitized.email;
      delete sanitized.phone;
      if (Array.isArray(sanitized.reportsToIds)) {
        sanitized.reportsToIds = sanitized.reportsToIds.map((r) => {
          if (typeof r === 'object' && r !== null) {
            const rep = { ...r };
            delete rep.email;
            delete rep.phone;
            return rep;
          }
          return r;
        });
      }
      return sanitized;
    });
  }

  return people;
}

export async function getPersonById(id, actor) {
  const person = await Person.findById(id)
    .populate('departmentId', 'name code')
    .populate('reportsToIds', 'name email role jobRole')
    .lean();

  if (!person) {
    const error = new Error('Person not found');
    error.code = 'PERSON_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  if (actor) {
    const scope = await resolveScope(actor);
    if (!scope.canAccessPerson(person._id)) {
      const error = new Error('Access denied: person is outside your team scope');
      error.code = 'FORBIDDEN';
      error.statusCode = 403;
      throw error;
    }
  }

  if (!canSeeContacts(actor)) {
    const sanitized = { ...person };
    delete sanitized.email;
    delete sanitized.phone;
    if (Array.isArray(sanitized.reportsToIds)) {
      sanitized.reportsToIds = sanitized.reportsToIds.map((r) => {
        if (typeof r === 'object' && r !== null) {
          const rep = { ...r };
          delete rep.email;
          delete rep.phone;
          return rep;
        }
        return r;
      });
    }
    return sanitized;
  }

  return person;
}

export async function createPerson(data, actor) {
  const actorRole = normalizeRole(actor?.role);
  if (!hasPermission(actor, 'user.manage')) {
    const error = new Error('Forbidden: only Administrator can create users');
    error.code = 'FORBIDDEN';
    error.statusCode = 403;
    throw error;
  }

  const email = (data.email || '').toLowerCase().trim();
  const existing = await Person.findOne({ email });
  if (existing) {
    const error = new Error('A person with this email already exists');
    error.code = 'PERSON_EXISTS';
    error.statusCode = 409;
    throw error;
  }

  const rawPassword = data.temporaryPassword || data.password;
  let passwordHash = undefined;
  let mustSetPassword = true;
  let mustChangePassword = false;

  if (rawPassword) {
    if (typeof rawPassword !== 'string' || rawPassword.length < 8) {
      const error = new Error('Temporary password must be at least 8 characters long');
      error.code = 'INVALID_PASSWORD';
      error.statusCode = 400;
      throw error;
    }
    if (!/[A-Z]/.test(rawPassword)) {
      const error = new Error('Temporary password must contain at least one uppercase letter');
      error.code = 'INVALID_PASSWORD';
      error.statusCode = 400;
      throw error;
    }
    if (!/[0-9]/.test(rawPassword)) {
      const error = new Error('Temporary password must contain at least one number');
      error.code = 'INVALID_PASSWORD';
      error.statusCode = 400;
      throw error;
    }
    const confirm = data.confirmTemporaryPassword || data.confirmPassword;
    if (confirm !== undefined && confirm !== rawPassword) {
      const error = new Error('Temporary password and confirmation do not match');
      error.code = 'PASSWORD_MISMATCH';
      error.statusCode = 400;
      throw error;
    }

    const salt = await bcrypt.genSalt(10);
    passwordHash = await bcrypt.hash(rawPassword, salt);
    mustSetPassword = false;
    mustChangePassword = true;
  }

  const person = await Person.create({
    name: data.name.trim(),
    email,
    passwordHash,
    role: data.role || WORKER_ROLE,
    jobRole: data.jobRole || '',
    departmentId: data.departmentId || null,
    reportsToIds: data.reportsToIds || [],
    weeklyCapacityHours: data.weeklyCapacityHours ?? 40,
    workPreferences: data.workPreferences || [],
    status: data.status || 'active',
    mustSetPassword,
    mustChangePassword,
  });

  await logActivity({
    entityType: 'person',
    entityId: person._id,
    actor,
    action: 'person.created',
    metadata: { name: person.name, email: person.email, role: person.role },
  });

  if (person.status === 'active') {
    await syncUserTeamChatMembership(person._id).catch(() => {});
  }

  return person;
}

export async function updatePerson(id, updates, actor) {
  const actorRole = normalizeRole(actor?.role);
  const target = await Person.findById(id);
  let accessChanges = null;

  if (!target) {
    const error = new Error('Person not found');
    error.code = 'PERSON_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  const targetRole = normalizeRole(target.role);
  // Job role sets eligibility; preferences can only narrow it (checked before any write).
  const eligiblePrefs = eligiblePreferencesForUpdate(target, updates);

  // Lead update restrictions (creative_lead, growth_lead): operational fields of workers and SM Managers only
  if (isOperationalManager(actor)) {
    // Cannot touch admin, lead or read-only head accounts
    if (isProtectedAccount(targetRole)) {
      const error = new Error('Forbidden: a lead cannot modify admin, lead or head accounts');
      error.code = 'FORBIDDEN';
      error.statusCode = 403;
      throw error;
    }

    // Cannot modify core account identity fields
    if (updates.role && updates.role !== target.role) {
      const error = new Error('Forbidden: a lead cannot change user roles');
      error.code = 'FORBIDDEN';
      error.statusCode = 403;
      throw error;
    }

    if (updates.status && updates.status !== target.status) {
      const error = new Error('Forbidden: a lead cannot change user status (suspend/activate)');
      error.code = 'FORBIDDEN';
      error.statusCode = 403;
      throw error;
    }

    if (updates.email || updates.password || updates.name) {
      const error = new Error('Forbidden: a lead can only edit operational fields (department, jobRole, workPreferences, weeklyCapacityHours, activeStepLimit)');
      error.code = 'FORBIDDEN';
      error.statusCode = 403;
      throw error;
    }

    // Only apply operational fields
    if (updates.departmentId !== undefined) target.departmentId = updates.departmentId;
    if (updates.jobRole !== undefined) target.jobRole = updates.jobRole;
    if (updates.reportsToIds !== undefined) target.reportsToIds = updates.reportsToIds;
    if (updates.weeklyCapacityHours !== undefined) target.weeklyCapacityHours = updates.weeklyCapacityHours;
    if (updates.activeStepLimit !== undefined) target.activeStepLimit = validLimit(updates.activeStepLimit);
    if (eligiblePrefs !== undefined) target.workPreferences = eligiblePrefs;
  } else if (hasPermission(actor, 'user.manage')) {
    // Admin has full control
    if (updates.name !== undefined) target.name = updates.name;
    if (updates.email !== undefined) target.email = updates.email.toLowerCase().trim();
    // Role and status go through the admin page's savePersonChange (reason, guards, health check).
    if (updates.role !== undefined || updates.status !== undefined) accessChanges = { role: updates.role, status: updates.status, reason: updates.reason };
    if (updates.jobRole !== undefined) target.jobRole = updates.jobRole;
    if (updates.departmentId !== undefined) target.departmentId = updates.departmentId;
    if (updates.reportsToIds !== undefined) target.reportsToIds = updates.reportsToIds;
    if (updates.weeklyCapacityHours !== undefined) target.weeklyCapacityHours = updates.weeklyCapacityHours;
    if (updates.activeStepLimit !== undefined) target.activeStepLimit = validLimit(updates.activeStepLimit);
    if (eligiblePrefs !== undefined) target.workPreferences = eligiblePrefs;

    if (updates.password) {
      const salt = await bcrypt.genSalt(10);
      target.passwordHash = await bcrypt.hash(updates.password, salt);
      target.mustSetPassword = false;
    }
  } else {
    const error = new Error('Forbidden: insufficient permissions to update people');
    error.code = 'FORBIDDEN';
    error.statusCode = 403;
    throw error;
  }

  // One write per person: the other fields ride on the access change's save; refused = nothing saved.
  if (accessChanges) await savePersonChange(String(target._id), accessChanges, actor, { person: target });
  else await target.save();

  await logActivity({
    entityType: 'person',
    entityId: target._id,
    actor,
    action: 'person.updated',
    metadata: { updatedFields: Object.keys(updates) },
  });

  return Person.findById(target._id); // fresh: role and status were saved by savePersonChange
}

export async function suspendPerson(id, actor, { reason } = {}) {
  const actorRole = normalizeRole(actor?.role);
  if (!hasPermission(actor, 'user.manage')) {
    const error = new Error('Forbidden: only Administrator can suspend users');
    error.code = 'FORBIDDEN';
    error.statusCode = 403;
    throw error;
  }

  const target = await Person.findById(id);
  if (!target) {
    const error = new Error('Person not found');
    error.code = 'PERSON_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  if (target._id.toString() === (actor._id || actor.id || actor.userId)?.toString()) {
    const error = new Error('Cannot suspend your own admin account');
    error.code = 'CANNOT_SUSPEND_SELF';
    error.statusCode = 400;
    throw error;
  }

  target.refreshTokenHash = undefined; // Force logout, in the same write as the suspension
  await savePersonChange(String(target._id), { status: 'suspended', reason }, actor, { person: target });

  await logActivity({
    entityType: 'person',
    entityId: target._id,
    actor,
    action: 'person.suspended',
    fromStatus: 'active',
    toStatus: 'suspended',
  });

  await syncUserTeamChatMembership(target._id).catch(() => {});

  return Person.findById(target._id);
}

export async function reactivatePerson(id, actor, { reason } = {}) {
  const actorRole = normalizeRole(actor?.role);
  if (!hasPermission(actor, 'user.manage')) {
    const error = new Error('Forbidden: only Administrator can reactivate users');
    error.code = 'FORBIDDEN';
    error.statusCode = 403;
    throw error;
  }

  const target = await Person.findById(id);
  if (!target) {
    const error = new Error('Person not found');
    error.code = 'PERSON_NOT_FOUND';
    error.statusCode = 404;
    throw error;
  }

  await savePersonChange(String(target._id), { status: 'active', reason }, actor);

  await logActivity({
    entityType: 'person',
    entityId: target._id,
    actor,
    action: 'person.reactivated',
    fromStatus: 'suspended',
    toStatus: 'active',
  });

  await syncUserTeamChatMembership(target._id).catch(() => {});

  return Person.findById(target._id);
}

export async function getAssignmentCandidates({ departmentId, excludeIds = [] }) {
  const query = {
    role: { $nin: rolesOutsidePools() }, // Admin & read-only roles strictly excluded from candidate pools
    status: 'active',
  };

  if (departmentId) {
    query.departmentId = departmentId;
  }

  if (excludeIds.length > 0) {
    query._id = { $nin: excludeIds };
  }

  return Person.find(query)
    .populate('departmentId', 'name code')
    .lean();
}

/**
 * Checks if two users are collaborators on at least one shared ContentPiece
 */
export async function sharesContentPiece(personAId, personBId) {
  if (!personAId || !personBId) return false;
  if (personAId.toString() === personBId.toString()) return true;

  try {
    const { ContentPiece } = await import('../calendar/contentPiece.model.js');
    const { WorkItem } = await import('../workItems/model.js');

    // 1. Direct ContentPiece stagePlan or postingOwner
    const directPieces = await ContentPiece.find({
      $or: [
        { 'stagePlan.ownerId': personAId },
        { postingOwnerId: personAId },
      ],
    }).select('_id stagePlan postingOwnerId').lean();

    for (const piece of directPieces) {
      const stageOwners = (piece.stagePlan || [])
        .map((s) => s.ownerId?.toString())
        .filter(Boolean);
      if (piece.postingOwnerId) stageOwners.push(piece.postingOwnerId.toString());
      if (stageOwners.includes(personBId.toString())) {
        return true;
      }
    }

    // 2. WorkItem distinct pieces
    const piecesWithA = await WorkItem.distinct('contentPieceId', {
      ownerId: personAId,
      contentPieceId: { $ne: null },
    });

    if (piecesWithA.length > 0) {
      const hasBInSamePiece = await WorkItem.exists({
        contentPieceId: { $in: piecesWithA },
        ownerId: personBId,
      });
      if (hasBInSamePiece) return true;
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Error checking shared content piece');
  }

  return false;
}

/**
 * Get person profile for read-only drawer / inspect views
 * Enforces strict visibility rules:
 * - Admin, Creative Manager, SM Manager: Full profile with contact details
 * - Executive: Full profile with contact details masked
 * - Team Member: Allowed ONLY if sharing a ContentPiece with the person; contact details masked
 */
export async function getPersonProfile(targetId, actor) {
  const person = await Person.findById(targetId)
    .populate('departmentId', 'name code')
    .populate('reportsToIds', 'name email role jobRole')
    .lean();

  if (!person) {
    const error = new Error('Person not found');
    error.statusCode = 404;
    error.code = 'PERSON_NOT_FOUND';
    throw error;
  }

  const actorRole = normalizeRole(actor?.role);
  const isSelf = actor?._id?.toString() === person._id.toString();

  // Fixed rule 5: another person's profile does not exist for a worker, teammates on the same
  // piece included (404, not 403, so the answer does not confirm the person exists).
  if (!isSelf && !hasPermission(actorRole, 'team.profile.view')) {
    const error = new Error('Person not found');
    error.statusCode = 404;
    error.code = 'PERSON_NOT_FOUND';
    throw error;
  }

  const deptName = person.departmentId?.name || (typeof person.department === 'string' ? person.department : '');

  const result = {
    id: person._id.toString(),
    _id: person._id.toString(),
    name: person.name,
    preferredName: person.preferredName || '',
    role: normalizeRole(person.role),
    jobRole: person.jobRole || (isSuperuser(person) ? 'System Administrator' : 'Team Member'),
    department: deptName || 'General',
    departmentId: person.departmentId?._id?.toString() || null,
    status: person.status || 'active',
    avatarUrl: person.avatarUrl || null,
    avatarStorageId: person.avatarStorageId || null,
    about: person.about || '',
    skills: Array.isArray(person.skills) ? person.skills : [],
    languages: Array.isArray(person.languages) ? person.languages : [],
    weeklyCapacityHours: person.weeklyCapacityHours || person.capacity || 40,
    workPreferences: Array.isArray(person.workPreferences) ? person.workPreferences : [],
    createdAt: person.createdAt,
    lastLoginAt: person.lastLoginAt || person.lastLogin || null,
  };

  // Contact details visibility:
  // Everyone except workers sees contact details (Phase 12b: the read-only heads too).
  // A worker (executive) sees only their own.
  const canSeeContact = isSelf || canSeeContacts(actorRole);

  if (canSeeContact) {
    result.email = person.email;
    result.phone = person.phone || '';
    result.whatsappNumber = person.whatsappNumber || '';
  } else {
    result.email = null;
    result.phone = null;
    result.whatsappNumber = null;
  }

  return result;
}

/**
 * Admin updates another person's basic info (name, phone)
 */
export async function adminUpdatePersonBasic(targetId, data, actor) {
  const actorRole = normalizeRole(actor?.role);
  if (!hasPermission(actor, 'user.manage')) {
    const error = new Error('Forbidden: Only administrators can update person basic info');
    error.statusCode = 403;
    error.code = 'FORBIDDEN';
    throw error;
  }

  const person = await Person.findById(targetId);
  if (!person) {
    const error = new Error('Person not found');
    error.statusCode = 404;
    error.code = 'PERSON_NOT_FOUND';
    throw error;
  }

  const changedFields = [];
  if (data.name !== undefined) {
    person.name = String(data.name).trim();
    changedFields.push('name');
  }
  if (data.phone !== undefined) {
    person.phone = String(data.phone).trim();
    changedFields.push('phone');
  }

  await person.save();

  if (changedFields.length > 0) {
    try {
      const { ActivityEvent } = await import('../activity/model.js');
      await ActivityEvent.create({
        entityType: 'person',
        entityId: person._id,
        actorId: actor._id,
        actingAs: actor.role,
        action: 'person.basic_info_updated',
        metadata: { changedFields },
      });
    } catch (e) {
      logger.warn({ err: e.message }, 'Failed to record ActivityEvent for basic info update');
    }
  }

  return getPersonProfile(targetId, actor);
}

/**
 * Admin removes another person's photo
 */
export async function adminRemovePersonAvatar(targetId, actor) {
  const actorRole = normalizeRole(actor?.role);
  if (!hasPermission(actor, 'user.manage')) {
    const error = new Error('Forbidden: Only administrators can remove person avatar');
    error.statusCode = 403;
    error.code = 'FORBIDDEN';
    throw error;
  }

  const { removeAvatar } = await import('../profile/service.js');
  return removeAvatar(targetId, actor);
}

/**
 * Retrieves per-person individual work view:
 * sections Now, Next, Done (last 30 with timings), timeline data, and summary metrics (no performance ranking).
 */
export async function getPersonWorkHistory(targetPersonId, user) {
  const actorRole = normalizeRole(user?.role);
  const actorId = (user?._id || user?.id || user?.userId)?.toString();

  const isSelf = actorId === targetPersonId?.toString();
  const isElevated = hasPermission(actorRole, 'team.profile.view');

  // Fixed rule 5: another person's work history does not exist for a worker (404).
  if (!isSelf && !isElevated) {
    const error = new Error('Person not found');
    error.statusCode = 404;
    error.code = 'PERSON_NOT_FOUND';
    throw error;
  }

  const person = await Person.findById(targetPersonId).select('name email role jobRole avatarUrl departmentId');
  if (!person) {
    const error = new Error('Person not found');
    error.statusCode = 404;
    error.code = 'PERSON_NOT_FOUND';
    throw error;
  }

  const { WorkItem } = await import('../workItems/model.js');
  const { calculateIndividualWorkMeasures, formatDuration } = await import('@mmp/shared');

  const allItems = await WorkItem.find({
    ownerId: targetPersonId,
    isSkipped: { $ne: true },
  })
    .populate('contentPieceId', 'title calendar monthYear code status publishDate')
    .sort({ deadline: 1, createdAt: -1 });

  const nowItems = [];
  const nextItems = [];
  const doneItems = [];

  for (const item of allItems) {
    const itemObj = item.toObject ? item.toObject() : { ...item };
    const measures = calculateIndividualWorkMeasures(itemObj);
    itemObj.measures = measures;

    if (['Approved', 'Published'].includes(item.status)) {
      doneItems.push(itemObj);
    } else if (item.isLocked || item.status === 'Not Started') {
      nextItems.push(itemObj);
    } else if (['In Progress', 'Feedback', 'Pending', 'Blocked'].includes(item.status)) {
      nowItems.push(itemObj);
    } else {
      nowItems.push(itemObj);
    }
  }

  // Mark the steps waiting on a reviewer, so the history says "Waiting for approval" for them.
  const { markAwaitingReview } = await import('../workItems/reviewState.js');
  await markAwaitingReview(nowItems);

  // Done items: last 30 completed, sorted descending by completion date
  doneItems.sort((a, b) => {
    const timeA = new Date(a.postedAt || a.approvedAt || a.updatedAt).getTime();
    const timeB = new Date(b.postedAt || b.approvedAt || b.updatedAt).getTime();
    return timeB - timeA;
  });
  const limitedDone = doneItems.slice(0, 30);

  // Summary calculation (alphabetical/neutral metrics, strictly NO speed/performance ranking)
  let onTimeCount = 0;
  let itemsWithDeadlineCount = 0;
  let totalRevisions = 0;
  let totalApprovalWaitMs = 0;
  let approvalWaitCount = 0;

  const stepTypeWorkTimes = {};

  for (const d of doneItems) {
    totalRevisions += d.revisions || 0;
    if (d.measures?.approvalWaitMs != null) {
      totalApprovalWaitMs += d.measures.approvalWaitMs;
      approvalWaitCount++;
    }
    if (d.deadline) {
      itemsWithDeadlineCount++;
      if (!d.measures?.isLate) {
        onTimeCount++;
      }
    }
    const stepKey = d.stageKey || d.workType || 'Other';
    if (d.measures?.workTimeMs != null) {
      if (!stepTypeWorkTimes[stepKey]) {
        stepTypeWorkTimes[stepKey] = { totalMs: 0, count: 0 };
      }
      stepTypeWorkTimes[stepKey].totalMs += d.measures.workTimeMs;
      stepTypeWorkTimes[stepKey].count++;
    }
  }

  const avgWorkTimeByStepType = {};
  for (const [stepKey, data] of Object.entries(stepTypeWorkTimes)) {
    const avgMs = Math.round(data.totalMs / data.count);
    avgWorkTimeByStepType[stepKey] = {
      avgMs,
      formatted: formatDuration(avgMs),
      count: data.count,
    };
  }

  const summary = {
    totalCompleted: doneItems.length,
    activeCount: nowItems.length,
    nextCount: nextItems.length,
    onTimeRate: itemsWithDeadlineCount > 0 ? Math.round((onTimeCount / itemsWithDeadlineCount) * 100) : 100,
    averageApprovalWaitMs: approvalWaitCount > 0 ? Math.round(totalApprovalWaitMs / approvalWaitCount) : null,
    averageApprovalWaitFormatted:
      approvalWaitCount > 0 ? formatDuration(Math.round(totalApprovalWaitMs / approvalWaitCount)) : '—',
    avgWorkTimeByStepType,
    totalRevisions,
  };

  return {
    person,
    now: nowItems,
    next: nextItems,
    done: limitedDone,
    summary,
  };
}
