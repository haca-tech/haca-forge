import mongoose from 'mongoose';
import { afterOwnerChange } from '../workItems/pause.service.js';
import { AssignmentOverride } from './model.js';
import { Person } from '../people/model.js';
import { Department } from '../departments/model.js';
import { WorkItem } from '../workItems/model.js';
import { resolveScope } from '../../lib/scope.js';
import { logActivity } from '../activity/service.js';
import { WORK_TYPE_DEPARTMENT_MAP, READ_ONLY_VIEWER_ROLES, isWorker, effectiveStepsFor, WORKER_ROLE, APPROVER_ROLES, workloadFor } from '@mmp/shared';
import { resolveProfileObjectId } from '../referenceData/service.js';
import { ownerCandidates, pickOwner } from '../workload/service.js';

/**
 * Calculate member workload metrics and capacity bands
 * Healthy: < 65% | High: 65% - 85% | Overloaded: > 85%
 */
export async function calculateMemberWorkloadMetrics(personId, personDoc = null) {
  const person = personDoc || (await Person.findById(personId));
  if (!person) {
    const error = new Error('Person not found');
    error.statusCode = 404;
    throw error;
  }

  const capacity = person.weeklyCapacityHours || person.capacity || 40;

  // Open work items (status not Approved or Published)
  const openItems = await WorkItem.find({
    ownerId: person._id,
    status: { $nin: ['Approved', 'Published'] },
  }).sort({ deadline: 1 });

  const allocatedHours = openItems.reduce((acc, it) => acc + (it.estimatedEffortHrs || 4), 0);
  const workloadPct = capacity > 0 ? Math.round((allocatedHours / capacity) * 100) : 0;

  let capacityBand = 'Healthy';
  if (workloadPct > 85) {
    capacityBand = 'Overloaded';
  } else if (workloadPct >= 65) {
    capacityBand = 'High';
  }

  const availableHours = Math.max(0, capacity - allocatedHours);

  return {
    _id: person._id,
    name: person.name,
    person: {
      _id: person._id,
      name: person.name,
      email: person.email,
      role: person.role,
      jobRole: person.jobRole,
      departmentId: person.departmentId,
      weeklyCapacityHours: capacity,
    },
    capacity,
    allocatedHours,
    availableHours,
    workloadPct,
    capacityBand,
    band: capacityBand,
    activeItemsCount: openItems.length,
    activeWorkItems: openItems,
  };
}

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
    estimatedEffortHrs = 4,
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
    // Stage Work Items: candidates are the people eligible for the step (job role sets it,
    // preferences narrow it; Post is SM Managers only). No fallback to ineligible people.
    candidates = (
      await Person.find({ status: 'active', role: { $in: [WORKER_ROLE, 'sm_manager'] } })
    ).filter((person) => effectiveStepsFor(person).includes(effectiveStageKey));
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
      role: { $nin: ['admin', ...READ_ONLY_VIEWER_ROLES, ...APPROVER_ROLES] },
    };

    if (targetDepartment) {
      deptQuery.departmentId = targetDepartment._id;
    }

    candidates = await Person.find(deptQuery);

    if (candidates.length === 0) {
      candidates = await Person.find({
        status: 'active',
        role: { $nin: ['admin', ...READ_ONLY_VIEWER_ROLES, ...APPROVER_ROLES] },
      });
    }
  }

  if (candidates.length === 0) {
    return {
      recommendedPerson: null,
      rationale: effectiveStageKey
        ? `No active team members available with "${effectiveStageKey}" work preference.`
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
  const members = owners.filter((c) => isWorker(c.person.role));
  const pick = pickOwner(members, { targetDue, now }) || pickOwner(owners, { targetDue, now });
  const best = pick.candidate;
  const deptLabel = targetDepartment ? targetDepartment.name : 'Marketing Operations';

  // The pool, by name (never ranked by load). Hours-based fields are deprecated, kept for
  // one release while a screen still reads them.
  const candidatePool = [];
  for (const c of [...owners].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }))) {
    const legacy = await calculateMemberWorkloadMetrics(c.person._id, c.person);
    candidatePool.push({
      ...legacy,
      newWorkloadPct: Math.round(((legacy.allocatedHours + estimatedEffortHrs) / legacy.capacity) * 100),
      canAccommodate: legacy.availableHours >= estimatedEffortHrs,
      workload: workloadFor(c, c.steps, now),
      recommended: c.id === best.id,
    });
  }
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
      // Deprecated (hours based), kept for one release.
      workloadPct: bestEntry.workloadPct,
      capacityBand: bestEntry.capacityBand,
      allocatedHours: bestEntry.allocatedHours,
      availableHours: bestEntry.availableHours,
      newWorkloadPct: bestEntry.newWorkloadPct,
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
 * Team Workload Aggregator by Department and Capacity Bands
 * Serves Screen 9 (Team Workload)
 */
export async function getTeamWorkload(filters = {}, user) {
  const scope = await resolveScope(user, filters);

  const personQuery = {
    status: 'active',
    role: { $nin: ['admin', ...READ_ONLY_VIEWER_ROLES, ...APPROVER_ROLES] }, // Admin and Executive excluded from operational workload
  };

  if (filters.departmentId && filters.departmentId !== 'all') {
    personQuery.departmentId = filters.departmentId;
  }

  // An empty list means nobody (not everybody).
  if (scope.allowedPersonIds) {
    personQuery._id = { $in: scope.allowedPersonIds };
  }

  const people = await Person.find(personQuery)
    .populate('departmentId', 'name code')
    .sort({ name: 1 });

  // Calculate metrics for each person
  const memberMetrics = await Promise.all(
    people.map((p) => calculateMemberWorkloadMetrics(p._id, p))
  );

  // Group by Department
  const allDepartments = await Department.find({}).sort({ name: 1 });
  const deptMap = new Map();

  for (const d of allDepartments) {
    deptMap.set(d._id.toString(), {
      _id: d._id,
      name: d.name,
      code: d.code,
      totalMembers: 0,
      totalAllocatedHours: 0,
      totalCapacityHours: 0,
      avgWorkloadPct: 0,
      bandCounts: {
        healthy: 0,
        high: 0,
        overloaded: 0,
      },
      members: [],
    });
  }

  // Also handle unassigned department
  const unassignedDeptKey = 'unassigned';
  deptMap.set(unassignedDeptKey, {
    _id: 'unassigned',
    name: 'General / Unassigned',
    code: 'unassigned',
    totalMembers: 0,
    totalAllocatedHours: 0,
    totalCapacityHours: 0,
    avgWorkloadPct: 0,
    bandCounts: {
      healthy: 0,
      high: 0,
      overloaded: 0,
    },
    members: [],
  });

  let totalAllocatedOverall = 0;
  let totalCapacityOverall = 0;
  let overloadedOverall = 0;
  let totalOpenItemsOverall = 0;

  for (const m of memberMetrics) {
    const deptId = (m.person.departmentId?._id || m.person.departmentId)?.toString();
    const group = deptMap.get(deptId) || deptMap.get(unassignedDeptKey);

    group.totalMembers += 1;
    group.totalAllocatedHours += m.allocatedHours;
    group.totalCapacityHours += m.capacity;
    group.members.push(m);

    if (m.capacityBand === 'Healthy') group.bandCounts.healthy += 1;
    else if (m.capacityBand === 'High') group.bandCounts.high += 1;
    else if (m.capacityBand === 'Overloaded') group.bandCounts.overloaded += 1;

    totalAllocatedOverall += m.allocatedHours;
    totalCapacityOverall += m.capacity;
    if (m.capacityBand === 'Overloaded') overloadedOverall += 1;
    totalOpenItemsOverall += m.activeItemsCount;
  }

  // Calculate averages per department
  const departmentsResult = [];
  for (const group of deptMap.values()) {
    if (group.members.length > 0) {
      group.avgWorkloadPct =
        group.totalCapacityHours > 0
          ? Math.round((group.totalAllocatedHours / group.totalCapacityHours) * 100)
          : 0;
      // By name: workload is a planning tool, never a ranking.
      group.members.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'en', { sensitivity: 'base' }));
      departmentsResult.push(group);
    }
  }

  const overallAvgWorkload =
    totalCapacityOverall > 0 ? Math.round((totalAllocatedOverall / totalCapacityOverall) * 100) : 0;

  return {
    summary: {
      totalMembers: memberMetrics.length,
      totalCapacityHours: totalCapacityOverall,
      totalAllocatedHours: totalAllocatedOverall,
      availableCapacityHours: Math.max(0, totalCapacityOverall - totalAllocatedOverall),
      overallAvgWorkload,
      overloadedCount: overloadedOverall,
      totalOpenItems: totalOpenItemsOverall,
    },
    departments: departmentsResult,
    members: memberMetrics,
    team: memberMetrics,
  };
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
