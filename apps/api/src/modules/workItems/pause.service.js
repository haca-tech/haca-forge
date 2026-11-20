import mongoose from 'mongoose';
import {
  PAUSE_NOTE_MAX,
  PAUSE_REASONS,
  PAUSE_REASON_LABELS,
  REMINDER_HOUR_IST,
  canDecide,
  decisionCalendarsFor,
  isApprover,
  isReadOnlyViewer,
  isWorkingDayIST,
  istDateKey,
  istHour,
  nextWorkingDayKeyIST,
  normalizeRole,
} from '@mmp/shared';
import { WorkItem } from './model.js';
import { PauseRequest } from './pauseRequest.model.js';
import { assertDecidesOn, calendarOf, decidersFor, decisionCalendarFilter } from './deciders.js';
import { Person } from '../people/model.js';
import { logActivity } from '../activity/service.js';
import { createNotification } from '../notifications/service.js';
import { logger } from '../../lib/logger.js';
import { can as canPure } from '@mmp/shared';
import * as access from '../../lib/accessResolver.js';
import { hasPermission, isReadOnly } from '../../lib/roleAccess.js';

/**
 * Pause work with lead approval. A worker asks to pause a step they are working on; the
 * lead of the step's calendar (Growth Lead for Ads, Creative Lead otherwise, admin as a
 * backup; never the requester) approves or rejects it. While pending, time keeps counting.
 * An approved pause opens a `manual_pause` interval at the approval time (work time stops);
 * resume closes it. The status stays In Progress; `pauseState` says "requested" or "paused".
 * Due dates never change. Each write is a conditional update, so two clicks cannot both win.
 */

const idOf = (v) => (v?._id || v || '').toString();
const userIdOf = (user) => idOf(user?._id || user?.userId || user?.id);

function fail(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details) error.details = details;
  return error;
}

/** The step can be paused or decided: In Progress, unlocked, not paused by a reopened step. */
const WORKABLE = { status: 'In Progress', isLocked: { $ne: true }, $or: [{ pausedBy: { $exists: false } }, { pausedBy: { $size: 0 } }] };

function assertWorkable(step) {
  if (step.status !== 'In Progress') {
    throw fail(409, 'STEP_NOT_IN_PROGRESS', 'A pause can only be asked for, or decided, while the step is In Progress.');
  }
  if (step.isLocked || (Array.isArray(step.pausedBy) && step.pausedBy.length)) {
    throw fail(409, 'STEP_LOCKED', 'This step is locked or paused while an earlier step is redone.');
  }
}

async function loadStep(id) {
  if (!mongoose.isValidObjectId(id)) throw fail(404, 'NOT_FOUND', 'Work item not found');
  const step = await WorkItem.findById(id);
  if (!step) throw fail(404, 'NOT_FOUND', 'Work item not found');
  return step;
}

const currentRoundIndex = (step) => (Array.isArray(step.rounds) && step.rounds.length ? step.rounds.length - 1 : -1);

/** The step calendar's posters (default: every active SM Manager). */
async function smManagers(step) {
  return (await access.postersFor(step)).people;
}

async function notifyAll(people, payload, exceptId) {
  const seen = new Set();
  for (const p of people) {
    const id = idOf(p._id || p);
    if (!id || seen.has(id) || id === exceptId) continue;
    seen.add(id);
    await createNotification({ recipient: id, ...payload });
  }
}

const reasonText = (r) => `${PAUSE_REASON_LABELS[r.reason] || r.reason}: ${r.note}`;

function logPause(step, user, action, metadata) {
  return logActivity({ entityType: 'work_item', entityId: step._id, actor: user, action: `work_item.${action}`, metadata });
}

/** Thrown while a step is paused: resume first. */
export function assertNotManuallyPaused(step) {
  if (step?.pauseState === 'paused') {
    throw fail(409, 'STEP_MANUALLY_PAUSED', 'This step is paused. Resume it first.');
  }
}

// ---------------------------------------------------------------- request / cancel

export async function requestPause(id, body = {}, user) {
  const step = await loadStep(id);
  const userId = userIdOf(user);
  if (idOf(step.ownerId) !== userId) throw fail(403, 'FORBIDDEN_NOT_OWNER', 'Only the step owner can ask to pause it.');
  assertWorkable(step);
  if (step.pauseState === 'requested') throw fail(409, 'PAUSE_ALREADY_REQUESTED', 'A pause request is already waiting for this step.');
  if (step.pauseState === 'paused') throw fail(409, 'STEP_MANUALLY_PAUSED', 'This step is already paused.');

  const reason = String(body.reason || '');
  if (!PAUSE_REASONS.includes(reason)) throw fail(400, 'INVALID_REASON', 'Choose a reason: Urgent task or Other.', { field: 'reason' });
  const note = String(body.note || '').trim();
  if (!note) throw fail(400, 'NOTE_REQUIRED', 'Add a short note for the lead.', { field: 'note' });
  if (note.length > PAUSE_NOTE_MAX) throw fail(400, 'NOTE_TOO_LONG', `Keep the note under ${PAUSE_NOTE_MAX} characters.`, { field: 'note' });

  let urgentStepId = null;
  if (body.urgentStepId) {
    if (reason !== 'urgent_task') throw fail(400, 'INVALID_URGENT_STEP', 'An urgent step goes with the reason "Urgent task".', { field: 'urgentStepId' });
    if (!mongoose.isValidObjectId(body.urgentStepId) || String(body.urgentStepId) === String(step._id)) {
      throw fail(400, 'INVALID_URGENT_STEP', 'Pick another of your open steps.', { field: 'urgentStepId' });
    }
    const urgent = await WorkItem.findById(body.urgentStepId).select('ownerId status isSkipped').lean();
    if (!urgent || idOf(urgent.ownerId) !== userId || ['Approved', 'Published'].includes(urgent.status) || urgent.isSkipped) {
      throw fail(400, 'INVALID_URGENT_STEP', 'The urgent step must be one of your own open steps.', { field: 'urgentStepId' });
    }
    urgentStepId = urgent._id;
  }

  let pauseUntil = null;
  if (body.pauseUntil) {
    const key = /^\d{4}-\d{2}-\d{2}$/.test(String(body.pauseUntil)) ? String(body.pauseUntil) : istDateKey(body.pauseUntil);
    if (!key || key <= istDateKey(new Date())) throw fail(400, 'INVALID_PAUSE_UNTIL', '"Pause until" must be a future date.', { field: 'pauseUntil' });
    pauseUntil = key;
  }

  // Claim the step first: only one request at a time, and only while it can be paused.
  const claimed = await WorkItem.findOneAndUpdate(
    { _id: step._id, ownerId: step.ownerId, pauseState: null, ...WORKABLE },
    { $set: { pauseState: 'requested' } },
    { new: true }
  );
  if (!claimed) throw fail(409, 'PAUSE_NOT_POSSIBLE', 'This step cannot be paused right now. Refresh and try again.');
  let request;
  try {
    request = await PauseRequest.create({ workItemId: step._id, ownerId: step.ownerId, reason, note, urgentStepId, pauseUntil });
  } catch (err) {
    await WorkItem.updateOne({ _id: step._id, pauseState: 'requested' }, { $set: { pauseState: null } });
    if (err?.code === 11000) throw fail(409, 'PAUSE_ALREADY_REQUESTED', 'A pause request is already waiting for this step.');
    throw err;
  }

  await logPause(step, user, 'pause_requested', { requestId: request._id, reason, note, urgentStepId, pauseUntil });
  await notifyAll(
    await decidersFor(calendarOf(step)),
    {
      type: 'pause_requested',
      title: 'Pause requested',
      message: `${user.name || 'A worker'} asks to pause "${step.title}". ${reasonText(request)}`,
      link: `/work/${step._id}`,
      metadata: { workItemId: step._id, pauseRequestId: request._id },
    },
    userId
  );
  return request.toObject();
}

export async function cancelPauseRequest(id, user, { reason = 'cancelled_by_owner' } = {}) {
  const step = await loadStep(id);
  if (idOf(step.ownerId) !== userIdOf(user)) throw fail(403, 'FORBIDDEN_NOT_OWNER', 'Only the step owner can cancel the request.');
  const request = await PauseRequest.findOneAndUpdate(
    { workItemId: step._id, status: 'pending' },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason } },
    { new: true }
  );
  if (!request) throw fail(409, 'NOT_PENDING', 'There is no pause request waiting for this step.');
  await WorkItem.updateOne({ _id: step._id, pauseState: 'requested' }, { $set: { pauseState: null } });
  await logPause(step, user, 'pause_cancelled', { requestId: request._id, cancelReason: reason });
  return request.toObject();
}

/**
 * Submitting withdraws a pending request. Call before the step is saved: the request's
 * "requested" state is cleared in that same step write. Returns true when there was one.
 */
export function clearRequestOnSubmit(step) {
  if (step?.pauseState !== 'requested') return false;
  step.pauseState = null;
  return true;
}

/** After the submit is saved: close the request record, log it and tell the lead it was withdrawn. */
export async function finishRequestOnSubmit(step, user) {
  const request = await PauseRequest.findOneAndUpdate(
    { workItemId: step._id, status: 'pending' },
    { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'cancelled_on_submit' } },
    { new: true }
  );
  if (!request) return null;
  await logPause(step, user, 'pause_cancelled', { requestId: request._id, cancelReason: 'cancelled_on_submit' });
  await notifyAll(
    await decidersFor(calendarOf(step)),
    {
      type: 'pause_withdrawn',
      title: 'Pause request withdrawn',
      message: `"${step.title}" was submitted, so its pause request was withdrawn.`,
      link: `/work/${step._id}`,
      metadata: { workItemId: step._id, pauseRequestId: request._id },
    },
    userIdOf(user)
  );
  return request;
}

// ---------------------------------------------------------------- decide

export async function decidePauseRequest(id, body = {}, user) {
  const step = await loadStep(id);
  // The lead of the step's calendar (or admin); the other lead gets WRONG_CALENDAR.
  await assertDecidesOn(user, calendarOf(step), { roleCode: 'FORBIDDEN_ACTION', roleMessage: 'Only the step\'s lead or an Admin can decide a pause request.' });
  const request = await PauseRequest.findOne({ workItemId: step._id, status: 'pending' });
  if (!request) throw fail(409, 'NOT_PENDING', 'There is no pause request waiting for this step.');
  if (idOf(request.ownerId) === userIdOf(user) || idOf(step.ownerId) === userIdOf(user)) {
    throw fail(403, 'FORBIDDEN_SELF_DECISION', 'Nobody decides their own pause request.');
  }
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'reject') throw fail(400, 'INVALID_DECISION', 'Decide approve or reject.');
  const message = String(body.message || '').trim().slice(0, PAUSE_NOTE_MAX);
  // Re-checked now: the step may have been submitted or blocked since the request.
  assertWorkable(step);
  const now = new Date();

  if (decision === 'reject') {
    const done = await PauseRequest.findOneAndUpdate(
      { _id: request._id, status: 'pending' },
      { $set: { status: 'rejected', decidedById: userIdOf(user), decidedAt: now, decisionMessage: message } },
      { new: true }
    );
    if (!done) throw fail(409, 'NOT_PENDING', 'This request was already decided or cancelled.');
    await WorkItem.updateOne({ _id: step._id, pauseState: 'requested' }, { $set: { pauseState: null } });
    await logPause(step, user, 'pause_rejected', { requestId: request._id, message });
    await createNotification({
      recipient: request.ownerId,
      type: 'pause_rejected',
      title: 'Pause not approved',
      message: `Your request to pause "${step.title}" was not approved${message ? `: ${message}` : '.'} The step stays In Progress.`,
      link: `/work/${step._id}`,
      metadata: { workItemId: step._id, pauseRequestId: request._id },
    });
    return done.toObject();
  }

  // Approve: open the manual pause on the step (and its current round) only if it is still workable.
  const interval = { kind: 'manual_pause', startedAt: now, endedAt: null, reason: request.reason, note: request.note };
  const r = currentRoundIndex(step);
  const push = { intervals: interval };
  const cond = { _id: step._id, pauseState: 'requested', ...WORKABLE };
  if (r >= 0) {
    push[`rounds.${r}.intervals`] = { ...interval };
    cond[`rounds.${r}`] = { $exists: true };
    cond[`rounds.${r + 1}`] = { $exists: false };
  }
  const paused = await WorkItem.findOneAndUpdate(cond, { $set: { pauseState: 'paused' }, $push: push }, { new: true });
  if (!paused) throw fail(409, 'STEP_NOT_IN_PROGRESS', 'The step changed before the decision. It is no longer In Progress.');
  const done = await PauseRequest.findOneAndUpdate(
    { _id: request._id, status: 'pending' },
    { $set: { status: 'approved', decidedById: userIdOf(user), decidedAt: now, decisionMessage: message } },
    { new: true }
  );
  if (!done) {
    // Cancelled in the same moment: undo the pause just opened.
    await WorkItem.updateOne(
      { _id: step._id },
      { $set: { pauseState: null }, $pull: { intervals: { kind: 'manual_pause', startedAt: now }, ...(r >= 0 ? { [`rounds.${r}.intervals`]: { kind: 'manual_pause', startedAt: now } } : {}) } }
    );
    throw fail(409, 'NOT_PENDING', 'This request was cancelled before the decision.');
  }
  await logPause(step, user, 'pause_approved', { requestId: request._id, message, pausedAt: now });
  const payload = {
    type: 'pause_approved',
    title: 'Step paused',
    link: `/work/${step._id}`,
    metadata: { workItemId: step._id, pauseRequestId: request._id },
  };
  await createNotification({
    recipient: request.ownerId,
    ...payload,
    message: `Your pause of "${step.title}" was approved. Work time stops until you resume.${message ? ` ${message}` : ''}`,
  });
  const owner = await Person.findById(request.ownerId).select('name').lean();
  await notifyAll(await smManagers(step), { ...payload, message: `"${step.title}" (${owner?.name || 'owner'}) is paused. ${reasonText(request)}` }, userIdOf(user));
  return done.toObject();
}

// ---------------------------------------------------------------- resume

export async function canResume(user, step) {
  if (isReadOnly(user)) return false;
  if (idOf(step.ownerId) === userIdOf(user)) return true;
  return access.can(user, 'review.decide', { calendar: calendarOf(step) });
}

export async function resumeStep(id, user) {
  const step = await loadStep(id);
  if (!(await canResume(user, step))) throw fail(403, 'FORBIDDEN_ACTION', 'Only the owner, the step\'s lead or an Admin can resume it.');
  if (step.pauseState !== 'paused') throw fail(409, 'NOT_PAUSED', 'This step is not paused.');
  const now = new Date();
  const resumed = await WorkItem.findOneAndUpdate(
    { _id: step._id, pauseState: 'paused' },
    {
      $set: {
        pauseState: null,
        'intervals.$[iv].endedAt': now,
        'rounds.$[].intervals.$[riv].endedAt': now,
      },
    },
    { new: true, arrayFilters: [{ 'iv.kind': 'manual_pause', 'iv.endedAt': null }, { 'riv.kind': 'manual_pause', 'riv.endedAt': null }] }
  );
  if (!resumed) throw fail(409, 'NOT_PAUSED', 'This step is not paused.');
  const request = await PauseRequest.findOneAndUpdate(
    { workItemId: step._id, status: 'approved' },
    { $set: { status: 'resumed', resumedById: userIdOf(user), resumedAt: now } },
    { new: true, sort: { decidedAt: -1 } }
  );
  await logPause(step, user, 'pause_resumed', { requestId: request?._id || null, resumedAt: now });
  const leads = await decidersFor(calendarOf(step));
  await notifyAll([...leads, ...(await smManagers(step))], {
    type: 'pause_resumed',
    title: 'Step resumed',
    message: `"${step.title}" is back In Progress.`,
    link: `/work/${step._id}`,
    metadata: { workItemId: step._id, pauseRequestId: request?._id || null },
  }, userIdOf(user));
  return { pauseState: null, resumedAt: now };
}

// ---------------------------------------------------------------- reads

/** Work Detail and My Work: the step's pause state, request, numbers and what this user may do. */
export async function pauseInfoFor(step, user) {
  const requests = await PauseRequest.find({ workItemId: step._id }).sort({ requestedAt: -1 }).populate('urgentStepId', 'title').lean();
  const pending = requests.find((r) => r.status === 'pending') || null;
  const active = step.pauseState === 'paused' ? requests.find((r) => r.status === 'approved') || null : null;
  const manual = (step.intervals || []).filter((iv) => iv && iv.kind === 'manual_pause' && iv.startedAt);
  const totalMs = manual.reduce((sum, iv) => sum + Math.max(0, new Date(iv.endedAt || Date.now()) - new Date(iv.startedAt)), 0);
  const isOwner = idOf(step.ownerId) === userIdOf(user);
  const role = normalizeRole(user?.role);
  const view = (r) =>
    r && {
      _id: String(r._id),
      reason: r.reason,
      reasonLabel: PAUSE_REASON_LABELS[r.reason] || r.reason,
      note: r.note,
      urgentStep: r.urgentStepId ? { _id: String(r.urgentStepId._id || r.urgentStepId), title: r.urgentStepId.title || '' } : null,
      pauseUntil: r.pauseUntil,
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
      decisionMessage: r.decisionMessage || '',
    };
  const lastRejected = requests.find((r) => r.status === 'rejected') || null;
  return {
    state: step.pauseState || null,
    request: view(pending),
    active: view(active),
    lastRejected: lastRejected && !pending && !active ? view(lastRejected) : null,
    count: manual.length,
    totalMs,
    canRequest: isOwner && !isReadOnly(user) && !step.pauseState && step.status === 'In Progress' && !step.isLocked && !(step.pausedBy || []).length,
    canCancel: isOwner && Boolean(pending),
    canDecide: Boolean(pending) && !isOwner && (await access.can(user, 'review.decide', { calendar: calendarOf(step) })) && idOf(pending?.ownerId) !== userIdOf(user),
    canResume: step.pauseState === 'paused' && (await canResume(user, step)),
  };
}

/** The lead's queue: pending requests on the calendars they decide (admin and read-only heads see all). */
export async function listPauseRequests(user, { status = 'pending' } = {}) {
  const role = normalizeRole(user?.role);
  const pending = await PauseRequest.find({ status })
    .sort({ requestedAt: 1 })
    .populate('ownerId', 'name')
    .populate('urgentStepId', 'title')
    .populate('workItemId', 'title stageKey status calendar ownerId deadline isLocked')
    .lean();
  const configs = await access.getAllWorkflowConfigs();
  const calendars = await decisionCalendarFilter(user);
  if (!calendars && !hasPermission(user, 'review.decide') && !isReadOnly(user)) {
    // Others (SM Manager, workers): their own requests only.
    return pending.filter((r) => idOf(r.ownerId) === userIdOf(user)).map((r) => itemView(r, user, configs));
  }
  return pending
    .filter((r) => r.workItemId && (!calendars || calendars.includes(calendarOf(r.workItemId))))
    .map((r) => itemView(r, user, configs));
}

function itemView(r, user, configs) {
  const step = r.workItemId || {};
  return {
    _id: String(r._id),
    workItem: { _id: String(step._id || ''), title: step.title || '', stageKey: step.stageKey, status: step.status, calendar: calendarOf(step) },
    owner: { _id: idOf(r.ownerId), name: r.ownerId?.name || '' },
    reason: r.reason,
    reasonLabel: PAUSE_REASON_LABELS[r.reason] || r.reason,
    note: r.note,
    urgentStep: r.urgentStepId ? { _id: idOf(r.urgentStepId), title: r.urgentStepId.title || '' } : null,
    pauseUntil: r.pauseUntil,
    requestedAt: r.requestedAt,
    canDecide: canPure(user, 'review.decide', { calendar: calendarOf(step) }, configs[calendarOf(step)]) && idOf(r.ownerId) !== userIdOf(user),
  };
}

// ---------------------------------------------------------------- hooks

/**
 * After steps change owner: a pending request from the old owner is cancelled and they are
 * told. A paused step stays paused; the new owner can resume it.
 */
export async function afterOwnerChange(workItemIds, actor) {
  const ids = (workItemIds || []).filter(Boolean);
  if (!ids.length) return 0;
  const pending = await PauseRequest.find({ workItemId: { $in: ids }, status: 'pending' }).lean();
  let cancelled = 0;
  for (const r of pending) {
    const step = await WorkItem.findById(r.workItemId).select('ownerId title').lean();
    if (!step || idOf(step.ownerId) === idOf(r.ownerId)) continue;
    const done = await PauseRequest.findOneAndUpdate(
      { _id: r._id, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'reassigned' } }
    );
    if (!done) continue;
    cancelled++;
    await WorkItem.updateOne({ _id: r.workItemId, pauseState: 'requested' }, { $set: { pauseState: null } });
    await logActivity({ entityType: 'work_item', entityId: r.workItemId, actor, action: 'work_item.pause_cancelled', metadata: { requestId: r._id, cancelReason: 'reassigned' } });
    await createNotification({
      recipient: r.ownerId,
      type: 'pause_cancelled',
      title: 'Pause request cancelled',
      message: `"${step.title}" was reassigned, so your pause request was cancelled.`,
      link: `/work/${r.workItemId}`,
      metadata: { workItemId: r.workItemId, pauseRequestId: r._id },
    });
  }
  return cancelled;
}

/** After a plan moves calendar: pending requests now belong to the new calendar's lead. */
export async function afterCalendarMove(workItemIds) {
  const pending = await PauseRequest.find({ workItemId: { $in: workItemIds }, status: 'pending' }).lean();
  for (const r of pending) {
    const step = await WorkItem.findById(r.workItemId).select('title calendar').lean();
    if (!step) continue;
    await notifyAll(await decidersFor(calendarOf(step)), {
      type: 'pause_requested',
      title: 'Pause request moved to you',
      message: `"${step.title}" moved calendar; its pause request now waits for your decision. ${reasonText(r)}`,
      link: `/work/${r.workItemId}`,
      metadata: { workItemId: r.workItemId, pauseRequestId: r._id },
    });
  }
  return pending.length;
}

// ---------------------------------------------------------------- reminders

/**
 * Hourly scan (worker; BullMQ or its in-memory fallback). On a working day (IST, Mon–Sat)
 * from 09:00: one reminder to the lead(s) for a request still undecided since an earlier
 * working day, and one reminder to the worker on the morning of their "pause until" date.
 */
/**
 * Every hourly run: a request still pending on a step that is no longer In Progress (submitted,
 * posted, blocked, finished; for example one left behind before submitting withdrew requests)
 * is cancelled as "cancelled_on_submit", logged on the step, and the lead is told once.
 */
export async function cancelStalePauseRequests() {
  let cancelled = 0;
  for (const r of await PauseRequest.find({ status: 'pending' }).lean()) {
    const step = await WorkItem.findById(r.workItemId).select('title status calendar pauseState').lean();
    if (step && step.status === 'In Progress') continue;
    const done = await PauseRequest.findOneAndUpdate(
      { _id: r._id, status: 'pending' },
      { $set: { status: 'cancelled', cancelledAt: new Date(), cancelReason: 'cancelled_on_submit' } },
      { new: true }
    );
    if (!done) continue;
    cancelled++;
    if (!step) continue;
    await WorkItem.updateOne({ _id: step._id, pauseState: 'requested' }, { $set: { pauseState: null } });
    // The owner's submit (or other move) is what ended it; the hourly job only tidied up.
    await logActivity({
      entityType: 'work_item',
      entityId: step._id,
      actor: { _id: r.ownerId },
      action: 'work_item.pause_cancelled',
      metadata: { requestId: r._id, cancelReason: 'cancelled_on_submit', by: 'pause_reminders', stepStatus: step.status },
    });
    await notifyAll(await decidersFor(calendarOf(step)), {
      type: 'pause_withdrawn',
      title: 'Pause request withdrawn',
      message: `"${step.title}" is no longer In Progress (${step.status}), so its pause request was withdrawn.`,
      link: `/work/${step._id}`,
      metadata: { workItemId: step._id, pauseRequestId: r._id },
    }, idOf(r.ownerId));
  }
  if (cancelled) logger.info({ cancelled }, 'Stale pause requests cancelled');
  return cancelled;
}

export async function runPauseReminders(now = new Date()) {
  const today = istDateKey(now);
  // Tidy-up runs every hour; reminders only on working days from 09:00 IST.
  const staleCancelled = await cancelStalePauseRequests();
  if (!isWorkingDayIST(now) || istHour(now) < REMINDER_HOUR_IST) {
    return { summary: `Not a reminder time (working days from 09:00 IST). Cancelled ${staleCancelled} stale requests.`, leadReminders: 0, untilReminders: 0, staleCancelled };
  }
  let leadReminders = 0;
  for (const r of await PauseRequest.find({ status: 'pending', leadRemindedAt: null }).lean()) {
    const due = nextWorkingDayKeyIST(r.requestedAt);
    if (!due || today < due) continue;
    const claimed = await PauseRequest.findOneAndUpdate({ _id: r._id, status: 'pending', leadRemindedAt: null }, { $set: { leadRemindedAt: now } });
    if (!claimed) continue;
    const step = await WorkItem.findById(r.workItemId).select('title calendar').lean();
    if (!step) continue;
    await notifyAll(await decidersFor(calendarOf(step)), {
      type: 'pause_request_reminder',
      title: 'Pause request waiting',
      message: `A pause request for "${step.title}" is still waiting for your decision. ${reasonText(r)}`,
      link: `/work/${r.workItemId}`,
      metadata: { workItemId: r.workItemId, pauseRequestId: r._id },
    }, idOf(r.ownerId));
    leadReminders++;
  }
  let untilReminders = 0;
  for (const r of await PauseRequest.find({ status: 'approved', pauseUntil: { $ne: null, $lte: today }, untilRemindedAt: null }).lean()) {
    const claimed = await PauseRequest.findOneAndUpdate({ _id: r._id, status: 'approved', untilRemindedAt: null }, { $set: { untilRemindedAt: now } });
    if (!claimed) continue;
    const step = await WorkItem.findById(r.workItemId).select('title ownerId pauseState').lean();
    if (!step || step.pauseState !== 'paused') continue;
    await createNotification({
      recipient: step.ownerId,
      type: 'pause_until_reminder',
      title: 'Time to resume?',
      message: `You planned to resume "${step.title}" today. It stays paused until you resume it.`,
      link: `/work/${r.workItemId}`,
      metadata: { workItemId: r.workItemId, pauseRequestId: r._id },
    });
    untilReminders++;
  }
  if (leadReminders || untilReminders) logger.info({ leadReminders, untilReminders }, 'Pause reminders sent');
  return {
    summary: `Sent ${leadReminders} lead reminders and ${untilReminders} resume reminders; cancelled ${staleCancelled} stale requests.`,
    leadReminders,
    untilReminders,
    staleCancelled,
    affectedCount: leadReminders + untilReminders + staleCancelled,
  };
}
