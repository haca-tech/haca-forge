import mongoose from 'mongoose';

/**
 * History of access changes (Phase D writes it: role and calendar scope of a person, a
 * calendar's reviewers / plan approvers / posters / fallback). Who, when, what, before and after.
 */
const accessChangeSchema = new mongoose.Schema(
  {
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
    at: { type: Date, default: Date.now, index: true },
    entityType: { type: String, enum: ['person', 'workflow_config'], required: true },
    entityId: { type: String, required: true, index: true },
    field: { type: String, required: true },
    before: { type: mongoose.Schema.Types.Mixed, default: null },
    after: { type: mongoose.Schema.Types.Mixed, default: null },
    /** The reason given (required on the admin page). */
    note: { type: String, trim: true, default: '' },
    /** Calendar settings: the whole config before and after the save, and the new version (for Restore). */
    configBefore: { type: mongoose.Schema.Types.Mixed, default: null },
    configAfter: { type: mongoose.Schema.Types.Mixed, default: null },
    version: { type: Number, default: null },
  },
  { timestamps: false }
);

export const AccessChange = mongoose.models.AccessChange || mongoose.model('AccessChange', accessChangeSchema);
