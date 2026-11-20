import { ineligiblePreferences, eligibleStepsFor, isWorker, normalizeRole } from '@mmp/shared';
import { canTakeSteps, eligibleSteps } from '../../lib/roleAccess.js';

/**
 * Phase 12b: a worker's job role sets the steps they are eligible for; preferences can only
 * narrow it. Checks the update before anything is written.
 * - Preferences sent outside the eligibility: 400 PREFERENCE_NOT_ELIGIBLE.
 * - A job role change drops the preferences the new job role does not allow.
 * Returns the preferences to save, or undefined to leave them as they are.
 */
export function eligiblePreferencesForUpdate(target, updates) {
  const role = normalizeRole(updates.role !== undefined ? updates.role : target.role);
  const jobRole = updates.jobRole !== undefined ? updates.jobRole : target.jobRole;
  const person = { role, jobRole };
  if (updates.workPreferences !== undefined) {
    const prefs = Array.isArray(updates.workPreferences) ? updates.workPreferences : [];
    const bad = canTakeSteps(role) ? ineligiblePreferences(person, prefs) : [];
    if (bad.length) {
      const allowed = eligibleSteps(person);
      const error = new Error(
        `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} not allowed for ${jobRole || 'this role'}. Allowed: ${allowed.join(', ') || 'none'}.`
      );
      error.code = 'PREFERENCE_NOT_ELIGIBLE';
      error.statusCode = 400;
      error.details = { notAllowed: bad, allowed };
      throw error;
    }
    return prefs;
  }
  if (updates.jobRole !== undefined || updates.role !== undefined) {
    const current = Array.isArray(target.workPreferences) ? target.workPreferences : [];
    const allowed = eligibleSteps(person);
    const kept = current.filter((p) => allowed.includes(p));
    if (kept.length !== current.length) return kept;
  }
  return undefined;
}
