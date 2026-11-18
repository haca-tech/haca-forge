/**
 * Phase 12b test helper: the worker job role that makes these preferences eligible
 * (job role sets eligibility; preferences can only narrow it).
 */
export function jobRoleFor(workPreferences = []) {
  const prefs = new Set(workPreferences);
  const only = (...steps) => [...prefs].every((p) => steps.includes(p));
  if (!prefs.size) return '';
  if (only('Script', 'Content')) return 'Writer';
  if (only('Shoot')) return 'Cinematographer';
  if (only('Design')) return 'Graphic Designer';
  if (only('Edit')) return 'Video Editor';
  return 'All Rounder';
}
