import {
  getPipelineForContent,
  calculateStageDueDate,
  isPostableWorkType,
  normalizeWorkType,
  WORKER_ROLE,
  effectiveStepsFor,
  pickOwner,
  withPlannedStep,
} from '@mmp/shared';
import { Person } from '../people/model.js';
import { ownerCandidates } from '../workload/service.js';

/**
 * Load everything autofill reads from the database, once, however many rows are filled:
 * active workers and SM Managers with their open steps (step counts, no hours).
 *
 * Suggestions use the shared owner rule (pickOwner): eligible (the person's steps; Post is
 * SM Managers only), fewest due in the step's 7-day window, fewest in progress, name, id.
 * Revision history, ratings and speed are never factors.
 */
export async function buildAutofillContext() {
  const members = await Person.find({ role: { $in: [WORKER_ROLE, 'sm_manager'] }, status: 'active' }).lean();
  const owners = await ownerCandidates(members);
  return {
    candidates: owners.map((c) => ({ ...c, member: c.person, workPreferences: effectiveStepsFor(c.person) })),
  };
}

/**
 * Steps already planned in this plan or run but not yet created as steps: each row's
 * stage owners with their due dates. Rows whose steps exist are already counted.
 */
function plannedStepsFrom(rows) {
  const planned = [];
  for (const r of rows || []) {
    if (r?.stagesGenerated) continue;
    for (const st of Array.isArray(r?.stagePlan) ? r.stagePlan : []) {
      if (st?.ownerId) planned.push({ ownerId: String(st.ownerId._id || st.ownerId), dueDate: st.dueDate || null });
    }
  }
  return planned;
}

/**
 * Suggest stage owners and deadlines for a row before saving
 *
 * @param {Object} input
 * @param {string} input.type Deliverable type (Reel, Static Post, etc.)
 * @param {Date|string} input.postingDate Final posting date (F)
 * @param {boolean} [input.needsScript=false]
 * @param {boolean} [input.needsShoot=false]
 * @param {Array} [input.currentPlanRows=[]] Other rows in the same plan (or run): their owners count
 * @param {Object} [input.context] From buildAutofillContext(); pass it when filling many rows
 * @returns {Promise<{ pipeline: string, hasPostStage: boolean, stages: Array, suggestedPostingOwner: Object|null }>}
 */
export async function autofillRowPlan({
  type,
  postingDate,
  needsScript = false,
  needsShoot = false,
  needsContent = true,
  currentPlanRows = [],
  context = null,
}) {
  const ctx = context || (await buildAutofillContext());
  const normType = normalizeWorkType(type || 'Static Post');
  const finalDate = postingDate ? new Date(postingDate) : new Date();
  const now = new Date();

  const pipelineInfo = getPipelineForContent({
    contentType: normType,
    needsScript: Boolean(needsScript),
    needsShoot: Boolean(needsShoot),
    needsContent: needsContent !== false,
  });

  // A fresh copy per row: the plan's other rows count as planned steps, and each pick in
  // this row is added before the next, so work spreads across the run.
  let candidates = [...ctx.candidates];
  for (const ps of plannedStepsFrom(currentPlanRows)) {
    candidates = candidates.map((c) => (c.id === ps.ownerId ? withPlannedStep(c, ps.dueDate) : c));
  }
  const pickFor = (stageKey, dueDate) => {
    const pick = pickOwner(candidates, { targetDue: dueDate, now, eligible: (c) => c.workPreferences.includes(stageKey) });
    if (pick) candidates = candidates.map((c) => (c.id === pick.candidate.id ? withPlannedStep(c, dueDate) : c));
    return pick;
  };

  const stages = [];
  for (const stageKey of pipelineInfo.stages) {
    const dueDate = calculateStageDueDate(finalDate, pipelineInfo.pipeline, stageKey, pipelineInfo.hasPostStage);
    const pick = pickFor(stageKey, dueDate);
    stages.push(
      pick
        ? {
            stageKey,
            ownerId: pick.candidate.id,
            ownerName: pick.candidate.name,
            dueDate,
            ownerSource: 'suggested',
            dueDateSource: 'auto',
            reason: pick.reason,
            overLimit: pick.overLimit,
            warning: pick.warning,
          }
        : {
            stageKey,
            ownerId: null,
            ownerName: null,
            dueDate,
            ownerSource: 'suggested',
            dueDateSource: 'auto',
            reason: 'No eligible person for this step',
            overLimit: false,
            warning: null,
          },
    );
  }

  // If postable, also suggest posting owner (Post: SM Managers only, by eligibility).
  let suggestedPostingOwner = null;
  if (isPostableWorkType(normType)) {
    const postStage = stages.find((s) => s.stageKey === 'Post');
    const postPick = postStage?.ownerId
      ? { candidate: candidates.find((c) => c.id === postStage.ownerId), reason: postStage.reason, warning: postStage.warning }
      : pickFor('Post', finalDate);
    if (postPick?.candidate) {
      suggestedPostingOwner = {
        _id: postPick.candidate.id,
        name: postPick.candidate.name,
        email: postPick.candidate.member?.email,
        reason: postPick.reason,
        warning: postPick.warning || null,
      };
    }
  }

  return {
    pipeline: pipelineInfo.pipeline,
    hasPostStage: pipelineInfo.hasPostStage,
    stages,
    suggestedPostingOwner,
  };
}
