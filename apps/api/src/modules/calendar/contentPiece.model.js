import mongoose from 'mongoose';
import { ROW_STATUSES, WORK_TYPES, CALENDAR_KEYS } from '@mmp/shared';

const contentPieceSchema = new mongoose.Schema(
  {
    planId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CalendarPlan',
      required: true,
      index: true,
    },
    postingDate: {
      type: Date,
      required: true,
      index: true,
    },
    postingTime: {
      type: String,
      trim: true,
      default: '18:00',
    },
    topic: {
      type: String,
      required: true,
      trim: true,
    },
    contentType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    calendar: {
      type: String,
      enum: CALENDAR_KEYS,
      default: 'sm',
      index: true,
    },
    programOrEvent: {
      type: String,
      trim: true,
      default: '',
    },
    brief: {
      type: String,
      trim: true,
      default: '',
    },
    referenceLink: {
      type: String,
      trim: true,
      default: '',
    },
    priority: {
      type: String,
      enum: ['Normal', 'Urgent', 'High', 'Medium', 'Low'],
      default: 'Normal',
    },
    postingOwnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
    },
    sourceVideoLink: {
      type: String,
      trim: true,
      default: '',
    },
    needsScript: {
      type: Boolean,
      default: false,
    },
    needsShoot: {
      type: Boolean,
      default: false,
    },
    // Static Post / Carousel Post: false = Design only. No default, so existing rows are not
    // rewritten; a missing value means With content.
    needsContent: {
      type: Boolean,
    },
    contentLink: {
      type: String,
      trim: true,
      default: '',
    },
    remarks: {
      type: String,
      trim: true,
      default: '',
    },
    rowStatus: {
      type: String,
      enum: ROW_STATUSES,
      default: 'draft',
      index: true,
    },
    reviewComment: {
      type: String,
      trim: true,
      default: null,
    },
    // Phase 13: the lead's open change request on this row (message plus optional suggested
    // values). Cleared when a suggestion is applied or the row is resubmitted; the row history
    // (activity events) keeps every request.
    changeRequest: {
      type: new mongoose.Schema(
        {
          message: { type: String, trim: true, required: true },
          suggestions: {
            postingDate: { type: String, default: undefined },
            topic: { type: String, default: undefined },
            type: { type: String, default: undefined },
            workflow: { type: String, default: undefined },
            brief: { type: String, default: undefined },
          },
          requestedById: { type: mongoose.Schema.Types.ObjectId, ref: 'Person', default: null },
          requestedAt: { type: Date, default: Date.now },
        },
        { _id: false }
      ),
      default: null,
    },
    stagePlan: [
      {
        stageKey: {
          type: String,
          enum: ['Content', 'Script', 'Design', 'Shoot', 'Edit', 'Post'],
          required: true,
        },
        ownerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Person',
          default: null,
        },
        dueDate: {
          type: Date,
          required: true,
        },
        ownerSource: {
          type: String,
          enum: ['suggested', 'manual'],
          default: 'suggested',
        },
        dueDateSource: {
          type: String,
          enum: ['auto', 'manual'],
          default: 'auto',
        },
        overrideReason: {
          type: String,
          default: '',
        },
        // Why autofill picked this owner, and its over-limit warning (suggested owners only).
        ownerReason: {
          type: String,
        },
        ownerWarning: {
          type: String,
        },
      },
    ],
    pipeline: {
      type: String,
      enum: ['design', 'reel_a', 'reel_b', 'reel_c'],
      required: true,
      index: true,
    },
    hasPostStage: {
      type: Boolean,
      default: true,
    },
    stagesGenerated: {
      type: Boolean,
      default: false,
      index: true,
    },
    /** Set while a repair generates the steps of an approved row that has none (one repair at a time). */
    stageRepairClaimedAt: {
      type: Date,
      default: null,
    },
    publishedAt: {
      type: Date,
      default: null,
    },
    liveUrl: {
      type: String,
      trim: true,
      default: '',
    },
    turnaroundDays: {
      type: Number,
      default: null,
    },
    createdById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
    },
    /** Who last submitted the row for approval (nobody approves a row they submitted). */
    submittedById: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Person',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

contentPieceSchema.virtual('type').get(function () {
  return this.contentType;
}).set(function (val) {
  this.contentType = val;
});

contentPieceSchema.index({ planId: 1, rowStatus: 1 });
contentPieceSchema.index({ postingDate: 1, contentType: 1 });

export const ContentPiece = mongoose.model('ContentPiece', contentPieceSchema);
export default ContentPiece;
