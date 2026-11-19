import mongoose from 'mongoose';
import { PAUSE_REASONS } from '@mmp/shared';

/**
 * A worker's request to pause a step (decided by the step's lead). One record per request,
 * kept for the history: pending → cancelled | rejected | approved → resumed. At most one
 * pending request per step (partial unique index). The step itself carries `pauseState` and,
 * while paused, an open `manual_pause` interval.
 */
const pauseRequestSchema = new mongoose.Schema(
  {
    workItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkItem', required: true, index: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    reason: { type: String, enum: [...PAUSE_REASONS], required: true },
    note: { type: String, trim: true, required: true },
    urgentStepId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkItem', default: null },
    /** The IST day the worker expects to resume (a reminder that morning; nothing ends automatically). */
    pauseUntil: { type: String, default: null },
    status: { type: String, enum: ['pending', 'cancelled', 'rejected', 'approved', 'resumed'], default: 'pending', index: true },
    requestedAt: { type: Date, default: Date.now },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: null },
    decidedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
    decidedAt: { type: Date, default: null },
    decisionMessage: { type: String, trim: true, default: '' },
    resumedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
    resumedAt: { type: Date, default: null },
    leadRemindedAt: { type: Date, default: null },
    untilRemindedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

pauseRequestSchema.index({ workItemId: 1 }, { unique: true, partialFilterExpression: { status: 'pending' }, name: 'one_pending_per_step' });

export const PauseRequest = mongoose.models.PauseRequest || mongoose.model('PauseRequest', pauseRequestSchema);
