import { CALENDARS } from '@mmp/shared';
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
