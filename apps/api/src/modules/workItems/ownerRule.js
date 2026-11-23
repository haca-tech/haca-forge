import { CALENDARS, STAGE_KEYS, effectiveStepsFor, stepEligibility as stepEligibilityPure } from '@mmp/shared';
import * as access from '../../lib/accessResolver.js';

/**
 * The one rule for who may own a step, used by every path that sets or changes a step's owner
 * (assignment override, Tracker assign, reassign one stage, Work Detail, plan grid / plan rows,
 * step generation, team reassignment):
 * - the person exists and is active;
 * - they pass stepEligibility for that step: production steps by job role; a Post step only for a
 *   poster on the step's calendar (named or by role, inside their calendar limit, able to own steps).
 * Standalone work items (no stageKey) only need an active person.
 */
const calName = (c) => CALENDARS[c]?.name || c;

/** Why this person cannot own this step, or null when they can. */
export async function ownerProblem(person, step) {
  if (!person) return 'That person does not exist.';
  const name = person.name || 'This person';
  if (person.status !== 'active') return `${name} is ${person.status || 'not active'}, so they cannot own steps.`;
  const stageKey = step?.stageKey;
  if (!stageKey) return null;
  const calendar = step.calendar || 'sm';
  if (await access.stepEligibility(person, { stageKey, calendar })) return null;
  if (stageKey === 'Post') return `${name} is not a poster on ${calName(calendar)}, so they cannot own its Post step.`;
  return `${name} cannot own ${stageKey} steps (job role: ${person.jobRole || 'none'}).`;
}

/** Throws 400 OWNER_NOT_ELIGIBLE with the reason when this person cannot own this step. */
export async function assertCanOwnStep(person, step) {
  const problem = await ownerProblem(person, step);
  if (!problem) return;
  const error = new Error(problem);
  error.statusCode = 400;
  error.code = 'OWNER_NOT_ELIGIBLE';
  error.details = { field: 'ownerId', stageKey: step?.stageKey || null };
  throw error;
}

/** Of these people, the ones who can own this step (owner dropdowns). */
export async function eligibleOwners(people, step) {
  const out = [];
  for (const p of people || []) if (!(await ownerProblem(p, step))) out.push(p);
  return out;
}

// ---------------------------------------------------------------- suggestions (many picks at once)

/**
 * Has this person, by their work preferences, chosen this step? Preferences only narrow: no
 * preferences set means every step their job role allows (SM Managers post whatever they set).
 */
export function prefersStep(person, stageKey) {
  const prefs = Array.isArray(person?.workPreferences) ? person.workPreferences : [];
  return !prefs.length || prefs.includes(stageKey) || effectiveStepsFor(person).includes(stageKey);
}

/** The people who prefer the step, or all of them when that would leave nobody. */
export function narrowByPreferences(people, stageKey, personOf = (x) => x) {
  const preferred = (people || []).filter((x) => prefersStep(personOf(x), stageKey));
  return preferred.length ? preferred : people || [];
}

/**
 * For suggestions on one calendar (autofill, import, Recommended Owner): per person id, the steps
 * they may own under the owner rule (active; production steps by job role; Post only for a poster
 * on this calendar). Read once, then used for every pick.
 */
export async function ownableStepsFor(people, calendar = 'sm') {
  const posterIds = new Set((await access.postersFor({ calendar: calendar || 'sm' })).people.map((p) => String(p._id)));
  return new Map(
    (people || []).map((p) => [
      String(p._id),
      p.status !== 'active'
        ? []
        : STAGE_KEYS.filter((stageKey) => (stageKey === 'Post' ? posterIds.has(String(p._id)) : stepEligibilityPure(p, { stageKey }))),
    ])
  );
}

/**
 * The candidates a suggestion chooses from for a step: the same people the owner dropdown
 * offers (`ownable` from ownableStepsFor), narrowed by preferences but never down to nobody.
 */
export function ownerPool(candidates, stageKey, ownable, personOf = (c) => c.member || c.person || c) {
  const eligible = (candidates || []).filter((c) => (ownable.get(String(personOf(c)?._id)) || []).includes(stageKey));
  return narrowByPreferences(eligible, stageKey, personOf);
}
