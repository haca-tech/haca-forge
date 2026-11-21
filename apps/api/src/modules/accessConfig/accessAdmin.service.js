import mongoose from 'mongoose';
import {
  CALENDARS,
  CALENDAR_KEYS,
  ROLE_KEYS,
  WORKFLOW_SLOTS,
  WORKFLOW_SLOT_LABELS,
  WORKFLOW_SLOT_PERMISSION,
  can,
  slotEligibleRole,
  describeAccessChange,
  roleHasCalendarScopedPermissions,
  systemRoleOf,
  withinCalendarScope,
} from '@mmp/shared';
import { Person } from '../people/model.js';
import { WorkItem } from '../workItems/model.js';
import { PauseRequest } from '../workItems/pauseRequest.model.js';
import { ContentPiece } from '../calendar/contentPiece.model.js';
import { AccessChange } from './accessChange.model.js';
import { WorkflowConfig } from './workflowConfig.model.js';
import { changePersonAccess } from './personAccess.service.js';
import { updateWorkflowConfig } from './workflowConfig.service.js';
import { getAllWorkflowConfigs, getWorkflowConfig } from '../../lib/accessResolver.js';
import { countAwaitingReview } from '../workItems/reviewState.js';
import { calendarQueryFor } from '../workItems/deciders.js';
import { createNotification } from '../notifications/service.js';
import { logActivity } from '../activity/service.js';

/**
 * Access & Approvals (Phase D, admin only). People: role and calendar limit (through
 * changePersonAccess). Calendars: who approves plans, reviews, posts, and the fallback (through
 * updateWorkflowConfig), with a live health check and a re-routing preview. History and restore.
 * Waiting reviews, plan rows and pause requests are not stored per person: the resolver routes
 * them live, so a settings change moves them at once; here we tell the new people once and move
 * open Post steps whose owner is no longer a poster.
 */

const idOf = (v) => String(v?._id || v || '');
const calName = (c) => CALENDARS[c]?.name || c;

function fail(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}
const requireReason = (reason) => {
  const r = String(reason || '').trim();
  if (r.length < 3) throw fail(400, 'REASON_REQUIRED', 'Give a reason for this change.', { field: 'reason' });
  return r;
};

// ---------------------------------------------------------------- people

export async function listPeople({ search = '', role = '', status = '' } = {}) {
  const q = {};
  if (role && ROLE_KEYS.includes(role)) q.role = role;
  if (status && ['active', 'invited', 'suspended'].includes(status)) q.status = status;
  if (search.trim()) {
    const rx = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    q.$or = [{ name: rx }, { email: rx }, { jobRole: rx }];
  }
  const people = await Person.find(q).select('name email jobRole role status calendarScope lastLoginAt').sort({ name: 1 }).lean();
  return people.map((p) => ({
    _id: idOf(p),
    name: p.name,
    email: p.email,
    jobRole: p.jobRole || '',
    role: p.role,
    status: p.status,
    calendarScope: Array.isArray(p.calendarScope) && p.calendarScope.length ? p.calendarScope : null,
    lastActive: p.lastLoginAt || null,
    calendarLimitApplies: roleHasCalendarScopedPermissions(p.role),
  }));
}

/** Validates a requested role / calendar limit; returns the normalised values. */
function cleanPersonChange(target, { role, calendarScope, status } = {}) {
  const nextStatus = status === undefined ? target.status : String(status);
  if (!['active', 'invited', 'suspended'].includes(nextStatus)) throw fail(400, 'VALIDATION_ERROR', `Unknown status: ${status}`, { field: 'status' });
  const nextRole = role === undefined ? target.role : String(role);
  if (!ROLE_KEYS.includes(nextRole)) throw fail(400, 'VALIDATION_ERROR', `Unknown role: ${role}`, { field: 'role' });
  let scope = calendarScope === undefined ? target.calendarScope || null : calendarScope;
  if (Array.isArray(scope) && !scope.length) scope = null;
  if (scope && scope.some((c) => !CALENDAR_KEYS.includes(c))) throw fail(400, 'VALIDATION_ERROR', 'Unknown calendar in the limit.', { field: 'calendarScope' });
  // A limit means nothing for roles without calendar-routed permissions (and the locked admin is never limited).
  if (!roleHasCalendarScopedPermissions(nextRole)) scope = null;
  return { role: nextRole, status: nextStatus, calendarScope: scope ? [...new Set(scope)].sort() : null };
}

export async function previewPersonChange(id, body, actor) {
  if (!mongoose.isValidObjectId(id)) throw fail(404, 'NOT_FOUND', 'Person not found');
  const target = await Person.findById(id).select('name role status calendarScope').lean();
  if (!target) throw fail(404, 'NOT_FOUND', 'Person not found');
  const next = cleanPersonChange(target, body);
  const before = { _id: idOf(target), role: target.role, status: target.status, calendarScope: target.calendarScope || null };
  const after = { ...before, role: next.role, status: next.status, calendarScope: next.calendarScope };
  const { gains, losses } = describeAccessChange(before, after, await getAllWorkflowConfigs());
  const guard = selfGuard(target, next, actor) || (await lastAdminGuard(target, next)) || (await calendarGuard(target, next));
  return {
    name: target.name,
    before: { role: before.role, status: before.status, calendarScope: before.calendarScope?.length ? before.calendarScope : null },
    after: next,
    gains,
    losses,
    blocked: guard,
  };
}

/** An admin can't demote or suspend themselves. */
function selfGuard(target, next, actor) {
  if (idOf(target) !== idOf(actor)) return null;
  if (next.role !== target.role) return { code: 'SELF_DEMOTE', message: 'You cannot change your own role. Ask another admin.' };
  if (next.status !== target.status) return { code: 'SELF_SUSPEND', message: 'You cannot suspend yourself. Ask another admin.' };
  return null;
}

/** The last active admin keeps the role (the Person model enforces it too, with 409 LAST_ADMIN). */
async function lastAdminGuard(target, next) {
  const isAdmin = systemRoleOf(target)?.locked && target.status === 'active';
  const staysAdmin = systemRoleOf({ role: next.role })?.locked && next.status === 'active';
  if (!isAdmin || staysAdmin) return null;
  const others = await Person.find({ _id: { $ne: target._id }, status: 'active' }).select('role').lean();
  if (others.some((p) => systemRoleOf(p)?.locked)) return null;
  return { code: 'LAST_ADMIN', message: 'This is the last active admin. Make someone else an admin first.' };
}

/**
 * Would this person change leave a calendar without anybody to approve plans, review or post?
 * Runs the health check on every calendar with and without the change; a problem the change
 * introduces blocks it, naming the calendars and settings to fix first.
 */
async function calendarGuard(target, next) {
  const override = { _id: idOf(target), role: next.role, status: next.status, calendarScope: next.calendarScope };
  const configs = await getAllWorkflowConfigs();
  const calendars = [];
  for (const calendar of CALENDAR_KEYS) {
    const before = await healthCheck(calendar, configs[calendar]);
    const after = await healthCheck(calendar, configs[calendar], { override });
    const had = new Set(before.errors.map((e) => `${e.slot}|${e.message}`));
    const added = after.errors.filter((e) => !had.has(`${e.slot}|${e.message}`));
    if (added.length) calendars.push({ calendar, name: calName(calendar), slots: [...new Set(added.map((e) => e.slot))], errors: added });
  }
  if (!calendars.length) return null;
  const list = calendars.map((c) => `${c.name} (${c.slots.map((s) => WORKFLOW_SLOT_LABELS[s] || s).join(', ')})`).join('; ');
  return {
    code: 'BREAKS_CALENDARS',
    message: `This change would leave a calendar without anyone to act. Fix these calendar settings first: ${list}.`,
    calendars,
  };
}

export async function savePersonChange(id, body = {}, actor) {
  const reason = requireReason(body.reason);
  if (!mongoose.isValidObjectId(id)) throw fail(404, 'NOT_FOUND', 'Person not found');
  const target = await Person.findById(id);
  if (!target) throw fail(404, 'NOT_FOUND', 'Person not found');
  const next = cleanPersonChange(target, body);
  const blocked = selfGuard(target, next, actor);
  if (blocked) throw fail(403, blocked.code, blocked.message);
  const lastAdmin = await lastAdminGuard(target, next);
  if (lastAdmin) throw fail(409, lastAdmin.code, lastAdmin.message);
  const breaks = await calendarGuard(target, next);
  if (breaks) throw fail(409, breaks.code, breaks.message, { calendars: breaks.calendars });
  const saved = await changePersonAccess(target, { role: next.role, status: next.status, calendarScope: next.calendarScope }, actor, { note: reason });
  return (await listPeople({ search: saved.email || saved.name })).find((p) => p._id === idOf(saved)) || { _id: idOf(saved) };
}

// ---------------------------------------------------------------- calendars

const rolesForSlot = (slot) => ROLE_KEYS.filter((role) => slotEligibleRole(role, slot));

/** What each slot's picker may offer: roles holding the permission and active people in them. */
export async function slotOptions() {
  const people = await Person.find({ status: 'active', role: { $in: ROLE_KEYS } }).select('name role calendarScope').sort({ name: 1 }).lean();
  const out = {};
  for (const slot of WORKFLOW_SLOTS) {
    const perm = WORKFLOW_SLOT_PERMISSION[slot];
    const roles = rolesForSlot(slot);
    out[slot] = {
      permission: perm,
      roles,
      people: people.filter((p) => roles.includes(p.role)).map((p) => ({ _id: idOf(p), name: p.name, role: p.role, calendarScope: p.calendarScope?.length ? p.calendarScope : null })),
    };
  }
  return out;
}

/**
 * The people an audience names: `active` (active and inside their calendar limit) and `named`
 * (each named id, or a missing marker). `override` replaces one person's role, status and limit
 * (to test a person change before saving it).
 */
async function resolveAudience(audience, calendar, { override } = {}) {
  const roles = audience?.roles || [];
  const ids = (audience?.userIds || []).filter((x) => mongoose.isValidObjectId(x));
  const or = [];
  if (roles.length) or.push({ role: { $in: roles } });
  if (ids.length) or.push({ _id: { $in: ids } });
  if (!or.length) return { active: [], named: [] };
  let all = await Person.find({ $or: or }).select('name role status calendarScope').lean();
  if (override) {
    all = all.filter((p) => idOf(p) !== override._id);
    const p = await Person.findById(override._id).select('name role status calendarScope').lean();
    if (p) {
      const changed = { ...p, role: override.role, status: override.status, calendarScope: override.calendarScope || null };
      if (roles.includes(changed.role) || ids.map(String).includes(override._id)) all.push(changed);
    }
  }
  const active = all.filter((p) => p.status === 'active' && withinCalendarScope(p, calendar));
  const named = ids.map((id) => all.find((p) => idOf(p) === String(id)) || { _id: id, missing: true });
  return { active, named };
}

const SLOT_NOUN = { posters: 'poster who can own Post steps', reviewers: 'reviewer', planApprovers: 'plan approver' };

/**
 * The health check for one calendar's settings: errors block saving, warnings do not.
 * Reviewers and plan approvers may be covered by the fallback; posters have no fallback (a Post
 * step needs an owner who takes steps, so the admin does not count as a poster).
 */
export async function healthCheck(calendar, config, { override } = {}) {
  const errors = [];
  const warnings = [];
  const resolved = {};
  for (const slot of WORKFLOW_SLOTS) {
    const aud = config[slot] || { roles: [], userIds: [] };
    for (const role of aud.roles || []) {
      if (!slotEligibleRole(role, slot)) errors.push({ slot, message: `The ${role} role cannot ${slot === 'posters' ? 'own Post steps' : 'decide'}.` });
    }
    const { active, named } = await resolveAudience(aud, calendar, { override });
    for (const p of named) {
      if (p.missing) errors.push({ slot, message: 'A named person no longer exists.' });
      else if (!slotEligibleRole(p.role, slot)) errors.push({ slot, message: `${p.name}'s role cannot do this.` });
      else if (p.status !== 'active') warnings.push({ slot, message: `${p.name} is ${p.status}.` });
      else if (!withinCalendarScope(p, calendar)) warnings.push({ slot, message: `${p.name} is limited to other calendars.` });
    }
    resolved[slot] = active.filter((p) => slotEligibleRole(p.role, slot)).map((p) => ({ _id: idOf(p), name: p.name, role: p.role }));
  }
  const fallback = resolved.fallbackApprovers;
  if (!fallback.length) errors.push({ slot: 'fallbackApprovers', message: 'The fallback resolves to nobody active.' });
  if (!resolved.posters.length) {
    errors.push({ slot: 'posters', message: `${calName(calendar)} has no active ${SLOT_NOUN.posters}.` });
  }
  for (const slot of ['planApprovers', 'reviewers']) {
    if (resolved[slot].length) continue;
    const perm = WORKFLOW_SLOT_PERMISSION[slot];
    const fb = (await resolveAudience(config.fallbackApprovers, calendar, { override })).active.filter((p) => can({ role: p.role, status: 'active' }, perm));
    if (fb.length) warnings.push({ slot, message: `Nobody active here: the fallback (${fb.map((p) => p.name).join(', ')}) takes it.` });
    else errors.push({ slot, message: `${calName(calendar)} has no active ${SLOT_NOUN[slot]}, even with the fallback.` });
  }
  return { ok: errors.length === 0, errors, warnings, resolved };
}

function mergeChanges(current, changes = {}) {
  const next = { ...current };
  for (const slot of WORKFLOW_SLOTS) {
    if (!(slot in changes)) continue;
    const a = changes[slot] || {};
    next[slot] = { roles: [...new Set((a.roles || []).map(String))], userIds: [...new Set((a.userIds || []).map(String))] };
  }
  return next;
}

const same = (a, b) =>
  JSON.stringify([[...(a?.roles || [])].sort(), [...(a?.userIds || [])].map(String).sort()]) ===
  JSON.stringify([[...(b?.roles || [])].sort(), [...(b?.userIds || [])].map(String).sort()]);

/** What a change would move, and to whom. */
async function reroutePlan(calendar, current, next) {
  const reviewersChanged = !same(current.reviewers, next.reviewers) || !same(current.fallbackApprovers, next.fallbackApprovers);
  const approversChanged = !same(current.planApprovers, next.planApprovers) || !same(current.fallbackApprovers, next.fallbackApprovers);
  const postersChanged = !same(current.posters, next.posters);
  const inCal = calendarQueryFor([calendar]);
  const stepIds = reviewersChanged ? (await WorkItem.find(inCal).select('_id').lean()).map((s) => s._id) : [];
  const waitingReviews = reviewersChanged ? await countAwaitingReview(inCal) : 0;
  const pauseRequests = reviewersChanged ? await PauseRequest.countDocuments({ status: 'pending', workItemId: { $in: stepIds } }) : 0;
  const planRows = approversChanged ? await ContentPiece.countDocuments({ ...inCal, rowStatus: 'submitted' }) : 0;

  const healthNext = await healthCheck(calendar, next);
  const healthNow = await healthCheck(calendar, current);
  const effective = (h, slot) => (h.resolved[slot].length ? h.resolved[slot] : h.resolved.fallbackApprovers);
  const newcomers = (slot) => {
    const was = new Set(effective(healthNow, slot).map((p) => p._id));
    return effective(healthNext, slot).filter((p) => !was.has(p._id));
  };
  const newReviewers = reviewersChanged ? newcomers('reviewers') : [];
  const newApprovers = approversChanged ? newcomers('planApprovers') : [];

  // Post steps not started yet move only when their owner is no longer a poster for this
  // calendar; a Post step in progress keeps its owner (Phase E fix: in-progress ones moved too).
  let postSteps = [];
  if (postersChanged) {
    const open = await WorkItem.find({ ...inCal, stageKey: 'Post', status: 'Not Started', isSkipped: { $ne: true } })
      .select('_id title ownerId')
      .populate('ownerId', 'name role status calendarScope')
      .lean();
    const posterIds = new Set(healthNext.resolved.posters.map((p) => p._id));
    postSteps = open.filter((s) => !s.ownerId || !posterIds.has(idOf(s.ownerId)));
  }
  const defaultPoster = healthNext.resolved.posters[0] || null;
  return { reviewersChanged, approversChanged, postersChanged, waitingReviews, pauseRequests, planRows, newReviewers, newApprovers, postSteps, defaultPoster, health: healthNext };
}

function previewSentences(calendar, plan) {
  const out = [];
  const names = (list) => list.map((p) => p.name).join(', ') || 'nobody new';
  if (plan.reviewersChanged) {
    const parts = [];
    if (plan.waitingReviews) parts.push(`${plan.waitingReviews} waiting review${plan.waitingReviews === 1 ? '' : 's'}`);
    if (plan.pauseRequests) parts.push(`${plan.pauseRequests} pause request${plan.pauseRequests === 1 ? '' : 's'}`);
    out.push(`Changing ${calName(calendar)} reviewers will re-route ${parts.join(' and ') || 'nothing waiting'}${parts.length ? ` to ${names(plan.newReviewers)}` : ''}.`);
  }
  if (plan.approversChanged) {
    out.push(`Changing ${calName(calendar)} plan approvers will re-route ${plan.planRows || 'no'} waiting plan row${plan.planRows === 1 ? '' : 's'}${plan.planRows ? ` to ${names(plan.newApprovers)}` : ''}.`);
  }
  if (plan.postersChanged) {
    out.push(plan.postSteps.length
      ? `${plan.postSteps.length} Post step${plan.postSteps.length === 1 ? '' : 's'} not started yet will move to ${plan.defaultPoster?.name || 'the fallback'} (their owner is no longer a poster).`
      : 'Post steps keep their owners.');
  }
  out.push('Steps in progress keep their owners.');
  return out;
}

async function calendarView(calendar) {
  const config = await getWorkflowConfig(calendar);
  const doc = await WorkflowConfig.findOne({ calendar }).populate('updatedBy', 'name').lean();
  const health = await healthCheck(calendar, config);
  const names = {};
  for (const slot of WORKFLOW_SLOTS) for (const id of config[slot].userIds) names[id] = names[id] || null;
  const people = Object.keys(names).length ? await Person.find({ _id: { $in: Object.keys(names) } }).select('name role status').lean() : [];
  return {
    calendar,
    name: calName(calendar),
    config: Object.fromEntries(WORKFLOW_SLOTS.map((s) => [s, config[s]])),
    version: doc?.version ?? 0,
    stored: Boolean(doc),
    updatedAt: doc?.updatedAt || null,
    updatedBy: doc?.updatedBy?.name || null,
    namedPeople: people.map((p) => ({ _id: idOf(p), name: p.name, role: p.role, status: p.status })),
    health,
  };
}

export async function getCalendars() {
  return { calendars: await Promise.all(CALENDAR_KEYS.map(calendarView)), options: await slotOptions() };
}

function assertCalendar(calendar) {
  if (!CALENDAR_KEYS.includes(calendar)) throw fail(404, 'NOT_FOUND', 'Unknown calendar');
}

export async function previewCalendarChange(calendar, changes = {}) {
  assertCalendar(calendar);
  const current = await getWorkflowConfig(calendar);
  const next = mergeChanges(current, changes);
  const plan = await reroutePlan(calendar, current, next);
  return {
    health: plan.health,
    sentences: previewSentences(calendar, plan),
    counts: { waitingReviews: plan.waitingReviews, pauseRequests: plan.pauseRequests, planRows: plan.planRows, postSteps: plan.postSteps.length },
    newRecipients: { reviewers: plan.newReviewers, planApprovers: plan.newApprovers },
  };
}

export async function saveCalendarChange(calendar, body = {}, actor) {
  assertCalendar(calendar);
  const reason = requireReason(body.reason);
  const changes = Object.fromEntries(WORKFLOW_SLOTS.filter((s) => s in (body.changes || {})).map((s) => [s, body.changes[s]]));
  const current = await getWorkflowConfig(calendar);
  const next = mergeChanges(current, changes);
  const plan = await reroutePlan(calendar, current, next);
  if (!plan.health.ok) throw fail(409, 'HEALTH_CHECK_FAILED', 'Fix the health check before saving.', { errors: plan.health.errors });

  await updateWorkflowConfig(calendar, changes, actor, { note: reason });

  // Tell each new person once what now comes to them.
  const counts = new Map();
  const add = (p, key, n) => {
    if (!n) return;
    const c = counts.get(p._id) || { person: p, reviews: 0, pauses: 0, rows: 0 };
    c[key] += n;
    counts.set(p._id, c);
  };
  for (const p of plan.newReviewers) {
    add(p, 'reviews', plan.waitingReviews);
    add(p, 'pauses', plan.pauseRequests);
  }
  for (const p of plan.newApprovers) add(p, 'rows', plan.planRows);
  for (const { person, reviews, pauses, rows } of counts.values()) {
    const parts = [
      reviews && `${reviews} waiting review${reviews === 1 ? '' : 's'}`,
      pauses && `${pauses} pause request${pauses === 1 ? '' : 's'}`,
      rows && `${rows} plan row${rows === 1 ? '' : 's'}`,
    ].filter(Boolean);
    await createNotification({
      recipient: person._id,
      type: 'access_rerouted',
      title: `${calName(calendar)}: decisions now come to you`,
      message: `You now decide on ${calName(calendar)}: ${parts.join(', ')} moved to you.`,
      link: '/feedback',
      metadata: { calendar, reviews, pauses, rows },
    });
  }

  // Open Post steps whose owner is no longer a poster: to the calendar's first poster.
  let movedPosts = 0;
  if (plan.postSteps.length && plan.defaultPoster) {
    for (const s of plan.postSteps) {
      const res = await WorkItem.updateOne({ _id: s._id, status: 'Not Started', ownerId: s.ownerId?._id || s.ownerId || null }, { $set: { ownerId: plan.defaultPoster._id } });
      if (!res.modifiedCount) continue;
      movedPosts += 1;
      await logActivity({ entityType: 'work_item', entityId: s._id, actor, action: 'work_item.owner_rerouted', metadata: { from: idOf(s.ownerId), to: plan.defaultPoster._id, reason } });
    }
    if (movedPosts) {
      await createNotification({
        recipient: plan.defaultPoster._id,
        type: 'access_rerouted',
        title: `${calName(calendar)}: Post steps assigned to you`,
        message: `${movedPosts} open Post step${movedPosts === 1 ? '' : 's'} on ${calName(calendar)} now belong to you.`,
        link: '/my-work',
        metadata: { calendar, postSteps: movedPosts },
      });
    }
  }
  return { calendar: await calendarView(calendar), sentences: previewSentences(calendar, plan), notified: counts.size, movedPosts };
}

// ---------------------------------------------------------------- history and restore

export async function listHistory({ person = '', calendar = '', type = '' } = {}) {
  const q = {};
  if (type === 'person' || type === 'workflow_config') q.entityType = type;
  if (person && mongoose.isValidObjectId(person)) Object.assign(q, { entityType: 'person', entityId: String(person) });
  if (calendar && CALENDAR_KEYS.includes(calendar)) Object.assign(q, { entityType: 'workflow_config', entityId: calendar });
  const rows = await AccessChange.find(q).sort({ at: -1, _id: -1 }).limit(300).populate('actorId', 'name').lean();
  const personIds = [...new Set(rows.filter((r) => r.entityType === 'person').map((r) => r.entityId))];
  const people = personIds.length ? await Person.find({ _id: { $in: personIds } }).select('name').lean() : [];
  const nameOf = new Map(people.map((p) => [idOf(p), p.name]));
  return rows.map((r) => ({
    _id: idOf(r),
    at: r.at,
    actor: r.actorId?.name || 'System',
    type: r.entityType,
    subject: r.entityType === 'person' ? nameOf.get(r.entityId) || 'Unknown person' : calName(r.entityId),
    entityId: r.entityId,
    field: r.field,
    before: r.before,
    after: r.after,
    reason: r.note || '',
    version: r.version ?? null,
    canRestore: r.entityType === 'workflow_config' && Boolean(r.configBefore),
  }));
}

/** Restore a calendar's settings to what they were before a history entry (same checks as a save). */
export async function restoreCalendarVersion(changeId, { preview = false, reason } = {}, actor) {
  if (!mongoose.isValidObjectId(changeId)) throw fail(404, 'NOT_FOUND', 'History entry not found');
  const entry = await AccessChange.findById(changeId).lean();
  if (!entry || entry.entityType !== 'workflow_config' || !entry.configBefore) throw fail(404, 'NOT_FOUND', 'This entry cannot be restored.');
  const changes = Object.fromEntries(WORKFLOW_SLOTS.map((s) => [s, entry.configBefore[s]]));
  if (preview) return previewCalendarChange(entry.entityId, changes);
  return saveCalendarChange(entry.entityId, { changes, reason: reason || `Restored the settings from before version ${entry.version ?? ''}`.trim() }, actor);
}

export const __test = { healthCheck, cleanPersonChange };
