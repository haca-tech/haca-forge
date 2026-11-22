import mongoose from 'mongoose';
import {
  CALENDAR_KEYS,
  ROLE_KEYS,
  audienceIncludes,
  can as canPure,
  defaultWorkflowConfig,
  permissionDef,
  slotEligibleRole,
  stepEligibility as stepEligibilityPure,
  systemRoleOf,
  withinCalendarScope,
} from '@mmp/shared';
import { Person } from '../modules/people/model.js';
import { WorkflowConfig, onWorkflowConfigChange } from '../modules/accessConfig/workflowConfig.model.js';

const lockedRoles = () => ROLE_KEYS.filter((role) => systemRoleOf({ role })?.locked);
/** Step-taking roles that post (today: the SM Manager), for "needs an owner" notices. */
const postingRoles = () => ROLE_KEYS.filter((role) => slotEligibleRole(role, 'posters'));

/**
 * The central access resolver (Phase B; used by routes, services and sockets since Phase C).
 * The parity test (test/access_parity.test.js) proves the defaults match the old rules;
 * docs/ACCESS.md describes the model.
 *
 * Workflow configs are read through a cache keyed by calendar and version: cleared when a
 * config changes, and re-read after CACHE_TTL_MS as a safety net (several API processes).
 * A calendar without a stored config uses the seeded default (today's rules).
 */

const CACHE_TTL_MS = 5000;
const cache = new Map(); // calendar -> { config, version, loadedAt }
/**
 * Bumped on every clear. A read that started before a save only fills the cache if no clear
 * happened meanwhile, so it cannot put the old settings back after the save cleared them.
 */
let generation = 0;
onWorkflowConfigChange((calendar) => {
  generation += 1;
  if (calendar) cache.delete(calendar);
  else cache.clear();
});
/** Test hooks (no-op in the app). */
export const accessResolverHooks = { afterRead: null };

export const clearAccessCache = () => {
  generation += 1;
  cache.clear();
};

const calOf = (item) => (item && item.calendar) || 'sm';
const idOf = (v) => String(v?._id || v || '');

function plainAudience(a) {
  return { roles: [...(a?.roles || [])], userIds: (a?.userIds || []).map((id) => String(id)) };
}
function plainConfig(doc, calendar) {
  if (!doc) return defaultWorkflowConfig(calendar);
  return {
    calendar: doc.calendar,
    reviewers: plainAudience(doc.reviewers),
    planApprovers: plainAudience(doc.planApprovers),
    posters: plainAudience(doc.posters),
    fallbackApprovers: plainAudience(doc.fallbackApprovers),
    version: doc.version,
  };
}

/** The workflow config of a calendar (cached). */
export async function getWorkflowConfig(calendar) {
  const cal = calendar || 'sm';
  const hit = cache.get(cal);
  if (hit && Date.now() - hit.loadedAt < CACHE_TTL_MS) return hit.config;
  const startedAt = generation;
  const config = await readWorkflowConfigFresh(cal);
  // Test hook (no-op in the app): lets a test hold a read between the database and the cache.
  if (accessResolverHooks.afterRead) await accessResolverHooks.afterRead({ calendar: cal, config });
  if (startedAt === generation) cache.set(cal, { config, version: config.version, loadedAt: Date.now() });
  return config;
}

/** A calendar's settings straight from the database, never the cache (saves compare against this). */
export async function readWorkflowConfigFresh(calendar) {
  const cal = calendar || 'sm';
  const doc = mongoose.connection.readyState === 1 ? await WorkflowConfig.findOne({ calendar: cal }).lean() : null;
  return plainConfig(doc, cal);
}

export async function getAllWorkflowConfigs() {
  const entries = await Promise.all(CALENDAR_KEYS.map(async (c) => [c, await getWorkflowConfig(c)]));
  return Object.fromEntries(entries);
}

/**
 * can(user, permission, { calendar, ownerId }) with the stored config for that calendar. For a
 * decision (review, classify, plan approval) by someone in the calendar's fallback, it also works
 * out whether the main list has anybody active and eligible: if not, the fallback decides.
 */
export async function can(user, permission, ctx = {}) {
  if (ctx.calendar === undefined) return canPure(user, permission, ctx, null);
  const calendar = ctx.calendar || 'sm';
  const config = await getWorkflowConfig(calendar);
  if (canPure(user, permission, ctx, config)) return true;
  const slot = permissionDef(permission)?.routedBy;
  if (slot !== 'reviewers' && slot !== 'planApprovers') return false;
  if (!audienceIncludes(config.fallbackApprovers, user)) return false;
  if ((await peopleFor(config[slot], calendar, { slot })).length) return false;
  return canPure(user, permission, ctx, { ...config, primaryInactive: { [slot]: true } });
}

/** The calendars this user reviews on (queues), counting calendars where they are the acting fallback. */
export async function decisionCalendars(user) {
  if (!systemRoleOf(user) || user?.status === 'suspended') return [];
  const out = [];
  for (const calendar of CALENDAR_KEYS) if (await can(user, 'review.decide', { calendar })) out.push(calendar);
  return out;
}

export async function stepEligibility(user, step) {
  return stepEligibilityPure(user, step, await getWorkflowConfig(calOf(step)));
}

/**
 * The query for an audience's people. A single role and no named people gives exactly the
 * legacy query shape ({ role, status }), so unsorted findOne picks the same person as today.
 */
function audienceQuery(audience, statusFilter = 'active') {
  const roles = audience?.roles || [];
  const userIds = (audience?.userIds || []).filter((id) => mongoose.isValidObjectId(id));
  const status = statusFilter === 'not_suspended' ? { $ne: 'suspended' } : 'active';
  if (!userIds.length && roles.length === 1) return { role: roles[0], status };
  if (!userIds.length) return { role: { $in: roles }, status };
  const or = [{ _id: { $in: userIds } }];
  if (roles.length) or.unshift({ role: { $in: roles } });
  return { $or: or, status };
}

/**
 * The people a slot names who can act now: active (or not suspended, when asked), inside their
 * calendar limit, and whose current role can fill the slot (a named person whose role changed is
 * skipped, so the fallback takes over). Posters must also be able to own Post steps.
 */
async function peopleFor(audience, calendar, { slot, statusFilter = 'active' } = {}) {
  if (!audience || (!(audience.roles || []).length && !(audience.userIds || []).length)) return [];
  // A stable order (name, then id): the default poster is never "whoever was inserted first".
  const people = await Person.find(audienceQuery(audience, statusFilter)).sort({ name: 1, _id: 1 });
  return people.filter((p) => withinCalendarScope(p, calendar) && (!slot || slotEligibleRole(p.role, slot)));
}

/** Every active admin: the final fallback on every calendar. */
const activeAdmins = () => Person.find({ role: { $in: lockedRoles() }, status: 'active' });

/**
 * Fallback people: the calendar's fallback list (active, eligible, within their limit), or every
 * active admin when that list has nobody (admins are always the final fallback).
 */
async function fallbackFor(config, calendar) {
  const named = await peopleFor(config.fallbackApprovers, calendar, { slot: 'fallbackApprovers' });
  return named.length ? named : activeAdmins();
}

/**
 * Who reviews a step. `primary`: the calendar's reviewers who can act now (active, eligible role,
 * inside their limit). `people`: primary, or the fallback when there is no primary (the named
 * fallback, or every active admin when that has nobody either).
 */
export async function reviewersFor(step) {
  const calendar = calOf(step);
  const config = await getWorkflowConfig(calendar);
  const primary = await peopleFor(config.reviewers, calendar, { slot: 'reviewers' });
  const fallback = primary.length ? [] : await fallbackFor(config, calendar);
  return { calendar, primary, fallback, people: primary.length ? primary : fallback };
}

export async function planApproversFor(plan) {
  const calendar = calOf(plan);
  const config = await getWorkflowConfig(calendar);
  const primary = await peopleFor(config.planApprovers, calendar, { slot: 'planApprovers' });
  const fallback = primary.length ? [] : await fallbackFor(config, calendar);
  return { calendar, primary, fallback, people: primary.length ? primary : fallback };
}

/**
 * Posters of a calendar. `people`: every active poster who can own Post steps on it.
 * `defaultPoster`: the person a new row's Post step goes to; null when the calendar has no active
 * poster (the Post step then waits unowned and "needs an owner" is sent).
 */
export async function postersFor(piece) {
  const calendar = calOf(piece);
  const config = await getWorkflowConfig(calendar);
  const people = await peopleFor(config.posters, calendar, { slot: 'posters' });
  // The first of the scoped list: active, able to own Post steps, inside their calendar limit.
  const defaultPoster = people[0] || null;
  return { calendar, people, defaultPoster };
}

/** Posters of the step's department (when it has one), eligible and inside their limit. */
async function departmentPosters(config, calendar, departmentId, { sort = false } = {}) {
  if (!departmentId) return [];
  let q = Person.find({ ...audienceQuery(config.posters), departmentId });
  if (sort) q = q.sort({ createdAt: 1 });
  return (await q.lean()).filter((p) => withinCalendarScope(p, calendar) && slotEligibleRole(p.role, 'posters'));
}

/**
 * Notification recipients, by event:
 *  - submission.ready / plan.submitted: the calendar's reviewers / plan approvers, or the fallback.
 *  - revision.flagged: reviewers (or the fallback) and the step department's posters.
 *  - revision.flag_escalated: reviewers and admins, every status but suspended.
 *  - step.needs_owner: every active poster; when the calendar has none, the holders of the posters'
 *    roles, every SM Manager (posting role) and every admin, so somebody can assign it.
 *  - step.overdue_manager: every active poster of the step's department, else every active poster (Phase C5).
 *  - access.requested: every active admin.
 */
export async function recipientsFor(event, item = {}) {
  const calendar = calOf(item);
  const config = await getWorkflowConfig(calendar);
  switch (event) {
    case 'submission.ready':
      return (await reviewersFor(item)).people;
    case 'plan.submitted':
      return (await planApproversFor(item)).people;
    case 'revision.flagged': {
      // The step's reviewers (or the fallback) and its department's posters; active, within their
      // calendar limit (Phase E fix: the limit was ignored here).
      const { people: reviewers } = await reviewersFor(item);
      const posters = await departmentPosters(config, calendar, item.departmentId);
      return [...new Map([...reviewers, ...posters].map((p) => [String(p._id), p])).values()];
    }
    case 'revision.flag_escalated': {
      const reviewers = await peopleFor(config.reviewers, calendar, { slot: 'reviewers', statusFilter: 'not_suspended' });
      const admins = await Person.find({ role: { $in: lockedRoles() }, status: { $ne: 'suspended' } }).lean();
      return [...new Map([...reviewers, ...admins].map((p) => [String(p._id), p])).values()];
    }
    case 'step.needs_owner': {
      const posters = await peopleFor(config.posters, calendar, { slot: 'posters' });
      if (posters.length) return posters;
      const roles = [...new Set([...(config.posters.roles || []), ...postingRoles(), ...lockedRoles()])];
      return Person.find({ role: { $in: roles }, status: 'active' });
    }
    case 'step.overdue_manager': {
      // Phase C5: every SM Manager of the step's department, or every SM Manager when it has none
      // (was: the first one only).
      const inDept = await departmentPosters(config, calendar, item.departmentId, { sort: true });
      if (inDept.length) return inDept;
      return (await Person.find(audienceQuery(config.posters)).sort({ createdAt: 1 }).lean()).filter(
        (p) => withinCalendarScope(p, calendar) && slotEligibleRole(p.role, 'posters')
      );
    }
    case 'comment.posted': {
      // Live review comments: the step calendar's reviewers (or the fallback) and every active admin.
      const { people } = await reviewersFor(item);
      const admins = await Person.find({ role: { $in: lockedRoles() }, status: 'active' }).select('_id').lean();
      return [...new Map([...people, ...admins].map((p) => [String(p._id), p])).values()];
    }
    case 'access.requested':
      return Person.find({ role: 'admin', status: 'active' }).select('_id email name notificationPreferences');
    default:
      throw new Error(`recipientsFor: unknown event "${event}"`);
  }
}

export const __test = { audienceQuery, idOf };
