import mongoose from 'mongoose';
import {
  HELP_TOPIC_LABELS,
  PAUSE_REASON_LABELS,
  canDecide,
  canSeeAllReviewText,
  decisionCalendarsFor,
  getStepStatusLabel,
  isApprover,
  isReadOnlyViewer,
  isWorker,
  normalizeRole,
  stepReviewState,
} from '@mmp/shared';
import { WorkItem } from '../workItems/model.js';
import { Submission, Rating } from '../submissions/model.js';
import { RevisionFlag, FeedbackEntry } from '../feedback/model.js';
import { ActivityEvent } from '../activity/model.js';
import { PauseRequest } from '../workItems/pauseRequest.model.js';
import { HelpRequest } from '../workItems/helpRequest.model.js';
import { CalendarPlan } from '../calendar/plan.model.js';
import { ContentPiece } from '../calendar/contentPiece.model.js';
import { calendarOf, calendarQueryFor, canDecideOn } from '../workItems/deciders.js';
import { attachTimeLabels } from '../workItems/timeLabels.js';
import { outputItems } from '../workItems/handoff.js';
import { listPauseRequests } from '../workItems/pause.service.js';
import * as access from '../../lib/accessResolver.js';
import { hasPermission, isOwnScope, isReadOnly, isSuperuser } from '../../lib/roleAccess.js';

/**
 * Review Hub: an inbox and a history of review rounds, read from the real records (versions,
 * rounds, ratings, revision flags, pause requests, activity events; old Feedback-page entries
 * as "Earlier note"). Leads see the calendars they decide, admin and the read-only heads see
 * everything (the heads without actions), workers see only their own steps. Read-only.
 */

const idOf = (v) => (v?._id || v || '').toString();
const userIdOf = (u) => idOf(u?._id || u?.userId || u?.id);

/** "1 revision" / "2 revisions". */
export const revisionsLabel = (n) => `${n || 0} ${n === 1 ? 'revision' : 'revisions'}`;

export const LEAD_TABS = ['waiting', 'changes', 'pauses', 'plans', 'flagged', 'history'];
export const WORKER_TABS = ['needs_action', 'waiting', 'history'];
const TAB_LABELS = {
  waiting: 'Waiting for review',
  changes: 'Changes requested',
  pauses: 'Pause requests',
  plans: 'Plan approvals',
  flagged: 'Flagged (round 4)',
  history: 'History',
  needs_action: 'Needs my action',
};

function viewerKind(user) {
  if (isOwnScope(user)) return 'worker';
  if (isSuperuser(user)) return 'admin';
  if (hasPermission(user, 'review.decide')) return 'lead';
  return 'viewer'; // read-only heads and the SM Manager: everything, no decisions here
}

/** The steps this viewer's hub covers. */
async function scopeQuery(user, calendar) {
  const kind = viewerKind(user);
  const q = { isSkipped: { $ne: true } };
  const and = [];
  if (kind === 'worker') q.ownerId = new mongoose.Types.ObjectId(userIdOf(user));
  if (kind === 'lead') and.push(calendarQueryFor(await access.decisionCalendars(user)));
  if (calendar) and.push(calendarQueryFor([calendar]));
  if (and.length) q.$and = and;
  return q;
}

async function latestVersions(stepIds) {
  if (!stepIds.length) return new Map();
  const rows = await Submission.aggregate([
    { $match: { workItemId: { $in: stepIds }, version: { $gt: 0 } } },
    { $sort: { version: -1 } },
    { $group: { _id: '$workItemId', id: { $first: '$_id' }, version: { $first: '$version' }, status: { $first: '$status' }, submittedAt: { $first: '$submittedAt' }, reviewedAt: { $first: '$reviewedAt' } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r]));
}

/** Which tab a step belongs to (null: none). */
function placeOf(step, latest) {
  const state = stepReviewState(step.status, latest?.status, step.revisions || 0);
  if (state === 'awaiting_review' && latest?.status === 'submitted') return 'waiting';
  if (state === 'changes_requested' || state === 'rework_in_progress') return 'changes';
  if ((step.status === 'Approved' || step.status === 'Published') && latest) return 'history';
  return null;
}

function matchesSearch(step, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return String(step.title || '').toLowerCase().includes(needle) || String(step.ownerId?.name || '').toLowerCase().includes(needle);
}

/**
 * The inbox: the tabs with their counts (after the search and calendar filter) and the items of
 * the chosen tab. Oldest waiting first; History newest decision first.
 */
export async function reviewInbox(user, { tab, q = '', calendar = '' } = {}) {
  const kind = viewerKind(user);
  const tabs = kind === 'worker' ? WORKER_TABS : LEAD_TABS;
  const active = tabs.includes(tab) ? tab : tabs[0];
  const search = String(q || '').trim().slice(0, 100);

  const steps = await WorkItem.find(await scopeQuery(user, calendar))
    .select('title stageKey workType calendar ownerId status revisions deadline dueDate unlockedAt startedAt submittedAt approvedAt postedAt isLocked isSkipped rounds intervals pauseState contentPieceId')
    .populate('ownerId', 'name')
    .lean();
  const visible = steps.filter((s) => matchesSearch(s, search));
  const latest = await latestVersions(visible.map((s) => s._id));
  const flags = await RevisionFlag.find({ workItemId: { $in: visible.map((s) => s._id) }, isFlagged: true, rootCause: null }).lean();
  const flagOf = new Map(flags.map((f) => [String(f.workItemId), f]));

  const buckets = { waiting: [], changes: [], flagged: [], history: [] };
  for (const step of visible) {
    const l = latest.get(String(step._id));
    const place = placeOf(step, l);
    if (place) buckets[place].push({ step, latest: l });
    if (flagOf.has(String(step._id))) buckets.flagged.push({ step, latest: l, flag: flagOf.get(String(step._id)) });
  }

  let pauseCount = 0;
  let planCount = 0;
  if (kind !== 'worker') {
    const pauses = await listPauseRequests(user);
    pauseCount = pauses.filter((r) => (!calendar || r.workItem.calendar === calendar) && (!search || `${r.workItem.title} ${r.owner.name}`.toLowerCase().includes(search.toLowerCase()))).length;
    const waitingRows = await ContentPiece.aggregate([{ $match: { rowStatus: 'submitted' } }, { $group: { _id: '$planId' } }]);
    const plans = await CalendarPlan.find({ _id: { $in: waitingRows.map((r) => r._id) } }).select('calendar title').lean();
    const allowed = kind === 'lead' ? await access.decisionCalendars(user) : null;
    planCount = plans.filter((p) => (!allowed || allowed.includes(p.calendar || 'sm')) && (!calendar || (p.calendar || 'sm') === calendar)).length;
  }

  const counts = {
    waiting: buckets.waiting.length,
    changes: buckets.changes.length,
    needs_action: buckets.changes.length,
    pauses: pauseCount,
    plans: planCount,
    flagged: buckets.flagged.length,
    history: buckets.history.length,
  };

  const bucketKey = active === 'needs_action' ? 'changes' : active;
  let rows = buckets[bucketKey] || [];
  const at = (r) => {
    if (bucketKey === 'flagged') return new Date(r.flag.flaggedAt).getTime();
    if (bucketKey === 'history') return new Date(r.step.approvedAt || r.latest?.reviewedAt || 0).getTime();
    if (bucketKey === 'changes') return new Date(r.latest?.reviewedAt || r.step.updatedAt || 0).getTime();
    return new Date(r.latest?.submittedAt || 0).getTime();
  };
  rows = [...rows].sort((a, b) => (bucketKey === 'history' ? at(b) - at(a) : at(a) - at(b)));
  await attachTimeLabels(rows.map((r) => r.step));

  const items = rows.map(({ step, latest: l, flag }) => ({
    workItemId: String(step._id),
    title: step.title,
    stageKey: step.stageKey,
    type: step.workType,
    calendar: calendarOf(step),
    owner: { _id: idOf(step.ownerId), name: step.ownerId?.name || '' },
    status: step.status,
    reviewState: stepReviewState(step.status, l?.status, step.revisions || 0),
    statusLabel: getStepStatusLabel(step.status),
    version: l?.version || null,
    submittedAt: l?.submittedAt || null,
    decidedAt: bucketKey === 'history' ? step.approvedAt || l?.reviewedAt || null : l?.reviewedAt || null,
    revisions: step.revisions || 0,
    revisionsLabel: revisionsLabel(step.revisions || 0),
    timeLabels: (step.timeLabels || []).filter((t) => t.kind === 'overdue' || t.kind === 'done_late' || t.kind === 'paused'),
    flag: flag ? { _id: String(flag._id), flaggedAt: flag.flaggedAt, revisionsCount: flag.revisionsCount } : null,
  }));

  return {
    viewer: kind,
    tab: active,
    tabs: tabs.map((key) => ({ key, label: TAB_LABELS[key], count: counts[key] })),
    items,
  };
}

// ---------------------------------------------------------------- timeline

function notFound() {
  const e = new Error('Work item not found');
  e.statusCode = 404;
  e.code = 'NOT_FOUND';
  return e;
}

/**
 * One step's review story, oldest first, from the real records. Review text (messages,
 * notes, ratings, root causes) follows the Phase 3 rule: the owner and leadership only.
 * Workers see only their own steps here.
 */
export async function stepTimeline(workItemId, user) {
  if (!mongoose.isValidObjectId(workItemId)) throw notFound();
  const step = await WorkItem.findById(workItemId).populate('ownerId', 'name').lean();
  if (!step) throw notFound();
  const role = normalizeRole(user?.role);
  const me = userIdOf(user);
  const isOwner = idOf(step.ownerId) === me;
  if (isOwnScope(user) && !isOwner) throw notFound();
  const privateOk = isOwner || hasPermission(user, 'review.read_all');

  const versions = await Submission.find({ workItemId: step._id, version: { $gt: 0 } })
    .sort({ version: 1 })
    .populate('submittedById', 'name')
    .populate('reviewedById', 'name')
    .lean();
  const latest = versions.at(-1) || null;
  const versionIds = versions.map((v) => v._id);
  const [ratings, revisionEvents, statusEvents, pauses, flag, entries, helps] = await Promise.all([
    Rating.find({ submissionId: { $in: versionIds } }).populate('raterId', 'name').lean(),
    ActivityEvent.find({ entityId: { $in: [...versionIds, ...versionIds.map(String)] }, action: 'submission.revision_requested' }).populate('actorId', 'name').lean(),
    ActivityEvent.find({ entityId: { $in: [step._id, String(step._id)] }, action: 'work_item.status_changed' }).populate('actorId', 'name').sort({ timestamp: 1 }).lean(),
    PauseRequest.find({ workItemId: step._id }).populate('ownerId', 'name').populate('decidedById', 'name').populate('resumedById', 'name').lean(),
    RevisionFlag.findOne({ workItemId: step._id }).populate('classifiedBy', 'name').lean(),
    FeedbackEntry.find({ workItemId: step._id }).populate('fromPersonId', 'name').sort({ createdAt: 1 }).lean(),
    HelpRequest.find({ workItemId: step._id }).populate('askerId', 'name').populate('helperId', 'name').populate('resolvedById', 'name').lean(),
  ]);

  const events = [];
  const add = (e) => e.at && events.push(e);
  const text = (v) => (privateOk ? v || '' : '');

  for (const v of versions) {
    add({ kind: 'submitted', at: v.submittedAt, by: v.submittedById?.name || '', version: v.version, links: outputItems(v).map((i) => ({ url: i.url, kind: i.kind })), note: text(v.notes) });
    if (v.status === 'changes_requested' && v.reviewedAt) {
      const ev = revisionEvents.find((e) => idOf(e.entityId) === String(v._id));
      // Shoot clip review and transitions leave the message on the status event instead.
      const st = !ev?.metadata?.comment
        ? statusEvents.filter((e) => e.toStatus === 'Feedback' && new Date(e.timestamp) >= new Date(v.submittedAt || 0)).at(0)
        : null;
      add({
        kind: 'changes_requested',
        at: v.reviewedAt,
        by: v.reviewedById?.name || ev?.actorId?.name || st?.actorId?.name || '',
        version: v.version,
        message: text(ev?.metadata?.comment || st?.metadata?.comment),
        rootCause: privateOk ? ev?.metadata?.rootCause || null : null,
      });
    }
    if (v.status === 'approved' && v.reviewedAt) {
      const r = ratings.find((x) => idOf(x.submissionId) === String(v._id));
      add({
        kind: 'approved',
        at: v.reviewedAt,
        by: v.reviewedById?.name || r?.raterId?.name || '',
        version: v.version,
        rating: privateOk && r ? r.score : null,
        message: text(r?.feedback),
      });
    }
  }

  // Rework starts: a round that follows a change request starts when the owner clicks Start rework.
  const rounds = Array.isArray(step.rounds) ? step.rounds : [];
  rounds.forEach((r, i) => {
    if (i > 0 && rounds[i - 1]?.decision === 'changes_requested' && r?.startedAt) {
      add({ kind: 'rework_started', at: r.startedAt, by: step.ownerId?.name || '', round: i + 1 });
    }
  });

  for (const e of statusEvents) {
    if (['Approved', 'Published'].includes(e.fromStatus) && ['Feedback', 'In Progress'].includes(e.toStatus)) {
      add({ kind: 'reopened', at: e.timestamp, by: e.actorId?.name || '', message: text(e.metadata?.comment) });
    }
  }

  for (const p of pauses) {
    const reason = `${PAUSE_REASON_LABELS[p.reason] || p.reason}`;
    add({ kind: 'pause_requested', at: p.requestedAt, by: p.ownerId?.name || '', reason, note: text(p.note), pauseUntil: p.pauseUntil || null });
    if (p.status === 'cancelled') add({ kind: 'pause_cancelled', at: p.cancelledAt, by: p.ownerId?.name || '', cancelReason: p.cancelReason || '' });
    if (p.decidedAt) add({ kind: p.status === 'rejected' ? 'pause_rejected' : 'pause_approved', at: p.decidedAt, by: p.decidedById?.name || '', message: text(p.decisionMessage) });
    if (p.resumedAt) add({ kind: 'pause_resumed', at: p.resumedAt, by: p.resumedById?.name || '' });
  }

  // Help requests: asked and resolved (the message follows the review-text rule).
  for (const h of helps) {
    add({ kind: 'help_requested', at: h.createdAt, by: h.askerId?.name || '', to: h.helperId?.name || '', topic: HELP_TOPIC_LABELS[h.topic] || h.topic, message: text(h.message), open: h.status === 'open' });
    if (h.resolvedAt) add({ kind: 'help_resolved', at: h.resolvedAt, by: h.resolvedById?.name || '', topic: HELP_TOPIC_LABELS[h.topic] || h.topic });
  }

  if (flag) {
    add({ kind: 'flagged', at: flag.flaggedAt, by: '', revisions: flag.revisionsCount });
    if (flag.classifiedAt) add({ kind: 'classified', at: flag.classifiedAt, by: flag.classifiedBy?.name || '', rootCause: privateOk ? flag.rootCause : null });
  }

  for (const fe of entries) {
    add({ kind: 'earlier_note', at: fe.createdAt, by: fe.fromPersonId?.name || '', round: fe.round, isResponse: Boolean(fe.isResponse), message: text(fe.text) });
  }

  // Oldest first; at the same moment, a submission comes before its decision.
  const ORDER = ['submitted', 'rework_started', 'pause_requested', 'pause_approved', 'pause_rejected', 'pause_cancelled', 'pause_resumed', 'help_requested', 'help_resolved', 'changes_requested', 'approved', 'flagged', 'classified', 'reopened', 'earlier_note'];
  events.sort((a, b) => new Date(a.at) - new Date(b.at) || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  const state = stepReviewState(step.status, latest?.status, step.revisions || 0);
  const cal = calendarOf(step);
  let mainAction = { kind: 'open_work_detail', href: `/work/${step._id}` };
  const readOnly = isReadOnly(user);
  if (!readOnly) {
    if (state === 'awaiting_review' && latest?.status === 'submitted' && (await canDecideOn(user, cal, { ownerId: step.ownerId }))) {
      mainAction = { kind: 'open_review_studio', href: `/feedback/review-studio?submissionId=${latest._id}` };
    } else if (flag && flag.isFlagged && !flag.rootCause && (await canDecideOn(user, cal, { permission: 'revision.classify' }))) {
      mainAction = { kind: 'classify', flagId: String(flag._id) };
    } else if (isOwner && state === 'changes_requested') {
      mainAction = { kind: 'start_rework' };
    } else if (isOwner && state === 'rework_in_progress') {
      mainAction = { kind: 'resubmit' };
    }
  }

  return {
    step: {
      _id: String(step._id),
      title: step.title,
      stageKey: step.stageKey,
      type: step.workType,
      calendar: cal,
      owner: { _id: idOf(step.ownerId), name: step.ownerId?.name || '' },
      status: step.status,
      reviewState: state,
      statusLabel: getStepStatusLabel(step.status),
      version: latest?.version || null,
      dueDate: step.dueDate || step.deadline || null,
      revisions: step.revisions || 0,
      revisionsLabel: revisionsLabel(step.revisions || 0),
      publishedUrl: step.publishedUrl || '',
      openHelpCount: helps.filter((h) => h.status === 'open').length,
    },
    mainAction,
    events,
  };
}
