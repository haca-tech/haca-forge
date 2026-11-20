import mongoose from 'mongoose';
import { CALENDAR_KEYS, ROLE_KEYS } from '@mmp/shared';

/**
 * Who reviews, approves plans and posts on one calendar (Phase B: stored, not yet read by the
 * app). One document per calendar. Each slot lists roles and/or named people; several are
 * allowed, all are notified, the first to act decides. `fallbackApprovers` is used when no
 * active primary resolves (fixed rule 12). Seeded from today's rules by
 * scripts/seed-workflow-config.js. Every change bumps `version` (the resolver cache key).
 */
const audienceSchema = new mongoose.Schema(
  {
    roles: { type: [{ type: String, enum: ROLE_KEYS }], default: [] },
    userIds: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Person' }], default: [] },
  },
  { _id: false }
);

const workflowConfigSchema = new mongoose.Schema(
  {
    calendar: { type: String, enum: CALENDAR_KEYS, required: true, unique: true },
    reviewers: { type: audienceSchema, default: () => ({}) },
    planApprovers: { type: audienceSchema, default: () => ({}) },
    posters: { type: audienceSchema, default: () => ({}) },
    fallbackApprovers: { type: audienceSchema, default: () => ({ roles: ['admin'] }) },
    version: { type: Number, default: 1 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
  },
  { timestamps: true }
);

// Any change to an existing config bumps its version.
workflowConfigSchema.pre('save', function (next) {
  if (!this.isNew && this.isModified()) this.version = (this.version || 1) + 1;
  next();
});

/** Listeners told when a config changes (the resolver cache). */
const changeListeners = new Set();
export const onWorkflowConfigChange = (fn) => {
  changeListeners.add(fn);
  return () => changeListeners.delete(fn);
};
const notify = (calendar) => changeListeners.forEach((fn) => fn(calendar));
workflowConfigSchema.post('save', (doc) => notify(doc.calendar));
workflowConfigSchema.post(['findOneAndUpdate', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'findOneAndDelete'], () => notify(null));

export const WorkflowConfig = mongoose.models.WorkflowConfig || mongoose.model('WorkflowConfig', workflowConfigSchema);
