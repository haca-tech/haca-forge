import mongoose from 'mongoose';
import { HELP_TARGET_KINDS, HELP_TOPICS } from '@mmp/shared';

/**
 * A step owner's request for help, sent to one person: the step's deciding lead, an SM
 * Manager, or the owner of another step on the same piece. It never pauses or blocks the
 * step and never touches work time or KPIs: it lives in its own collection and the step
 * record is not written. open → resolved; replies are kept on the request.
 */
const replySchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true },
    text: { type: String, trim: true, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: true }
);

const helpRequestSchema = new mongoose.Schema(
  {
    workItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'WorkItem', required: true, index: true },
    contentPieceId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentPiece', default: null },
    askerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    helperId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', required: true, index: true },
    helperKind: { type: String, enum: [...HELP_TARGET_KINDS], required: true },
    topic: { type: String, enum: [...HELP_TOPICS], required: true },
    message: { type: String, trim: true, required: true },
    link: { type: String, trim: true, default: '' },
    status: { type: String, enum: ['open', 'resolved'], default: 'open', index: true },
    replies: { type: [replySchema], default: [] },
    resolvedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

helpRequestSchema.index({ workItemId: 1, status: 1 });

export const HelpRequest = mongoose.models.HelpRequest || mongoose.model('HelpRequest', helpRequestSchema);
