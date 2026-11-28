/**
 * Recent activity (admin Live Status page): the audit log as plain sentences.
 * "Riya approved a submission · Diwali reel". Only a few safe fields are returned
 * (no message text, no contact details, no tokens).
 */
import mongoose from 'mongoose';
import { ActivityEvent } from './model.js';
import { Person } from '../people/model.js';
import { WorkItem } from '../workItems/model.js';
import { CalendarPlan } from '../calendar/plan.model.js';

/** Filter chips on the page -> action prefixes. */
export const FEED_CATEGORIES = {
  sign_ins: ['auth.'],
  work: ['work_item.', 'submission.', 'revision.', 'assignment.', 'blocker.', 'steps.', 'rating.', 'content_piece.', 'live_link.'],
  plans: ['calendar_plan.', 'plan.'],
  people: ['person.', 'access_request.', 'password.', 'session.', 'sessions.', 'profile.', 'avatar.', 'settings.'],
};

export function categoryOf(action = '') {
  for (const [key, prefixes] of Object.entries(FEED_CATEGORIES)) {
    if (prefixes.some((p) => action.startsWith(p))) return key;
  }
  return 'other';
}

/** Verb phrase per action; anything not listed is worded from the action name. */
const VERBS = {
  'auth.signed_in': 'signed in',
  'auth.signed_out': 'signed out',
  'auth.sign_in_failed': 'failed to sign in (wrong password)',
  'work_item.created': 'created work',
  'work_item.updated': 'updated work',
  'work_item.deleted': 'deleted work',
  'work_item.assigned': 'assigned work',
  'work_item.reassigned': 'reassigned work',
  'work_item.status_changed': 'changed the status of',
  'work_item.deadline_changed': 'changed the deadline of',
  'work_item.approved': 'approved',
  'work_item.blocked': 'marked as blocked',
  'work_item.unblocked': 'unblocked',
  'work_item.help_requested': 'asked for help on',
  'work_item.help_resolved': 'resolved a help request on',
  'work_item.feedback_submitted': 'gave feedback on',
  'work_item.feedback_response': 'replied to feedback on',
  'work_item.owner_rerouted': 'rerouted the owner of',
  'work_item.pause_cancelled': 'cancelled a pause on',
  'submission.submitted': 'submitted',
  'submission.approved': 'approved a submission',
  'submission.revision_requested': 'requested changes',
  'submission.comment_resolved': 'resolved a review comment',
  'revision.flagged': 'flagged a revision',
  'revision.classified': 'classified a revision',
  'rating.given': 'rated work',
  'rating.edited': 'edited a rating',
  'steps.reassigned': 'reassigned steps',
  'assignment.overridden': 'overrode an assignment',
  'blocker.reminder_sent': 'sent a blocker reminder',
  'content_piece.rescheduled': 'rescheduled a post',
  'live_link.changed': 'changed a live link',
  'calendar_plan.created': 'created a plan',
  'calendar_plan.submitted': 'submitted a plan for approval',
  'calendar_plan.deleted': 'deleted a plan',
  'calendar_plan.rows_added': 'added rows to a plan',
  'calendar_plan.row_deleted': 'deleted a plan row',
  'calendar_plan.row_submitted': 'submitted a plan row',
  'calendar_plan.grid_rows_saved': 'edited a plan',
  'plan.calendar_moved': 'moved a plan to another calendar',
  'person.created': 'added a person',
  'person.updated': 'updated a person',
  'person.basic_info_updated': 'updated details of',
  'person.suspended': 'suspended',
  'person.reactivated': 'reactivated',
  'person.password_regenerated': 'generated a temporary password for',
  'access_request.submitted': 'requested access',
  'access_request.approved': 'approved access for',
  'access_request.rejected': 'rejected access for',
  'access_request.info_requested': 'asked for more information from',
  'password.changed': 'changed their password',
  'session.revoked': 'signed out a device',
  'sessions.revoked_others': 'signed out their other devices',
  'profile.updated': 'updated their profile',
  'profile.change_requested': 'requested a profile change',
  'avatar.updated': 'changed their photo',
  'avatar.removed': 'removed their photo',
  'settings.updated': 'changed settings',
  'chat.message.deleted': 'deleted a chat message',
};

export function verbFor(action = '') {
  if (VERBS[action]) return VERBS[action];
  const [, ...rest] = action.split('.');
  return (rest.join(' ') || action).replace(/_/g, ' ');
}

const STATUS_FIELDS = (s) => (typeof s === 'string' && s.length <= 40 ? s.replace(/_/g, ' ') : undefined);

async function namesFor(events) {
  const ids = (type) => [
    ...new Set(events.filter((e) => e.entityType === type && mongoose.isValidObjectId(e.entityId)).map((e) => String(e.entityId))),
  ];
  const [items, people, plans] = await Promise.all([
    WorkItem.find({ _id: { $in: ids('work_item') } }).select('title').lean(),
    Person.find({ _id: { $in: ids('person') } }).select('name preferredName').lean(),
    CalendarPlan.find({ _id: { $in: ids('calendar_plan') } }).select('code calendar').lean(),
  ]);
  const map = new Map();
  items.forEach((w) => map.set(`work_item:${w._id}`, { label: w.title, link: `/work/${w._id}` }));
  people.forEach((p) => map.set(`person:${p._id}`, { label: p.preferredName || p.name, link: `/team/${p._id}` }));
  plans.forEach((p) => map.set(`calendar_plan:${p._id}`, { label: [p.code, p.calendar].filter(Boolean).join(' · '), link: '/calendar?tab=plans' }));
  return map;
}

/**
 * Newest first. `before` (ISO time) pages back; `category` is a FEED_CATEGORIES key;
 * `actorId` limits it to one person. Returns { items, nextBefore }.
 */
export async function activityFeed({ limit = 30, before, category, actorId } = {}) {
  const size = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const query = { action: { $not: /^chat\.(shared|unshared)$/ } };
  if (before && !Number.isNaN(Date.parse(before))) query.timestamp = { $lt: new Date(before) };
  if (category && FEED_CATEGORIES[category]) {
    query.action = { $regex: `^(${FEED_CATEGORIES[category].map((p) => p.replace(/\./g, '\\.')).join('|')})` };
  }
  if (actorId && mongoose.isValidObjectId(actorId)) query.actorId = actorId;

  const events = await ActivityEvent.find(query)
    .sort({ timestamp: -1 })
    .limit(size + 1)
    .populate('actorId', 'name preferredName role avatarUrl')
    .lean();
  const page = events.slice(0, size);
  const names = await namesFor(page);

  const items = page.map((e) => {
    const actor = e.actorId && typeof e.actorId === 'object' ? e.actorId : null;
    const target = names.get(`${e.entityType}:${e.entityId}`) || null;
    const self = target && actor && String(e.entityId) === String(actor._id);
    return {
      _id: String(e._id),
      at: e.timestamp,
      action: e.action,
      category: categoryOf(e.action),
      verb: verbFor(e.action),
      actor: actor
        ? { _id: String(actor._id), name: actor.preferredName || actor.name, role: actor.role, avatarUrl: actor.avatarUrl || null }
        : null,
      asAdmin: e.actingAs === 'admin',
      target: self ? null : target,
      fromStatus: STATUS_FIELDS(e.fromStatus),
      toStatus: STATUS_FIELDS(e.toStatus),
      device: typeof e.metadata?.device === 'string' ? e.metadata.device.slice(0, 60) : undefined,
    };
  });
  return { items, nextBefore: events.length > size ? page[page.length - 1].timestamp : null };
}
