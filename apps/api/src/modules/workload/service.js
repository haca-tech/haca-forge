import mongoose from 'mongoose';
import {
  workloadFor,
  pickOwner,
  withPlannedStep,
  activeStepLimitOf,
  normalizeRole,
  isApprover,
  isWorker,
  WORKER_ROLE,
  SIMPLE_WORKLOAD_BANDS,
} from '@mmp/shared';
import { Person } from '../people/model.js';
import { WorkItem } from '../workItems/model.js';
import { Submission } from '../submissions/model.js';
import { PersonChangeAudit } from '../team/audit.model.js';
import { logActivity } from '../activity/service.js';

/**
 * Simple workload (step counts). One definition everywhere: the workload page, dashboard,
 * profiles, autofill, import and Recommended Owner all read people's open steps through
 * `openStepsByOwner` and count them with the shared `workloadFor` / `pickOwner`.
 * No hours, capacity or percentages.
 */

const FINISHED = ['Approved', 'Published'];
/** People whose workload is planned: workers and SM Managers (Post). */
export const WORKLOAD_ROLES = [WORKER_ROLE, 'sm_manager'];
export const ACTIVE_STEP_LIMIT_MAX = 20;

const ownerKey = (v) => String(v?._id || v);

/**
 * Each owner's unfinished steps, with the latest version status for steps in Feedback
 * (so "changes requested" can be told apart from "waiting for review").
 * @returns {Promise<Map<string, Array>>}
 */
export async function openStepsByOwner(ownerIds) {
  const ids = [...new Set((ownerIds || []).map(ownerKey))].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const byOwner = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return byOwner;
  const steps = await WorkItem.find({ ownerId: { $in: ids }, status: { $nin: FINISHED }, isSkipped: { $ne: true } })
    .select('title stageKey status isLocked isSkipped dueDate deadline revisions ownerId contentPieceId pauseState calendar workType')
    .populate('contentPieceId', 'topic title code')
    .lean();
  const feedbackIds = steps.filter((s) => s.status === 'Feedback').map((s) => s._id);
  const latest = new Map();
  if (feedbackIds.length) {
    const rows = await Submission.aggregate([
      { $match: { workItemId: { $in: feedbackIds }, version: { $gt: 0 } } },
      { $sort: { version: -1 } },
      { $group: { _id: '$workItemId', status: { $first: '$status' } } },
    ]);
    for (const r of rows) latest.set(String(r._id), r.status);
  }
  for (const s of steps) {
    const list = byOwner.get(ownerKey(s.ownerId));
    if (list) list.push({ ...s, latestVersionStatus: latest.get(String(s._id)) ?? null });
  }
  return byOwner;
}

/** { inProgress, dueThisWeek, limit, band, nextDue } for one person. */
export async function workloadOfPerson(person, now = new Date()) {
  const steps = (await openStepsByOwner([person._id])).get(ownerKey(person._id)) || [];
  return workloadFor(person, steps, now);
}

/** Workload for many people: Map id -> workload. */
export async function workloadByPerson(people, now = new Date()) {
  const steps = await openStepsByOwner(people.map((p) => p._id));
  return new Map(people.map((p) => [ownerKey(p._id), workloadFor(p, steps.get(ownerKey(p._id)) || [], now)]));
}

/** { available, busy, over } counts from workload rows. */
export function bandCounts(rows) {
  const counts = { available: 0, busy: 0, over: 0 };
  for (const r of rows) {
    if (r.band === 'Available') counts.available += 1;
    else if (r.band === 'Busy') counts.busy += 1;
    else if (r.band === 'Over') counts.over += 1;
  }
  return counts;
}

const canEditLimits = (role) => {
  const r = normalizeRole(role);
  return r === 'admin' || isApprover(r);
};

const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }) || String(a._id).localeCompare(String(b._id));

/**
 * The workload list. Workers see only their own row. Rows are sorted by name (workload is a
 * planning tool: no ranking by load). Filters: jobRole, band (Available | Busy | Over), q (name).
 */
export async function listWorkload(user, { jobRole, band, q } = {}, now = new Date()) {
  const role = normalizeRole(user?.role);
  const query = { status: 'active', role: { $in: WORKLOAD_ROLES } };
  if (isWorker(role)) query._id = user._id;
  const people = (await Person.find(query).select('name role jobRole avatarUrl activeStepLimit departmentId').lean()).sort(byName);
  const workloads = await workloadByPerson(people, now);
  const all = people.map((p) => ({
    _id: String(p._id),
    name: p.name,
    role: p.role,
    jobRole: p.jobRole || '',
    avatarUrl: p.avatarUrl || null,
    ...workloads.get(String(p._id)),
  }));
  const needle = String(q || '').trim().toLowerCase();
  const rows = all.filter(
    (r) =>
      (!jobRole || r.jobRole === jobRole) &&
      (!band || !SIMPLE_WORKLOAD_BANDS.includes(band) || r.band === band) &&
      (!needle || r.name.toLowerCase().includes(needle)),
  );
  return {
    // The chips count everyone in view (before the band filter), so they can act as filters.
    bands: bandCounts(all.filter((r) => (!jobRole || r.jobRole === jobRole) && (!needle || r.name.toLowerCase().includes(needle)))),
    people: rows,
    jobRoles: [...new Set(all.map((r) => r.jobRole).filter(Boolean))].sort(),
    canEditLimit: canEditLimits(role),
  };
}

/** A person's open, unlocked steps for the side panel (step, project, status, due date). */
export async function openStepsOf(personId, user) {
  const role = normalizeRole(user?.role);
  const notFound = () => Object.assign(new Error('Person not found'), { statusCode: 404, code: 'NOT_FOUND' });
  if (!mongoose.Types.ObjectId.isValid(personId)) throw notFound();
  if (isWorker(role) && String(user._id) !== String(personId)) throw notFound();
  const person = await Person.findById(personId).select('name role jobRole activeStepLimit').lean();
  if (!person) throw notFound();
  const steps = ((await openStepsByOwner([person._id])).get(String(person._id)) || []).filter((s) => !s.isLocked);
  steps.sort((a, b) => new Date(a.dueDate || a.deadline || 8.64e15) - new Date(b.dueDate || b.deadline || 8.64e15));
  return {
    person: { _id: String(person._id), name: person.name, jobRole: person.jobRole || '' },
    workload: workloadFor(person, steps),
    steps: steps.map((s) => ({
      _id: String(s._id),
      title: s.title,
      stageKey: s.stageKey,
      status: s.status,
      paused: s.pauseState === 'paused',
      latestVersionStatus: s.latestVersionStatus,
      dueDate: s.dueDate || s.deadline || null,
      project: s.contentPieceId ? { _id: String(s.contentPieceId._id), name: s.contentPieceId.topic || s.contentPieceId.title || '', code: s.contentPieceId.code || '' } : null,
    })),
  };
}

/** Admin and both leads set a person's active-step limit (1 to 20). Others get 403. */
export async function setActiveStepLimit(personId, value, actor) {
  if (!canEditLimits(actor?.role)) {
    throw Object.assign(new Error('Only admin and the leads can change a limit.'), { statusCode: 403, code: 'FORBIDDEN' });
  }
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > ACTIVE_STEP_LIMIT_MAX) {
    throw Object.assign(new Error(`The limit must be a whole number from 1 to ${ACTIVE_STEP_LIMIT_MAX}.`), { statusCode: 400, code: 'INVALID_LIMIT' });
  }
  if (!mongoose.Types.ObjectId.isValid(personId)) throw Object.assign(new Error('Person not found'), { statusCode: 404, code: 'NOT_FOUND' });
  const person = await Person.findOne({ _id: personId, role: { $in: WORKLOAD_ROLES } });
  if (!person) throw Object.assign(new Error('Person not found'), { statusCode: 404, code: 'NOT_FOUND' });
  const old = activeStepLimitOf(person);
  if (old !== limit || person.activeStepLimit == null) {
    await Person.updateOne({ _id: person._id }, { $set: { activeStepLimit: limit } });
    await PersonChangeAudit.create({ personId: person._id, actorId: actor._id, field: 'activeStepLimit', oldValue: person.activeStepLimit ?? null, newValue: limit, reason: 'Active-step limit' });
    await logActivity({ entityType: 'person', entityId: person._id, actor, action: 'person.updated', metadata: { fields: ['activeStepLimit'] } });
  }
  return workloadOfPerson({ ...person.toObject(), activeStepLimit: limit });
}

/**
 * Suggestion candidates: people with their open steps, ready for `pickOwner`.
 * `plannedSteps` (rows of a plan not yet turned into steps) count as Not Started steps.
 */
export async function ownerCandidates(people, { plannedSteps = [] } = {}) {
  const steps = await openStepsByOwner(people.map((p) => p._id));
  let candidates = people.map((p) => ({ id: String(p._id), name: p.name, activeStepLimit: p.activeStepLimit, steps: steps.get(String(p._id)) || [], person: p }));
  for (const ps of plannedSteps) {
    candidates = candidates.map((c) => (c.id === String(ps.ownerId) ? withPlannedStep(c, ps.dueDate) : c));
  }
  return candidates;
}

/** Re-export so callers import the one rule from one place. */
export { pickOwner, withPlannedStep };
