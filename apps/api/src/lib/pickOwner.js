/**
 * The one rule every owner suggestion in the app uses (plan autofill, calendar import,
 * Recommended Owner):
 *
 *   1. Eligible: the caller decides (the person's steps, or the department).
 *   2. Available: workload under AVAILABLE_BELOW_PCT.
 *   3. Lowest workload % first.
 *   4. Ties: by name, then by id, so the same team always gives the same suggestion.
 *
 * Revision history, ratings and speed are never factors.
 */
export const AVAILABLE_BELOW_PCT = 85;

const text = (v) => String(v ?? '');

/** Comparator for rule steps 3 and 4. `load`, `name` and `id` read a candidate. */
export function compareOwners({ load, name, id }) {
  return (a, b) =>
    load(a) - load(b) ||
    text(name(a)).localeCompare(text(name(b)), 'en', { sensitivity: 'base' }) ||
    text(id(a)).localeCompare(text(id(b)));
}

/** True when the candidate has room for more work (rule step 2). */
export const isAvailable = (pct) => pct < AVAILABLE_BELOW_PCT;

/**
 * The suggested owner, or null when nobody eligible is available.
 * @param {Array} candidates
 * @param {{ eligible?: Function, load: Function, name: Function, id: Function }} read
 */
export function pickOwner(candidates, { eligible = () => true, load, name, id }) {
  const pool = candidates.filter((c) => eligible(c) && isAvailable(load(c)));
  if (pool.length === 0) return null;
  return [...pool].sort(compareOwners({ load, name, id }))[0];
}
