import { FeedbackEntry, RevisionFlag } from './model.js';
import { logger } from '../../lib/logger.js';
import { assertDecidesOn, calendarOf, calendarQueryFor, decisionCalendarFilter } from '../workItems/deciders.js';
import { WorkItem } from '../workItems/model.js';
import { Person } from '../people/model.js';
import { logActivity } from '../activity/service.js';
import { createNotification } from '../notifications/service.js';
/** A step is flagged when it reaches this review round (Phase 7 close-out). */
export const REVISION_FLAG_ROUND = 4;
import { resolveScope } from '../../lib/scope.js';
import { CANONICAL_REVISION_ROOT_CAUSES, normalizeRole, APPROVER_ROLES, isApprover, isReadOnlyViewer, isWorker, deciderRoleFor } from '@mmp/shared';
import { isTeamMember, requireParticipant } from '../workItems/access.js';
import {
  assertDecisionAllowed,
  claimSubmission,
  releaseSubmission,
  afterDecision,
  applyChangesRequested,
} from '../submissions/reviewDecision.js';
import * as access from '../../lib/accessResolver.js';
import { hasPermission, isOwnScope } from '../../lib/roleAccess.js';

/**
 * Get full feedback thread and revision flag status for a work item
 */
export async function getFeedbackForWorkItem(workItemId, user) {
  const workItem = await WorkItem.findById(workItemId)
    .populate('departmentId', 'name code')
    .populate('ownerId', 'name email role jobRole');

  if (!workItem) {
    const error = new Error('Work item not found');
    error.statusCode = 404;
    throw error;
  }

  // Feedback is private to the step owner and leadership. Executives see the item, not the notes.
  const userId = (user._id || user.id || user.userId)?.toString();
  if (isTeamMember(user) && workItem.ownerId?._id?.toString() !== userId) {
    const error = new Error('You do not have access to this work item feedback');
    error.statusCode = 403;
    throw error;
  }
  // The read-only heads see review text (Phase 12b): no separate branch for them.

  // Fetch entries sorted chronologically
  const entries = await FeedbackEntry.find({ workItemId })
    .populate('fromPersonId', 'name email role jobRole')
    .sort({ round: 1, isResponse: 1, createdAt: 1 });

  // Group into structured rounds
  const roundsMap = new Map();
  for (const entry of entries) {
    const roundNum = entry.round;
    if (!roundsMap.has(roundNum)) {
      roundsMap.set(roundNum, {
        roundNumber: roundNum,
        reviewerFeedback: null,
        ownerResponse: null,
        status: 'In Progress',
        createdAt: entry.createdAt,
      });
    }
    const roundData = roundsMap.get(roundNum);
    if (!entry.isResponse) {
      roundData.reviewerFeedback = entry;
      roundData.status = entry.roundStatus;
    } else {
      roundData.ownerResponse = entry;
    }
  }

  const rounds = Array.from(roundsMap.values());

  // Check for revision flag
  const flag = await RevisionFlag.findOne({ workItemId })
    .populate('ownerId', 'name email role jobRole')
    .populate('classifiedBy', 'name email role');

  return {
    workItem,
    entries,
    rounds,
    flag: flag
      ? {
          ...flag.toObject(),
          isOver48HoursUnclassified: flag.isOver48HoursUnclassified,
        }
      : null,
  };
}

/**
 * Submit a feedback entry (reviewer feedback or owner response)
 */
export async function createFeedbackEntry(data, user) {
  const { workItemId, text, attachments = [] } = data;
  if (isTeamMember(user)) await requireParticipant(workItemId, user);
  let { round, roundStatus = 'Revision Required', isResponse = false } = data;

  const workItem = await WorkItem.findById(workItemId)
    .populate('ownerId', 'name email role jobRole');

  if (!workItem) {
    const error = new Error('Work item not found');
    error.statusCode = 404;
    throw error;
  }

  // Resolve sender person
  const userId = (user._id || user.id || user.userId)?.toString();
  const fromPerson = await Person.findOne({
    $or: [{ userId }, { _id: userId }],
  });

  if (!fromPerson) {
    const error = new Error('Authenticated person record not found');
    error.statusCode = 400;
    throw error;
  }

  const ownerIdStr = workItem.ownerId?._id?.toString() || workItem.ownerId?.toString();
  const userRole = normalizeRole(user.role);
  const isAdminOrHead = hasPermission(user, 'review.decide');

  // Determine round if not explicitly supplied
  const existingEntries = await FeedbackEntry.find({ workItemId }).sort({ round: -1, createdAt: -1 });
  let submissionToDecide = null;
  const latestRound = existingEntries.length > 0 ? existingEntries[0].round : 0;

  if (isResponse) {
    // Owner response logic
    if (isOwnScope(user) && ownerIdStr !== fromPerson._id.toString()) {
      const error = new Error('Only the assigned owner can respond to review feedback');
      error.statusCode = 403;
      throw error;
    }

    if (!round) {
      round = latestRound || 1;
    }

    // Verify a reviewer entry exists for this round
    const reviewerEntry = await FeedbackEntry.findOne({
      workItemId,
      round,
      isResponse: false,
    });

    if (!reviewerEntry) {
      const error = new Error(`Cannot submit owner response for Round ${round} without reviewer feedback`);
      error.statusCode = 400;
      throw error;
    }
  } else {
    // Reviewer feedback logic. This route cannot approve: approval needs a rating, through the review flow.
    if (roundStatus === 'Approved') {
      const error = new Error('Approve this step through the review flow, where a rating is required.');
      error.statusCode = 409;
      error.code = 'USE_REVIEW_FLOW';
      throw error;
    }

    // Everything is checked before the first write.
    submissionToDecide = await assertDecisionAllowed({ user, workItem, decision: 'revision' });

    // Auto-advance round if latest round has already been reviewed
    if (!round) {
      const hasReviewerInLatest = existingEntries.some(
        (e) => e.round === latestRound && !e.isResponse
      );
      round = hasReviewerInLatest ? latestRound + 1 : Math.max(1, latestRound);
    }
  }

  // A reviewer's entry is a decision: claim the latest version first, so only one decision can win.
  if (submissionToDecide) {
    await claimSubmission(submissionToDecide, 'changes_requested', user);
  }

  // Create feedback entry
  let entry;
  const fromStatus = workItem.status;
  try {
    entry = await FeedbackEntry.create({
      workItemId,
      round,
      fromPersonId: fromPerson._id,
      roundStatus,
      text,
      isResponse,
      attachments,
    });

    // Update WorkItem state based on entry
    if (!isResponse) {
      // The same end state as every other revision path.
      applyChangesRequested(workItem);
      await workItem.save();
    }
  } catch (error) {
    if (entry) await FeedbackEntry.deleteOne({ _id: entry._id });
    if (submissionToDecide) await releaseSubmission(submissionToDecide);
    throw error;
  }

  if (!isResponse) {
    // The decision is saved. What follows must not fail it.
    await afterDecision('the feedback event', () =>
      logActivity({
        entityType: 'work_item',
        entityId: workItem._id,
        actor: user,
        action: 'work_item.feedback_submitted',
        fromStatus,
        toStatus: workItem.status,
        metadata: {
          round,
          roundStatus,
          text,
          revisions: workItem.revisions,
        },
      })
    );

    // Notify WorkItem Owner
    if (workItem.ownerId?._id && workItem.ownerId._id.toString() !== fromPerson._id.toString()) {
      await afterDecision('the feedback notification', () =>
        createNotification({
          recipient: workItem.ownerId._id,
          type: 'work_item.feedback',
          title: `Feedback on Round ${round}: ${workItem.title}`,
          message: `${fromPerson.name} marked "${workItem.title}" as ${roundStatus}.`,
          link: `/work/${workItem._id}`,
          metadata: { workItemId: workItem._id, round, roundStatus },
        })
      );
    }

    // CHECK REVISION FLAG INVARIANT:
    // Trigger automatically when revisions >= 4 OR revisions > (ownerBaselineAvg + 1)
    await afterDecision('the revision flag check', () => checkAndCreateRevisionFlag(workItem, user));
  } else {
    // Owner responded
    await logActivity({
      entityType: 'work_item',
      entityId: workItem._id,
      actor: user,
      action: 'work_item.feedback_response',
      metadata: {
        round,
        text,
      },
    });
  }

  return FeedbackEntry.findById(entry._id).populate('fromPersonId', 'name email role jobRole');
}

/**
 * Where the step stands in its current review cycle, from the step itself. A cycle runs from
 * the step's start (or the round after its last approval, when it was reopened) to now. The
 * round due is the change requests in this cycle + 1 (Phase 7: flag at round 4, three change
 * requests). Steps without rounds (older data) count their revisions as one cycle.
 */
export function revisionCycleOf(step) {
  const rounds = Array.isArray(step?.rounds) ? step.rounds : [];
  if (!rounds.length) {
    const changeRequests = step?.revisions || 0;
    return { cycle: 0, changeRequests, round: changeRequests + 1 };
  }
  let start = 0;
  let cycle = 0;
  rounds.forEach((r, i) => {
    if (r?.decision === 'approved' && i < rounds.length - 1) {
      start = i + 1;
      cycle += 1;
    }
  });
  const changeRequests = rounds.slice(start).filter((r) => r?.decision === 'changes_requested').length;
  return { cycle, changeRequests, round: changeRequests + 1 };
}

/**
 * Flag a step when its current cycle reaches round 4: at most one flag per step per crossing.
 * A step reopened later that reaches round 4 again is flagged again (the same record is
 * re-armed; the earlier crossing is kept in previousCrossings). The lead of the step's
 * calendar and the department's SM Manager are alerted once per crossing.
 * Callers run this after the decision is saved and never let it fail the decision.
 */
export async function checkAndCreateRevisionFlag(workItem, actor = null) {
  const ownerId = workItem.ownerId?._id || workItem.ownerId;
  if (!ownerId) return null;
  const { cycle, changeRequests, round } = revisionCycleOf(workItem);

  const existing = await RevisionFlag.findOne({ workItemId: workItem._id });
  const sameCrossing = existing && (existing.cycle ?? 0) === cycle;
  if (sameCrossing) {
    if (existing.revisionsCount !== changeRequests && round >= REVISION_FLAG_ROUND) {
      existing.revisionsCount = changeRequests;
      await existing.save();
    }
    return existing;
  }
  if (round < REVISION_FLAG_ROUND) return existing || null;

  const now = new Date();
  let flag;
  if (existing) {
    // A new crossing after a reopen: re-arm the record, keeping the earlier crossing.
    flag = await RevisionFlag.findOneAndUpdate(
      { _id: existing._id, cycle: existing.cycle ?? 0 },
      {
        $push: {
          previousCrossings: {
            cycle: existing.cycle ?? 0,
            revisionsCount: existing.revisionsCount,
            flaggedAt: existing.flaggedAt,
            rootCause: existing.rootCause || null,
            rootCauseNotes: existing.rootCauseNotes || '',
            classifiedBy: existing.classifiedBy || null,
            classifiedAt: existing.classifiedAt || null,
          },
        },
        $set: {
          cycle,
          ownerId,
          revisionsCount: changeRequests,
          isFlagged: true,
          flaggedAt: now,
          rootCause: null,
          rootCauseNotes: '',
          classifiedBy: null,
          classifiedAt: null,
          isEscalated: false,
          escalatedAt: null,
        },
      },
      { new: true }
    );
    if (!flag) return RevisionFlag.findOne({ workItemId: workItem._id }); // another decision re-armed it first
  } else {
    try {
      flag = await RevisionFlag.create({ workItemId: workItem._id, ownerId, revisionsCount: changeRequests, cycle, isFlagged: true, flaggedAt: now });
    } catch (err) {
      if (err?.code === 11000) return RevisionFlag.findOne({ workItemId: workItem._id }); // created by a parallel decision
      throw err;
    }
  }

  const actorObj =
    actor && (actor._id || actor.id || actor.userId) ? actor : { _id: ownerId, role: 'system', name: 'Revision Engine' };
  await logActivity({
    entityType: 'work_item',
    entityId: workItem._id,
    actor: actorObj,
    action: 'revision.flagged',
    metadata: { revisionsCount: changeRequests, round, cycle, reason: `Reached round ${round} (${changeRequests} change requests)` },
  });

  // Alert the lead of the step's calendar and the department's SM Manager, once per crossing.
  const alertPersons = await access.recipientsFor('revision.flagged', workItem);
  for (const recipient of alertPersons) {
    await createNotification({
      recipient: recipient._id,
      type: 'revision.flagged',
      title: `Revision Flag Triggered: ${workItem.title}`,
      message: `"${workItem.title}" reached round ${round} (${changeRequests} change requests). Root cause classification required.`,
      link: `/feedback?tab=flagged&step=${workItem._id}`,
      metadata: { workItemId: workItem._id, revisionsCount: changeRequests, round, cycle },
    });
  }
  return flag;
}

/** After a change request is saved (every revision path): flag at round 4, never failing the decision. */
export async function flagAfterChangesRequested(workItem, actor) {
  try {
    return await checkAndCreateRevisionFlag(workItem, actor);
  } catch (err) {
    logger.error({ err: err.message, workItemId: String(workItem?._id) }, 'Revision flag check failed; the decision stands');
    return null;
  }
}

/**
 * Classify root cause for a revision flag (SM Manager, Creative Manager or Admin)
 */
export async function classifyRevisionFlag(flagId, { rootCause, rootCauseNotes }, user) {
  if (isOwnScope(user)) {
    const error = new Error('Only an SM Manager, Creative Manager, or Admin can classify revision root causes');
    error.statusCode = 403;
    throw error;
  }

  // New classifications accept the 7 canonical causes only; legacy values on saved flags stay readable.
  if (!CANONICAL_REVISION_ROOT_CAUSES.includes(rootCause)) {
    const error = new Error(
      `Invalid root cause: "${rootCause}". Must be one of: ${CANONICAL_REVISION_ROOT_CAUSES.join(', ')}`
    );
    error.statusCode = 400;
    throw error;
  }

  const flag = await RevisionFlag.findById(flagId)
    .populate('workItemId', 'title departmentId calendar ownerId')
    .populate('ownerId', 'name email role');

  if (!flag) {
    const error = new Error('Revision flag not found');
    error.statusCode = 404;
    throw error;
  }
  // Phase 13: the lead of the step's calendar (or admin) classifies its root cause.
  // Phase C5: never on your own step (403 SELF_DECISION), like every other decision.
  await assertDecidesOn(user, calendarOf(flag.workItemId), {
    roleCode: 'FORBIDDEN_ACTION',
    permission: 'revision.classify',
    ownerId: flag.workItemId?.ownerId?._id || flag.workItemId?.ownerId || null,
  });

  const userId = (user._id || user.id || user.userId)?.toString();
  const classifierPerson = await Person.findOne({
    $or: [{ userId }, { _id: userId }],
  });

  flag.rootCause = rootCause;
  flag.rootCauseNotes = rootCauseNotes?.trim() || '';
  flag.classifiedBy = classifierPerson?._id || null;
  flag.classifiedAt = new Date();
  await flag.save();

  // Log ActivityEvent
  await logActivity({
    entityType: 'work_item',
    entityId: flag.workItemId._id,
    actor: user,
    action: 'revision.classified',
    metadata: {
      flagId: flag._id,
      rootCause,
      rootCauseNotes: flag.rootCauseNotes,
      classifiedBy: classifierPerson?.name,
    },
  });

  return RevisionFlag.findById(flag._id)
    .populate('workItemId', 'title workType status deadline')
    .populate('ownerId', 'name email role jobRole')
    .populate('classifiedBy', 'name email role');
}

/**
 * List revision flags with status filter and escalation evaluation
 */
export async function listRevisionFlags(filters = {}, user) {
  const query = {};

  if (filters.status === 'unclassified') {
    query.rootCause = null;
  } else if (filters.status === 'classified') {
    query.rootCause = { $ne: null };
  }

  if (filters.ownerId) {
    query.ownerId = filters.ownerId;
  }

  const flags = await RevisionFlag.find(query)
    .populate({
      path: 'workItemId',
      select: 'title workType status deadline departmentId revisions',
      populate: [
        { path: 'departmentId', select: 'name code' },
      ],
    })
    .populate('ownerId', 'name email role jobRole departmentId')
    .populate('classifiedBy', 'name email role')
    .sort({ flaggedAt: -1 });

  // Map and compute escalation status
  const mapped = flags.map((f) => {
    const obj = f.toObject();
    const isEscalated =
      f.isEscalated || (!f.rootCause && Date.now() - new Date(f.flaggedAt).getTime() > 48 * 3600 * 1000);
    return {
      ...obj,
      isEscalated,
      isOver48HoursUnclassified: isEscalated,
    };
  });

  if (filters.status === 'escalated') {
    return mapped.filter((f) => f.isEscalated);
  }

  return mapped;
}

/**
 * List all active feedback threads across deliverables
 */
export async function listFeedbackThreads(filters = {}, user) {
  const scope = resolveScope(user, filters);

  const workItemsQuery = {
    ...scope,
    $or: [{ status: 'Feedback' }, { status: 'Pending' }, { revisions: { $gt: 0 } }],
  };
  // Phase 13: a lead sees the threads of their own calendars.
  const myCalendars = await decisionCalendarFilter(user);
  if (myCalendars) workItemsQuery.$and = [...(workItemsQuery.$and || []), calendarQueryFor(myCalendars)];

  if (filters.departmentId) {
    workItemsQuery.departmentId = filters.departmentId;
  }

  const workItems = await WorkItem.find(workItemsQuery)
    .populate('departmentId', 'name code')
    .populate('ownerId', 'name email role jobRole')
    .sort({ updatedAt: -1 })
    .limit(filters.limit ? Number(filters.limit) : 50);

  // Which of them wait on a reviewer (the rest in 'Feedback' were sent back for changes).
  const { awaitingReviewIds } = await import('../workItems/reviewState.js');
  const awaiting = await awaitingReviewIds(workItems);

  // For each work item, fetch latest feedback round and check if flagged
  const results = await Promise.all(
    workItems.map(async (item) => {
      const latestEntry = await FeedbackEntry.findOne({ workItemId: item._id })
        .populate('fromPersonId', 'name email role')
        .sort({ round: -1, createdAt: -1 });

      const totalEntries = await FeedbackEntry.countDocuments({ workItemId: item._id });
      const flag = await RevisionFlag.findOne({ workItemId: item._id });

      return {
        workItem: item,
        awaitingReview: awaiting.has(String(item._id)),
        latestEntry,
        totalEntries,
        revisions: item.revisions || 0,
        flag: flag
          ? {
              ...flag.toObject(),
              isOver48HoursUnclassified: flag.isOver48HoursUnclassified,
            }
          : null,
      };
    })
  );

  return results;
}
