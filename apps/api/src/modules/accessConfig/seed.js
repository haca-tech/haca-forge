import { CALENDAR_KEYS, defaultWorkflowConfig } from '@mmp/shared';
import { WorkflowConfig } from './workflowConfig.model.js';

/**
 * Seeding WorkflowConfig from today's rules: Ads → Growth Lead, every other calendar → Creative
 * Lead (reviewers and plan approvers), posters → SM Manager, fallback → admin. Only calendars
 * without a config are created; an existing config is never changed (running twice changes nothing).
 */
export async function planWorkflowSeed() {
  const existing = new Set((await WorkflowConfig.find({}).select('calendar').lean()).map((c) => c.calendar));
  return CALENDAR_KEYS.map((calendar) => {
    const d = defaultWorkflowConfig(calendar);
    return {
      calendar,
      action: existing.has(calendar) ? 'keep' : 'create',
      config: { calendar, reviewers: d.reviewers, planApprovers: d.planApprovers, posters: d.posters, fallbackApprovers: d.fallbackApprovers },
    };
  });
}

/** Creates the planned configs. Returns the calendars created. */
export async function applyWorkflowSeed(plan) {
  const created = [];
  for (const p of plan.filter((x) => x.action === 'create')) {
    // Upsert on the unique calendar: a config created meanwhile is left as it is.
    const res = await WorkflowConfig.updateOne(
      { calendar: p.calendar },
      { $setOnInsert: { ...p.config, version: 1, updatedBy: null } },
      { upsert: true }
    );
    if (res.upsertedCount) created.push(p.calendar);
  }
  return created;
}

const fmt = (a) => [...(a.roles || []).map((r) => `role:${r}`), ...(a.userIds || []).map((u) => `user:${u}`)].join(', ') || '(none)';
export const describeSeedRow = (p) =>
  `${p.calendar.padEnd(22)} ${p.action === 'create' ? 'CREATE' : 'keep  '} reviewers=${fmt(p.config.reviewers)}; planApprovers=${fmt(p.config.planApprovers)}; posters=${fmt(p.config.posters)}; fallback=${fmt(p.config.fallbackApprovers)}`;
