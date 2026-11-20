import mongoose from 'mongoose';
import {
  HELP_MESSAGE_MAX,
  HELP_REPLY_MAX,
  HELP_TOPICS,
  HELP_TOPIC_LABELS,
  isApprover,
  isHttpsUrl,
  isReadOnlyViewer,
  isWorker,
  normalizeRole,
} from '@mmp/shared';
import { WorkItem } from './model.js';
import { HelpRequest } from './helpRequest.model.js';
import { calendarOf, decidersFor } from './deciders.js';
import { Person } from '../people/model.js';
import { logActivity } from '../activity/service.js';
import { createNotification } from '../notifications/service.js';
import * as access from '../../lib/accessResolver.js';
import { handlesDeliverables, isOwnScope, isReadOnly } from '../../lib/roleAccess.js';

/**
 * Help requests on a step. The step owner asks one person (the deciding lead by default,
 * an SM Manager, or the owner of another step on the same piece); that person is notified
 * once. The asker, the helper, both leads, admin and SM Managers reply and resolve; the
 * read-only heads only read (their writes are refused by auth); any other worker gets 404.
 * Nothing here writes the step, so a request never pauses or blocks it and never changes
 * work time or KPIs.
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
const notFound = () => fail(404, 'NOT_FOUND', 'Not found');

const STAGE_NAME = { Content: 'Content', Script: 'Script', Shoot: 'Shoot', Edit: 'Edit', Design: 'Design', Post: 'Posting' };
const FINISHED = ['Approved', 'Published'];

async function loadStep(id) {
  if (!mongoose.isValidObjectId(id)) throw notFound();
  const step = await WorkItem.findById(id).select('title ownerId contentPieceId calendar status isSkipped stageKey').lean();
  if (!step) throw notFound();
  return step;
}

/** Leadership roles that can reply to and resolve any help request (read-only heads cannot write). */
const isHelpManager = (role) => handlesDeliverables(role);

/** The people the owner can ask, in order: the deciding lead(s), SM Managers, other step owners on the piece. */
export async function helpOptionsFor(step) {
  const askerId = idOf(step.ownerId);
  const seen = new Set([askerId]);
  const options = [];
  const push = (kind, person, label) => {
    const id = idOf(person?._id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    options.push({ kind, personId: id, name: person.name || '', label });
  };
  for (const p of await decidersFor(calendarOf(step))) push('lead', p, `${p.name} (lead for this step)`);
  const sms = [...(await access.postersFor(step)).people].sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  for (const p of sms) push('sm_manager', p, `${p.name} (SM Manager)`);
  if (step.contentPieceId) {
    const siblings = await WorkItem.find({ contentPieceId: step.contentPieceId, _id: { $ne: step._id }, ownerId: { $ne: null }, isSkipped: { $ne: true } })
      .select('stageKey stageOrder ownerId')
      .sort({ stageOrder: 1 })
      .populate('ownerId', 'name status')
      .lean();
    for (const s of siblings) {
      if (!s.ownerId || s.ownerId.status === 'suspended') continue;
      push('step_owner', s.ownerId, `${s.ownerId.name} (${STAGE_NAME[s.stageKey] || s.stageKey} step)`);
    }
  }
  return options;
}

/** The viewer's access to the help requests of a step: 'manage', 'view', or a worker's own share. */
function accessOf(step, user) {
  const role = normalizeRole(user?.role);
  const me = userIdOf(user);
  if (isOwnScope(role)) return { kind: 'worker', me, isAsker: idOf(step.ownerId) === me };
  if (isReadOnly(role)) return { kind: 'view', me };
  if (isHelpManager(role)) return { kind: 'manage', me };
  return { kind: 'none', me };
}

const canWrite = (r, access) =>
  access.kind === 'manage' || (access.kind === 'worker' && (idOf(r.askerId) === access.me || idOf(r.helperId) === access.me));

/** A worker sees a step's requests only as the asker, or the requests sent to them. */
function visibleTo(r, access) {
  if (access.kind === 'manage' || access.kind === 'view') return true;
  if (access.kind === 'worker') return access.isAsker || idOf(r.helperId) === access.me;
  return false;
}

function view(r, access) {
  const person = (p) => (p && typeof p === 'object' ? { _id: idOf(p._id), name: p.name || '' } : { _id: idOf(p), name: '' });
  const write = canWrite(r, access) && r.status === 'open';
  return {
    _id: String(r._id),
    workItemId: String(r.workItemId),
    topic: r.topic,
    topicLabel: HELP_TOPIC_LABELS[r.topic] || r.topic,
    message: r.message,
    link: r.link || '',
    status: r.status,
    asker: person(r.askerId),
    helper: { ...person(r.helperId), kind: r.helperKind },
    createdAt: r.createdAt,
    replies: (r.replies || []).map((x) => ({ _id: String(x._id), author: person(x.authorId), text: x.text, at: x.at })),
    resolvedBy: r.resolvedById ? person(r.resolvedById) : null,
    resolvedAt: r.resolvedAt || null,
    canReply: write,
    canResolve: write,
  };
}

const populated = (q) => q.populate('askerId', 'name').populate('helperId', 'name').populate('replies.authorId', 'name').populate('resolvedById', 'name');

// ---------------------------------------------------------------- reads

/** Work Detail: the step's help requests this viewer may see, and whether (and whom) they can ask. */
export async function listHelpRequests(id, user) {
  const step = await loadStep(id);
  const access = accessOf(step, user);
  if (access.kind === 'none') throw notFound();
  const all = await populated(HelpRequest.find({ workItemId: step._id }).sort({ createdAt: -1 })).lean();
  const mine = all.filter((r) => visibleTo(r, access));
  // A worker with no share in the step's help requests gets the same 404 as anyone else.
  if (access.kind === 'worker' && !access.isAsker && mine.length === 0) throw notFound();
  const canAsk = access.kind === 'worker' && access.isAsker && !FINISHED.includes(step.status) && !step.isSkipped;
  const options = canAsk ? await helpOptionsFor(step) : [];
  return {
    open: mine.filter((r) => r.status === 'open').map((r) => view(r, access)),
    resolved: mine.filter((r) => r.status === 'resolved').map((r) => view(r, access)),
    openCount: mine.filter((r) => r.status === 'open').length,
    canAsk,
    options,
    defaultHelperId: options.find((o) => o.kind === 'lead')?.personId || options[0]?.personId || null,
  };
}

/** Open help requests per step id (Tracker chips, Review Hub). Counts only, no text. */
export async function openHelpCounts(stepIds) {
  const ids = (stepIds || []).filter((x) => mongoose.isValidObjectId(String(x))).map((x) => new mongoose.Types.ObjectId(String(x)));
  if (!ids.length) return new Map();
  const rows = await HelpRequest.aggregate([{ $match: { workItemId: { $in: ids }, status: 'open' } }, { $group: { _id: '$workItemId', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

// ---------------------------------------------------------------- writes

export async function createHelpRequest(id, body = {}, user) {
  const step = await loadStep(id);
  const me = userIdOf(user);
  if (idOf(step.ownerId) !== me) {
    // Another worker on the piece learns nothing; leadership is told why.
    if (isOwnScope(user)) throw notFound();
    throw fail(403, 'FORBIDDEN_NOT_OWNER', 'Only the step owner can ask for help on it.');
  }
  if (FINISHED.includes(step.status) || step.isSkipped) throw fail(409, 'STEP_FINISHED', 'This step is finished, so help cannot be asked on it.');

  const topic = String(body.topic || '');
  if (!HELP_TOPICS.includes(topic)) throw fail(400, 'INVALID_TOPIC', 'Choose a topic.', { field: 'topic' });
  const message = String(body.message || '').trim();
  if (!message) throw fail(400, 'MESSAGE_REQUIRED', 'Write what you need help with.', { field: 'message' });
  if (message.length > HELP_MESSAGE_MAX) throw fail(400, 'MESSAGE_TOO_LONG', `Keep the message under ${HELP_MESSAGE_MAX} characters.`, { field: 'message' });
  const link = String(body.link || '').trim();
  if (link && !isHttpsUrl(link)) throw fail(400, 'INVALID_LINK', 'The link must start with https://', { field: 'link' });

  const options = await helpOptionsFor(step);
  const choice = options.find((o) => o.personId === String(body.helperId || ''));
  if (!choice) throw fail(400, 'INVALID_HELPER', 'Choose who should help from the list.', { field: 'helperId' });

  const request = await HelpRequest.create({
    workItemId: step._id,
    contentPieceId: step.contentPieceId || null,
    askerId: me,
    helperId: choice.personId,
    helperKind: choice.kind,
    topic,
    message,
    link,
  });
  await logActivity({ entityType: 'work_item', entityId: step._id, actor: user, action: 'work_item.help_requested', metadata: { helpRequestId: request._id, topic, helperId: choice.personId } });
  await createNotification({
    recipient: choice.personId,
    type: 'help_requested',
    title: 'Help requested',
    message: `${user?.name || 'A teammate'} asks for help on "${step.title}" (${HELP_TOPIC_LABELS[topic]}): ${message.slice(0, 160)}${message.length > 160 ? '…' : ''}`,
    link: `/work/${step._id}#help`,
    metadata: { workItemId: step._id, helpRequestId: request._id },
  });
  return view(await populated(HelpRequest.findById(request._id)).lean(), accessOf(step, user));
}

/** Loads a request on this step for a write, with the same 404 for workers who have no share in it. */
async function loadForWrite(id, helpId, user) {
  const step = await loadStep(id);
  if (!mongoose.isValidObjectId(helpId)) throw notFound();
  const r = await HelpRequest.findOne({ _id: helpId, workItemId: step._id }).lean();
  if (!r) throw notFound();
  const access = accessOf(step, user);
  if (!visibleTo(r, access)) throw notFound();
  if (!canWrite(r, access)) throw fail(403, 'FORBIDDEN_HELP', 'Only the person who asked, the person asked, a lead, an SM Manager or an Admin can do this.');
  if (r.status !== 'open') throw fail(409, 'HELP_RESOLVED', 'This help request is already resolved.');
  return { step, r, access };
}

/** Tell the asker and the helper (never the person acting). */
async function notifyParties(r, user, payload) {
  const me = userIdOf(user);
  for (const to of new Set([idOf(r.askerId), idOf(r.helperId)])) {
    if (to && to !== me) await createNotification({ recipient: to, ...payload });
  }
}

export async function replyToHelpRequest(id, helpId, body = {}, user) {
  const { step, r, access } = await loadForWrite(id, helpId, user);
  const text = String(body.text || '').trim();
  if (!text) throw fail(400, 'REPLY_REQUIRED', 'Write a reply.', { field: 'text' });
  if (text.length > HELP_REPLY_MAX) throw fail(400, 'REPLY_TOO_LONG', `Keep the reply under ${HELP_REPLY_MAX} characters.`, { field: 'text' });
  const updated = await HelpRequest.findOneAndUpdate(
    { _id: r._id, status: 'open' },
    { $push: { replies: { authorId: userIdOf(user), text, at: new Date() } } },
    { new: true }
  );
  if (!updated) throw fail(409, 'HELP_RESOLVED', 'This help request is already resolved.');
  await notifyParties(r, user, {
    type: 'help_reply',
    title: 'New reply on a help request',
    message: `${user?.name || 'A teammate'} replied on "${step.title}": ${text.slice(0, 160)}${text.length > 160 ? '…' : ''}`,
    link: `/work/${step._id}#help`,
    metadata: { workItemId: step._id, helpRequestId: r._id },
  });
  return view(await populated(HelpRequest.findById(r._id)).lean(), access);
}

export async function resolveHelpRequest(id, helpId, user) {
  const { step, r, access } = await loadForWrite(id, helpId, user);
  const updated = await HelpRequest.findOneAndUpdate(
    { _id: r._id, status: 'open' },
    { $set: { status: 'resolved', resolvedById: userIdOf(user), resolvedAt: new Date() } },
    { new: true }
  );
  if (!updated) throw fail(409, 'HELP_RESOLVED', 'This help request is already resolved.');
  await logActivity({ entityType: 'work_item', entityId: step._id, actor: user, action: 'work_item.help_resolved', metadata: { helpRequestId: r._id } });
  await notifyParties(r, user, {
    type: 'help_resolved',
    title: 'Help request resolved',
    message: `${user?.name || 'A teammate'} marked the help request on "${step.title}" resolved.`,
    link: `/work/${step._id}#help`,
    metadata: { workItemId: step._id, helpRequestId: r._id },
  });
  return view(await populated(HelpRequest.findById(r._id)).lean(), access);
}
