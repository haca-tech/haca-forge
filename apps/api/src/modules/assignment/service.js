import mongoose from 'mongoose';
import { afterOwnerChange } from '../workItems/pause.service.js';
import { AssignmentOverride } from './model.js';
import { Person } from '../people/model.js';
import { Department } from '../departments/model.js';
import { WorkItem } from '../workItems/model.js';
import { logActivity } from '../activity/service.js';
import { WORK_TYPE_DEPARTMENT_MAP, READ_ONLY_VIEWER_ROLES, isWorker, effectiveStepsFor, WORKER_ROLE, APPROVER_ROLES, workloadFor } from '@mmp/shared';
import { resolveProfileObjectId } from '../referenceData/service.js';
import { ownerCandidates, pickOwner } from '../workload/service.js';
import { isOwnScope, stepTakingRoles } from '../../lib/roleAccess.js';
import { assertCanOwnStep, narrowByPreferences, ownerProblem } from '../workItems/ownerRule.js';

/**
 * Auto-Assignment Recommendation Engine
 * Recommends an assignee with the shared owner rule (pickOwner in @mmp/shared): eligible
 * (step or department), team members first, then fewest steps due in the target step's
 * 7-day window, fewest in progress, name, id. Nobody is left out for load: when everyone is
 * over their limit the pick still comes back, with an over-limit warning. Revision history,
 * ratings and speed are never factors. Never assigns silently; returns a readable rationale.
 */
export async function recommendAssignee(criteria = {}, user) {
  const {
    workType,
    departmentId,
    deadline,
    stageKey,
    workItemId,
  } = criteria;

  let effectiveStageKey = stageKey || null;

  let targetDue = deadline || null;
  // Infer stageKey (and the due date) from existing work item if provided
  if (workItemId && mongoose.Types.ObjectId.isValid(workItemId)) {
    const item = await WorkItem.findById(workItemId);
    if (item && !effectiveStageKey && item.stageKey) {
      effectiveStageKey = item.stageKey;
    }
    if (item && !targetDue) targetDue = item.dueDate || item.deadline || null;
  }

  let candidates = [];
  let targetDepartment = null;

  if (effectiveStageKey) {
    // Stage Work Items: the same people the owner dropdown offers (the one owner rule: active, the
    // job role sets eligibility, a poster on the step's calendar for Post). Work preferences only
    // narrow that: people who set preferences without this step are passed over, unless that
    // would leave nobody. So the suggestion is always someone the dropdown offers, and there is a
    // suggestion whenever the dropdown has anyone.
    const item = workItemId && mongoose.Types.ObjectId.isValid(workItemId) ? await WorkItem.findById(workItemId).select('calendar').lean() : null;
    const step = { stageKey: effectiveStageKey, calendar: item?.calendar || criteria.calendar || 'sm' };
    const eligible = [];
    for (const person of await Person.find({ status: 'active', role: { $in: stepTakingRoles() } })) {
      if (!(await ownerProblem(person, step))) eligible.push(person);
    }
    candidates = narrowByPreferences(eligible, effectiveStageKey);
  } else {
    // Standalone Work Items: Candidates come from target department responsible for workType
    if (departmentId && mongoose.Types.ObjectId.isValid(departmentId)) {
      targetDepartment = await Department.findById(departmentId);
    } else if (workType && WORK_TYPE_DEPARTMENT_MAP[workType]) {
      const deptCode = WORK_TYPE_DEPARTMENT_MAP[workType];
      targetDepartment = await Department.findOne({
        $or: [{ code: deptCode }, { name: new RegExp(`^${deptCode}$`, 'i') }],
      });
    }

    const deptQuery = {
      status: 'active',
      role: { $in: stepTakingRoles() },
    };

    if (targetDepartment) {
      deptQuery.departmentId = targetDepartment._id;
    }

    candidates = await Person.find(deptQuery);

    if (candidates.length === 0) {
      candidates = await Person.find({
        status: 'active',
        role: { $in: stepTakingRoles() },
      });
    }
  }

  if (candidates.length === 0) {
    return {
      recommendedPerson: null,
      rationale: effectiveStageKey
        ? `Nobody active can own ${effectiveStageKey} steps${effectiveStageKey === 'Post' ? ' on this calendar (posters only)' : ' (by job role)'}.`
        : 'No active team members available for assignment.',
      stageKey: effectiveStageKey,
      department: targetDepartment,
      candidatePool: [],
      isOverloadWarning: false,
    };
  }

  // 3. Workload (step counts) for each candidate, then the shared owner rule.
  const now = new Date();
  const owners = await ownerCandidates(candidates);
  const members = owners.filter((c) => isOwnScope(c.person));
  const pick = pickOwner(members, { targetDue, now }) || pickOwner(owners, { targetDue, now });
  const best = pick.candidate;
  const deptLabel = targetDepartment ? targetDepartment.name : 'Marketing Operations';

  // The pool, by name (never ranked by load): step counts only.
  const candidatePool = [...owners]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))
    .map((c) => ({
      _id: c.person._id,
      name: c.person.name,
      person: { _id: c.person._id, name: c.person.name, email: c.person.email, role: c.person.role, jobRole: c.person.jobRole, departmentId: c.person.departmentId },
      workload: workloadFor(c, c.steps, now),
      recommended: c.id === best.id,
    }));
  const bestEntry = candidatePool.find((c) => c.recommended);

  // 4. Explainable rationale
  const isOverloadWarning = pick.overLimit;
  const why = effectiveStageKey ? `matched work preference "${effectiveStageKey}"` : `suitable skill in ${deptLabel}`;
  const rationale = `Recommended Owner: ${best.name}. Reason: ${why}; ${pick.reason}.${pick.warning ? ` ${pick.warning}` : ''}`;

  return {
    recommendedPerson: bestEntry.person,
    recommendedMetrics: {
      ...bestEntry.workload,
      dueInWindow: pick.dueInWindow,
      overLimit: pick.overLimit,
    },
    rationale,
    reason: pick.reason,
    overLimitWarning: pick.warning,
    stageKey: effectiveStageKey,
    department: targetDepartment,
    candidatePool,
    isOverloadWarning,
  };
}

/**
 * Record an Assignment Override when a lead/admin departs from auto-assignment recommendation
 */
export async function recordAssignmentOverride(data, user) {
  const { workItemId, recommendedPersonId, chosenPersonId, reason, metadata = {} } = data;

  const workItem = await WorkItem.findById(workItemId);
  if (!workItem) {
    const error = new Error('Work item not found');
    error.statusCode = 404;
    throw error;
  }

  const [recommendedPerson, chosenPerson] = await Promise.all([
    Person.findById(recommendedPersonId),
    Person.findById(chosenPersonId),
  ]);

  if (!recommendedPerson || !chosenPerson) {
    const error = new Error('Recommended or chosen person not found');
    error.statusCode = 400;
    throw error;
  }
  // The one owner rule: active, eligible for the step, a poster on the calendar for Post (400).
  await assertCanOwnStep(chosenPerson, workItem);

  const override = await AssignmentOverride.create({
    workItemId,
    recommendedPersonId,
    chosenPersonId,
    overriddenById: user._id || user.id,
    reason: reason.trim(),
    metadata: {
      ...metadata,
      workItemTitle: workItem.title,
      recommendedName: recommendedPerson.name,
      chosenName: chosenPerson.name,
    },
  });

  // Update workItem owner to chosen person
  workItem.ownerId = chosenPersonId;
  await workItem.save();
  await afterOwnerChange([workItem._id], user);

  // Audit activity
  await logActivity({
    entityType: 'work_item',
    entityId: workItem._id,
    actor: user,
    action: 'assignment.overridden',
    metadata: {
      fromPersonId: recommendedPersonId,
      fromPersonName: recommendedPerson.name,
      toPersonId: chosenPersonId,
      toPersonName: chosenPerson.name,
      reason: reason.trim(),
    },
  });

  return override;
}

/**
 * List historical assignment overrides
 */
export async function listAssignmentOverrides(filters = {}, user) {
  const query = {};
  if (filters.workItemId) query.workItemId = filters.workItemId;

  return AssignmentOverride.find(query)
    .populate('workItemId', 'title workType deadline')
    .populate('recommendedPersonId', 'name email role jobRole')
    .populate('chosenPersonId', 'name email role jobRole')
    .populate('overriddenById', 'name email role')
    .sort({ createdAt: -1 })
    .limit(50);
}
