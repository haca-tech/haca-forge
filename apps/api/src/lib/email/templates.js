// Every HACA Forge email, built on the one layout (layout.js). Each template returns
// { subject, html, text }. Wording is kept from the earlier templates where it existed, renamed
// from "HACA Marketing OS" to "HACA Forge". Codes never appear in a subject line.
//
// `sample` is the data the dev preview page (/dev/emails), the snapshot tests and
// scripts/send-test-email.js render each template with.

import { ROLE_LABELS, WORKER_ROLE } from '@mmp/shared';
import { renderLayout, oneLine } from './layout.js';

/** Role keys shown as their labels ("executive" -> "Executive"); unknown values as they are. */
const roleLabel = (role) => ROLE_LABELS[role] || oneLine(role);

export const IGNORE_IF_NOT_YOU = "If you didn't request this, ignore this email.";

/** "+919876543210" -> "+91••••••3210": every digit masked except the last 4. */
export function maskPhone(phone) {
  const value = String(phone ?? '').trim();
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return value;
  let toMask = digits.length - 4;
  let out = '';
  for (const ch of value) {
    if (/\d/.test(ch) && toMask > 0) {
      out += '•';
      toMask -= 1;
    } else {
      out += ch;
    }
  }
  return out;
}

/** "mohammed@harisandcoacademy.com" -> "m•••@harisandcoacademy.com". */
export function maskEmail(email) {
  const value = String(email ?? '').trim();
  const at = value.lastIndexOf('@');
  if (at < 1) return value ? '•••' : '';
  return `${value[0]}•••${value.slice(at)}`;
}

const greeting = (name) => (oneLine(name) ? `Hello ${oneLine(name)},` : 'Hello,');

function formatDue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
}

export const TEMPLATES = {
  verificationCode: {
    label: 'Verification code',
    sample: { name: 'Mohammed Rafi', code: '482913', minutes: 10, purpose: 'confirm it is you' },
    render: ({ name, code, minutes = 10, purpose = 'confirm it is you' }, ctx) => ({
      subject: 'Your HACA Forge verification code',
      ...renderLayout({
        ...ctx,
        preheader: `Your verification code is valid for ${minutes} minutes.`,
        title: 'Your verification code',
        intro: `${greeting(name)} use this code to ${oneLine(purpose)}.`,
        blocks: [
          { type: 'code', code },
          { type: 'paragraph', text: `This code is valid for ${minutes} minutes.` },
          { type: 'small', text: IGNORE_IF_NOT_YOU },
        ],
      }),
    }),
  },

  phoneVerificationCode: {
    label: 'Phone number verification code',
    sample: { name: 'Mohammed Rafi', code: '730158', phone: '+919876543210', minutes: 10 },
    render: ({ name, code, phone, minutes = 10 }, ctx) => ({
      subject: 'Verify your phone number for HACA Forge',
      ...renderLayout({
        ...ctx,
        preheader: `Enter this code in HACA Forge to add ${maskPhone(phone)} to your profile.`,
        title: 'Verify your phone number',
        intro: `${greeting(name)} enter this code in HACA Forge to add this phone number to your profile.`,
        blocks: [
          { type: 'details', rows: [['Phone number', maskPhone(phone)]] },
          { type: 'code', code },
          { type: 'paragraph', text: `This code is valid for ${minutes} minutes.` },
          { type: 'small', text: IGNORE_IF_NOT_YOU },
        ],
      }),
    }),
  },

  passwordReset: {
    label: 'Password reset',
    sample: { name: 'Mohammed Rafi', resetUrl: 'http://localhost:5173/set-password?token=sample-token', hours: 48 },
    render: ({ name, resetUrl, hours = 48 }, ctx) => ({
      subject: 'HACA Forge - Password Reset Request',
      ...renderLayout({
        ...ctx,
        preheader: `Set a new password. The link is valid for ${hours} hours.`,
        title: 'Reset your password',
        intro: `${greeting(name)} a password reset was requested for your account.`,
        blocks: [
          { type: 'paragraph', text: `Click the button below to set your password. This single-use link is valid for ${hours} hours.` },
          { type: 'small', text: IGNORE_IF_NOT_YOU },
        ],
        button: { label: 'Set Password & Sign In', url: resetUrl },
        secondary: { label: 'If the button does not work, copy and paste this link into your browser:', url: resetUrl },
      }),
    }),
  },

  accessRequestReceived: {
    label: 'Access request received (to admins)',
    sample: { name: 'Aisha Noor', email: 'aisha@harisandcoacademy.com', department: 'Social Media', jobRole: 'Writer', requestedRole: WORKER_ROLE },
    render: ({ name, email, department, jobRole, requestedRole }, ctx) => ({
      subject: `New Access Request: ${oneLine(name)} (${oneLine(department) || 'General'})`,
      ...renderLayout({
        ...ctx,
        preheader: `${oneLine(name)} asked for access to HACA Forge.`,
        title: 'New access request',
        intro: 'A new user has submitted details for review:',
        blocks: [
          {
            type: 'details',
            rows: [
              ['Name', name],
              ['Email', email],
              ['Department', department || 'General'],
              ['Job role', jobRole || 'Not specified'],
              ['Requested role', roleLabel(requestedRole)],
            ],
          },
          { type: 'paragraph', text: 'Sign in to HACA Forge to confirm the final role, reports-to and capacity.' },
        ],
        button: { label: 'Review access requests', url: '/admin/access-requests' },
      }),
    }),
  },

  accessApproved: {
    label: 'Access request approved',
    sample: { name: 'Aisha Noor', setPasswordUrl: 'http://localhost:5173/set-password?token=sample-token', hours: 48 },
    render: ({ name, setPasswordUrl, hours = 48 }, ctx) => ({
      subject: 'Welcome to HACA Forge - Set Your Password',
      ...renderLayout({
        ...ctx,
        preheader: `Your access request was approved. Set your password within ${hours} hours.`,
        title: `Welcome to the team, ${oneLine(name)}`,
        intro: 'Your access request has been approved by the administrator.',
        blocks: [
          { type: 'paragraph', text: `Click the button below to set your account password and activate your workspace. This single-use link is valid for ${hours} hours.` },
        ],
        button: { label: 'Set Password & Activate Account', url: setPasswordUrl },
        secondary: { label: 'If the button does not work, copy and paste this link into your browser:', url: setPasswordUrl },
      }),
    }),
  },

  accessRejected: {
    label: 'Access request rejected',
    sample: { name: 'Aisha Noor', reason: 'Please ask your department head to confirm your role first.' },
    render: ({ name, reason }, ctx) => ({
      subject: 'Update Regarding Your HACA Forge Access Request',
      ...renderLayout({
        ...ctx,
        preheader: 'Your access request was reviewed.',
        title: 'Access request update',
        intro: greeting(name),
        blocks: [
          { type: 'paragraph', text: 'Your request for access to HACA Forge was reviewed by an administrator, but could not be approved at this time.' },
          { type: 'note', label: 'Reason', text: reason || 'Administrative decision' },
          { type: 'small', text: 'If you have questions or believe this was in error, please reach out to your administrator.' },
        ],
      }),
    }),
  },

  accessInfoNeeded: {
    label: 'Access request: more information needed',
    sample: { name: 'Aisha Noor', question: 'Which brand will you be writing for?' },
    render: ({ name, question }, ctx) => ({
      subject: 'Action Needed: Your HACA Forge Access Request',
      ...renderLayout({
        ...ctx,
        preheader: 'The administrator needs a little more information.',
        title: 'More information needed',
        intro: greeting(name),
        blocks: [
          { type: 'paragraph', text: 'Before your access request can be completed, the administrator needs additional information:' },
          { type: 'note', text: question },
          { type: 'small', text: 'Please reply to this email or send the details to your administrator.' },
        ],
      }),
    }),
  },

  welcome: {
    label: 'Welcome / account created',
    sample: { name: 'Aisha Noor' },
    render: ({ name }, ctx) => ({
      subject: 'Your HACA Forge account is ready',
      ...renderLayout({
        ...ctx,
        preheader: 'Your HACA Forge account is ready to use.',
        title: `Welcome to HACA Forge, ${oneLine(name)}`,
        intro: 'Your account has been created and is ready to use.',
        blocks: [{ type: 'paragraph', text: 'Sign in to see your work, calendars and team.' }],
        button: { label: 'Sign in to HACA Forge', url: '/login' },
      }),
    }),
  },

  passwordChanged: {
    label: 'Password changed (security notice)',
    sample: { name: 'Mohammed Rafi', time: '23 Nov 2026, 10:42 am IST' },
    render: ({ name, time }, ctx) => ({
      subject: '[Security Alert] Password Changed for Your HACA Forge Account',
      ...renderLayout({
        ...ctx,
        preheader: 'Your HACA Forge password was changed.',
        title: 'Your password was changed',
        intro: greeting(name),
        blocks: [
          { type: 'paragraph', text: `The password for your HACA Forge account was changed on ${oneLine(time) || formatDue(new Date())}.` },
          { type: 'small', text: 'If you did not make this change, contact your administrator immediately to secure your account.' },
        ],
      }),
    }),
  },

  changeRequest: {
    label: 'Work details change request (to admins)',
    sample: {
      requesterName: 'Mohammed Rafi',
      requesterEmail: 'rafi@harisandcoacademy.com',
      requesterRole: WORKER_ROLE,
      requestedChanges: 'Please move me to the Design department from next month.',
    },
    render: ({ requesterName, requesterEmail, requesterRole, requestedChanges }, ctx) => ({
      subject: `[Change Request] Work Details Update Requested by ${oneLine(requesterName)}`,
      ...renderLayout({
        ...ctx,
        preheader: `${oneLine(requesterName)} asked for a work details change.`,
        title: 'Work details change request',
        intro: 'A work details change request was submitted:',
        blocks: [
          { type: 'details', rows: [['Requester', `${oneLine(requesterName)} (${oneLine(requesterEmail)})`], ['Current role', roleLabel(requesterRole)]] },
          { type: 'note', text: requestedChanges },
          { type: 'small', text: 'Review this request in People to adjust role, department or capacity if appropriate.' },
        ],
        button: { label: 'Open in HACA Forge', url: '/people' },
      }),
    }),
  },

  notification: {
    label: 'Notification (overdue, blocked, reminders)',
    sample: {
      name: 'Mohammed Rafi',
      title: 'Overdue: Ramadan reel script',
      message: '"Ramadan reel script" was due 2026-11-21 (IST) and is now overdue. Please update it in HACA Forge.',
      itemName: 'Ramadan reel script',
      url: '/work/665f1c2e9b1e8a0012345678',
    },
    render: ({ name, title, subject, message, itemName, url, preheader }, ctx) => ({
      subject: oneLine(subject || title),
      ...renderLayout({
        ...ctx,
        notification: true,
        preheader: oneLine(preheader || message || title),
        title: oneLine(title),
        intro: greeting(name),
        blocks: [
          ...(itemName ? [{ type: 'details', rows: [['Item', itemName]] }] : []),
          { type: 'paragraph', text: message },
        ],
        button: url ? { label: 'Open in HACA Forge', url } : undefined,
      }),
    }),
  },

  test: {
    label: 'Test email',
    sample: { driver: 'console', sentAt: '23 Nov 2026, 10:42 am IST' },
    render: ({ driver, sentAt }, ctx) => ({
      subject: 'HACA Forge test email',
      ...renderLayout({
        ...ctx,
        preheader: 'Email from HACA Forge is working.',
        title: 'Email is working',
        intro: 'This is a test email from HACA Forge. If you can read it, email delivery is set up correctly.',
        blocks: [{ type: 'details', rows: [['Driver', driver], ['Sent', sentAt]] }],
        button: { label: 'Open HACA Forge', url: '/' },
      }),
    }),
  },
};

export const TEMPLATE_NAMES = Object.keys(TEMPLATES);

/**
 * Render a template by name.
 * @param {string} name   a key of TEMPLATES
 * @param {object} data   the template's data (user-supplied text is escaped by the layout)
 * @param {{appUrl:string, logoUrl?:string}} ctx
 */
export function renderTemplate(name, data, ctx) {
  const template = TEMPLATES[name];
  if (!template) throw new Error(`Unknown email template: ${name}`);
  return template.render(data || {}, ctx);
}
