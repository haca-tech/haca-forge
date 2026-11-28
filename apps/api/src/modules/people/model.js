import mongoose from 'mongoose';
import { toStoredFile } from '../../lib/storage/keys.js';
import { ROLE_KEYS, JOB_ROLES, normalizeRole, WORK_PREFERENCES, WORKER_ROLE, CALENDAR_KEYS } from '@mmp/shared';

const personSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      select: false,
    },
    role: {
      type: String,
      enum: ROLE_KEYS,
      default: WORKER_ROLE,
      required: true,
      index: true,
      set: (val) => normalizeRole(val),
    },
    jobRole: {
      type: String,
      enum: [...JOB_ROLES, ''],
      trim: true,
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Department',
      index: true,
    },
    reportsToIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Person',
        index: true,
      },
    ],
    // Stored but no longer used: workload counts steps, not hours.
    weeklyCapacityHours: {
      type: Number,
      default: 40,
      min: 0,
      max: 168,
    },
    // Workload: how many steps due in a week this person can take. No default is stored;
    // a missing value means the shared default (DEFAULT_ACTIVE_STEP_LIMIT, 4).
    activeStepLimit: {
      type: Number,
      min: 1,
      max: 20,
    },
    workPreferences: {
      type: [String],
      enum: WORK_PREFERENCES,
      default: [],
    },
    status: {
      type: String,
      enum: ['invited', 'active', 'suspended'],
      default: 'active',
      index: true,
    },
    // Optional per-person calendar limit for decisions and queues (Phase B: stored, not yet used).
    // Unset (the default, so existing records are unchanged) means every calendar; admin is never limited.
    calendarScope: {
      type: [{ type: String, enum: CALENDAR_KEYS }],
      default: undefined,
    },
    mustSetPassword: {
      type: Boolean,
      default: false,
    },
    mustChangePassword: {
      type: Boolean,
      default: false,
    },
    lastLogin: {
      type: Date,
    },
    lastLoginAt: {
      type: Date,
      default: null,
    },
    // When the person's last open portal tab closed (lib/presence.js).
    lastSeenAt: {
      type: Date,
      default: null,
    },
    avatarUrl: {
      type: String,
      default: null,
      trim: true,
      set: toStoredFile,
    },
    avatarStorageId: {
      type: String,
      default: null,
      trim: true,
    },
    preferredName: {
      type: String,
      default: '',
      trim: true,
      maxlength: 60,
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    phoneVerifiedAt: {
      type: Date,
      default: null,
    },
    // How the phone number was verified: 'email' (code sent to the registered email) or 'sms'.
    // Null for numbers saved before this was recorded.
    phoneVerifiedVia: {
      type: String,
      enum: ['email', 'sms', null],
      default: null,
    },
    whatsappNumber: {
      type: String,
      default: '',
      trim: true,
    },
    languages: {
      type: [String],
      default: [],
    },
    about: {
      type: String,
      default: '',
      trim: true,
      maxlength: 200,
    },
    preferences: {
      startPage: {
        type: String,
        enum: ['Home', 'My Work', 'Calendar'],
        default: 'Home',
      },
      dateFormat: {
        type: String,
        enum: ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'],
        default: 'DD/MM/YYYY',
      },
      timeFormat: {
        type: String,
        enum: ['12h', '24h'],
        default: '12h',
      },
      weekStart: {
        type: String,
        enum: ['monday', 'sunday'],
        default: 'monday',
      },
    },
    notificationPrefs: {
      mySteps: {
        inApp: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
      },
      approvalsRevisions: {
        inApp: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
      },
      messagesComments: {
        inApp: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
      },
      deadlinesOverdue: {
        inApp: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
      },
      planUpdates: {
        inApp: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
      },
      system: {
        inApp: { type: Boolean, default: true },
        email: { type: Boolean, default: true },
      },
    },
    profileCompletedAt: {
      type: Date,
      default: null,
    },
    refreshTokenHash: {
      type: String,
      select: false,
    },
    resetPasswordTokenHash: {
      type: String,
      select: false,
    },
    resetPasswordExpiresAt: {
      type: Date,
    },
    skills: {
      type: [String],
      default: [],
    },
    notificationPreferences: {
      email: {
        requestUpdates: { type: Boolean, default: true },
        taskAssigned: { type: Boolean, default: true },
        taskBlocked: { type: Boolean, default: true },
        reviewDecisions: { type: Boolean, default: true },
        deadlineReminders: { type: Boolean, default: true },
        dailyDigest: { type: Boolean, default: true },
      },
      inApp: {
        requestUpdates: { type: Boolean, default: true },
        taskAssigned: { type: Boolean, default: true },
        taskBlocked: { type: Boolean, default: true },
        reviewDecisions: { type: Boolean, default: true },
        deadlineReminders: { type: Boolean, default: true },
        mentions: { type: Boolean, default: true },
      },
      dailyDigest: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

personSchema.virtual('capacity').get(function () {
  return this.weeklyCapacityHours || 40;
}).set(function (val) {
  this.weeklyCapacityHours = val;
});

personSchema.virtual('department').get(function () {
  return this.departmentId;
}).set(function (val) {
  if (val === null || val === undefined) {
    this.departmentId = null;
  } else if (val instanceof mongoose.Types.ObjectId || (mongoose.Types.ObjectId.isValid(val) && /^[0-9a-fA-F]{24}$/.test(String(val)))) {
    this.departmentId = val;
  }
});

// Resilient role normalization hooks for legacy document preservation
personSchema.pre('validate', function (next) {
  if (this.role) {
    this.role = normalizeRole(this.role);
  }
  next();
});

personSchema.post('init', function () {
  if (this.role) {
    this.role = normalizeRole(this.role);
  }
  this.$locals.accessKey = `${this.role}|${this.status}`;
});

// Role, status and calendar limit change only through changePersonAccess
// (accessConfig/personAccess.service.js), which sends `access:changed` and then closes the
// person's sockets. Here we only remember what was loaded, for the last-admin guard.
personSchema.post('save', function (doc) {
  doc.$locals.accessKey = `${doc.role}|${doc.status}`;
});

// Fixed rule: there is always at least one active admin. A change that would turn the last
// active admin into a non-admin or a non-active account (save, updateOne, updateMany,
// findOneAndUpdate) or delete it (deleteOne, findOneAndDelete) is refused with 409 LAST_ADMIN.
// deleteMany (maintenance and test clean-up) and raw collection writes are not guarded.
function lastAdminError() {
  const error = new Error('There must be at least one active admin. Make another person an active admin first.');
  error.statusCode = 409;
  error.code = 'LAST_ADMIN';
  return error;
}
const isActiveAdmin = (role, status) => normalizeRole(role) === 'admin' && status === 'active';

personSchema.pre('save', async function () {
  if (this.isNew) return;
  const [wasRole, wasStatus] = String(this.$locals.accessKey || '|').split('|');
  if (!isActiveAdmin(wasRole, wasStatus) || isActiveAdmin(this.role, this.status)) return;
  const others = await this.constructor.countDocuments({ _id: { $ne: this._id }, role: 'admin', status: 'active' });
  if (others === 0) throw lastAdminError();
});

async function guardQueryChange() {
  const update = this.getUpdate() || {};
  const set = { ...update, ...(update.$set || {}) };
  const demotes = ('role' in set && normalizeRole(set.role) !== 'admin') || ('status' in set && set.status !== 'active');
  if (!demotes) return;
  const targets = await this.model.find({ ...this.getFilter(), role: 'admin', status: 'active' }).select('_id').lean();
  if (!targets.length) return;
  const others = await this.model.countDocuments({ _id: { $nin: targets.map((t) => t._id) }, role: 'admin', status: 'active' });
  if (others === 0) throw lastAdminError();
}
personSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], { document: false, query: true }, guardQueryChange);

async function guardQueryDelete() {
  const targets = await this.model.find({ ...this.getFilter(), role: 'admin', status: 'active' }).select('_id').lean();
  if (!targets.length) return;
  const others = await this.model.countDocuments({ _id: { $nin: targets.map((t) => t._id) }, role: 'admin', status: 'active' });
  if (others === 0) throw lastAdminError();
}
personSchema.pre(['deleteOne', 'findOneAndDelete'], { document: false, query: true }, guardQueryDelete);

// Primary Person model, pointing to 'users' collection to transform in-place
export const Person = mongoose.models.Person || mongoose.model('Person', personSchema, 'users');
export const User = Person;
