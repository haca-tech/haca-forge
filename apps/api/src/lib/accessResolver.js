import mongoose from 'mongoose';
import {
  CALENDAR_KEYS,
  can as canPure,
  decisionCalendars as decisionCalendarsPure,
  defaultWorkflowConfig,
  stepEligibility as stepEligibilityPure,
  withinCalendarScope,
} from '@mmp/shared';
import { Person } from '../modules/people/model.js';
import { WorkflowConfig, onWorkflowConfigChange } from '../modules/accessConfig/workflowConfig.model.js';

/**
 * The central access resolver (Phase B). NOT used by the app yet: Phase C switches routes,
 * services, web and sockets to it. The permanent parity test (test/access_parity.test.js)
 * proves it returns exactly what today's hard-coded rules return.
 *
 * Workflow configs are read through a cache keyed by calendar and version: cleared when a
 * config changes, and re-read after CACHE_TTL_MS as a safety net (several API processes).
 * A calendar without a stored config uses the seeded default (today's rules).
 */

const CACHE_TTL_MS = 5000;
const cache = new Map(); // calendar -> { config, version, loadedAt }
onWorkflowConfigChange((calendar) => (calendar ? cache.delete(calendar) : cache.clear()));
export const clearAccessCache = () => cache.clear();

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
  const doc = mongoose.connection.readyState === 1 ? await WorkflowConfig.findOne({ calendar: cal }).lean() : null;
  const config = plainConfig(doc, cal);
  cache.set(cal, { config, version: config.version, loadedAt: Date.now() });
  return config;
}

export async function getAllWorkflowConfigs() {
  const entries = await Promise.all(CALENDAR_KEYS.map(async (c) => [c, await getWorkflowConfig(c)]));
  return Object.fromEntries(entries);
}

/** can(user, permission, { calendar, ownerId }) with the stored config for that calendar. */
export async function can(user, permission, ctx = {}) {
  const config = ctx.calendar !== undefined ? await getWorkflowConfig(ctx.calendar) : null;
  return canPure(user, permission, ctx, config);
}

export async function decisionCalendars(user) {
  return decisionCalendarsPure(user, await getAllWorkflowConfigs());
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

async function peopleFor(audience, calendar, { statusFilter = 'active' } = {}) {
  if (!audience || (!(audience.roles || []).length && !(audience.userIds || []).length)) return [];
  const people = await Person.find(audienceQuery(audience, statusFilter));
  return people.filter((p) => withinCalendarScope(p, calendar));
}

/** Fallback people (fixed rule 12): every active admin plus the named fallback people. */
async function fallbackFor(config, calendar) {
  return peopleFor(config.fallbackApprovers, calendar);
}

/**
 * Who reviews a step. `primary`: the calendar's reviewers (today: the calendar's lead role,
 * active). `people`: primary, or the fallback when no primary is active.
 */
export async function reviewersFor(step) {
  const calendar = calOf(step);
  const config = await getWorkflowConfig(calendar);
  const primary = await peopleFor(config.reviewers, calendar);
  const fallback = primary.length ? [] : await fallbackFor(config, calendar);
  return { calendar, primary, fallback, people: primary.length ? primary : fallback };
}

export async function planApproversFor(plan) {
  const calendar = calOf(plan);
  const config = await getWorkflowConfig(calendar);
  const primary = await peopleFor(config.planApprovers, calendar);
  const fallback = primary.length ? [] : await fallbackFor(config, calendar);
  return { calendar, primary, fallback, people: primary.length ? primary : fallback };
}

/**
 * Posters of a calendar. `people`: every active poster. `defaultPoster`: the person a new row's
 * Post step goes to, the first active poster as today (unsorted findOne, plan.service.js:508,880).
 */
export async function postersFor(piece) {
  const calendar = calOf(piece);
  const config = await getWorkflowConfig(calendar);
  const people = await peopleFor(config.posters, calendar);
  const defaultPoster = config.posters.roles.length || config.posters.userIds.length
    ? await Person.findOne(audienceQuery(config.posters)).lean()
    : null;
  return { calendar, people, defaultPoster };
}

/**
 * Notification recipients, by event. Each mirrors today's query exactly (Phase B parity),
 * including "first SM Manager only" where that is today's rule; Phase C changes those on purpose.
 *  - submission.ready / plan.submitted: the calendar's reviewers / plan approvers (active).
 *  - revision.flagged: reviewers (active) and the step department's SM Managers (active).
 *  - revision.flag_escalated: reviewers and admins, every status but suspended.
 *  - step.needs_owner: every active poster (SM Manager).
 *  - step.overdue_manager: the first active poster of the step's department by creation, else the first overall.
 *  - access.requested: every active admin.
 */
export async function recipientsFor(event, item = {}) {
  const calendar = calOf(item);
  const config = await getWorkflowConfig(calendar);
  switch (event) {
    case 'submission.ready':
      return peopleFor(config.reviewers, calendar);
    case 'plan.submitted':
      return peopleFor(config.planApprovers, calendar);
    case 'revision.flagged': {
      const or = [audienceQuery(config.reviewers)];
      if (item.departmentId) or.push({ ...audienceQuery(config.posters), departmentId: item.departmentId });
      return Person.find({ $or: or });
    }
    case 'revision.flag_escalated': {
      const reviewers = await peopleFor(config.reviewers, calendar, { statusFilter: 'not_suspended' });
      const admins = await Person.find({ role: 'admin', status: { $ne: 'suspended' } }).lean();
      return [...reviewers, ...admins];
    }
    case 'step.needs_owner':
      return peopleFor(config.posters, calendar);
    case 'step.overdue_manager': {
      const inDept = item.departmentId
        ? await Person.findOne({ departmentId: item.departmentId, ...audienceQuery(config.posters) }).sort({ createdAt: 1 }).lean()
        : null;
      if (inDept) return [inDept];
      const any = await Person.findOne(audienceQuery(config.posters)).sort({ createdAt: 1 }).lean();
      return any ? [any] : [];
    }
    case 'access.requested':
      return Person.find({ role: 'admin', status: 'active' }).select('_id email name notificationPreferences');
    default:
      throw new Error(`recipientsFor: unknown event "${event}"`);
  }
}

export const __test = { audienceQuery, idOf };
