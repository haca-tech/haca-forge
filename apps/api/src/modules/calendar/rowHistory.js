import mongoose from 'mongoose';
import { logActivity } from '../activity/service.js';
import { ActivityEvent } from '../activity/model.js';

/**
 * A plan row's history (Phase 13): change requests, applied suggestions, resubmits and
 * approvals, as activity events on the row. Read back with rowHistory().
 */
export const ROW_HISTORY_ACTIONS = ['row.changes_requested', 'row.suggestion_applied', 'row.resubmitted', 'row.approved'];

export function logRowHistory(rowId, actor, action, metadata = {}) {
  return logActivity({ entityType: 'content_piece', entityId: rowId, actor, action, metadata });
}

export async function rowHistory(rowId) {
  const events = await ActivityEvent.find({
    entityType: 'content_piece',
    // Stored as an ObjectId (Mixed field); match the string form too.
    entityId: { $in: mongoose.isValidObjectId(rowId) ? [new mongoose.Types.ObjectId(String(rowId)), String(rowId)] : [String(rowId)] },
    action: { $in: ROW_HISTORY_ACTIONS },
  })
    .sort({ timestamp: 1 })
    .populate('actorId', 'name role')
    .lean();
  return events.map((e) => ({
    action: e.action.replace('row.', ''),
    at: e.timestamp,
    by: e.actorId ? { name: e.actorId.name, role: e.actorId.role } : null,
    message: e.metadata?.message || '',
    suggestions: e.metadata?.suggestions || null,
    applied: e.metadata?.applied || null,
    // The row's values when the lead asked (so history shows "16 Nov → 18 Nov" as it was).
    before: e.metadata?.before || null,
    withPlan: Boolean(e.metadata?.withPlan),
  }));
}
