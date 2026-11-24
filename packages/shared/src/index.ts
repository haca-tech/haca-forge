import { z } from "zod";

// ==========================================
// 1. Roles & Permissions (Phase 12b: 7-role model)
// ==========================================
// Two keys were reused with a new meaning in Phase 12b:
// - "executive" now means a production worker (it was read-only leadership);
// - "creative_head" now means read-only leadership (it was the approver).
// Code outside this file uses the helpers below (isApprover, isReadOnlyViewer, isWorker)
// or the role-group constants, never these two keys as literals, so no check can keep the
// old meaning. A guard test enforces it.

export const ROLE_KEYS = [
  "admin",
  "creative_head",
  "production_head",
  "creative_lead",
  "growth_lead",
  "sm_manager",
  "executive",
  "viewer",
] as const;

export type UserRole = (typeof ROLE_KEYS)[number];

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Admin",
  creative_head: "Marketing Head",
  production_head: "Production Head",
  creative_lead: "Creative Manager",
  growth_lead: "Marketing Growth Manager",
  sm_manager: "SM Manager",
  executive: "Executive",
  viewer: "Viewer",
};

/** Approve plan rows, review, rate, reopen and classify root causes (both leads, every calendar in Phase 12b). */
export const APPROVER_ROLES = ["creative_lead", "growth_lead"] as const;
/** See everything, read-only: every write is refused (403). Contact details and review text visible. */
export const READ_ONLY_VIEWER_ROLES = ["creative_head", "production_head"] as const;
/** Production workers: own their steps, see only what they take part in. */
export const WORKER_ROLE = "executive" as const;
/** Every role that sees the whole team (not a worker). */
export const LEADERSHIP_ROLES = ["admin", ...READ_ONLY_VIEWER_ROLES, ...APPROVER_ROLES, "sm_manager"] as const;

type RoleInput = string | null | undefined | { role?: string | null };
const roleOf = (input: RoleInput): string => (typeof input === "object" && input !== null ? input.role || "" : input || "");

export function normalizeRole(role: string | null | undefined): UserRole | string {
  if (!role) return role as string;
  return role;
}

export const isKnownRole = (role: RoleInput): boolean => (ROLE_KEYS as readonly string[]).includes(roleOf(role));
/** creative_lead or growth_lead. Admin reviews as a backup: use canReview for decisions. */
export const isApprover = (role: RoleInput): boolean => (APPROVER_ROLES as readonly string[]).includes(roleOf(role));
/** creative_head or production_head: read-only everywhere. */
export const isReadOnlyViewer = (role: RoleInput): boolean => (READ_ONLY_VIEWER_ROLES as readonly string[]).includes(roleOf(role));
/** A production worker (role key "executive"). */
export const isWorker = (role: RoleInput): boolean => roleOf(role) === WORKER_ROLE;
/** May approve, review, rate and reopen: both leads and admin (never on their own work). */
export const canReview = (role: RoleInput): boolean => roleOf(role) === "admin" || isApprover(role);
/** Sees everyone's email and phone. Workers see only their own. */
export const canSeeContactDetails = (role: RoleInput): boolean => isKnownRole(role) && seesContactDetails({ role: roleOf(role) });
/** Revision notes, rating feedback and clip threads on any step (workers: their own steps only). */
export const canSeeAllReviewText = (role: RoleInput): boolean => isKnownRole(role) && can({ role: roleOf(role), status: 'active' }, 'review.read_all');
/** Manage workers' operational fields: job role, preferences, capacity, department. */
export const canManageOperationalFields = (role: RoleInput): boolean => roleOf(role) === "admin" || isApprover(role);
/** View and download a person's profile report. */
export const canViewProfileReport = (role: RoleInput): boolean =>
  roleOf(role) === "admin" || isApprover(role) || isReadOnlyViewer(role);
// ==========================================
// Phase 13: approval routing by calendar
// ==========================================
/** The calendar Ads work belongs to; the Marketing Growth Manager decides it. */
export const ADS_CALENDAR = "ads";
const ALL_CALENDARS = ["sm", "sales", "ads", "academics_management", "other"] as const;

/**
 * The calendars a role decides on (approve, review, rate, reopen, request changes, classify):
 * growth_lead the Ads calendar only, creative_lead every other calendar, admin all of them
 * (as a backup). Everyone else none.
 */
export function decisionCalendarsFor(role: RoleInput): string[] {
  const r = roleOf(role);
  if (r === "admin") return [...ALL_CALENDARS];
  if (r === "growth_lead") return [ADS_CALENDAR];
  if (r === "creative_lead") return ALL_CALENDARS.filter((c) => c !== ADS_CALENDAR);
  return [];
}

/** The lead role that decides on a calendar (admin covers every calendar too). */
export function deciderRoleFor(calendarKey: string | null | undefined): "creative_lead" | "growth_lead" {
  return (calendarKey || "sm") === ADS_CALENDAR ? "growth_lead" : "creative_lead";
}

/**
 * May this user decide on work in this calendar? The work's current calendar counts (a
 * missing calendar is SM), and nobody decides on their own work (pass ownerId).
 */
export function canDecide(
  user: { _id?: unknown; id?: unknown; userId?: unknown; role?: string | null } | string | null | undefined,
  calendarKey: string | null | undefined,
  { ownerId }: { ownerId?: unknown } = {},
): boolean {
  const role = typeof user === "string" ? user : user?.role;
  if (!decisionCalendarsFor(role).includes(calendarKey || "sm")) return false;
  if (ownerId && user && typeof user === "object") {
    const me = String((user as any).userId || (user as any)._id || (user as any).id || "");
    const owner = String((ownerId as any)?._id || ownerId);
    if (me && owner && me === owner) return false;
  }
  return true;
}

/** Only admin grants these roles. */
export const ADMIN_GRANTED_ROLES = ["admin", ...READ_ONLY_VIEWER_ROLES, ...APPROVER_ROLES, "viewer"] as const;

// Canonical Permission Keys (Marketing OS Model)
export const PERMISSION_KEYS = [
  "portal.view",
  "people.view",
  "people.assign",
  "calendar.plan",
  "calendar.approve",
  "work.create",
  "work.request",
  "work.update.own",
  "assignment.override",
  "feedback.give",
  "feedback.respond",
  "revision.classify",
  "analytics.team",
  "report.view",
  "report.configure",
  "automation.manage",
  "user.approve",
  "user.manage",
  "chat.use",
  "chat.group.create",
  "chat.moderate",
  "chat.read",
  "team.profile.view",
] as const;

export type PermissionKey = (typeof PERMISSION_KEYS)[number];

const LEAD_PERMISSIONS: PermissionKey[] = [
  "portal.view",
  "people.view",
  "people.assign",
  "calendar.approve",
  "feedback.give",
  "feedback.respond",
  "revision.classify",
  "assignment.override",
  "work.update.own",
  "analytics.team",
  "report.view",
  "chat.use",
  "chat.group.create",
  "chat.moderate",
  "team.profile.view",
];

const VIEWER_PERMISSIONS: PermissionKey[] = [
  "portal.view",
  "people.view",
  "analytics.team",
  "report.view",
  "chat.read",
  "team.profile.view",
];

// Role-to-Permission Matrix (Phase 12b). Admin holds every key. report.configure and
// automation.manage are admin only. In Phase 12b both leads approve on every calendar;
// Phase 13 splits them by calendar.
export const ROLE_PERMISSIONS: Record<UserRole, PermissionKey[]> = {
  admin: [...PERMISSION_KEYS],
  creative_head: [...VIEWER_PERMISSIONS],
  production_head: [...VIEWER_PERMISSIONS],
  creative_lead: [...LEAD_PERMISSIONS],
  growth_lead: [...LEAD_PERMISSIONS],
  sm_manager: [
    "calendar.plan",
    "work.create",
    "assignment.override",
    "work.update.own",
    "feedback.respond",
    "analytics.team",
    "report.view",
    "people.view",
    "chat.use",
    "chat.group.create",
    "chat.moderate",
    "team.profile.view",
  ],
  executive: ["work.update.own", "work.request", "feedback.respond", "chat.use"],
  // Read-only observer (catalog v1 kept for older readers; the app uses SYSTEM_ROLES).
  viewer: ["analytics.team", "report.view"],
};

// ==========================================
// 2. Fixed Reference Taxonomies (Spec Section 14)
// ==========================================

export const DEPARTMENTS = [
  { name: "Design", code: "design" },
  { name: "Video Production", code: "video_production" },
  { name: "Social Media", code: "social_media" },
  { name: "SEO & Content", code: "seo_content" },
  { name: "WhatsApp", code: "whatsapp" },
  { name: "Performance Marketing", code: "performance_marketing" },
  { name: "Tech", code: "tech" },
] as const;

export const DEPARTMENT_CODES = DEPARTMENTS.map((d) => d.code);
export type DepartmentCode = (typeof DEPARTMENT_CODES)[number];
// Keep DEPARTMENT_TYPES alias for backward compatibility
export const DEPARTMENT_TYPES = DEPARTMENT_CODES;
export type DepartmentType = DepartmentCode;

// Phase 12b: the 5 worker job roles, plus the two leadership titles in use.
export const WORKER_JOB_ROLES = ["Writer", "Cinematographer", "Graphic Designer", "Video Editor", "All Rounder"] as const;
export type WorkerJobRole = (typeof WORKER_JOB_ROLES)[number];

export const JOB_ROLES = [...WORKER_JOB_ROLES, "Creative Manager (TL)", "Social Media Manager"] as const;
export type JobRole = (typeof JOB_ROLES)[number];

// Stage Work Preferences

export const WORK_PREFERENCES = [
  "Content",
  "Script",
  "Design",
  "Shoot",
  "Edit",
  "Post",
] as const;
export type WorkPreference = (typeof WORK_PREFERENCES)[number];

/**
 * Which steps a worker's job role makes them eligible for. Post is never a worker's step:
 * every Post step belongs to an SM Manager.
 */
export const JOB_ROLE_STEP_ELIGIBILITY: Record<WorkerJobRole, WorkPreference[]> = {
  Writer: ["Script", "Content"],
  Cinematographer: ["Shoot"],
  "Graphic Designer": ["Design"],
  "Video Editor": ["Edit"],
  "All Rounder": ["Script", "Content", "Shoot", "Design", "Edit"],
};

// Kept for screens that prefill preferences from a job role: the eligible steps.
export const JOB_ROLE_DEFAULT_WORK_PREFERENCES: Record<string, WorkPreference[]> = { ...JOB_ROLE_STEP_ELIGIBILITY };

export function getDefaultPreferencesForJobRole(jobRole?: string | null): WorkPreference[] {
  if (!jobRole) return [];
  return [...(JOB_ROLE_DEFAULT_WORK_PREFERENCES[jobRole] || [])];
}

/** The steps a role and job role allow, before preferences. */
export function eligibleStepsFor(person: { role?: string | null; jobRole?: string | null } | null | undefined): WorkPreference[] {
  if (!person) return [];
  if (person.role === "sm_manager") return ["Post"];
  if (person.role !== WORKER_ROLE) return [];
  return [...(JOB_ROLE_STEP_ELIGIBILITY[(person.jobRole || "") as WorkerJobRole] || [])];
}

/**
 * The steps a person can be suggested for: their job role sets eligibility, and their
 * preferences can only narrow it (the steps in both). As before Phase 12b, a worker with
 * no preferences is not suggested for any step. An SM Manager is always eligible for Post.
 */
export function effectiveStepsFor(
  person: { role?: string | null; jobRole?: string | null; workPreferences?: string[] | null } | null | undefined,
): WorkPreference[] {
  const eligible = eligibleStepsFor(person);
  if (person?.role === "sm_manager") return eligible;
  const prefs = Array.isArray(person?.workPreferences) ? person!.workPreferences! : [];
  return eligible.filter((step) => prefs.includes(step));
}

/** Preferences outside the job role's eligibility (empty when all are allowed). */
export function ineligiblePreferences(
  person: { role?: string | null; jobRole?: string | null } | null | undefined,
  prefs: string[] | null | undefined,
): string[] {
  const eligible = eligibleStepsFor(person) as string[];
  return (prefs || []).filter((p) => !eligible.includes(p));
}

export const PROGRAMS = [
  "AI Integrated Graphic Design",
  "UI/UX Design + AI",
  "Creative Design & Communication",
  "AI Integrated Video Editing Mastery",
  "Branding & Identity Online Program",
] as const;
export type Program = (typeof PROGRAMS)[number];

export const WORK_TYPES = [
  "Reel",
  "Ad Creative",
  "Landing Page",
  "Carousel",
  "Post",
  "Blog",
  "Email",
  "WhatsApp Blast",
  "Ad Set",
  "YouTube Short/Video",
  "SEO Audit",
  "Copy",
  "Video Ad",
  "Internal Report",
  // 14 SM Content Flow Design Requirement Types (docs/CONTENT_FLOW.md §1 & §3.3)
  "Static Post",
  "Carousel Post",
  "Story",
  "Cover Image",
  "Thumbnail",
  "Meta Ad Creative",
  "Class Announcement",
  "Orientation Creative",
  "Graduation Creative",
  "Brochure",
  "Certificate",
  "Offer Creative",
  "Custom Request",
  "Placement Poster",
  // Alias for Static Post
  "Poster",
  "Flyer",
  "Banner",
  "Standee",
  "ID Card",
  "Presentation",
  "Newsletter",
  "Merchandise",
  "Other",
] as const;
export type WorkType = (typeof WORK_TYPES)[number];

export const CANONICAL_DELIVERABLE_TYPES = [
  "Reel",
  "Static Post",
  "Carousel Post",
  "Story",
  "Poster",
  "Brochure",
  "Flyer",
  "Banner",
  "Standee",
  "Certificate",
  "ID Card",
  "Presentation",
  "Newsletter",
  "Merchandise",
  "Other",
] as const;

export const WORK_TYPE_ALIASES: Record<string, string> = {
  poster: "Poster",
  Flyer: "Flyer",
  flyer: "Flyer",
  "Reel A": "Reel",
  "Reel B": "Reel",
  "Reel C": "Reel",
  "reel a": "Reel",
  "reel b": "Reel",
  "reel c": "Reel",
  Reel: "Reel",
  reel: "Reel",
  reels: "Reel",
  "Reel / Video": "Reel",
  "reel / video": "Reel",
  "Reel/Video": "Reel",
  "reel/video": "Reel",
  Video: "Reel",
  video: "Reel",
  "Video Ad": "Reel",
  "YouTube Short/Video": "Reel",
  "Motion Graphic": "Reel",
  "motion graphic": "Reel",
  Carousel: "Carousel Post",
  carousel: "Carousel Post",
  "Carousel Post": "Carousel Post",
  "carousel post": "Carousel Post",
  "Static Post": "Static Post",
  "static post": "Static Post",
  Post: "Static Post",
  post: "Static Post",
  Story: "Story",
  story: "Story",
  "Article / Blog": "Other",
  "article / blog": "Other",
  Article: "Other",
  article: "Other",
  Blog: "Other",
  blog: "Other",
};

export function normalizeWorkType(type: string | null | undefined): string {
  if (!type) return "";
  const trimmed = type.trim();
  if (trimmed in WORK_TYPE_ALIASES) {
    return WORK_TYPE_ALIASES[trimmed];
  }
  const lower = trimmed.toLowerCase();
  for (const [k, v] of Object.entries(WORK_TYPE_ALIASES)) {
    if (k.toLowerCase() === lower) {
      return v;
    }
  }
  for (const dt of CANONICAL_DELIVERABLE_TYPES) {
    if (dt.toLowerCase() === lower) {
      return dt;
    }
  }
  if (lower.includes("reel") || lower === "video" || lower.includes("video reel")) {
    return "Reel";
  }
  if (lower.includes("carousel")) {
    return "Carousel Post";
  }
  if (lower.includes("story") || lower.includes("stories")) {
    return "Story";
  }
  return trimmed;
}

export const WORK_TYPE_DEPARTMENT_MAP: Record<WorkType, DepartmentCode> = {
  Reel: "video_production",
  "Video Ad": "video_production",
  "YouTube Short/Video": "video_production",
  "Ad Creative": "design",
  Carousel: "design",
  "Landing Page": "design",
  Post: "social_media",
  Blog: "seo_content",
  Email: "seo_content",
  Copy: "seo_content",
  "SEO Audit": "seo_content",
  "WhatsApp Blast": "whatsapp",
  "Ad Set": "performance_marketing",
  "Internal Report": "performance_marketing",
  // 14 Design Requirement Types map to Design department
  "Static Post": "design",
  "Carousel Post": "design",
  Story: "design",
  "Cover Image": "design",
  Thumbnail: "design",
  "Meta Ad Creative": "design",
  "Class Announcement": "design",
  "Orientation Creative": "design",
  "Graduation Creative": "design",
  Brochure: "design",
  Certificate: "design",
  "Offer Creative": "design",
  "Custom Request": "design",
  "Placement Poster": "design",
  Poster: "design",
  Flyer: "design",
  Banner: "design",
  Standee: "design",
  "ID Card": "design",
  Presentation: "design",
  Newsletter: "design",
  Merchandise: "design",
  Other: "design",
};

export const FOR_TEAMS = ["Sales", "Marketing", "Academics", "Other", "HACA"] as const;
export type ForTeam = (typeof FOR_TEAMS)[number];

export const CALENDAR_KEYS = [
  "sm",
  "sales",
  "ads",
  "academics_management",
  "other",
] as const;
export type CalendarKey = (typeof CALENDAR_KEYS)[number];

export interface CalendarDefinition {
  id: CalendarKey;
  key: CalendarKey;
  name: string;
  color: string;
  bg: string;
  border: string;
  text: string;
}

export const CALENDARS: Record<CalendarKey, CalendarDefinition> = {
  sm: {
    id: "sm",
    key: "sm",
    name: "SM Calendar",
    color: "#7a6af6",
    bg: "#ede9fe",
    border: "#c4b5fd",
    text: "#5b21b6",
  },
  sales: {
    id: "sales",
    key: "sales",
    name: "Sales Calendar",
    color: "#10b981",
    bg: "#d1fae5",
    border: "#a7f3d0",
    text: "#065f46",
  },
  ads: {
    id: "ads",
    key: "ads",
    name: "Ads Calendar",
    color: "#f59e0b",
    bg: "#fef3c7",
    border: "#fde68a",
    text: "#92400e",
  },
  academics_management: {
    id: "academics_management",
    key: "academics_management",
    name: "Academics & Management Calendar",
    color: "#0284c7",
    bg: "#e0f2fe",
    border: "#bae6fd",
    text: "#0369a1",
  },
  other: {
    id: "other",
    key: "other",
    name: "Other",
    color: "#64748b",
    bg: "#f1f5f9",
    border: "#e2e8f0",
    text: "#334155",
  },
};

export const CALENDAR_LIST: CalendarDefinition[] = [
  CALENDARS.sm,
  CALENDARS.sales,
  CALENDARS.ads,
  CALENDARS.academics_management,
  CALENDARS.other,
];

export function getCalendarDefinition(key?: string | null): CalendarDefinition {
  if (key && key in CALENDARS) {
    return CALENDARS[key as CalendarKey];
  }
  return CALENDARS.sm;
}


export const CANONICAL_PRIORITIES = ["Normal", "Urgent"] as const;
/** The only priorities accepted anywhere (Phase 7 close-out). */
export const PRIORITIES = CANONICAL_PRIORITIES;
export type Priority = (typeof PRIORITIES)[number];
/**
 * Older values that may still be stored. They are never accepted as input and are shown
 * as Normal; records that have them are left unchanged in the database.
 */
export const LEGACY_PRIORITIES = ["Low", "Medium", "High"] as const;
/** What a stored record may hold: the two priorities plus the legacy values. */
export const STORED_PRIORITIES = [...PRIORITIES, ...LEGACY_PRIORITIES] as const;

/** How a stored priority is shown and sorted: Urgent, otherwise Normal (Low, Medium, High included). */
export function normalizePriority(p?: string | null): Priority {
  return typeof p === "string" && p.trim().toLowerCase() === "urgent" ? "Urgent" : "Normal";
}

/**
 * A priority from input: "Normal" or "Urgent" (any case); empty gives undefined; anything
 * else, including Low, Medium and High, gives null (invalid).
 */
export function parsePriorityInput(value: unknown): Priority | undefined | null {
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return undefined;
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "normal") return "Normal";
  if (v === "urgent") return "Urgent";
  return null;
}

/** Urgent first, then by due date (earliest first; no date last). */
export function compareUrgentThenDue(
  a: { priority?: string | null; dueDate?: string | Date | null; deadline?: string | Date | null },
  b: { priority?: string | null; dueDate?: string | Date | null; deadline?: string | Date | null }
): number {
  const ua = normalizePriority(a.priority) === "Urgent" ? 0 : 1;
  const ub = normalizePriority(b.priority) === "Urgent" ? 0 : 1;
  if (ua !== ub) return ua - ub;
  const da = a.dueDate || a.deadline ? new Date((a.dueDate || a.deadline) as string).getTime() : Infinity;
  const db = b.dueDate || b.deadline ? new Date((b.dueDate || b.deadline) as string).getTime() : Infinity;
  return da - db;
}

export const CANONICAL_BLOCKER_REASONS = [
  "Waiting for feedback",
  "Waiting for content",
  "Waiting for data",
  "Technical issue",
  "Dependency",
  "Client/business approval",
  "Resource issue",
  "Unclear requirement",
  "Other",
] as const;

export const BLOCKER_REASONS = [
  "Waiting for feedback",
  "Waiting for content",
  "Waiting for data",
  "Technical issue",
  "Dependency",
  "Client/business approval",
  "Resource issue",
  "Unclear requirement",
  "Other",
  "Asset delay",
  "Brief clarification",
  "Dependency on external team",
  "Resource unavailable",
  "Scope change",
  "Client asset delay",
  "Software or tool failure",
] as const;
export type BlockerReason = (typeof BLOCKER_REASONS)[number];

// Reasons that require dependencyOwnerId to be specified
export const BLOCKER_DEPENDENCY_REASONS: BlockerReason[] = [
  "Waiting for feedback",
  "Waiting for content",
  "Waiting for data",
  "Asset delay",
  "Brief clarification",
  "Dependency on external team",
  "Client asset delay",
];

export const CANONICAL_REVISION_ROOT_CAUSES = [
  "Brief unclear",
  "Creative direction unclear",
  "Technical error",
  "Brand guideline deviation",
  "Scope change",
  "Approval delay",
  "Other",
] as const;

export const REVISION_ROOT_CAUSES = [
  "Brief unclear",
  "Creative direction unclear",
  "Technical error",
  "Brand guideline deviation",
  "Scope change",
  "Approval delay",
  "Other",
  "Brief ambiguity",
  "Script change",
  "Visual defect",
  "Audio issue",
  "TL approval delay",
] as const;
export type RevisionRootCause = (typeof REVISION_ROOT_CAUSES)[number];
/** The only values accepted for new revision classifications and revision requests. */
export type CanonicalRevisionRootCause = (typeof CANONICAL_REVISION_ROOT_CAUSES)[number];
/** Older values that may exist in saved records. Readable, never offered or accepted for new writes. */
export const LEGACY_REVISION_ROOT_CAUSES = REVISION_ROOT_CAUSES.filter(
  (c) => !(CANONICAL_REVISION_ROOT_CAUSES as readonly string[]).includes(c),
);
export function isCanonicalRevisionRootCause(value: unknown): value is CanonicalRevisionRootCause {
  return typeof value === "string" && (CANONICAL_REVISION_ROOT_CAUSES as readonly string[]).includes(value);
}

export const WORK_ITEM_STATUSES = [
  "Not Started",
  "In Progress",
  "Feedback",
  "Pending",
  "Blocked",
  "Approved",
  "Published",
] as const;
export type WorkItemStatus = (typeof WORK_ITEM_STATUSES)[number];

export const ACCESS_REQUEST_STATUSES = [
  "pending",
  "approved",
  "rejected",
  "info_needed",
] as const;
export type AccessRequestStatus = (typeof ACCESS_REQUEST_STATUSES)[number];

export const WORKLOAD_BANDS = {
  HEALTHY_MAX: 65,
  HIGH_MAX: 85,
} as const;

export function getWorkloadBand(
  workloadPct: number,
): "Healthy" | "High" | "Overloaded" {
  if (workloadPct < WORKLOAD_BANDS.HEALTHY_MAX) return "Healthy";
  if (workloadPct <= WORKLOAD_BANDS.HIGH_MAX) return "High";
  return "Overloaded";
}

// Deliverables & Upload constants (kept for upload infrastructure)
export const DELIVERABLE_TYPES = [
  "video",
  "image",
  "document",
  "audio",
  "copy",
  "link",
  "other",
] as const;
export type DeliverableType = (typeof DELIVERABLE_TYPES)[number];

export const MAX_UPLOAD_SIZES = {
  video: 500 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  document: 50 * 1024 * 1024,
  pdf: 50 * 1024 * 1024,
  other: 50 * 1024 * 1024,
} as const;

// Role Workspaces Step Output Kinds
export const STEP_OUTPUT_KINDS = [
  "document",
  "video",
  "image",
  "pdf",
  "link",
] as const;
export type StepOutputKind = (typeof STEP_OUTPUT_KINDS)[number];

export const STAGE_PRIMARY_OUTPUT_KIND: Record<string, StepOutputKind> = {
  Content: "document",
  Script: "document",
  Shoot: "video",
  Edit: "video",
  Design: "image",
  Post: "link",
};

export const STAGE_FALLBACK_OUTPUT_KIND: Record<string, StepOutputKind> = {
  Content: "link",
  Script: "link",
  Shoot: "link",
  Edit: "link",
  Design: "pdf",
};

// Workspaces Upload Constants & Server-side Limits
// ==========================================
// Saved output links (Phase 5)
// ==========================================
// A step's output is either a file uploaded through the app or a Google Drive / Docs link.

export const DRIVE_LINK_HOSTS = ["drive.google.com", "docs.google.com"] as const;
export const DRIVE_LINK_HINT = "Make sure the link is shared with HACA reviewers.";

/** An https link on drive.google.com or docs.google.com, with no credentials or port. */
export function isDriveLink(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const parsed = new URL(url.trim());
    return (
      parsed.protocol === "https:" &&
      (DRIVE_LINK_HOSTS as readonly string[]).includes(parsed.hostname) &&
      !parsed.port &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

/**
 * A storage key: where an uploaded file lives, the same on every storage driver.
 *   uploads/<name>                                  older uploads (stored as "/uploads/<name>")
 *   uploads/<yyyy>/<mm>/<name>                      work files
 *   uploads/avatars/<name>                          profile photos
 *   uploads/chat/<channelId>/<uuid>/<name>          chat attachments
 */
const STORAGE_KEY =
  /^uploads\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}|\d{4}\/\d{2}\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}|avatars\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}|chat\/[0-9a-f]{24}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9_-]{1,60}\.[a-z0-9]{2,5})$/;

/**
 * The storage key a stored or served file value points at, or null: a key ("uploads/..."), a
 * local path ("/uploads/..."), or a signed file URL the API gave out (https://<cdn>/uploads/...
 * ?token=...&expires=...). Anything else (Drive links, other sites) is not an app file.
 */
export function storageKeyOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (!text || text.includes("..") || text.includes("\\")) return null;
  // https in production; http only for a local mock CDN in development and tests.
  if (/^https?:\/\//i.test(text)) {
    try {
      const u = new URL(text);
      if (!u.searchParams.get("token") || !u.searchParams.get("expires")) return null;
      text = decodeURIComponent(u.pathname);
    } catch {
      return null;
    }
  }
  if (text.startsWith("/")) text = text.slice(1);
  return STORAGE_KEY.test(text) ? text : null;
}

/** The shape of a file uploaded through the app (a key, /uploads/..., or a signed file URL). The API also checks it exists. */
export function isAppUploadPath(url: unknown): boolean {
  return storageKeyOf(url) !== null;
}

/** When a signed file URL stops working (ms since epoch), or null for a URL that never expires. */
export function fileUrlExpiresAt(url: unknown): number | null {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  try {
    const expires = Number(new URL(url).searchParams.get("expires"));
    return Number.isFinite(expires) && expires > 0 ? expires * 1000 : null;
  } catch {
    return null;
  }
}

/** A URL a clip or submission may be saved with: an app upload or a Drive link. */
export function isAllowedOutputUrl(url: unknown): boolean {
  return isAppUploadPath(url) || isDriveLink(url);
}

export const OUTPUT_URL_ERROR =
  "Use a file uploaded here, or an https link on drive.google.com or docs.google.com.";

// ==========================================
// Locked workspaces: submit with links
// ==========================================
// The one switch. While true, the production workspaces (Writing Studio, Shoot, Edit, Design,
// Post) show a locked screen, the API refuses workspace-only writes, and every step is
// submitted with Google Drive links from My Work and Work Detail. Set to false to unlock.
export const WORKSPACES_LOCKED = true;

export const DRIVE_LINK_ERROR = "Use an https link on drive.google.com or docs.google.com.";
export const MAX_SUBMIT_LINKS = 20;

/** Design is submitted as one or more links (one per slide or file); every other step as one. */
export function stepAllowsManyLinks(stageKey: string | null | undefined): boolean {
  return stageKey === "Design";
}

export const stepLinkSubmitSchema = z.object({
  links: z.array(z.string().trim().min(1, "Enter a link")).min(1, "Enter a link").max(MAX_SUBMIT_LINKS),
  note: z.string().trim().max(5000).optional(),
});
export type StepLinkSubmitInput = z.infer<typeof stepLinkSubmitSchema>;

export const LIVE_URL_ERROR = "Enter the live post link, starting with https://";
/** A site homepage is not a post (Published page). */
export const SITE_ROOT_URL_ERROR = "Paste the link to the post itself, not the site homepage.";

/**
 * What is wrong with a live post link, or null when it is fine: https on any host, no
 * credentials, and a path beyond "/" (a site homepage is not a post).
 */
export function livePostUrlError(url: unknown): string | null {
  if (typeof url !== "string" || !url.trim()) return LIVE_URL_ERROR;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return LIVE_URL_ERROR;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return LIVE_URL_ERROR;
  if (parsed.pathname === "" || parsed.pathname === "/") return SITE_ROOT_URL_ERROR;
  return null;
}

/** The live link of a published post (see livePostUrlError). */
export function isLivePostUrl(url: unknown): boolean {
  return livePostUrlError(url) === null;
}

// ==========================================
// Published page: official public embeds (no API keys)
// ==========================================

export type EmbedKind =
  | "instagram_reel"
  | "instagram_post"
  | "youtube"
  | "youtube_short"
  | "facebook_video"
  | "facebook_reel"
  | "facebook_post"
  | "linkedin"
  | "drive"
  | "link";
export type EmbedAspect = "9:16" | "4:5" | "16:9" | "1:1";
export interface EmbedInfo {
  kind: EmbedKind;
  /** Only for an embeddable post: the official embed URL. Never set for kind "link". */
  embedUrl?: string;
  aspect?: EmbedAspect;
  /** "Instagram reel", "YouTube Short", ... or "Link". */
  label: string;
}

const LINK_EMBED: EmbedInfo = { kind: "link", label: "Link" };

/**
 * Hosts the web app may frame (CSP frame-src). The four embed hosts, plus the hosts the
 * Review Studio link viewer already frames (YouTube and Figma embeds). Kept in step with
 * vercel.json, the Vite dev server and helmet by a test.
 */
export const FRAME_SRC_HOSTS = [
  "https://www.instagram.com",
  "https://www.youtube-nocookie.com",
  "https://www.facebook.com",
  "https://www.linkedin.com",
  "https://www.youtube.com",
  "https://youtube.com",
  "https://m.youtube.com",
  "https://www.figma.com",
  "https://figma.com",
  "https://drive.google.com",
] as const;
export const FRAME_SRC_POLICY = `frame-src 'self' ${FRAME_SRC_HOSTS.join(" ")}`;

/**
 * Where uploaded files are served from in production: the Bunny Pull Zone (docs/STORAGE.md).
 * A Pull Zone's own hostname is <name>.b-cdn.net; add a custom hostname here if one is set up.
 */
export const FILE_CDN_HOSTS = ["https://*.b-cdn.net"] as const;

/**
 * The web app's Content-Security-Policy: the frames above, plus where images, videos and file
 * requests may come from (the file CDN named explicitly). Images and API calls also keep `https:`
 * (external thumbnails and the API on its own host); videos come only from this site or the CDN.
 * `extraFileHosts` adds development hosts (the local mock Bunny server).
 */
export function webContentSecurityPolicy(extraFileHosts: readonly string[] = []): string {
  const files = [...FILE_CDN_HOSTS, ...extraFileHosts].join(" ");
  return [
    FRAME_SRC_POLICY,
    `img-src 'self' data: blob: ${files} https:`,
    `media-src 'self' blob: ${files}`,
    `connect-src 'self' ${files} https: wss:`,
  ].join("; ");
}
export const WEB_CSP_POLICY = webContentSecurityPolicy();

function parseHttps(raw: unknown): URL | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    return u;
  } catch {
    return null;
  }
}
const segmentsOf = (u: URL) => u.pathname.split("/").filter(Boolean);
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const IG_CODE = /^[A-Za-z0-9_-]{5,64}$/;
const FB_ID = /^\d{5,25}$/;

function instagramEmbed(u: URL): EmbedInfo | null {
  const segs = segmentsOf(u);
  // /p/<code>, /reel/<code>, /reels/<code>, /tv/<code>, also /<username>/p/<code>
  for (const i of [0, 1]) {
    const type = segs[i];
    const code = segs[i + 1];
    if (!type || !code || !IG_CODE.test(code)) continue;
    if (type === "p") return { kind: "instagram_post", embedUrl: `https://www.instagram.com/p/${code}/embed`, aspect: "4:5", label: "Instagram post" };
    if (type === "reel" || type === "reels") return { kind: "instagram_reel", embedUrl: `https://www.instagram.com/reel/${code}/embed`, aspect: "9:16", label: "Instagram reel" };
    if (type === "tv") return { kind: "instagram_reel", embedUrl: `https://www.instagram.com/tv/${code}/embed`, aspect: "9:16", label: "Instagram video" };
  }
  return null;
}

function youtubeEmbed(u: URL, host: string): EmbedInfo | null {
  const segs = segmentsOf(u);
  let id: string | null = null;
  let short = false;
  if (host === "youtu.be") id = segs[0] || null;
  else if (segs[0] === "watch") id = u.searchParams.get("v");
  else if (segs[0] === "shorts") {
    id = segs[1] || null;
    short = true;
  } else if (segs[0] === "embed" || segs[0] === "live") id = segs[1] || null;
  if (!id || !YT_ID.test(id)) return null;
  return short
    ? { kind: "youtube_short", embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, aspect: "9:16", label: "YouTube Short" }
    : { kind: "youtube", embedUrl: `https://www.youtube-nocookie.com/embed/${id}`, aspect: "16:9", label: "YouTube video" };
}

function facebookEmbed(u: URL): EmbedInfo | null {
  const segs = segmentsOf(u);
  const canonical = `https://www.facebook.com${u.pathname}${u.search}`;
  const plugin = (kind: "video" | "post") =>
    `https://www.facebook.com/plugins/${kind}.php?href=${encodeURIComponent(canonical)}&show_text=false`;
  // Videos: /<page>/videos/<id>, /videos/<id>, /watch?v=<id>, /reel/<id>
  const v = segs.indexOf("videos");
  if (v >= 0 && FB_ID.test(segs[v + 1] || "")) return { kind: "facebook_video", embedUrl: plugin("video"), aspect: "16:9", label: "Facebook video" };
  if (segs[0] === "watch" && FB_ID.test(u.searchParams.get("v") || "")) return { kind: "facebook_video", embedUrl: plugin("video"), aspect: "16:9", label: "Facebook video" };
  if (segs[0] === "reel" && FB_ID.test(segs[1] || "")) return { kind: "facebook_reel", embedUrl: plugin("video"), aspect: "9:16", label: "Facebook reel" };
  // Posts: /<page>/posts/<id>, /permalink.php?story_fbid=..., /photo?fbid=..., /photo.php?fbid=...
  const p = segs.indexOf("posts");
  if (p >= 1 && /^[A-Za-z0-9_-]{5,80}$/.test(segs[p + 1] || "")) return { kind: "facebook_post", embedUrl: plugin("post"), aspect: "1:1", label: "Facebook post" };
  if (segs[0] === "permalink.php" && u.searchParams.get("story_fbid")) return { kind: "facebook_post", embedUrl: plugin("post"), aspect: "1:1", label: "Facebook post" };
  if ((segs[0] === "photo" || segs[0] === "photo.php") && FB_ID.test(u.searchParams.get("fbid") || "")) return { kind: "facebook_post", embedUrl: plugin("post"), aspect: "1:1", label: "Facebook post" };
  return null;
}

function linkedinEmbed(u: URL): EmbedInfo | null {
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  const urn = /urn:li:(activity|share|ugcPost):(\d{10,25})(?!\d)/.exec(path);
  const activity = /[-/]activity-(\d{10,25})(?!\d)/.exec(path);
  const type = urn ? urn[1] : activity ? "activity" : null;
  const id = urn ? urn[2] : activity ? activity[1] : null;
  if (!type || !id) return null;
  return { kind: "linkedin", embedUrl: `https://www.linkedin.com/embed/feed/update/urn:li:${type}:${id}`, aspect: "4:5", label: "LinkedIn post" };
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,200}$/;
/** A Drive file (not a folder): /file/d/<id>/... or /open?id=<id>, played through /preview. */
function driveEmbed(u: URL): EmbedInfo | null {
  const segs = segmentsOf(u);
  let id: string | null = null;
  if (segs[0] === "file" && segs[1] === "d") id = segs[2] || null;
  else if (segs[0] === "open" && segs.length === 1) id = u.searchParams.get("id");
  if (!id || !DRIVE_ID.test(id)) return null;
  return { kind: "drive", embedUrl: `https://drive.google.com/file/d/${id}/preview`, aspect: "16:9", label: "Google Drive file" };
}

/**
 * The official public embed for a live post link, or { kind: "link" }. Only Instagram,
 * YouTube, Facebook and LinkedIn posts and Google Drive files embed; https only, exact hosts (look-alikes such as
 * instagram.com.evil.com are links). Pages must frame only an embedUrl from here.
 */
export function toEmbed(liveUrl: unknown): EmbedInfo {
  const u = parseHttps(liveUrl);
  if (!u) return LINK_EMBED;
  const host = u.hostname.toLowerCase();
  let out: EmbedInfo | null = null;
  if (host === "instagram.com" || host === "www.instagram.com") out = instagramEmbed(u);
  else if (["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) out = youtubeEmbed(u, host);
  else if (["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"].includes(host)) out = facebookEmbed(u);
  else if (host === "linkedin.com" || host === "www.linkedin.com") out = linkedinEmbed(u);
  else if (host === "drive.google.com") out = driveEmbed(u);
  return out || LINK_EMBED;
}

const EMBED_URL_PATTERNS = [
  /^https:\/\/www\.instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]{5,64}\/embed$/,
  /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/,
  /^https:\/\/www\.facebook\.com\/plugins\/(video|post)\.php\?href=https%3A%2F%2Fwww\.facebook\.com%2F[^&#\s]*&show_text=false$/,
  /^https:\/\/www\.linkedin\.com\/embed\/feed\/update\/urn:li:(activity|share|ugcPost):\d{10,25}$/,
  /^https:\/\/drive\.google\.com\/file\/d\/[A-Za-z0-9_-]{10,200}\/preview$/,
];
/** True only for an embed URL of the shape toEmbed produces (checked again before framing). */
export function isTrustedEmbedUrl(url: unknown): boolean {
  return typeof url === "string" && EMBED_URL_PATTERNS.some((re) => re.test(url));
}

/** The preview line in the posting dialog: "Instagram reel detected" or "Will show as a link". */
export function embedPreviewText(liveUrl: unknown): string {
  const e = toEmbed(liveUrl);
  return e.kind === "link" ? "Will show as a link" : `${e.label} detected`;
}

/**
 * Where a step stands with its reviewer. 'Feedback' is saved both for a step that was just
 * submitted and for one that was sent back; the latest version tells them apart.
 * - awaiting_review: submitted, waiting for the reviewer ("Waiting for approval")
 * - changes_requested: sent back, rework not started ("Changes requested")
 * - rework_in_progress: the owner has started the rework
 */
export type StepReviewState = "awaiting_review" | "changes_requested" | "rework_in_progress" | null;

export function stepReviewState(
  status: string | null | undefined,
  latestSubmissionStatus: string | null | undefined,
  revisions: number = 0,
): StepReviewState {
  if (status === "Pending") return "awaiting_review";
  if (status === "Feedback") {
    if (latestSubmissionStatus === "submitted") return "awaiting_review";
    if (latestSubmissionStatus === "changes_requested") return "changes_requested";
    return revisions > 0 ? "changes_requested" : "awaiting_review";
  }
  if (status === "In Progress" && latestSubmissionStatus === "changes_requested") return "rework_in_progress";
  return null;
}

export const UPLOAD_KINDS = ["video", "image", "pdf"] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

export const UPLOAD_LIMITS_BYTES: Record<UploadKind, number> = {
  video: 500 * 1024 * 1024, // 500 MB (mp4, mov, webm)
  image: 20 * 1024 * 1024,  // 20 MB (png, jpg, webp)
  pdf: 50 * 1024 * 1024,    // 50 MB (pdf)
};

export const UPLOAD_ALLOWED_MIME_TYPES: Record<UploadKind, string[]> = {
  video: ["video/mp4", "video/quicktime", "video/webm"],
  image: ["image/png", "image/jpeg", "image/jpg", "image/webp"],
  pdf: ["application/pdf"],
};

export const UPLOAD_ALLOWED_EXTENSIONS: Record<UploadKind, string[]> = {
  video: [".mp4", ".mov", ".webm"],
  image: [".png", ".jpg", ".jpeg", ".webp"],
  pdf: [".pdf"],
};

// Workspaces Quality Rating Constants
export const RATING_SCORES = [1, 2, 3, 4, 5] as const;
export type RatingScore = (typeof RATING_SCORES)[number];

export const RATING_SCORE_LABELS: Record<RatingScore, string> = {
  1: "Needs a lot of work",
  2: "Below standard",
  3: "Good",
  4: "Very good",
  5: "Excellent",
};

export const RATING_TAGS = [
  "Great hook",
  "Clear message",
  "Needs polish",
  "Off brief",
] as const;
export type RatingTag = (typeof RATING_TAGS)[number];

// ==========================================
// 3. Zod Schemas
// ==========================================

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const setPasswordSchema = z.object({
  token: z.string().min(1, "Invite token is required"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
});
export type SetPasswordInput = z.infer<typeof setPasswordSchema>;

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[0-9]/, "Password must contain at least one number"),
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

// Strict Change Password for authenticated settings
export const changePasswordStrictSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
      .regex(/[0-9]/, "Password must contain at least one number"),
    confirmPassword: z.string().min(1, "Password confirmation is required"),
  })
  .strict()
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "New password and confirm password must match",
    path: ["confirmPassword"],
  })
  .refine((data) => data.newPassword !== data.currentPassword, {
    message: "New password must be different from current password",
    path: ["newPassword"],
  });
export type ChangePasswordStrictInput = z.infer<typeof changePasswordStrictSchema>;

// Profile & Settings Taxonomies
export const START_PAGE_OPTIONS = ["Home", "My Work", "Calendar"] as const;
export type StartPageOption = (typeof START_PAGE_OPTIONS)[number];

export const DATE_FORMAT_OPTIONS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"] as const;
export type DateFormatOption = (typeof DATE_FORMAT_OPTIONS)[number];

export const TIME_FORMAT_OPTIONS = ["12h", "24h"] as const;
export type TimeFormatOption = (typeof TIME_FORMAT_OPTIONS)[number];

export const WEEK_START_OPTIONS = ["monday", "sunday"] as const;
export type WeekStartOption = (typeof WEEK_START_OPTIONS)[number];

export const NOTIFICATION_CATEGORIES = [
  "mySteps",
  "approvalsRevisions",
  "messagesComments",
  "deadlinesOverdue",
  "planUpdates",
  "system",
  "chat",
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * A phone number field: spaces, dashes, dots and brackets people type ("+91 90721 90088",
 * "(907) 219-0088") are removed first, then it must be + and 7–15 digits. The parsed value is the
 * cleaned number, so the API stores it without separators.
 */
export const PHONE_SEPARATORS = /[\s\-().]/g;
export const cleanPhoneInput = (value: unknown) => (typeof value === "string" ? value.replace(PHONE_SEPARATORS, "") : value);
const phoneField = (message: string) => z.preprocess(cleanPhoneInput, z.string().regex(/^\+?[1-9]\d{6,14}$/, message));

/**
 * Whether a new or changed mobile number needs a 6-digit code before it is saved. Off for now:
 * the number is entered directly. The code flow (/api/me/phone-otp, code sent to the registered
 * email) stays in place; set this to true to require it again.
 */
export const PHONE_VERIFICATION_REQUIRED: boolean = false;

export const sendPhoneOtpSchema = z.object({
  phone: phoneField("Please enter a valid mobile number (e.g. +919876543210)"),
});
export type SendPhoneOtpInput = z.infer<typeof sendPhoneOtpSchema>;

export const verifyPhoneOtpSchema = z.object({
  phone: phoneField("Please enter a valid mobile number"),
  otp: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Verification code must be exactly 6 digits"),
});
export type VerifyPhoneOtpInput = z.infer<typeof verifyPhoneOtpSchema>;

export const profileUpdateSchema = z
  .object({
    name: z.string().trim().min(2, "Full name must be at least 2 characters").max(100).optional(),
    preferredName: z.string().trim().max(60, "Preferred name must not exceed 60 characters").optional(),
    phone: phoneField("Phone number must be a valid format (e.g. +919876543210)")
      .optional()
      .or(z.literal("")),
    phoneVerificationToken: z.string().optional(),
    enforceOtp: z.boolean().optional(),
    whatsappNumber: phoneField("WhatsApp number must be a valid format (e.g. +919876543210)")
      .optional()
      .or(z.literal("")),
    languages: z.array(z.string().trim().max(40)).max(5, "Maximum 5 languages permitted").optional(),
    about: z.string().trim().max(200, "About must not exceed 200 characters").optional(),
    skills: z
      .array(z.string().trim().max(30, "Each skill tag must be up to 30 characters"))
      .max(10, "Maximum 10 skill tags permitted")
      .optional(),
  })
  .strict();
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

export const userPreferencesSchema = z
  .object({
    startPage: z.enum(START_PAGE_OPTIONS).optional(),
    dateFormat: z.enum(DATE_FORMAT_OPTIONS).optional(),
    timeFormat: z.enum(TIME_FORMAT_OPTIONS).optional(),
    weekStart: z.enum(WEEK_START_OPTIONS).optional(),
  })
  .strict();
export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>;

export const notificationCategoryPrefSchema = z
  .object({
    inApp: z.boolean(),
    email: z.boolean(),
    mentionsOnly: z.boolean().optional(),
  })
  .strict();
export type NotificationCategoryPref = z.infer<typeof notificationCategoryPrefSchema>;

export const notificationPrefsSchema = z
  .object({
    mySteps: notificationCategoryPrefSchema.optional(),
    approvalsRevisions: notificationCategoryPrefSchema.optional(),
    messagesComments: notificationCategoryPrefSchema.optional(),
    deadlinesOverdue: notificationCategoryPrefSchema.optional(),
    planUpdates: notificationCategoryPrefSchema.optional(),
    system: notificationCategoryPrefSchema.optional(),
    chat: notificationCategoryPrefSchema.optional(),
  })
  .strict();
export type NotificationPrefsInput = z.infer<typeof notificationPrefsSchema>;

export const settingsUpdateSchema = z
  .object({
    preferences: userPreferencesSchema.optional(),
    notificationPrefs: notificationPrefsSchema.optional(),
  })
  .strict();
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

export const changeRequestSchema = z
  .object({
    requestedChanges: z
      .string()
      .trim()
      .min(5, "Please provide at least 5 characters describing your requested changes")
      .max(1000, "Request message must not exceed 1000 characters"),
  })
  .strict();
export type ChangeRequestInput = z.infer<typeof changeRequestSchema>;

export const adminUpdatePersonBasicSchema = z
  .object({
    name: z.string().trim().min(2, "Name must be at least 2 characters").optional(),
    phone: phoneField("Valid phone number required")
      .optional()
      .or(z.literal("")),
  })
  .strict();
export type AdminUpdatePersonBasicInput = z.infer<typeof adminUpdatePersonBasicSchema>;

export const welcomeCompleteSchema = z
  .object({
    name: z.string().trim().min(2, "Full name must be at least 2 characters"),
    phone: phoneField("Valid phone number required (e.g. +919876543210)"),
    avatarUrl: z.string().trim().optional().nullable(),
    avatarStorageId: z.string().trim().optional().nullable(),
  })
  .strict();
export type WelcomeCompleteInput = z.infer<typeof welcomeCompleteSchema>;

export const refreshTokenSchema = z.object({
  refreshToken: z.string().optional(),
});

// Public access requests: a worker (executive) or an SM Manager only.
export const REQUESTABLE_ROLES = ["executive", "sm_manager"] as const;
export type RequestableRole = (typeof REQUESTABLE_ROLES)[number];

export const requestAccessSchema = z.object({
  name: z.string().trim().min(2, "Full name must be at least 2 characters"),
  email: z.string().trim().email("Valid work email required"),
  phone: z.string().trim().min(7, "Valid contact number required"),
  department: z.string().trim().min(1, "Department is required"),
  jobRole: z.string().trim().min(1, "Job role is required"),
  requestedRole: z.enum(REQUESTABLE_ROLES, {
    errorMap: () => ({
      message: "Only Team Member or SM Manager can be requested",
    }),
  }),
  requestedProfileCodes: z.array(z.string()).optional().default([]),
  reason: z
    .string()
    .trim()
    .min(
      10,
      "Please describe your role and the work you will do in the marketing team (min 10 characters)",
    ),
});
export type RequestAccessInput = z.infer<typeof requestAccessSchema>;
export const publicRequestAccessSchema = requestAccessSchema;
export type PublicRequestAccessInput = RequestAccessInput;

export const accessRequestReviewSchema = z.object({
  status: z
    .enum(["approved", "rejected", "info_needed"])
    .optional()
    .default("approved"),
  assignedRole: z.enum(ROLE_KEYS).optional(),
  departmentId: z.string().optional().nullable(),
  jobRole: z.string().optional(),
  weeklyCapacityHours: z.number().min(0).max(80).default(40).optional(),
  profileAccess: z.array(z.string()).optional().default([]),
  reportsToIds: z.array(z.string()).optional(),
  reason: z.string().optional(),
  question: z.string().optional(),
});
export type AccessRequestReviewInput = z.infer<
  typeof accessRequestReviewSchema
>;

export const departmentSchema = z.object({
  name: z.string().min(2, "Department name is required"),
  code: z.string().min(2, "Department code is required"),
  description: z.string().optional(),
  lead: z.string().optional().nullable(),
  isActive: z.boolean().default(true),
});
export type DepartmentInput = z.infer<typeof departmentSchema>;

export const personCreateSchema = z.object({
  name: z.string().min(2, "Name is required"),
  email: z.string().email("Valid email is required"),
  role: z.enum(ROLE_KEYS),
  jobRole: z.enum(JOB_ROLES).optional(),
  departmentId: z.string().optional().nullable(),
  reportsToIds: z.array(z.string()).default([]),
  weeklyCapacityHours: z.number().min(0).max(80).default(40),
  password: z.string().min(8).optional(),
  workPreferences: z.array(z.enum(WORK_PREFERENCES)).default([]),
});
export type PersonCreateInput = z.infer<typeof personCreateSchema>;

export const personOperationalUpdateSchema = z.object({
  departmentId: z.string().optional().nullable(),
  jobRole: z.enum(JOB_ROLES).optional().nullable(),
  reportsToIds: z.array(z.string()).optional(),
  weeklyCapacityHours: z.number().min(0).max(80).optional(),
  activeStepLimit: z.number().int().min(1).max(20).optional(),
  workPreferences: z.array(z.enum(WORK_PREFERENCES)).optional(),
});
export type PersonOperationalUpdateInput = z.infer<
  typeof personOperationalUpdateSchema
>;

export const personAdminUpdateSchema = personOperationalUpdateSchema.extend({
  name: z.string().min(2).optional(),
  email: z.string().email().optional(),
  role: z.enum(ROLE_KEYS).optional(),
  status: z.enum(["invited", "active", "suspended"]).optional(),
});
export type PersonAdminUpdateInput = z.infer<typeof personAdminUpdateSchema>;


// Work Items Schemas
export const briefSchema = z.object({
  description: z.string().optional().default(""),
  contentLink: z.string().optional().default(""),
  assetsLink: z.string().optional().default(""),
});
export type BriefInput = z.infer<typeof briefSchema>;

export const workItemCreateSchema = z.object({
  title: z.string().trim().min(2, "Work item title is required"),
  workType: z.enum(WORK_TYPES),
  departmentId: z.string().optional().nullable(),
  ownerId: z.string().optional().nullable(),
  deadline: z.coerce.date(),
  estimatedEffortHrs: z.number().min(0.5).max(100).default(4),
  status: z.enum(WORK_ITEM_STATUSES).default("Not Started"),
  priority: z.enum(PRIORITIES).default("Normal"),
  description: z.string().optional(),
  deliverableUrl: z.string().optional(),
  publishedUrl: z.string().optional(),
  blockerReason: z.enum(BLOCKER_REASONS).optional(),
  blockerNote: z.string().optional(),
  // Content Flow stage fields (Phase 3 delta)
  contentPieceId: z.string().optional().nullable(),
  stageKey: z.string().optional().nullable(),
  stageOrder: z.number().int().min(1).optional().nullable(),
  reviewRequired: z.boolean().default(false).optional(),
  unlockedAt: z.coerce.date().optional().nullable(),
  isSkipped: z.boolean().default(false).optional(),
  contentLink: z.string().optional(),
  assetsLink: z.string().optional(),
  brief: z.union([z.string(), briefSchema]).optional(),
});
export type WorkItemCreateInput = z.infer<typeof workItemCreateSchema>;

export const workItemUpdateSchema = workItemCreateSchema.partial();
export type WorkItemUpdateInput = z.infer<typeof workItemUpdateSchema>;

// Post caption and hashtags (Phase 5d). No longer asked for or saved: a Post step is marked
// posted with its live link only. Captions saved earlier stay in the database. The limits
// are kept for the caption counter component.
// Counted together, as on the platforms: Instagram allows 2,200 characters, LinkedIn 3,000.
export const POST_CAPTION_LIMITS = { instagram: 2200, linkedin: 3000 } as const;
export const POST_CAPTION_MAX = POST_CAPTION_LIMITS.linkedin;
export function postCaptionLength(caption: string = "", hashtags: string = ""): number {
  const parts = [String(caption || "").trim(), String(hashtags || "").trim()].filter(Boolean);
  // Joined by a blank line, as posted: two characters between caption and hashtags.
  return parts.join("").length + (parts.length > 1 ? 2 : 0);
}

export const workItemTransitionSchema = z.object({
  toStatus: z.enum(WORK_ITEM_STATUSES),
  blockerReason: z.enum(BLOCKER_REASONS).optional(),
  blockerNote: z.string().optional(),
  deliverableUrl: z.string().optional(),
  publishedUrl: z.string().optional(),
  comment: z.string().optional(),
});
export type WorkItemTransitionInput = z.infer<typeof workItemTransitionSchema>;

// Auto-Assignment & Workload Schemas
export const CAPACITY_BANDS = ["Healthy", "High", "Overloaded"] as const;
export type CapacityBand = (typeof CAPACITY_BANDS)[number];

export const assignmentRecommendSchema = z.object({
  workType: z.enum(WORK_TYPES).optional(),
  departmentId: z.string().optional(),
  deadline: z.coerce.date().optional(),
  estimatedEffortHrs: z.number().min(0.5).max(120).default(4),
  stageKey: z.string().optional().nullable(),
  workItemId: z.string().optional().nullable(),
});
export type AssignmentRecommendInput = z.infer<
  typeof assignmentRecommendSchema
>;

export const assignmentOverrideSchema = z.object({
  workItemId: z.string().min(1, "Work item ID is required"),
  recommendedPersonId: z.string().min(1, "Recommended person ID is required"),
  chosenPersonId: z.string().min(1, "Chosen person ID is required"),
  reason: z.string().min(3, "Override reason is required"),
  metadata: z.record(z.any()).optional(),
});
export type AssignmentOverrideInput = z.infer<typeof assignmentOverrideSchema>;

// Feedback Loops, Revision Flags & Blockers Schemas
export const FEEDBACK_ROUND_STATUSES = [
  "Revision Required",
  "Approved",
] as const;
export type FeedbackRoundStatus = (typeof FEEDBACK_ROUND_STATUSES)[number];

export const feedbackEntryCreateSchema = z.object({
  workItemId: z.string().min(1, "Work item ID is required"),
  round: z.number().int().min(1).default(1),
  roundStatus: z.enum(FEEDBACK_ROUND_STATUSES).default("Revision Required"),
  text: z.string().trim().min(2, "Feedback or response text is required"),
  isResponse: z.boolean().default(false),
  attachments: z
    .array(
      z.object({
        name: z.string(),
        url: z.string().url("Attachment URL must be valid"),
        fileType: z.string().optional(),
        size: z.number().optional(),
      }),
    )
    .optional(),
});
export type FeedbackEntryCreateInput = z.infer<
  typeof feedbackEntryCreateSchema
>;

export const revisionClassifySchema = z.object({
  // New classifications: canonical values only (legacy values stay readable on saved flags).
  rootCause: z.enum(CANONICAL_REVISION_ROOT_CAUSES),
  rootCauseNotes: z.string().optional(),
});
export type RevisionClassifyInput = z.infer<typeof revisionClassifySchema>;

export const blockerCreateSchema = z
  .object({
    workItemId: z.string().min(1, "Work item ID is required"),
    reason: z.enum(BLOCKER_REASONS),
    notes: z.string().optional(),
    dependencyOwnerId: z.string().optional(),
  })
  .refine(
    (data) => {
      if (BLOCKER_DEPENDENCY_REASONS.includes(data.reason)) {
        return Boolean(
          data.dependencyOwnerId && data.dependencyOwnerId.trim().length > 0,
        );
      }
      return true;
    },
    {
      message:
        "dependencyOwnerId is mandatory when blocker reason is Waiting for feedback, Waiting for content, or Waiting for data",
      path: ["dependencyOwnerId"],
    },
  );
export type BlockerCreateInput = z.infer<typeof blockerCreateSchema>;

export const blockerResolveSchema = z.object({
  resolutionNotes: z.string().optional(),
  // Left out: the step returns to the status it had before it was blocked.
  resumeStatus: z.enum(WORK_ITEM_STATUSES).optional(),
});
export type BlockerResolveInput = z.infer<typeof blockerResolveSchema>;

// ==========================================
// Automation Rules & Report Definitions
// ==========================================

export const AUTOMATION_RULE_KEYS = [
  "month_end_report",
  "overdue_escalation",
  "todo_escalation",
  "blocker_dependency_alert",
  "revision_pattern_flag",
  "pause_reminders",
  "weekly_report",
] as const;
export type AutomationRuleKey = (typeof AUTOMATION_RULE_KEYS)[number];

export const automationRuleToggleSchema = z.object({
  active: z.boolean(),
});
export type AutomationRuleToggleInput = z.infer<
  typeof automationRuleToggleSchema
>;

export const automationRuleRunSchema = z.object({
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
export type AutomationRuleRunInput = z.infer<typeof automationRuleRunSchema>;

export const REPORT_KEYS = [
  "weekly_marketing",
  "monthly_scorecard",
  "creative_production",
  "team_performance",
] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const REPORT_CADENCES = ["Weekly", "Monthly", "On Demand"] as const;
export type ReportCadence = (typeof REPORT_CADENCES)[number];

export const reportGenerateSchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  departmentId: z.string().optional(),
  sendEmail: z.boolean().default(false),
});
export type ReportGenerateInput = z.infer<typeof reportGenerateSchema>;

// ==========================================
// 4. Content Flow & Pipelines (Scope Reset R3)
// ==========================================

export const PIPELINES = {
  DESIGN: "design",
  REEL_A: "reel_a",
  REEL_B: "reel_b",
  REEL_C: "reel_c",
} as const;
export type PipelineKey = (typeof PIPELINES)[keyof typeof PIPELINES];

export const STAGE_KEYS = [
  "Content",
  "Script",
  "Design",
  "Shoot",
  "Edit",
  "Post",
] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const REVIEW_STAGES: StageKey[] = ["Content", "Script", "Shoot", "Design", "Edit"];
export const NON_REVIEW_STAGES: StageKey[] = ["Post"];

// 15 Deliverable Types (Workflow V2)
export const DELIVERABLE_TYPES_CONFIG = [
  { type: "Reel", isPostable: true, label: "Reel" },
  { type: "Static Post", isPostable: true, label: "Static Post" },
  { type: "Carousel Post", isPostable: true, label: "Carousel Post" },
  { type: "Story", isPostable: true, label: "Story" },
  { type: "Poster", isPostable: false, label: "Poster" },
  { type: "Brochure", isPostable: false, label: "Brochure" },
  { type: "Flyer", isPostable: false, label: "Flyer" },
  { type: "Banner", isPostable: false, label: "Banner" },
  { type: "Standee", isPostable: false, label: "Standee" },
  { type: "Certificate", isPostable: false, label: "Certificate" },
  { type: "ID Card", isPostable: false, label: "ID Card" },
  { type: "Presentation", isPostable: false, label: "Presentation" },
  { type: "Newsletter", isPostable: false, label: "Newsletter" },
  { type: "Merchandise", isPostable: false, label: "Merchandise" },
  { type: "Other", isPostable: false, label: "Other" },
] as const;

export const DELIVERABLE_TYPE_KEYS = DELIVERABLE_TYPES_CONFIG.map((d) => d.type);
export type DeliverableTypeKey = (typeof DELIVERABLE_TYPE_KEYS)[number];

export const POSTABLE_WORK_TYPES = [
  "Reel",
  "Static Post",
  "Carousel Post",
  "Story",
] as const;

export const NON_POSTABLE_WORK_TYPES = [
  "Poster",
  "Brochure",
  "Flyer",
  "Banner",
  "Standee",
  "Certificate",
  "ID Card",
  "Presentation",
  "Newsletter",
  "Merchandise",
  "Other",
  // Legacy compatibility types
  "Cover Image",
  "Thumbnail",
  "Meta Ad Creative",
  "Class Announcement",
  "Orientation Creative",
  "Graduation Creative",
  "Offer Creative",
  "Placement Poster",
  "Custom Request",
] as const;

export function isPostableWorkType(type: string): boolean {
  if (type === "Poster" || type === "poster") return false;
  const norm = normalizeWorkType(type);
  if (norm === "Poster" || (NON_POSTABLE_WORK_TYPES as readonly string[]).includes(type)) return false;
  return (POSTABLE_WORK_TYPES as readonly string[]).includes(norm);
}

export function getPipelineForContent({
  contentType,
  needsScript,
  needsShoot,
  needsContent,
}: {
  contentType: string;
  needsScript?: boolean;
  needsShoot?: boolean;
  /** Static Post / Carousel Post only: false = Design only (Design → Post). Missing = true. */
  needsContent?: boolean;
}): {
  pipeline: PipelineKey;
  stages: StageKey[];
  hasPostStage: boolean;
} {
  const norm = normalizeWorkType(contentType);
  if (norm === "Reel") {
    const withScript = Boolean(needsScript);
    const withShoot = Boolean(needsShoot);
    if (withScript && withShoot) {
      return {
        pipeline: "reel_a",
        stages: ["Script", "Shoot", "Edit", "Post"],
        hasPostStage: true,
      };
    }
    if (!withScript && withShoot) {
      return {
        pipeline: "reel_b",
        stages: ["Shoot", "Edit", "Post"],
        hasPostStage: true,
      };
    }
    return {
      pipeline: "reel_c",
      stages: ["Edit", "Post"],
      hasPostStage: true,
    };
  }
  const postable = isPostableWorkType(contentType);
  const designOnly = needsContent === false && (DESIGN_WORKFLOW_TYPES as readonly string[]).includes(norm);
  const stages: StageKey[] = [
    ...(designOnly ? [] : (["Content"] as StageKey[])),
    "Design",
    ...(postable ? (["Post"] as StageKey[]) : []),
  ];
  return { pipeline: "design", stages, hasPostStage: postable };
}

// ==========================================
// Row workflows (which steps a row has)
// ==========================================
// Stored as the row's flags (needsScript, needsShoot, needsContent); the workflow is read from them.

export const ROW_WORKFLOWS = ["full", "shoot_edit", "edit_only", "with_content", "design_only"] as const;
export type RowWorkflow = (typeof ROW_WORKFLOWS)[number];

export const ROW_WORKFLOW_LABELS: Record<RowWorkflow, string> = {
  full: "Full",
  shoot_edit: "Shoot + Edit",
  edit_only: "Edit only",
  with_content: "With content",
  design_only: "Design only",
};

/** Types whose design rows may drop the Content step. */
export const DESIGN_WORKFLOW_TYPES = ["Static Post", "Carousel Post"] as const;

export interface RowStepFlags {
  needsScript?: boolean | null;
  needsShoot?: boolean | null;
  needsContent?: boolean | null;
}

/** Workflow choices for a type, default first; empty for types with a fixed step list. */
export function workflowOptionsFor(type: string | null | undefined): RowWorkflow[] {
  const norm = normalizeWorkType(type || "");
  if (norm === "Reel") return ["full", "shoot_edit", "edit_only"];
  if ((DESIGN_WORKFLOW_TYPES as readonly string[]).includes(norm)) return ["with_content", "design_only"];
  return [];
}

export function defaultWorkflowFor(type: string | null | undefined): RowWorkflow | null {
  return workflowOptionsFor(type)[0] ?? null;
}

/** The stored flags for a workflow. */
export function workflowFlags(workflow: RowWorkflow): { needsScript: boolean; needsShoot: boolean; needsContent: boolean } {
  switch (workflow) {
    case "full":
      return { needsScript: true, needsShoot: true, needsContent: true };
    case "shoot_edit":
      return { needsScript: false, needsShoot: true, needsContent: true };
    case "edit_only":
      return { needsScript: false, needsShoot: false, needsContent: true };
    case "design_only":
      return { needsScript: false, needsShoot: false, needsContent: false };
    default:
      return { needsScript: false, needsShoot: false, needsContent: true };
  }
}

/** The workflow a row's stored flags give (same rule as getPipelineForContent); null for fixed types. */
export function workflowFromFlags(type: string | null | undefined, flags: RowStepFlags = {}): RowWorkflow | null {
  const norm = normalizeWorkType(type || "");
  if (norm === "Reel") {
    if (flags.needsScript && flags.needsShoot) return "full";
    return flags.needsShoot ? "shoot_edit" : "edit_only";
  }
  if ((DESIGN_WORKFLOW_TYPES as readonly string[]).includes(norm)) return flags.needsContent === false ? "design_only" : "with_content";
  return null;
}

/** "Reel · Edit only"; just the type for types without a workflow choice. */
export function workflowLabel(type: string | null | undefined, flags: RowStepFlags = {}): string {
  const t = String(type || "");
  const w = workflowFromFlags(t, flags);
  return w ? `${t} · ${ROW_WORKFLOW_LABELS[w]}` : t;
}

const normWorkflowWord = (v: string) => v.trim().toLowerCase().replace(/[\s_+-]+/g, " ").trim();
const WORKFLOW_BY_WORD = new Map<string, RowWorkflow>(
  ROW_WORKFLOWS.flatMap((w) => [
    [normWorkflowWord(w), w] as [string, RowWorkflow],
    [normWorkflowWord(ROW_WORKFLOW_LABELS[w]), w] as [string, RowWorkflow],
  ])
);

export type WorkflowParseResult = { ok: true; value: RowWorkflow | null } | { ok: false; error: string };

/** Workflow cell for a type. Blank = the type's default (value null). A choice the type does not have is an error. */
export function parseWorkflow(type: string | null | undefined, raw: unknown): WorkflowParseResult {
  const text = raw === null || raw === undefined ? "" : String(raw).trim();
  if (!text) return { ok: true, value: null };
  const w = WORKFLOW_BY_WORD.get(normWorkflowWord(text));
  const options = workflowOptionsFor(type);
  const optionWords = options.map((o) => ROW_WORKFLOW_LABELS[o]).join(", ");
  if (!w) {
    return { ok: false, error: `Unknown workflow "${text}". Use ${optionWords || "nothing (leave it blank)"}.` };
  }
  if (!type) return { ok: true, value: w };
  if (!options.length) return { ok: false, error: `${type} has no workflow choice. Leave Workflow blank.` };
  if (!options.includes(w)) return { ok: false, error: `${type} can't use "${ROW_WORKFLOW_LABELS[w]}". Use ${optionWords}.` };
  return { ok: true, value: w };
}

/** Edit only reels start from a source video: an app upload or a Google Drive / Docs link. Null when fine. */
export function sourceVideoLinkError(workflow: RowWorkflow | null, link: unknown): string | null {
  if (workflow !== "edit_only") return null;
  const value = typeof link === "string" ? link.trim() : "";
  if (!value) return "Edit only needs a source video link: a file uploaded here, or a Google Drive / Docs link.";
  if (!isAllowedOutputUrl(value)) return `Source video link: ${OUTPUT_URL_ERROR}`;
  return null;
}

// Due-date offsets (counted back in calendar days from final date F per Workflow V2)
export const STAGE_DUE_OFFSETS: Record<string, Record<string, number>> = {
  design_postable: { Content: 5, Design: 2, Post: 0 },
  design_non_postable: { Content: 5, Design: 2 },
  reel_a: { Script: 8, Shoot: 5, Edit: 2, Post: 0 },
  reel_b: { Shoot: 5, Edit: 2, Post: 0 },
  reel_c: { Edit: 2, Post: 0 },
};

// Default stage effort hours (internal engine config, never shown in user forms)
export const DEFAULT_STAGE_HOURS: Record<StageKey, number> = {
  Content: 2,
  Script: 2,
  Design: 4,
  Shoot: 4,
  Edit: 6,
  Post: 1,
};

export function calculateStageDueDate(
  finalDate: Date,
  pipeline: string,
  stage: StageKey,
  hasPostStage: boolean = true
): Date {
  let key = pipeline;
  if (pipeline === "design") {
    key = hasPostStage ? "design_postable" : "design_non_postable";
  }
  const offsetDays = STAGE_DUE_OFFSETS[key]?.[stage] ?? 0;
  const dueDate = new Date(finalDate);
  dueDate.setDate(dueDate.getDate() - offsetDays);
  return dueDate;
}

export const DISPLAY_WORDS = {
  DONE: "Done",
  APPROVED: "Approved",
  REVISION_REQUESTED: "Revision requested",
} as const;

// Exactly two plan kinds: monthly and individual (project removed)
export const CALENDAR_PLAN_KINDS = ["monthly", "individual", "project"] as const;
export type CalendarPlanKind = (typeof CALENDAR_PLAN_KINDS)[number];

export const CALENDAR_PLAN_STATUSES = [
  "Draft",
  "Submitted",
  "Changes requested",
  "Approved",
  "Approved with pending rows",
] as const;
export type CalendarPlanStatus = (typeof CALENDAR_PLAN_STATUSES)[number];

export const ROW_STATUSES = [
  "draft",
  "submitted",
  "changes_requested",
  "approved",
] as const;
export type RowStatus = (typeof ROW_STATUSES)[number];

// Validation Codes (Workflow V2 Section 5)
export const VALIDATION_ERROR_CODES = {
  MISSING_REQUIRED_FIELDS: "MISSING_REQUIRED_FIELDS",
  UNKNOWN_TYPE: "UNKNOWN_TYPE",
  PAST_DATE: "PAST_DATE",
  DEADLINE_AFTER_POSTING: "DEADLINE_AFTER_POSTING",
  OUT_OF_ORDER_DEADLINES: "OUT_OF_ORDER_DEADLINES",
  MISSING_SOURCE_VIDEO: "MISSING_SOURCE_VIDEO",
  MISSING_POSTING_OWNER: "MISSING_POSTING_OWNER",
  INVALID_STAGE_OWNER: "INVALID_STAGE_OWNER",
  DUPLICATE_ROW: "DUPLICATE_ROW",
  INDIVIDUAL_PLAN_ROW_LIMIT: "INDIVIDUAL_PLAN_ROW_LIMIT",
} as const;
export type ValidationErrorCode = (typeof VALIDATION_ERROR_CODES)[keyof typeof VALIDATION_ERROR_CODES];

export const VALIDATION_WARNING_CODES = {
  TIGHT_CREATION_BUFFER: "TIGHT_CREATION_BUFFER",
  WORKLOAD_SATURATION: "WORKLOAD_SATURATION",
  MONTH_MISMATCH: "MONTH_MISMATCH",
  /** The calendar has no active poster: the Post step waits unowned and the posters are told. */
  NO_ACTIVE_POSTER: "NO_ACTIVE_POSTER",
} as const;
export type ValidationWarningCode = (typeof VALIDATION_WARNING_CODES)[keyof typeof VALIDATION_WARNING_CODES];

export function derivePlanStatus(
  rows: { rowStatus: RowStatus }[],
  submittedAt?: Date | null
): CalendarPlanStatus {
  if (!rows || rows.length === 0) {
    return "Draft";
  }
  const total = rows.length;
  const approvedCount = rows.filter((r) => r.rowStatus === "approved").length;
  const changesCount = rows.filter(
    (r) => r.rowStatus === "changes_requested"
  ).length;
  const submittedCount = rows.filter((r) => r.rowStatus === "submitted").length;
  const draftCount = rows.filter((r) => r.rowStatus === "draft").length;

  if (approvedCount === total && total > 0) return "Approved";
  if (
    approvedCount > 0 &&
    (draftCount > 0 || submittedCount > 0 || changesCount > 0)
  ) {
    return "Approved with pending rows";
  }
  if (changesCount > 0) return "Changes requested";
  if (submittedCount > 0) return "Submitted";
  return "Draft";
}

export function formatPlanRowCounts(counts?: {
  draft?: number;
  submitted?: number;
  changes_requested?: number;
  approved?: number;
  total?: number;
} | null): string {
  if (!counts) return "No rows yet";
  const total =
    counts.total ??
    ((counts.draft || 0) +
      (counts.submitted || 0) +
      (counts.changes_requested || 0) +
      (counts.approved || 0));
  if (total === 0) return "No rows yet";

  const parts: string[] = [];
  if (counts.approved && counts.approved > 0) parts.push(`${counts.approved} approved`);
  if (counts.submitted && counts.submitted > 0) parts.push(`${counts.submitted} submitted`);
  if (counts.changes_requested && counts.changes_requested > 0) parts.push(`${counts.changes_requested} changes requested`);
  if (counts.draft && counts.draft > 0) parts.push(`${counts.draft} draft`);

  const rowsLabel = total === 1 ? "1 row" : `${total} rows`;
  return parts.length > 0 ? `${rowsLabel}: ${parts.join(", ")}` : rowsLabel;
}

// Stage Plan Item inside a draft row
export const stagePlanItemSchema = z.object({
  stageKey: z.enum(STAGE_KEYS),
  ownerId: z.string().optional().nullable(),
  dueDate: z.coerce.date(),
  ownerSource: z.enum(["suggested", "manual"]).default("suggested"),
  dueDateSource: z.enum(["auto", "manual"]).default("auto"),
  overrideReason: z.string().optional(),
});
export type StagePlanItem = z.infer<typeof stagePlanItemSchema>;

// Calendar Plan Schemas (Workflow V2)
export const calendarPlanRowCreateSchema = z.object({
  postingDate: z.coerce.date(),
  postingTime: z.string().optional().default("18:00"),
  topic: z.string().trim().min(2, "Topic must be at least 2 characters"),
  type: z.string().trim().min(1, "Deliverable type is required"),
  contentType: z.string().optional(), // alias
  forTeam: z.string().optional(),
  calendar: z.enum(CALENDAR_KEYS).optional(),
  programOrEvent: z.string().optional().default(""),
  brief: z.string().optional().default(""),
  referenceLink: z.string().optional().default(""),
  priority: z.enum(PRIORITIES).default("Normal"),
  remarks: z.string().optional().default(""),
  postingOwnerId: z.string().optional().nullable(),
  needsScript: z.boolean().default(false).optional(),
  needsShoot: z.boolean().default(false).optional(),
  sourceVideoLink: z.string().optional().default(""),
  rowStatus: z.enum(ROW_STATUSES).default("draft"),
  reviewComment: z.string().optional().default(""),
  stagePlan: z.array(stagePlanItemSchema).optional().default([]),
});
export type CalendarPlanRowCreateInput = z.infer<
  typeof calendarPlanRowCreateSchema
>;

export const calendarPlanCreateSchema = z.object({
  code: z.string().optional(),
  title: z.string().trim().optional(),
  calendar: z.enum(CALENDAR_KEYS).default("sm"),
  kind: z.enum(CALENDAR_PLAN_KINDS).default("monthly"),
  /** Monthly plans: 'YYYY-MM'. When given, the period is that whole month. */
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  comment: z.string().optional().default(""),
  rejectionConcern: z.string().optional().default(""),
  rows: z.array(calendarPlanRowCreateSchema).optional().default([]),
});
export type CalendarPlanCreateInput = z.infer<typeof calendarPlanCreateSchema>;

/** Phase 13: values a lead may suggest when sending a plan row back. All optional. */
export const PLAN_ROW_SUGGESTION_FIELDS = ["postingDate", "topic", "type", "workflow", "brief"] as const;
export type PlanRowSuggestionField = (typeof PLAN_ROW_SUGGESTION_FIELDS)[number];
export const planRowSuggestionsSchema = z
  .object({
    postingDate: z.string().optional(),
    topic: z.string().optional(),
    type: z.string().optional(),
    workflow: z.string().optional(),
    brief: z.string().optional(),
  })
  .strict();
export type PlanRowSuggestions = z.infer<typeof planRowSuggestionsSchema>;

/**
 * Plan review (Phase 13): approve rows, request changes on rows (message required, optional
 * suggested values) or on the whole plan (request_changes_all: every submitted row, one
 * message). The old "reject" action is retired and fails validation (400).
 */
export const calendarPlanReviewSchema = z.object({
  action: z.enum(["approve_all", "approve_selected", "request_changes", "request_changes_all"]),
  approvedRowIds: z.array(z.string()).optional().default([]),
  selectedRowIds: z.array(z.string()).optional(),
  comments: z.record(z.string()).optional(),
  message: z.string().optional(),
  changes: z
    .array(
      z.object({
        rowId: z.string().min(1, "Row ID is required"),
        comment: z.string().trim().min(1, "Write what should change."),
        suggestions: planRowSuggestionsSchema.optional(),
      })
    )
    .optional()
    .default([]),
});
export type CalendarPlanReviewInput = z.infer<typeof calendarPlanReviewSchema>;

export const contentPieceAssignSchema = z.object({
  assignments: z.array(
    z.object({
      workItemId: z.string().min(1, "Work item ID is required"),
      assigneeId: z.string().min(1, "Assignee ID is required"),
      overrideReason: z.string().optional(),
    })
  ),
});
export type ContentPieceAssignInput = z.infer<typeof contentPieceAssignSchema>;

export const contentPieceRescheduleSchema = z.object({
  postingDate: z.coerce.date(),
  shiftUnstartedStages: z.boolean().default(true).optional(),
});
export type ContentPieceRescheduleInput = z.infer<
  typeof contentPieceRescheduleSchema
>;

// ==========================================
// 8. Shared Work Actions & Role Authorization Matrix
// ==========================================

export const WORK_ACTION_KEYS = [
  "start",
  "submit_for_approval",
  "mark_as_posted",
  "mark_blocked",
  "request_help",
  "approve",
  "request_revision",
  "change_owner",
  "change_date",
  "skip_step",
  "resolve_blocker",
  "edit_details",
  "delete",
] as const;

export type WorkActionKey = (typeof WORK_ACTION_KEYS)[number];

export const ACTION_LABELS: Record<WorkActionKey, string> = {
  start: "Start",
  submit_for_approval: "Submit for approval",
  mark_as_posted: "Mark as posted",
  mark_blocked: "Mark blocked",
  request_help: "Request help",
  approve: "Approve",
  request_revision: "Request revision",
  change_owner: "Change owner",
  change_date: "Change date",
  skip_step: "Skip step",
  resolve_blocker: "Resolve blocker",
  edit_details: "Edit details",
  delete: "Delete",
};

export interface WorkActionStageContext {
  _id?: string;
  id?: string;
  ownerId?: any;
  status?: string;
  stageKey?: string | null;
  stageOrder?: number | null;
  isLocked?: boolean;
  isSkipped?: boolean;
  reviewRequired?: boolean;
  blockerReason?: string | null;
  deliverableUrl?: string | null;
  publishedUrl?: string | null;
  startedAt?: string | Date | null;
  previousStage?: {
    stageKey?: string;
    owner?: { name?: string };
    status?: string;
  } | null;
  pieceStages?: any[];
  /** "paused" while a lead-approved pause runs: no work actions until it is resumed. */
  pauseState?: string | null;
}

export interface WorkActionPieceContext {
  _id?: string;
  topic?: string;
  contentType?: string;
  pipeline?: string;
  stages?: any[];
}

export interface AvailableActionsResult {
  actions: WorkActionKey[];
  isOwner: boolean;
  reason?: string;
}

/**
 * Returns available actions for a user on a given stage/task.
 * Strictly enforces:
 * - A user never gets owner actions on a task they do not own, even with permission keys.
 * - creative_lead, growth_lead and admin: Approve and Request revision only when Waiting for approval (Pending) and user is not owner. Nothing else on tasks they don't own.
 * - sm_manager and admin: Change owner, Change date, Skip step (before start), Resolve blocker, Edit details, Delete (before start). No approve, no submit.
 * - creative_head, production_head (read-only) and non-owners without role rights: no action buttons.
 */
export function getAvailableActions(
  user: { _id?: string; id?: string; userId?: string; role?: string; name?: string } | null | undefined,
  stage: WorkActionStageContext | null | undefined,
  piece?: WorkActionPieceContext | null | undefined
): AvailableActionsResult {
  if (!user || !stage) {
    return { actions: [], isOwner: false, reason: "No user or stage" };
  }

  const userId = (user.userId || user._id || user.id)?.toString();
  const rawOwner = stage.ownerId;
  const stageOwnerId = (rawOwner?._id || rawOwner?.id || rawOwner)?.toString();
  const isOwner = Boolean(userId && stageOwnerId && userId === stageOwnerId);
  const role = normalizeRole(user.role);

  const status = stage.status || "Not Started";
  const isLocked = Boolean(stage.isLocked);
  const isSkipped = Boolean(stage.isSkipped);
  const stageKey = stage.stageKey;

  const actions: WorkActionKey[] = [];

  // 1. Owner Actions (strictly while unlocked and not skipped)
  if (isOwner && !isLocked && !isSkipped) {
    if (status === "Not Started") {
      actions.push("start");
    } else if (status === "In Progress") {
      if (stageKey === "Post") {
        actions.push("mark_as_posted");
      } else {
        // Review steps: Content, Script, Shoot, Design, Edit (or generic reviewable step)
        actions.push("submit_for_approval");
      }
      actions.push("mark_blocked");
      actions.push("request_help");
    } else if (status === "Feedback") {
      actions.push("submit_for_approval");
      actions.push("mark_blocked");
      actions.push("request_help");
    } else if (status === "Blocked") {
      // The owner resolves their own blocker (the API allows owner, sm_manager and admin).
      actions.push("resolve_blocker");
      actions.push("request_help");
    } else if (status === "Approved" && stageKey === "Post") {
      actions.push("mark_as_posted");
    }
  }

  // 2. Creative Manager Actions (Approve & Request revision ONLY on Pending tasks they do NOT own)
  if (canReview(role) && !isOwner) {
    if (status === "Pending") {
      actions.push("approve");
      actions.push("request_revision");
    }
  }

  // 3. SM Manager & Admin Actions (Change owner, Change date, Skip step, Resolve blocker, Edit, Delete)
  if (role === "sm_manager" || role === "admin") {
    // Only management actions, no approve, no submit (unless owner of the stage handled above)
    if (status !== "Published") {
      actions.push("change_owner");
      actions.push("change_date");
    }

    if (status === "Not Started" && !stage.startedAt && !isSkipped) {
      actions.push("skip_step");
    }

    if (status === "Blocked" && !actions.includes("resolve_blocker")) {
      actions.push("resolve_blocker");
    }

    if (status !== "Published") {
      actions.push("edit_details");
    }

    if (status === "Not Started" && !stage.startedAt) {
      actions.push("delete");
    }
  }

  // A paused step (pause with lead approval) takes no work actions until it is resumed.
  if (stage.pauseState === "paused") {
    const blockedWhilePaused: WorkActionKey[] = ["start", "submit_for_approval", "mark_as_posted", "mark_blocked", "resolve_blocker", "request_help", "skip_step"] as WorkActionKey[];
    for (let i = actions.length - 1; i >= 0; i--) if (blockedWhilePaused.includes(actions[i])) actions.splice(i, 1);
    if (actions.length === 0) return { actions, isOwner, reason: "This step is paused. Resume it to continue." };
  }

  // 4. Compute reason if no actions available for viewer
  let reason: string | undefined;
  if (actions.length === 0) {
    reason = getActionDisabledReason(user, stage, piece);
  }

  return { actions, isOwner, reason };
}

/**
 * Returns a user-friendly one-line reason when the viewer has no active actions on a stage.
 */
export function getActionDisabledReason(
  user: { _id?: string; id?: string; userId?: string; role?: string; name?: string } | null | undefined,
  stage: WorkActionStageContext | null | undefined,
  piece?: WorkActionPieceContext | null | undefined
): string {
  if (!stage) return "No task found";

  const userId = (user?.userId || user?._id || user?.id)?.toString();
  const rawOwner = stage.ownerId;
  const stageOwnerId = (rawOwner?._id || rawOwner?.id || rawOwner)?.toString();
  const isOwner = Boolean(userId && stageOwnerId && userId === stageOwnerId);
  const ownerName = rawOwner?.name || "the owner";
  const status = stage.status || "Not Started";

  if (stage.isSkipped) {
    return "This step was skipped";
  }

  if (stage.isLocked) {
    const prevKey =
      stage.previousStage?.stageKey ||
      stage.pieceStages?.find(
        (s: any) => s.status !== 'Approved' && s.status !== 'Published' && s.stageKey !== stage.stageKey
      )?.stageKey;
    if (prevKey) {
      return `Locked until the ${prevKey} step is approved`;
    }
    return "Locked until the previous step is approved";
  }

  if (status === "Pending") {
    if (isOwner) {
      return "Waiting for the Creative Manager";
    }
    return "Waiting for the Creative Manager";
  }

  if (status === "Blocked") {
    if (stage.blockerReason) {
      return `Blocked: ${stage.blockerReason}`;
    }
    return "Blocked waiting on resolution";
  }

  if (status === "Not Started") {
    if (!isOwner) {
      return `Waiting for ${ownerName} to start`;
    }
    return "Not started";
  }

  if (status === "In Progress") {
    if (!isOwner) {
      return `Waiting for ${ownerName}`;
    }
    return "In progress";
  }

  if (status === "Feedback") {
    if (!isOwner) {
      return `Waiting for ${ownerName} to revise`;
    }
    return "Revision requested";
  }

  if (status === "Approved") {
    return "Approved";
  }

  if (status === "Published") {
    return "Published live";
  }

  return "";
}

// ==========================================
// 9. Workspaces Submissions, Comments & Ratings Schemas
// ==========================================

export const COMMENT_ANCHOR_TYPES = ["text", "time", "point"] as const;
export type CommentAnchorType = (typeof COMMENT_ANCHOR_TYPES)[number];

export const submissionCommentAnchorSchema = z.object({
  type: z.enum(COMMENT_ANCHOR_TYPES),
  range: z
    .object({
      from: z.number().optional(),
      to: z.number().optional(),
      text: z.string().optional(),
    })
    .optional(),
  seconds: z.number().min(0).optional(),
  x: z.number().min(0).max(100).optional(),
  y: z.number().min(0).max(100).optional(),
  page: z.number().int().min(1).optional(),
});
export type SubmissionCommentAnchor = z.infer<typeof submissionCommentAnchorSchema>;

export const submissionFileItemSchema = z.object({
  url: z.string().min(1, "File URL is required"),
  size: z.number().min(0).optional(),
  duration: z.number().min(0).optional(),
  width: z.number().min(0).optional(),
  height: z.number().min(0).optional(),
  mime: z.string().optional(),
  name: z.string().optional(),
});
export type SubmissionFileItem = z.infer<typeof submissionFileItemSchema>;

export const submissionDraftSaveSchema = z.object({
  kind: z.enum(STEP_OUTPUT_KINDS).optional(),
  document: z
    .object({
      json: z.any().optional(),
      htmlSnapshot: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    })
    .passthrough()
    .optional(),
  files: z.array(submissionFileItemSchema).optional(),
  linkUrl: z.string().url("Invalid link URL").or(z.literal("")).optional(),
  notes: z.string().max(5000).optional(),
  versionToken: z.string().optional(),
});
export type SubmissionDraftSaveInput = z.infer<typeof submissionDraftSaveSchema>;

export const submissionSubmitSchema = z.object({
  kind: z.enum(STEP_OUTPUT_KINDS).optional(),
  document: z
    .object({
      json: z.any().optional(),
      htmlSnapshot: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    })
    .passthrough()
    .optional(),
  files: z.array(submissionFileItemSchema).optional(),
  linkUrl: z.string().url("Invalid link URL").or(z.literal("")).optional(),
  notes: z.string().max(5000).optional(),
});
export type SubmissionSubmitInput = z.infer<typeof submissionSubmitSchema>;

export const submissionCommentCreateSchema = z.object({
  text: z.string().trim().min(1, "Comment text is required"),
  anchor: submissionCommentAnchorSchema.optional(),
  parentId: z.string().optional().nullable(),
});
export type SubmissionCommentCreateInput = z.infer<typeof submissionCommentCreateSchema>;

export const submissionReviewApproveSchema = z.object({
  score: z.number().int().min(1).max(5),
  feedback: z.string().max(2000).optional().default(""),
  tags: z.array(z.enum(RATING_TAGS)).optional().default([]),
  alsoShareToTeamChat: z.boolean().optional().default(false),
});
export type SubmissionReviewApproveInput = z.infer<typeof submissionReviewApproveSchema>;

export const submissionReviewRevisionSchema = z.object({
  comment: z.string().trim().min(1, "Revision comment or note is required"),
  // New revision requests: canonical values only.
  rootCause: z.enum(CANONICAL_REVISION_ROOT_CAUSES).optional(),
});
export type SubmissionReviewRevisionInput = z.infer<typeof submissionReviewRevisionSchema>;

export const ratingEditSchema = z.object({
  score: z.number().int().min(1).max(5).optional(),
  feedback: z.string().max(2000).optional(),
  tags: z.array(z.enum(RATING_TAGS)).optional(),
  reason: z.string().trim().min(1, "Reason for editing rating is required"),
});
export type RatingEditInput = z.infer<typeof ratingEditSchema>;

// ==========================================
// 10. Canonical Workspace Modes & Status Words
// ==========================================

export type WorkspaceMode = "edit" | "read" | "review" | "none";

export interface WorkspaceModeInfo {
  mode: WorkspaceMode;
  reason?: string;
  isOwner: boolean;
  canEdit: boolean;
}

export const STEP_STATUS_LABELS: Record<string, string> = {
  "not started": "Not started",
  "not_started": "Not started",
  "in progress": "In progress",
  "in_progress": "In progress",
  feedback: "Changes requested",
  "changes requested": "Changes requested",
  "changes_requested": "Changes requested",
  "revision requested": "Changes requested",
  pending: "Waiting for approval",
  "waiting for approval": "Waiting for approval",
  "waiting_for_approval": "Waiting for approval",
  blocked: "Blocked",
  approved: "Approved",
  published: "Published",
  posted: "Published",
};

export function getStepStatusLabel(
  status: WorkItemStatus | string | null | undefined,
): string {
  if (!status) return "";
  const key = status.toLowerCase().replace(/_/g, " ").trim();
  return STEP_STATUS_LABELS[key] || status;
}

export function normalizeStatusKey(
  status: string | null | undefined,
): string {
  if (!status) return "not started";
  const s = status.toLowerCase().replace(/_/g, " ").trim();
  if (s === "feedback" || s === "changes requested" || s === "revision requested") {
    return "changes requested";
  }
  if (s === "pending" || s === "waiting for approval") {
    return "waiting for approval";
  }
  if (s === "in progress") return "in progress";
  if (s === "not started") return "not started";
  if (s === "blocked") return "blocked";
  if (s === "approved") return "approved";
  if (s === "published" || s === "posted") return "posted";
  return s;
}

/**
 * Canonical workspace access decision engine.
 * Rules:
 * - the owner of an unlocked step gets edit in the states not started, in progress, changes requested and blocked
 *   (blocked keeps edit but shows the blocker banner);
 * - waiting for approval gives the owner read;
 * - approved and posted give read;
 * - locked gives none for the owner with the message 'Locked until <previous step> is approved'.
 * - creative_lead, growth_lead and admin get read on every step and review on a step waiting for approval.
 * - sm_manager, creative_head and production_head get read.
 * - Other owners in the same piece get read of earlier steps only.
 * - Ownership is compared as strings of the id on the stage item, never through the piece.
 */
export function getWorkspaceModeInfo(
  user:
    | { _id?: string; id?: string; userId?: string; role?: string; name?: string }
    | null
    | undefined,
  stage: any,
  piece?: any,
): WorkspaceModeInfo {
  if (!user || !stage) {
    return {
      mode: "none",
      isOwner: false,
      canEdit: false,
      reason: "No user or stage specified",
    };
  }

  const userId = (user.userId || user._id || user.id)?.toString();
  const rawOwner = stage.ownerId;
  const stageOwnerId = (rawOwner?._id || rawOwner?.id || rawOwner)?.toString();
  const isOwner = Boolean(userId && stageOwnerId && userId === stageOwnerId);
  const role = normalizeRole(user.role);

  const statusKey = normalizeStatusKey(stage.status);
  const isLocked = Boolean(stage.isLocked);
  const isSkipped = Boolean(stage.isSkipped);

  // 1. Locked check for the owner
  if (isOwner && isLocked) {
    let prevName = stage.previousStage?.stageKey;
    if (!prevName && Array.isArray(stage.pieceStages)) {
      const curOrder = stage.stageOrder || 0;
      const prev = stage.pieceStages.find(
        (s: any) => s.stageOrder === curOrder - 1,
      );
      if (prev?.stageKey) prevName = prev.stageKey;
    }
    if (!prevName && piece && Array.isArray(piece.stagePlan)) {
      const curOrder = stage.stageOrder || 0;
      const prev = piece.stagePlan[curOrder - 2];
      if (prev?.stageKey) prevName = prev.stageKey;
    }
    const reason = prevName
      ? `Locked until ${prevName} is approved`
      : "Locked until previous step is approved";
    return { mode: "none", isOwner: true, canEdit: false, reason };
  }

  // 2. Step Owner (unlocked)
  if (isOwner) {
    if (isSkipped) {
      return {
        mode: "read",
        isOwner: true,
        canEdit: false,
        reason: "This step was skipped",
      };
    }
    if (
      statusKey === "not started" ||
      statusKey === "in progress" ||
      statusKey === "changes requested" ||
      statusKey === "blocked"
    ) {
      const reason =
        statusKey === "blocked"
          ? stage.blockerReason
            ? `Blocked: ${stage.blockerReason}`
            : "Blocked"
          : undefined;
      return { mode: "edit", isOwner: true, canEdit: true, reason };
    }
    if (statusKey === "waiting for approval") {
      return {
        mode: "read",
        isOwner: true,
        canEdit: false,
        reason: "Waiting for approval",
      };
    }
    if (statusKey === "approved") {
      return {
        mode: "read",
        isOwner: true,
        canEdit: false,
        reason: "Approved",
      };
    }
    if (statusKey === "posted") {
      return {
        mode: "read",
        isOwner: true,
        canEdit: false,
        reason: "Published",
      };
    }
    return {
      mode: "read",
      isOwner: true,
      canEdit: false,
      reason: stage.status || "Read only",
    };
  }

  // 3. Reviewers: both leads and admin
  if (canReview(role)) {
    if (statusKey === "waiting for approval") {
      return {
        mode: "review",
        isOwner: false,
        canEdit: false,
        reason: "Ready for review",
      };
    }
    return {
      mode: "read",
      isOwner: false,
      canEdit: false,
      reason: "Read only",
    };
  }

  // 4. sm_manager and the read-only heads
  if (role === "sm_manager" || isReadOnlyViewer(role)) {
    return {
      mode: "read",
      isOwner: false,
      canEdit: false,
      reason: "Read only",
    };
  }

  // 5. Other owners in the same piece get read of earlier steps only.
  const pieceStagesList: any[] =
    stage.pieceStages ||
    piece?.workItems ||
    piece?.stages ||
    piece?.stagePlan ||
    [];
  let userStagesInPiece: any[] = [];
  if (userId) {
    userStagesInPiece = pieceStagesList.filter((s: any) => {
      const sOwner = (s.ownerId?._id || s.ownerId?.id || s.ownerId)?.toString();
      return sOwner === userId;
    });
  }

  if (userStagesInPiece.length > 0) {
    const curStageOrder = stage.stageOrder || 1;
    const userMinOrder = Math.min(
      ...userStagesInPiece.map(
        (s: any) =>
          s.stageOrder || pieceStagesList.indexOf(s) + 1,
      ),
    );
    if (curStageOrder < userMinOrder) {
      return {
        mode: "read",
        isOwner: false,
        canEdit: false,
        reason: "Earlier step deliverable",
      };
    }
    return {
      mode: "none",
      isOwner: false,
      canEdit: false,
      reason: "Only earlier steps in this piece can be viewed",
    };
  }

  // Non-owner with no assignment in piece
  return {
    mode: "none",
    isOwner: false,
    canEdit: false,
    reason: "No access to this stage",
  };
}

export function getWorkspaceMode(
  user:
    | { _id?: string; id?: string; userId?: string; role?: string; name?: string }
    | null
    | undefined,
  stage: any,
  piece?: any,
): WorkspaceMode {
  return getWorkspaceModeInfo(user, stage, piece).mode;
}

// ==========================================
// 11. Shoot Workspace Media Items & Messages
// ==========================================

export const MEDIA_ITEM_STATUSES = [
  "uploading",
  "uploaded",
  "waiting_review",
  "approved",
  "reshoot_needed",
] as const;
export type MediaItemStatus = (typeof MEDIA_ITEM_STATUSES)[number];

export const MEDIA_ITEM_STATUS_LABELS: Record<MediaItemStatus, string> = {
  uploading: "Uploading",
  uploaded: "Uploaded",
  waiting_review: "Waiting for review",
  approved: "Approved",
  reshoot_needed: "Reshoot needed",
};

export function getMediaItemStatusLabel(
  status: MediaItemStatus | string | null | undefined,
): string {
  if (!status) return "";
  return (MEDIA_ITEM_STATUS_LABELS as any)[status] || status;
}

export const mediaItemCreateSchema = z.object({
  url: z
    .string()
    .trim()
    .min(1, "Valid media URL required")
    .refine((val) => isAllowedOutputUrl(val), { message: OUTPUT_URL_ERROR }),
  storageId: z.string().optional().default(""),
  thumbnailUrl: z.string().optional().default(""),
  kind: z.enum(["video", "image"]).default("video"),
  title: z.string().trim().min(1, "Title is required"),
  shotRef: z.string().optional().default(""),
  take: z.number().int().min(1).default(1),
  tags: z.array(z.string()).default([]),
  notes: z.string().max(2000).optional().default(""),
  favourite: z.boolean().default(false),
  order: z.number().int().default(0),
  durationSeconds: z.number().min(0).default(0),
  width: z.number().int().min(0).default(0),
  height: z.number().int().min(0).default(0),
  orientationOk: z.boolean().default(true),
  sizeBytes: z.number().int().min(0).default(0),
  status: z.enum(MEDIA_ITEM_STATUSES).default("uploaded"),
  replacesId: z.string().optional().nullable(),
});
export type MediaItemCreateInput = z.infer<typeof mediaItemCreateSchema>;

export const mediaItemUpdateSchema = z.object({
  title: z.string().trim().min(1).optional(),
  shotRef: z.string().optional(),
  take: z.number().int().min(1).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(2000).optional(),
  favourite: z.boolean().optional(),
  order: z.number().int().optional(),
});
export type MediaItemUpdateInput = z.infer<typeof mediaItemUpdateSchema>;

export const mediaMessageCreateSchema = z.object({
  text: z.string().trim().min(1, "Message text is required"),
  timeSeconds: z.number().min(0).optional().nullable(),
  replyToId: z.string().optional().nullable(),
});
export type MediaMessageCreateInput = z.infer<typeof mediaMessageCreateSchema>;

export const mediaItemReviewSchema = z.object({
  action: z.enum(["approve", "reshoot_needed"]),
  message: z.string().trim().optional(),
});
export type MediaItemReviewInput = z.infer<typeof mediaItemReviewSchema>;

export const shootStepFinishReviewSchema = z.object({
  score: z.number().int().min(1).max(5).optional(),
  feedback: z.string().max(2000).optional(),
  tags: z.array(z.enum(RATING_TAGS)).optional(),
  note: z.string().max(2000).optional(),
});
export type ShootStepFinishReviewInput = z.infer<typeof shootStepFinishReviewSchema>;

export const reorderClipsSchema = z.object({
  clipIds: z.array(z.string().min(1)),
});
export type ReorderClipsInput = z.infer<typeof reorderClipsSchema>;

export interface MediaItemType {
  _id: string;
  id?: string;
  stageItemId: string;
  contentPieceId?: string | null;
  submissionId?: string | null;
  kind: 'video' | 'image';
  url: string;
  storageId?: string;
  thumbnailUrl?: string;
  title: string;
  shotRef?: string;
  take: number;
  tags: string[];
  notes?: string;
  favourite: boolean;
  order: number;
  version: number;
  replacesId?: string | null;
  durationSeconds: number;
  width: number;
  height: number;
  orientationOk: boolean;
  sizeBytes: number;
  status: MediaItemStatus;
  decidedById?: { _id: string; name: string } | string | null;
  decidedAt?: string | null;
  unreadCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaMessageType {
  _id: string;
  id?: string;
  mediaItemId: string;
  authorId: { _id: string; name: string; role: string; jobRole?: string };
  text: string;
  timeSeconds?: number | null;
  replyToId?: { _id: string; text: string; authorId: { _id: string; name: string } } | string | null;
  replyToPreview?: { authorName: string; text: string } | null;
  seenBy: Array<{ userId: string; seenAt: string }>;
  doneAt?: string | null;
  doneById?: { _id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

// ==========================================
// 17. Team Chat & Communications System (docs/CHAT.md)
// ==========================================

export const CHAT_CHANNEL_TYPES = ['team', 'group', 'dm'] as const;
export type ChatChannelType = (typeof CHAT_CHANNEL_TYPES)[number];

export const CHAT_REACTION_EMOJIS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;
export type ChatReactionEmoji = (typeof CHAT_REACTION_EMOJIS)[number];

export const CHAT_ATTACHMENT_CONFIG = {
  maxCount: 5,
  images: {
    maxBytes: 20 * 1024 * 1024, // 20 MB
    mimes: ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'],
    extensions: ['.png', '.jpg', '.jpeg', '.webp'],
  },
  documents: {
    maxBytes: 25 * 1024 * 1024, // 25 MB
    mimes: [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'text/plain',
    ],
    extensions: ['.pdf', '.docx', '.xlsx', '.csv', '.txt'],
  },
  videos: {
    maxBytes: 100 * 1024 * 1024, // 100 MB
    mimes: ['video/mp4', 'video/quicktime', 'video/webm'],
    extensions: ['.mp4', '.mov', '.webm'],
  },
} as const;

export const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(40, 'Group name must not exceed 40 characters'),
  description: z.string().trim().max(200, 'Description must not exceed 200 characters').optional().default(''),
  memberIds: z.array(z.string()).min(1, 'At least one member is required'),
}).strict();
export type CreateGroupInput = z.infer<typeof createGroupSchema>;

export const updateGroupSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(40, 'Group name must not exceed 40 characters').optional(),
  description: z.string().trim().max(200, 'Description must not exceed 200 characters').optional(),
}).strict();
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const addGroupMembersSchema = z.object({
  memberIds: z.array(z.string()).min(1, 'At least one member ID is required'),
}).strict();
export type AddGroupMembersInput = z.infer<typeof addGroupMembersSchema>;

export const chatAttachmentInputSchema = z.object({
  _id: z.string().optional(),
  id: z.string().optional(),
  fileName: z.string().optional(),
  fileSize: z.number().optional(),
  mimeType: z.string().optional(),
  storageUrl: z.string().optional(),
  thumbnailUrl: z.string().optional().nullable(),
  width: z.number().optional().nullable(),
  height: z.number().optional().nullable(),
  duration: z.number().optional().nullable(),
}).passthrough();

export const sendMessageSchema = z.object({
  content: z.string().max(4000, 'Message must not exceed 4,000 characters').optional().default(''),
  replyToId: z.string().optional().nullable(),
  attachmentIds: z.array(z.string()).max(5, 'Maximum 5 attachments per message').optional().default([]),
  attachments: z.array(chatAttachmentInputSchema).max(5, 'Maximum 5 attachments per message').optional().default([]),
  sharedMedia: z.any().optional().nullable(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({
  content: z.string().trim().min(1, 'Message content cannot be empty').max(4000, 'Message must not exceed 4,000 characters'),
}).strict();
export type EditMessageInput = z.infer<typeof editMessageSchema>;

export const toggleReactionSchema = z.object({
  emoji: z.enum(CHAT_REACTION_EMOJIS),
}).strict();
export type ToggleReactionInput = z.infer<typeof toggleReactionSchema>;

export const shareToChatSchema = z.object({
  channelId: z.string().min(1, 'Target channel is required'),
  assetId: z.string().min(1).optional(),
  mediaItemId: z.string().min(1).optional(),
  assetType: z.enum(['clip', 'finalCut', 'designImages', 'designPdf', 'document', 'submission']).optional().default('clip'),
  contentPieceId: z.string().optional(),
  stageKey: z.string().optional(),
  note: z.string().trim().max(1000).optional().default(''),
});
export type ShareToChatInput = z.infer<typeof shareToChatSchema>;

export interface ChatAttachment {
  _id?: string;
  id?: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface ChatReactionRecord {
  emoji: ChatReactionEmoji;
  userIds: string[];
}

export interface ChatMessageAuthor {
  _id: string;
  id?: string;
  name: string;
  role: string;
  preferredName?: string;
  avatarUrl?: string;
}

export interface ChatMessageReplyPreview {
  _id: string;
  authorName: string;
  content: string;
}

export interface ChatSharedMediaCard {
  grantId: string;
  assetId: string;
  assetType: 'clip' | 'finalCut' | 'designImages' | 'designPdf' | 'document';
  contentPieceId: string;
  contentPieceTitle: string;
  stageKey: string;
  title: string;
  thumbnailUrl?: string;
  previewUrl?: string;
  downloadUrl?: string;
  owner: {
    _id: string;
    name: string;
    preferredName?: string;
    avatarUrl?: string;
  };
  note?: string;
  isRevoked: boolean;
}

export interface ChatMessageType {
  _id: string;
  id?: string;
  channelId: string;
  authorId: ChatMessageAuthor;
  content: string;
  replyToId?: string | null;
  replyPreview?: ChatMessageReplyPreview | null;
  attachments: ChatAttachment[];
  reactions: ChatReactionRecord[];
  isPinned: boolean;
  pinnedAt?: string | null;
  pinnedById?: string | null;
  isEdited: boolean;
  editedAt?: string | null;
  isDeleted: boolean;
  deletedAt?: string | null;
  deletedById?: string | null;
  sharedMedia?: ChatSharedMediaCard | null;
  seenBy: Array<{ userId: string; seenAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelMemberType {
  _id: string;
  channelId: string;
  userId: string;
  role: 'owner' | 'member';
  joinedAt: string;
  lastReadMessageId?: string | null;
  lastReadAt?: string | null;
  isMuted: boolean;
  user?: {
    _id: string;
    name: string;
    preferredName?: string;
    role: string;
    jobRole?: string;
    avatarUrl?: string;
    status: string;
  };
}

export interface ChatChannelTypeDetail {
  _id: string;
  id?: string;
  type: ChatChannelType;
  name: string;
  description?: string;
  systemSlug?: string | null;
  createdById?: string | null;
  isArchived: boolean;
  archivedAt?: string | null;
  archivedById?: string | null;
  lastMessageAt?: string | null;
  lastMessageSnippet?: string | null;
  unreadCount?: number;
  membersCount?: number;
  isMuted?: boolean;
  otherUser?: {
    _id: string;
    name: string;
    preferredName?: string;
    role: string;
    jobRole?: string;
    avatarUrl?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

// ==========================================
// 15. Individual Tracking & Worker Timing Engine
// ==========================================

/**
 * Non-working time on a step. "paused" is the reopen pause (Phase 6); "manual_pause" is a
 * pause the step's lead approved (pause requests). Each is opened and closed only by its own
 * logic; the work-time calculator subtracts them all, merged, so overlaps count once.
 */
export type IntervalKind = "blocked" | "pending" | "paused" | "manual_pause";
export const INTERVAL_KIND_LABELS: Record<IntervalKind, string> = {
  blocked: "Blocked",
  pending: "Waiting",
  paused: "Paused (earlier step redone)",
  manual_pause: "Paused (approved)",
};

export interface WorkInterval {
  kind: IntervalKind;
  startedAt: string | Date;
  endedAt?: string | Date | null;
  reason?: string;
  note?: string;
}

export interface WorkRound {
  roundNumber: number;
  startedAt: string | Date;
  submittedAt?: string | Date | null;
  decisionAt?: string | Date | null;
  decision?: "approved" | "changes_requested" | null;
  intervals?: WorkInterval[];
}

export interface WorkItemTimestamps {
  unlockedAt?: string | Date | null;
  assignedAt?: string | Date | null;
  startedAt?: string | Date | null;
  submittedAt?: string | Date | null;
  decisionAt?: string | Date | null;
  changesRequestedAt?: string | Date | null;
  resubmittedAt?: string | Date | null;
  approvedAt?: string | Date | null;
  postedAt?: string | Date | null;
  intervals?: WorkInterval[];
  rounds?: WorkRound[];
  dueDate?: string | Date | null;
  deadline?: string | Date | null;
  status?: string;
}

export interface WorkItemIndividualMeasures {
  waitingToStartMs: number | null;
  waitingToStartText: string;
  waitingToStartFormatted: string;
  totalWorkTimeMs: number | null;
  workTimeMs: number | null;
  totalWorkTimeText: string;
  workTimeFormatted: string;
  currentRoundWorkTimeMs: number | null;
  currentRoundWorkTimeText: string;
  approvalWaitMs: number | null;
  approvalWaitText: string;
  approvalWaitFormatted: string;
  lateByDays: number | null;
  lateByText: string;
  lateByFormatted: string;
  isLate: boolean;
}

/**
 * Format milliseconds into standard compact duration strings ('1d 4h', '3h 20m', '45m').
 * Returns '—' for null, undefined, negative, or invalid values.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || isNaN(ms) || ms < 0) {
    return "—";
  }
  const totalMinutes = Math.floor(ms / (1000 * 60));
  if (totalMinutes === 0) {
    return "0m";
  }

  const days = Math.floor(totalMinutes / (24 * 60));
  const remainingHours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const remainingMinutes = totalMinutes % 60;

  if (days > 0) {
    if (remainingHours > 0) {
      return `${days}d ${remainingHours}h`;
    }
    return `${days}d`;
  }

  if (remainingHours > 0) {
    if (remainingMinutes > 0) {
      return `${remainingHours}h ${remainingMinutes}m`;
    }
    return `${remainingHours}h`;
  }

  return `${remainingMinutes}m`;
}

/**
 * Normalizes any Date or ISO string to the start of local day (midnight).
 */
export function toMidnightDate(d: string | Date): Date {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Whole calendar days past a deadline (0 if it falls today or later), comparing dates in
 * Asia/Kolkata (Phase 7), so the result does not depend on the server or browser timezone.
 */
export function overdueDays(deadline: string | Date, now: string | Date = new Date()): number {
  return Math.max(0, istDayDiff(now, deadline) ?? 0);
}

export function formatOverdue(days: number): string {
  if (days <= 0) return "Overdue today";
  return `Overdue by ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Non-working time inside a window: every interval (blocked, waiting, reopen pause, approved
 * pause) clipped to the window and merged first, so time that was paused for two reasons at
 * once is subtracted once. An open interval runs to the end of the window.
 */
export function calculateIntervalDurationInWindow(
  intervals: WorkInterval[] = [],
  windowStart: Date,
  windowEnd: Date
): number {
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();
  const spans: Array<[number, number]> = [];
  for (const interval of intervals || []) {
    if (!interval || !interval.startedAt) continue;
    const intStart = new Date(interval.startedAt).getTime();
    const intEnd = interval.endedAt ? new Date(interval.endedAt).getTime() : winEnd;
    const start = Math.max(winStart, intStart);
    const end = Math.min(winEnd, intEnd);
    if (end > start) spans.push([start, end]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let pausedMs = 0;
  let curStart = -Infinity;
  let curEnd = -Infinity;
  for (const [start, end] of spans) {
    if (start > curEnd) {
      if (curEnd > curStart) pausedMs += curEnd - curStart;
      curStart = start;
      curEnd = end;
    } else if (end > curEnd) {
      curEnd = end;
    }
  }
  if (curEnd > curStart) pausedMs += curEnd - curStart;
  return pausedMs;
}

/** The same sum without merging (each interval counted in full): the rule before merging, for comparisons. */
export function calculateIntervalDurationInWindowUnmerged(
  intervals: WorkInterval[] = [],
  windowStart: Date,
  windowEnd: Date
): number {
  let pausedMs = 0;
  const winStart = windowStart.getTime();
  const winEnd = windowEnd.getTime();
  for (const interval of intervals || []) {
    if (!interval || !interval.startedAt) continue;
    const intStart = new Date(interval.startedAt).getTime();
    const intEnd = interval.endedAt ? new Date(interval.endedAt).getTime() : winEnd;
    const overlapStart = Math.max(winStart, intStart);
    const overlapEnd = Math.min(winEnd, intEnd);
    if (overlapEnd > overlapStart) pausedMs += overlapEnd - overlapStart;
  }
  return pausedMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// Working days and pause requests
// ─────────────────────────────────────────────────────────────────────────────

/** Working days in IST: Monday to Saturday (0 = Sunday). No holiday list for now. */
export const WORKING_DAYS_IST: readonly number[] = [1, 2, 3, 4, 5, 6];
/** Reminders go out from this hour (IST) on the day they are due. */
export const REMINDER_HOUR_IST = 9;

/** Weekday (0 = Sunday) of an IST date key YYYY-MM-DD. */
function weekdayOfKey(key: string): number {
  return new Date(`${key}T00:00:00Z`).getUTCDay();
}
function addDaysToKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function isWorkingDayIST(value: DateLike): boolean {
  const key = istDateKey(value);
  return Boolean(key) && WORKING_DAYS_IST.includes(weekdayOfKey(key as string));
}
/** The first working day (IST) after the IST day of `value`, as YYYY-MM-DD. */
export function nextWorkingDayKeyIST(value: DateLike): string | null {
  const key = istDateKey(value);
  if (!key) return null;
  let next = addDaysToKey(key, 1);
  for (let i = 0; i < 7 && !WORKING_DAYS_IST.includes(weekdayOfKey(next)); i++) next = addDaysToKey(next, 1);
  return next;
}
/** The hour (0-23) of `value` in IST. */
export function istHour(value: DateLike): number {
  const d = new Date(value as string | Date | number);
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: APP_TIME_ZONE, hour: "2-digit", hourCycle: "h23" }).format(d));
}

export const PAUSE_REASONS = ["urgent_task", "other"] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];
export const PAUSE_REASON_LABELS: Record<PauseReason, string> = { urgent_task: "Urgent task", other: "Other" };
/** A step's pause state (status stays In Progress; "Paused" is shown from this). */
export type PauseState = "requested" | "paused" | null;
export const PAUSE_NOTE_MAX = 300;

// ==========================================
// Help requests on a step (ask a lead, the SM Manager or another step's owner)
// ==========================================
export const HELP_TOPICS = ["brief_unclear", "need_files", "technical_issue", "other"] as const;
export type HelpTopic = (typeof HELP_TOPICS)[number];
export const HELP_TOPIC_LABELS: Record<HelpTopic, string> = {
  brief_unclear: "Brief unclear",
  need_files: "Need files or assets",
  technical_issue: "Technical issue",
  other: "Other",
};
/** Who the help request goes to: the step's deciding lead, an SM Manager, or the owner of another step on the piece. */
export const HELP_TARGET_KINDS = ["lead", "sm_manager", "step_owner"] as const;
export type HelpTargetKind = (typeof HELP_TARGET_KINDS)[number];
export const HELP_MESSAGE_MAX = 1000;
export const HELP_REPLY_MAX = 1000;
/** An optional help link: https only. */
export const isHttpsUrl = (value: unknown): boolean => {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === "https:" && Boolean(u.hostname);
  } catch {
    return false;
  }
};

/**
 * Comprehensive Individual Timing & Measures Calculator
 * Implements Section 2 of Individual Tracking & Timing spec:
 * - Waiting to start = startedAt - unlockedAt
 * - Work time = for each round, (submission - roundStart) - (blocked & pending time inside it); total is sum of rounds.
 * - Approval wait = decision time - submission time
 * - Late by = calendar days between submission date and step due date (date only). If unsubmitted: days between today and due date.
 */
export function calculateIndividualWorkMeasures(
  item: WorkItemTimestamps,
  nowDate: Date = new Date()
): WorkItemIndividualMeasures {
  const now = nowDate.getTime();

  // 1. Waiting to start
  let waitingToStartMs: number | null = null;
  if (item.startedAt && item.unlockedAt) {
    const startMs = new Date(item.startedAt).getTime();
    const unlockMs = new Date(item.unlockedAt).getTime();
    if (startMs >= unlockMs) {
      waitingToStartMs = startMs - unlockMs;
    }
  }

  // 2. Work time per round & total work time
  let totalWorkTimeMs: number | null = null;
  let currentRoundWorkTimeMs: number | null = null;

  const allIntervals = item.intervals || [];

  if (Array.isArray(item.rounds) && item.rounds.length > 0) {
    let accumulatedMs = 0;
    let hasAnyValidRound = false;

    for (let i = 0; i < item.rounds.length; i++) {
      const round = item.rounds[i];
      if (!round.startedAt) continue;
      hasAnyValidRound = true;

      const rStart = new Date(round.startedAt);
      const rEnd = round.submittedAt
        ? new Date(round.submittedAt)
        : (item.status === 'Approved' || item.status === 'Published') && item.approvedAt
        ? new Date(item.approvedAt)
        : new Date(now);

      const grossMs = Math.max(0, rEnd.getTime() - rStart.getTime());
      const roundIntervals = round.intervals && round.intervals.length > 0
        ? round.intervals
        : allIntervals;
      const pausedMs = calculateIntervalDurationInWindow(roundIntervals, rStart, rEnd);
      const netMs = Math.max(0, grossMs - pausedMs);

      accumulatedMs += netMs;
      if (i === item.rounds.length - 1) {
        currentRoundWorkTimeMs = netMs;
      }
    }

    if (hasAnyValidRound) {
      totalWorkTimeMs = accumulatedMs;
    }
  } else if (item.startedAt) {
    // Single round / legacy fallback
    const rStart = new Date(item.startedAt);
    const rEnd = item.submittedAt
      ? new Date(item.submittedAt)
      : (item.status === 'Approved' || item.status === 'Published') && item.approvedAt
      ? new Date(item.approvedAt)
      : new Date(now);

    const grossMs = Math.max(0, rEnd.getTime() - rStart.getTime());
    const pausedMs = calculateIntervalDurationInWindow(allIntervals, rStart, rEnd);
    totalWorkTimeMs = Math.max(0, grossMs - pausedMs);
    currentRoundWorkTimeMs = totalWorkTimeMs;
  }

  // 3. Approval wait
  let approvalWaitMs: number | null = null;
  if (item.submittedAt) {
    const subMs = new Date(item.submittedAt).getTime();
    const decDate = item.decisionAt || item.approvedAt || item.changesRequestedAt;
    if (decDate) {
      const decMs = new Date(decDate).getTime();
      if (decMs >= subMs) {
        approvalWaitMs = decMs - subMs;
      }
    } else if (item.status === 'Feedback') {
      // Currently waiting for approval
      approvalWaitMs = Math.max(0, now - subMs);
    }
  }

  // 4. Late by (Calendar Days, date-only)
  let lateByDays: number | null = null;
  const rawDue = item.dueDate || item.deadline;
  if (rawDue) {
    const dueMidnight = toMidnightDate(rawDue).getTime();
    const evalMidnight = item.submittedAt
      ? toMidnightDate(item.submittedAt).getTime()
      : (item.status === 'Approved' || item.status === 'Published') && item.approvedAt
      ? toMidnightDate(item.approvedAt).getTime()
      : toMidnightDate(nowDate).getTime();

    const diffDays = Math.floor((evalMidnight - dueMidnight) / (24 * 60 * 60 * 1000));
    const isTerminal = item.status === 'Approved' || item.status === 'Published';

    if (diffDays > 0) {
      lateByDays = diffDays;
    } else if (isTerminal) {
      lateByDays = 0; // Completed on time
    } else {
      lateByDays = 0; // On track
    }
  }

  const isLate = lateByDays !== null && lateByDays > 0;

  const waitingToStartText = formatDuration(waitingToStartMs);
  const totalWorkTimeText = formatDuration(totalWorkTimeMs);
  const currentRoundWorkTimeText = formatDuration(currentRoundWorkTimeMs);
  const approvalWaitText = formatDuration(approvalWaitMs);
  const lateByText =
    lateByDays === null
      ? "—"
      : lateByDays > 0
      ? `${lateByDays}d`
      : "On time";

  return {
    waitingToStartMs,
    waitingToStartText,
    waitingToStartFormatted: waitingToStartText,
    totalWorkTimeMs,
    workTimeMs: totalWorkTimeMs,
    totalWorkTimeText,
    workTimeFormatted: totalWorkTimeText,
    currentRoundWorkTimeMs,
    currentRoundWorkTimeText,
    approvalWaitMs,
    approvalWaitText,
    approvalWaitFormatted: approvalWaitText,
    lateByDays,
    lateByText,
    lateByFormatted: lateByText,
    isLate,
  };
}

/**
 * Work time over submitted rounds only (Phase 6): the same figure the team digest and the
 * Performance tab use, so a round still being worked on never counts. A step without rounds
 * counts once it has both a start and a submit time. Null when nothing has been submitted.
 */
export function submittedWorkTimeMs(item: WorkItemTimestamps): number | null {
  const rounds = Array.isArray(item.rounds) ? item.rounds : [];
  if (rounds.length) {
    const submitted = rounds.filter((r) => r && r.startedAt && r.submittedAt);
    if (!submitted.length) return null;
    return calculateIndividualWorkMeasures({ ...item, rounds: submitted }).workTimeMs;
  }
  if (item.startedAt && item.submittedAt) return calculateIndividualWorkMeasures(item).workTimeMs;
  return null;
}

/**
 * Rework time: the work time of every round that follows a "changes requested" decision,
 * by the same round rule as work time (blocked and paused time taken out). A rework round
 * starts when the owner clicks Start rework. Null when the step was never reworked.
 */
export function reworkTimeMs(item: WorkItemTimestamps, nowDate: Date = new Date()): number | null {
  const rounds = Array.isArray(item.rounds) ? item.rounds : [];
  let total: number | null = null;
  for (let i = 1; i < rounds.length; i++) {
    const round = rounds[i];
    if (!round || !round.startedAt || (rounds[i - 1] as any)?.decision !== "changes_requested") continue;
    // An unsubmitted round that is not the latest is not being worked on any more.
    if (!round.submittedAt && i !== rounds.length - 1) continue;
    const ms = calculateIndividualWorkMeasures({ ...item, rounds: [round] }, nowDate).workTimeMs;
    total = (total || 0) + (ms || 0);
  }
  return total;
}


// ─────────────────────────────────────────────────────────────────────────────
// Excel-style plan grid: month periods, column map and paste parsing.
// Pure helpers shared by the API (validation) and the web grid (paste preview).
// ─────────────────────────────────────────────────────────────────────────────

/** Business timezone for plan months (approved: Asia/Kolkata). */
export const APP_TIME_ZONE = "Asia/Kolkata";

const MONTH_KEY_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: unknown): value is string {
  return typeof value === "string" && MONTH_KEY_RE.test(value);
}

/** 'YYYY-MM' for a moment, read in the business timezone. */
export function monthKeyInAppTz(date: Date | string | number = new Date()): string {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const y = parts.find((p) => p.type === "year")?.value;
  const m = parts.find((p) => p.type === "month")?.value;
  return `${y}-${m}`;
}

/**
 * Month a stored plan belongs to. Plan dates are stored date-only (UTC midnight),
 * but some older rows were saved at local midnight (previous day 18:30Z); reading
 * the date in the business timezone gives the intended calendar day for both.
 */
export function planMonthKey(periodStart: Date | string): string {
  return monthKeyInAppTz(periodStart);
}

/** Full calendar month as stored date-only bounds: first day 00:00Z to last day 23:59:59.999Z. */
export function monthPeriod(monthKey: string): { periodStart: Date; periodEnd: Date } {
  const m = MONTH_KEY_RE.exec(monthKey);
  if (!m) throw new Error(`Invalid month "${monthKey}". Use YYYY-MM.`);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  return {
    periodStart: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    periodEnd: new Date(Date.UTC(year, month + 1, 0, 23, 59, 59, 999)),
  };
}

export function nextMonthKey(monthKey: string): string {
  const { periodStart } = monthPeriod(monthKey);
  return new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 7);
}

export const PLAN_GRID_GROUPS = [
  "Plan",
  "Script",
  "Shoot",
  "Edit",
  "Approval",
  "Publishing",
  "Tracking",
] as const;
export type PlanGridGroup = (typeof PLAN_GRID_GROUPS)[number];

export type PlanGridExcelColumnKey =
  | "postingDate"
  | "topic"
  | "type"
  | "scriptStatus"
  | "scriptDoneDate"
  | "scriptOwner"
  | "shootStatus"
  | "shootDoneDate"
  | "shootOwner"
  | "editStatus"
  | "editDoneDate"
  | "editOwner"
  | "approvalStatus"
  | "approvalDate"
  | "publishedDate"
  | "postingOwner"
  | "turnaroundDays"
  | "remarks";

/** App-only optional columns (Static/Carousel and other design rows have Content and Design steps). */
export type PlanGridExtraColumnKey = "contentOwner" | "designOwner" | "workflow" | "sourceVideoLink";
export type PlanGridColumnKey = PlanGridExcelColumnKey | PlanGridExtraColumnKey;

export interface PlanGridColumn {
  key: PlanGridColumnKey;
  header: string;
  group: PlanGridGroup;
  /** SM can type/paste into it. Workflow columns are filled by the system. */
  editable: boolean;
  frozen?: boolean;
  /** Stage whose owner this column sets, if any. */
  ownerStage?: StageKey;
  /** Optional app column, not one of the 18 Excel columns. */
  optional?: boolean;
  /** Short help shown as a tooltip on the header. */
  help?: string;
}

export const TURNAROUND_HELP =
  "Days from row approval to publishing. Counted once, when the post is published: from the time the Creative Manager approved the row (its first step was created) to the publish time.";

/** The 18 Excel columns, in Excel order. */
export const PLAN_GRID_COLUMNS: PlanGridColumn[] = [
  { key: "postingDate", header: "Posting Date", group: "Plan", editable: true, frozen: true },
  { key: "topic", header: "Topic", group: "Plan", editable: true, frozen: true },
  { key: "type", header: "Type", group: "Plan", editable: true, frozen: true },
  { key: "scriptStatus", header: "Script Status", group: "Script", editable: false },
  { key: "scriptDoneDate", header: "Script Done Date", group: "Script", editable: false },
  { key: "scriptOwner", header: "Script Owner", group: "Script", editable: true, ownerStage: "Script" },
  { key: "shootStatus", header: "Shoot Status", group: "Shoot", editable: false },
  { key: "shootDoneDate", header: "Shoot Done Date", group: "Shoot", editable: false },
  { key: "shootOwner", header: "Shoot Owner", group: "Shoot", editable: true, ownerStage: "Shoot" },
  { key: "editStatus", header: "Edit Status", group: "Edit", editable: false },
  { key: "editDoneDate", header: "Edit Done Date", group: "Edit", editable: false },
  { key: "editOwner", header: "Edit Owner", group: "Edit", editable: true, ownerStage: "Edit" },
  { key: "approvalStatus", header: "Approval Status", group: "Approval", editable: false },
  { key: "approvalDate", header: "Approval Date", group: "Approval", editable: false },
  { key: "publishedDate", header: "Published Date", group: "Publishing", editable: false },
  { key: "postingOwner", header: "Posting Owner", group: "Publishing", editable: true, ownerStage: "Post" },
  { key: "turnaroundDays", header: "Turnaround (Days)", group: "Tracking", editable: false, help: TURNAROUND_HELP },
  { key: "remarks", header: "Remarks", group: "Tracking", editable: true },
];

/** Optional app columns. Content sits with the writing step (Script), Design with production (Edit). */
export const PLAN_GRID_EXTRA_COLUMNS: (PlanGridColumn & { after: PlanGridExcelColumnKey })[] = [
  { key: "contentOwner", header: "Content Owner", group: "Script", editable: true, ownerStage: "Content", optional: true, after: "scriptOwner" },
  { key: "designOwner", header: "Design Owner", group: "Edit", editable: true, ownerStage: "Design", optional: true, after: "editOwner" },
  { key: "workflow", header: "Workflow", group: "Plan", editable: true, optional: true, after: "type", help: "Blank = Full for reels, With content for Static and Carousel posts." },
  { key: "sourceVideoLink", header: "Source Video Link", group: "Tracking", editable: true, optional: true, after: "remarks", help: "Edit only reels: a Google Drive / Docs link to the footage." },
];

/** Columns in on-screen order: the 18 Excel columns with the 2 optional ones placed after their anchors. */
export const PLAN_GRID_DISPLAY_COLUMNS: PlanGridColumn[] = PLAN_GRID_COLUMNS.flatMap((c) => [
  c,
  ...PLAN_GRID_EXTRA_COLUMNS.filter((x) => x.after === c.key).map(({ after: _after, ...rest }) => rest),
]);

/** Template / upload headers: the 18 Excel columns, then the 2 optional owner columns. */
export const PLAN_TEMPLATE_HEADERS: string[] = [
  ...PLAN_GRID_COLUMNS.map((c) => c.header),
  ...PLAN_GRID_EXTRA_COLUMNS.map((c) => c.header),
];

const normHeader = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");
const HEADER_TO_COLUMN = new Map<string, PlanGridColumnKey>(
  [...PLAN_GRID_COLUMNS, ...PLAN_GRID_EXTRA_COLUMNS].map((c) => [normHeader(c.header), c.key])
);
HEADER_TO_COLUMN.set("turnaround", "turnaroundDays");
HEADER_TO_COLUMN.set("turnaround days", "turnaroundDays");

/** Column key for a grid/template header, or null if it is not one. */
export function planGridColumnForHeader(header: string): PlanGridColumnKey | null {
  return HEADER_TO_COLUMN.get(normHeader(String(header ?? ""))) ?? null;
}

/** Headers only the new 18-column layout has; their presence marks a new-layout file. */
const NEW_LAYOUT_ONLY_HEADERS = new Set(
  ["Script Status", "Script Done Date", "Shoot Status", "Shoot Done Date", "Edit Status", "Edit Done Date", "Approval Status", "Approval Date", "Published Date", "Turnaround (Days)", "Turnaround"].map(normHeader)
);
export function isNewPlanLayout(headers: string[]): boolean {
  return headers.some((h) => NEW_LAYOUT_ONLY_HEADERS.has(normHeader(String(h ?? ""))));
}

/**
 * Split clipboard text from Excel (tab-separated, CRLF or LF rows, quoted cells
 * may contain tabs/newlines and doubled quotes). Trailing empty lines are dropped.
 */
export function parseClipboardTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  const src = String(text ?? "");
  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"' && cell === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === "\t") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i += ch === "\r" && src[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    cell += ch;
    i++;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows[rows.length - 1].every((c) => c.trim() === "")) rows.pop();
  return rows;
}

export type PlanGridCells = Partial<Record<PlanGridColumnKey, string>>;

/**
 * Turn pasted rows into cell maps. If the first row is a header row it places the
 * columns; otherwise columns follow the 18 Excel columns from `startColumn` (the cell
 * the paste landed on). A paste that starts on an optional column fills only that column.
 */
export function pastedRowsToCells(
  rows: string[][],
  startColumn: PlanGridColumnKey = "postingDate"
): { cells: PlanGridCells[]; headerDetected: boolean; unknownHeaders: string[] } {
  if (rows.length === 0) return { cells: [], headerDetected: false, unknownHeaders: [] };
  const first = rows[0];
  const headerHits = first.filter((h) => planGridColumnForHeader(h)).length;
  const headerDetected = headerHits >= 2;
  let keys: (PlanGridColumnKey | null)[];
  const unknownHeaders: string[] = [];
  let body = rows;
  if (headerDetected) {
    keys = first.map((h) => {
      const k = planGridColumnForHeader(h);
      if (!k && h.trim()) unknownHeaders.push(h.trim());
      return k;
    });
    body = rows.slice(1);
  } else if (PLAN_GRID_EXTRA_COLUMNS.some((c) => c.key === startColumn)) {
    keys = [startColumn];
  } else {
    const startIdx = Math.max(0, PLAN_GRID_COLUMNS.findIndex((c) => c.key === startColumn));
    keys = PLAN_GRID_COLUMNS.slice(startIdx).map((c) => c.key);
  }
  const cells = body
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const out: PlanGridCells = {};
      r.forEach((value, idx) => {
        const key = keys[idx];
        if (key) out[key] = value.trim();
      });
      return out;
    });
  return { cells, headerDetected, unknownHeaders };
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type GridDateResult =
  | { ok: true; value: string; resolvedByMonth?: boolean }
  | { ok: false; empty?: boolean; ambiguous?: boolean; error: string };

const isRealDate = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};
const ymd = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** '2026-11-02' -> '2 Nov 2026' */
export function formatGridDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!m) return value || "";
  return `${Number(m[3])} ${SHORT_MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/**
 * Parse a date cell into 'YYYY-MM-DD'. Accepts `2026-11-02`, `2 Nov, 2026`,
 * `2 November 2026`, `Nov 2, 2026` and slashed dates (`/`, `-` or `.`).
 *
 * Slashed dates: an unambiguous day/month date (e.g. 16/11/2026) is accepted.
 * When both DD/MM and MM/DD are real dates, or only MM/DD is, the grid month
 * (`opts.month`, 'YYYY-MM') decides: the date is accepted only when exactly one
 * reading falls in that month. Otherwise it is an error, never a guess.
 */
export function parseGridDate(raw: unknown, opts: { month?: string } = {}): GridDateResult {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, empty: true, error: "Date is required." };

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? { ok: true, value: ymd(y, mo, d) } : { ok: false, error: `"${s}" is not a real date.` };
  }

  m = /^(\d{1,2})\s+([A-Za-z]+)\.?,?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    const [d, y] = [Number(m[1]), Number(m[3])];
    if (mo && isRealDate(y, mo, d)) return { ok: true, value: ymd(y, mo, d) };
    return { ok: false, error: `"${s}" is not a real date.` };
  }

  m = /^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    const [d, y] = [Number(m[2]), Number(m[3])];
    if (mo && isRealDate(y, mo, d)) return { ok: true, value: ymd(y, mo, d) };
    return { ok: false, error: `"${s}" is not a real date.` };
  }

  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) {
    const [a, b, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dayFirst = isRealDate(y, b, a) ? ymd(y, b, a) : null;
    const monthFirst = isRealDate(y, a, b) ? ymd(y, a, b) : null;
    const readings = [...new Set([dayFirst, monthFirst].filter(Boolean) as string[])];
    if (readings.length === 0) return { ok: false, error: `"${s}" is not a real date.` };
    // Unambiguous day/month (the Excel sample's format).
    if (readings.length === 1 && dayFirst) return { ok: true, value: dayFirst };
    const month = opts.month && isMonthKey(opts.month) ? opts.month : null;
    if (month) {
      const inMonth = readings.filter((r) => r.slice(0, 7) === month);
      if (inMonth.length === 1) return { ok: true, value: inMonth[0], resolvedByMonth: true };
    }
    const options = readings.map(formatGridDate).join(" or ");
    return {
      ok: false,
      ambiguous: readings.length > 1,
      error:
        readings.length > 1
          ? `"${s}" could be ${options}${month ? ", and the grid month does not settle it" : ""}. Write the month as a word, e.g. ${formatGridDate(readings[0]).replace(/ (\d{4})$/, ", $1")}.`
          : `"${s}" reads as ${options} only month-first${month ? ", which is outside this grid month" : ""}. Use day/month/year.`,
    };
  }

  return { ok: false, error: `"${s}" is not a recognised date. Use 2 Nov, 2026 or 16/11/2026.` };
}

/** Grid/Excel vocabulary that differs from the app's type names (typed or pasted text only). */
export const PLAN_GRID_TYPE_ALIASES: Record<string, string> = {
  poster: "Static Post",
  carousal: "Carousel Post",
  carousel: "Carousel Post",
  "static post": "Static Post",
  "carousel post": "Carousel Post",
  reel: "Reel",
  reels: "Reel",
  story: "Story",
};

export type GridTypeResult = { ok: true; value: string } | { ok: false; empty?: boolean; error: string };

/**
 * Map a Type cell to an app deliverable type.
 * - Typed/pasted text: grid aliases first (Poster -> Static Post, Carousal -> Carousel Post),
 *   then an exact app type name. Nothing is guessed from partial text.
 * - `exact: true` (picked from the type list): one of the 15 documented types as-is,
 *   so the print "Poster" type stays selectable.
 */
export function parseGridType(raw: unknown, opts: { exact?: boolean } = {}): GridTypeResult {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: false, empty: true, error: "Type is required." };
  const lower = s.toLowerCase().replace(/\s+/g, " ");
  if (opts.exact) {
    const hit = DELIVERABLE_TYPE_KEYS.find((t) => t.toLowerCase() === lower);
    return hit ? { ok: true, value: hit } : { ok: false, error: `Unknown type "${s}".` };
  }
  const alias = PLAN_GRID_TYPE_ALIASES[lower];
  if (alias) return { ok: true, value: alias };
  const exact = DELIVERABLE_TYPE_KEYS.find((t) => t.toLowerCase() === lower);
  if (exact && exact !== "Poster") return { ok: true, value: exact };
  return { ok: false, error: `Unknown type "${s}". Use Reel, Poster, Carousal, Static Post, Carousel Post, Story or pick from the list.` };
}

export interface GridOwnerCandidate {
  _id: string;
  name: string;
}

export type GridOwnerResult =
  | { ok: true; empty: true }
  | { ok: true; empty?: false; id: string; name: string }
  | { ok: false; ambiguous?: boolean; error: string };

/** Exact (trimmed, case-sensitive) name match only. Two people with the same name is ambiguous. */
export function matchGridOwner(raw: unknown, people: GridOwnerCandidate[]): GridOwnerResult {
  const s = String(raw ?? "").trim();
  if (!s) return { ok: true, empty: true };
  const hits = people.filter((p) => (p.name || "").trim() === s);
  if (hits.length === 1) return { ok: true, id: String(hits[0]._id), name: hits[0].name };
  if (hits.length > 1) return { ok: false, ambiguous: true, error: `More than one active person is named "${s}". Pick the owner from the list.` };
  return { ok: false, error: `No active person is named exactly "${s}".` };
}


// ─────────────────────────────────────────────────────────────────────────────
// Phase 7: time labels and project KPIs. Computed only, from stored dates; dates are
// compared by calendar day in Asia/Kolkata, so a step due on a day is on time until
// 11:59 PM IST that day.
// ─────────────────────────────────────────────────────────────────────────────

type DateLike = string | Date | number | null | undefined;

const IST_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 'YYYY-MM-DD' of a moment in Asia/Kolkata, or null for a missing or invalid date. */
export function istDateKey(value: DateLike): string | null {
  if (value === null || value === undefined || value === "") return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return IST_DATE_FORMAT.format(d);
}

/**
 * Short date for screens: "16 Nov", with the year only when it is not the current year
 * ("3 Jan 2027"). IST calendar day. '' for a missing or invalid date.
 */
export function formatShortDate(value: DateLike, now: Date = new Date()): string {
  const key = istDateKey(value);
  if (!key) return "";
  const year = Number(key.slice(0, 4));
  const currentYear = Number((istDateKey(now) || "").slice(0, 4));
  return `${Number(key.slice(8, 10))} ${SHORT_MONTHS[Number(key.slice(5, 7)) - 1]}${year !== currentYear ? ` ${year}` : ""}`;
}

const IST_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "16 Nov, 14:05" (IST, 24-hour), with the year rule of formatShortDate. '' for a missing date. */
export function formatShortDateTime(value: DateLike, now: Date = new Date()): string {
  const day = formatShortDate(value, now);
  return day ? `${day}, ${IST_TIME_FORMAT.format(new Date(value as string | number | Date))}` : "";
}

const dayNumber = (key: string) =>
  Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 86400000;

/** Calendar days from `earlier` to `later`, by IST date (positive when `later` is a later day). */
export function istDayDiff(later: DateLike, earlier: DateLike): number | null {
  const a = istDateKey(later);
  const b = istDateKey(earlier);
  if (!a || !b) return null;
  return Math.round(dayNumber(a) - dayNumber(b));
}

/** The Monday ('YYYY-MM-DD') of the IST week a moment falls in. */
export function istWeekKey(value: DateLike): string | null {
  const key = istDateKey(value);
  if (!key) return null;
  const n = dayNumber(key);
  const weekday = (new Date(n * 86400000).getUTCDay() + 6) % 7; // Monday = 0
  return new Date((n - weekday) * 86400000).toISOString().slice(0, 10);
}

/** Minimum number of ratings before an average is shown. */
export const MIN_RATINGS = 3;
export const COLLECTING_BASELINE = "Collecting baseline";

export interface TimedStep {
  status?: string | null;
  stageKey?: string | null;
  isLocked?: boolean | null;
  isSkipped?: boolean | null;
  reviewRequired?: boolean | null;
  dueDate?: DateLike;
  deadline?: DateLike;
  unlockedAt?: DateLike;
  startedAt?: DateLike;
  submittedAt?: DateLike;
  approvedAt?: DateLike;
  postedAt?: DateLike;
  revisions?: number | null;
  rounds?: Array<{ startedAt?: DateLike; submittedAt?: DateLike; decision?: string | null; intervals?: unknown[] }> | null;
  intervals?: unknown[] | null;
  /** "paused" while a lead-approved pause is running. */
  pauseState?: string | null;
}

export const isFinishedStepStatus = (status?: string | null) => status === "Approved" || status === "Published";

export function stepDueDate(step: TimedStep): DateLike {
  return step.dueDate || step.deadline || null;
}

/**
 * When the step was first handed in: a Post step's posting time, otherwise the first
 * round's submit time, otherwise the stored first submission.
 */
export function firstSubmittedAt(step: TimedStep): Date | null {
  const raw = step.stageKey === "Post" ? step.postedAt : step.rounds?.[0]?.submittedAt || step.submittedAt;
  if (!raw) return null;
  const d = new Date(raw as string | Date | number);
  return isNaN(d.getTime()) ? null : d;
}

export type StepTimeLabelKind =
  | "overdue"
  | "done_late"
  | "done_on_time"
  | "late_earlier_step"
  | "waiting_earlier_step_late"
  | "blocked"
  | "paused";

export interface StepTimeLabel {
  kind: StepTimeLabelKind;
  text: string;
  days?: number;
}

const dayWord = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * The computed time labels of one step (Phase 7). A list, because a step can be both
 * "Late: earlier step" and "Done N days late", or Overdue and Blocked.
 * - Overdue: unlocked, not finished, today (IST) past the due date. A locked step is
 *   never Overdue; past its due date it is "Waiting: earlier step late".
 * - Done late / Done on time: finished, by the first submission's IST date.
 * - Late: earlier step: unlocked after its own due date (kept after it is finished).
 * - Blocked N days: an active blocker since `blockedSince`.
 * `firstSubmitted` overrides the stored first submission (older steps filled from history).
 */
export function stepTimeLabels(
  step: TimedStep,
  opts: { now?: DateLike; blockedSince?: DateLike; firstSubmitted?: DateLike } = {}
): StepTimeLabel[] {
  if (!step || step.isSkipped) return [];
  const now = opts.now ?? new Date();
  const due = stepDueDate(step);
  const labels: StepTimeLabel[] = [];
  const finished = isFinishedStepStatus(step.status);

  if (finished) {
    const first = opts.firstSubmitted ?? firstSubmittedAt(step);
    const late = due && first ? istDayDiff(first, due) : null;
    if (late !== null) {
      labels.push(
        late > 0
          ? { kind: "done_late", text: `Done ${dayWord(late)} late`, days: late }
          : { kind: "done_on_time", text: "Done on time" }
      );
    }
  } else if (step.isLocked) {
    const past = due ? istDayDiff(now, due) : null;
    if (past !== null && past > 0) labels.push({ kind: "waiting_earlier_step_late", text: "Waiting: earlier step late" });
  } else {
    const past = due ? istDayDiff(now, due) : null;
    if (past !== null && past > 0) labels.push({ kind: "overdue", text: formatOverdue(past), days: past });
  }

  if (!step.isLocked && step.unlockedAt && due) {
    const unlockedLate = istDayDiff(step.unlockedAt, due);
    if (unlockedLate !== null && unlockedLate > 0) labels.push({ kind: "late_earlier_step", text: "Late: earlier step" });
  }

  if (opts.blockedSince && !finished) {
    const days = Math.max(0, istDayDiff(now, opts.blockedSince) ?? 0);
    labels.push({ kind: "blocked", text: days === 0 ? "Blocked today" : `Blocked ${dayWord(days)}`, days });
  }
  // A paused step keeps its due date, so it can still go overdue; "Paused" says why.
  if (!finished && step.pauseState === "paused") labels.push({ kind: "paused", text: "Paused" });
  return labels;
}

export const hasTimeLabel = (labels: StepTimeLabel[] | null | undefined, kind: StepTimeLabelKind) =>
  Array.isArray(labels) && labels.some((l) => l.kind === kind);

/**
 * Worker on-time rate (Phase 7): finished steps judged Done on time or Done late. Steps that
 * unlocked after their own due date ("Late: earlier step") are left out of both the count
 * and the total, and reported as `delayedByEarlier`.
 */
export function workerOnTime(labelSets: StepTimeLabel[][]): {
  onTime: number;
  total: number;
  rate: number | null;
  /** Judged steps done late (same base as `rate`, so rate + lateRate = 100). */
  late: number;
  lateRate: number | null;
  /** Every step labelled "Done N days late", including those delayed by an earlier step. */
  doneLateCount: number;
  delayedByEarlier: number;
  delayedText: string;
} {
  let onTime = 0;
  let total = 0;
  let delayedByEarlier = 0;
  let doneLateCount = 0;
  for (const labels of labelSets) {
    const judged = hasTimeLabel(labels, "done_on_time") || hasTimeLabel(labels, "done_late");
    if (!judged) continue;
    if (hasTimeLabel(labels, "done_late")) doneLateCount += 1;
    if (hasTimeLabel(labels, "late_earlier_step")) {
      delayedByEarlier += 1;
      continue;
    }
    total += 1;
    if (hasTimeLabel(labels, "done_on_time")) onTime += 1;
  }
  const rate = total ? Math.round((onTime / total) * 100) : null;
  return {
    onTime,
    total,
    rate,
    late: total - onTime,
    lateRate: rate === null ? null : 100 - rate,
    doneLateCount,
    delayedByEarlier,
    delayedText: `${delayedByEarlier} ${delayedByEarlier === 1 ? "step" : "steps"} delayed by earlier steps`,
  };
}

/** A step approved without any changes requested. */
export function isFirstPassApproval(step: TimedStep, opts: { changesRequested?: boolean } = {}): boolean {
  if (opts.changesRequested) return false;
  if ((step.revisions || 0) > 0) return false;
  return !(step.rounds || []).some((r) => r && r.decision === "changes_requested");
}

/** Counted for first-pass approval: finished review steps; Post is never counted. */
export const isFirstPassCandidate = (step: TimedStep) =>
  !step.isSkipped && step.stageKey !== "Post" && isFinishedStepStatus(step.status);

/**
 * Elapsed work time of one step: submitted rounds only, minus blocked and paused time
 * (submittedWorkTimeMs). An older step without rounds falls back to its start and first
 * submission from history, which has no interval record, so it is marked `fromHistory`.
 */
export function stepElapsedWork(
  step: TimedStep,
  history: { startedAt?: DateLike; firstSubmittedAt?: DateLike } = {}
): { ms: number; fromHistory: boolean } | null {
  const measured = submittedWorkTimeMs(step as WorkItemTimestamps);
  if (measured !== null && measured !== undefined) return { ms: Math.max(0, measured), fromHistory: false };
  const start = history.startedAt ? new Date(history.startedAt as string).getTime() : NaN;
  const end = history.firstSubmittedAt ? new Date(history.firstSubmittedAt as string).getTime() : NaN;
  if (!isNaN(start) && !isNaN(end) && end >= start) return { ms: end - start, fromHistory: true };
  return null;
}

/** Average of one rating per step, or "Collecting baseline" under MIN_RATINGS. */
export function ratingAverage(scores: number[]): { count: number; average: number | null; text: string } {
  const valid = scores.filter((n) => typeof n === "number" && n >= 1 && n <= 5);
  if (valid.length < MIN_RATINGS) return { count: valid.length, average: null, text: COLLECTING_BASELINE };
  const average = Math.round((valid.reduce((a, b) => a + b, 0) / valid.length) * 10) / 10;
  return { count: valid.length, average, text: average.toFixed(1) };
}

export interface ProjectPieceInput {
  contentType?: string | null;
  postingDate?: DateLike;
  publishedAt?: DateLike;
  hasPostStage?: boolean | null;
}

/**
 * When a project was delivered: a posted Post step (its posting time, else the piece's
 * published time, else `postedFromHistory`), or, for a non-postable design, the approval
 * of its Design step (handover).
 */
export function projectDelivery(
  piece: ProjectPieceInput,
  steps: TimedStep[],
  opts: { postedFromHistory?: DateLike; approvedFromHistory?: DateLike } = {}
): { delivered: boolean; deliveredAt: Date | null; via: "post" | "handover" | null } {
  const live = (steps || []).filter((s) => !s.isSkipped);
  const post = live.find((s) => s.stageKey === "Post");
  const design = live.find((s) => s.stageKey === "Design");
  const asDate = (v: DateLike) => (v ? new Date(v as string) : null);
  if (post) {
    if (post.status !== "Published") return { delivered: false, deliveredAt: null, via: null };
    return { delivered: true, deliveredAt: asDate(post.postedAt || piece.publishedAt || opts.postedFromHistory), via: "post" };
  }
  const nonPostable = piece.hasPostStage === false || (piece.contentType ? !isPostableWorkType(piece.contentType) : false);
  if (design && nonPostable) {
    if (!isFinishedStepStatus(design.status)) return { delivered: false, deliveredAt: null, via: null };
    return { delivered: true, deliveredAt: asDate(design.approvedAt || opts.approvedFromHistory), via: "handover" };
  }
  return { delivered: false, deliveredAt: null, via: null };
}

export type ProjectLabelKind = "overdue" | "completed_late";

/**
 * Project labels: Overdue (publish date passed, not posted or handed over) and Completed
 * late (posted or handed over after the publish date), by IST date, whatever the cause.
 */
export function projectTimeLabel(
  piece: ProjectPieceInput,
  delivery: { delivered: boolean; deliveredAt: Date | null },
  opts: { now?: DateLike } = {}
): { kind: ProjectLabelKind; text: string; days: number } | null {
  if (!piece.postingDate) return null;
  if (delivery.delivered) {
    const late = delivery.deliveredAt ? istDayDiff(delivery.deliveredAt, piece.postingDate) : null;
    return late !== null && late > 0 ? { kind: "completed_late", text: `Completed ${dayWord(late)} late`, days: late } : null;
  }
  const past = istDayDiff(opts.now ?? new Date(), piece.postingDate);
  return past !== null && past > 0 ? { kind: "overdue", text: formatOverdue(past), days: past } : null;
}


// ─────────────────────────────────────────────────────────────────────────────
// Phase 8: profile KPIs. Each person's own figures only (no team averages, rankings or
// comparisons with others). Built on the Phase 7 label and KPI helpers above.
// ─────────────────────────────────────────────────────────────────────────────

export type ProfilePeriodKind = "month" | "3months" | "custom";

export interface ProfilePeriod {
  kind: ProfilePeriodKind;
  /** Inclusive IST calendar days, 'YYYY-MM-DD'. */
  from: string;
  to: string;
  label: string;
}

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const keyToDay = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 86400000;
const dayToKey = (n: number) => new Date(n * 86400000).toISOString().slice(0, 10);
const monthStartKey = (key: string, back = 0) => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 - back;
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
};
const monthEndKey = (key: string) => {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

/**
 * The profile period (Phase 8), in IST calendar days: this month, the last 3 months
 * (this month and the two before), or a custom range. A bad custom range falls back to
 * this month. Steps belong to it by their due date.
 */
export function resolveProfilePeriod(
  kind?: string | null,
  opts: { from?: string | null; to?: string | null; now?: string | Date | number } = {}
): ProfilePeriod {
  const today = istDateKey(opts.now ?? new Date()) as string;
  if (kind === "custom" && opts.from && opts.to && DAY_KEY_RE.test(opts.from) && DAY_KEY_RE.test(opts.to) && opts.from <= opts.to) {
    return { kind: "custom", from: opts.from, to: opts.to, label: `${opts.from} to ${opts.to}` };
  }
  if (kind === "3months") {
    const from = monthStartKey(today, 2);
    const to = monthEndKey(today);
    return { kind: "3months", from, to, label: `Last 3 months (${from.slice(0, 7)} to ${to.slice(0, 7)})` };
  }
  return { kind: "month", from: monthStartKey(today), to: monthEndKey(today), label: `This month (${today.slice(0, 7)})` };
}

/** The period just before, of the same kind and length (for the neutral "Last period" figure). */
export function previousProfilePeriod(period: ProfilePeriod): ProfilePeriod {
  if (period.kind === "month") {
    const from = monthStartKey(period.from, 1);
    return { kind: "month", from, to: monthEndKey(from), label: `Previous month (${from.slice(0, 7)})` };
  }
  if (period.kind === "3months") {
    const from = monthStartKey(period.from, 3);
    const to = monthEndKey(monthStartKey(period.from, 1));
    return { kind: "3months", from, to, label: `Previous 3 months (${from.slice(0, 7)} to ${to.slice(0, 7)})` };
  }
  const length = keyToDay(period.to) - keyToDay(period.from) + 1;
  const to = dayToKey(keyToDay(period.from) - 1);
  const from = dayToKey(keyToDay(period.from) - length);
  return { kind: "custom", from, to, label: `${from} to ${to}` };
}

/** Whether a moment falls on an IST day inside the period. */
export function inProfilePeriod(value: string | Date | number | null | undefined, period: ProfilePeriod): boolean {
  const key = istDateKey(value);
  return !!key && key >= period.from && key <= period.to;
}

/**
 * Review-step figures (Phase 8): review steps only (Post excluded), counted once they have a
 * decision (finished, or sent back at least once).
 * - changesRequestedRate: reviewed steps with at least one change request ÷ reviewed steps
 * - reworkRounds: total revision rounds; reworkRate: revision rounds ÷ reviewed steps
 */
export function reviewStats(
  steps: Array<TimedStep & { changesRequested?: boolean }>
): {
  reviewed: number;
  withChangeRequest: number;
  changesRequestedRate: number | null;
  reworkRounds: number;
  reworkRate: number | null;
} {
  let reviewed = 0;
  let withChangeRequest = 0;
  let reworkRounds = 0;
  for (const step of steps || []) {
    if (!step || step.isSkipped || step.stageKey === "Post") continue;
    const sentBack =
      Boolean(step.changesRequested) ||
      (step.revisions || 0) > 0 ||
      (step.rounds || []).some((r) => r && r.decision === "changes_requested");
    if (!isFinishedStepStatus(step.status) && !sentBack) continue;
    reviewed += 1;
    if (sentBack) withChangeRequest += 1;
    reworkRounds += Math.max(step.revisions || 0, sentBack ? 1 : 0);
  }
  return {
    reviewed,
    withChangeRequest,
    changesRequestedRate: reviewed ? Math.round((withChangeRequest / reviewed) * 100) : null,
    reworkRounds,
    reworkRate: reviewed ? Math.round((reworkRounds / reviewed) * 100) / 100 : null,
  };
}

/**
 * A reviewer's decisions (Phase 8): submissions they approved or sent back. Approval wait is
 * submission to decision, averaged over decisions that have both times.
 */
export function reviewerStats(
  decisions: Array<{ status?: string | null; submittedAt?: DateLike; reviewedAt?: DateLike }>
): { reviews: number; approvals: number; changesRequested: number; avgWaitMs: number | null; waitBasedOn: number } {
  let approvals = 0;
  let changesRequested = 0;
  let waitTotal = 0;
  let waitBasedOn = 0;
  for (const d of decisions || []) {
    if (d?.status === "approved") approvals += 1;
    else if (d?.status === "changes_requested") changesRequested += 1;
    else continue;
    if (d.submittedAt && d.reviewedAt) {
      const ms = new Date(d.reviewedAt as string).getTime() - new Date(d.submittedAt as string).getTime();
      if (!isNaN(ms) && ms >= 0) {
        waitTotal += ms;
        waitBasedOn += 1;
      }
    }
  }
  return {
    reviews: approvals + changesRequested,
    approvals,
    changesRequested,
    avgWaitMs: waitBasedOn ? Math.round(waitTotal / waitBasedOn) : null,
    waitBasedOn,
  };
}

/** The team review queue: how many are waiting and the oldest wait (from its latest submission). */
export function reviewQueueAge(
  waiting: Array<{ submittedAt?: DateLike }>,
  now: DateLike = new Date()
): { waiting: number; oldestMs: number | null; oldestSubmittedAt: Date | null } {
  const times = (waiting || [])
    .map((w) => (w?.submittedAt ? new Date(w.submittedAt as string).getTime() : NaN))
    .filter((t) => !isNaN(t));
  if (!times.length) return { waiting: (waiting || []).length, oldestMs: null, oldestSubmittedAt: null };
  const oldest = Math.min(...times);
  return { waiting: (waiting || []).length, oldestMs: Math.max(0, new Date(now as string).getTime() - oldest), oldestSubmittedAt: new Date(oldest) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Simple workload: step counts, no hours or percentages. One definition everywhere
// (workload page, dashboard, profiles, autofill, import, Recommended Owner).
// Days are IST calendar days; "this week" is today and the next 6 days, plus overdue.
// ─────────────────────────────────────────────────────────────────────────────

/** Active-step limit when a person has none set. */
export const DEFAULT_ACTIVE_STEP_LIMIT = 4;
/** Due this week at or below this is "Available". */
export const WORKLOAD_AVAILABLE_MAX = 2;
export const WORKLOAD_WINDOW_DAYS = 7;

export const SIMPLE_WORKLOAD_BANDS = ["Available", "Busy", "Over"] as const;
export type SimpleWorkloadBand = (typeof SIMPLE_WORKLOAD_BANDS)[number];

/** A step as workload reads it. `dueDate` falls back to `deadline`. */
export interface WorkloadStep {
  status?: string | null;
  isLocked?: boolean | null;
  isSkipped?: boolean | null;
  dueDate?: DateLike;
  deadline?: DateLike;
  /** Status of the step's latest version (submission), when it has one. */
  latestVersionStatus?: string | null;
  revisions?: number | null;
}

export interface Workload {
  inProgress: number;
  dueThisWeek: number;
  limit: number;
  band: SimpleWorkloadBand;
  /** Earliest due date (IST, YYYY-MM-DD) among the steps the owner has to act on, overdue included; or null. */
  nextDue: string | null;
}

/** The person's limit: a positive whole number, or the default. */
export function activeStepLimitOf(person: { activeStepLimit?: number | null } | null | undefined): number {
  const v = Number(person?.activeStepLimit);
  return Number.isInteger(v) && v > 0 ? v : DEFAULT_ACTIVE_STEP_LIMIT;
}

/** Over the limit first; otherwise Available (2 or fewer) or Busy. */
export function workloadBand(dueThisWeek: number, limit: number = DEFAULT_ACTIVE_STEP_LIMIT): SimpleWorkloadBand {
  if (dueThisWeek > limit) return "Over";
  if (dueThisWeek <= WORKLOAD_AVAILABLE_MAX) return "Available";
  return "Busy";
}

const stepDueKey = (s: WorkloadStep) => istDateKey(s.dueDate ?? s.deadline);

/**
 * True when the owner has something to do on the step: Not Started and unlocked,
 * In Progress (rework and paused included), Blocked, or Feedback with changes requested.
 * Waiting for review, Pending, Approved, Published, skipped and locked steps do not count.
 */
export function ownerHasWork(s: WorkloadStep): boolean {
  if (!s || s.isSkipped || s.isLocked) return false;
  switch (s.status) {
    case "Not Started":
    case "In Progress":
    case "Blocked":
      return true;
    case "Feedback":
      return stepReviewState("Feedback", s.latestVersionStatus ?? null, Number(s.revisions) || 0) === "changes_requested";
    default:
      return false;
  }
}

/** Steps the owner has to act on, due up to `endKey` and (unless overdue counts) from `startKey`. */
function countDue(steps: WorkloadStep[], startKey: string, endKey: string, includeOverdue: boolean): number {
  let n = 0;
  for (const s of steps || []) {
    if (!ownerHasWork(s)) continue;
    const key = stepDueKey(s);
    if (!key || key > endKey) continue;
    if (!includeOverdue && key < startKey) continue;
    n += 1;
  }
  return n;
}

const inProgressCount = (steps: WorkloadStep[]) => (steps || []).filter((s) => s && !s.isSkipped && s.status === "In Progress").length;

/**
 * One person's workload from their steps.
 * - inProgress: steps with status In Progress (rework and paused included), not skipped.
 * - dueThisWeek: steps the owner has to act on, due from today to today + 6 (IST), overdue included.
 */
export function workloadFor(
  person: { activeStepLimit?: number | null } | null | undefined,
  steps: WorkloadStep[],
  now: DateLike = new Date(),
): Workload {
  const todayKey = istDateKey(now) as string;
  const endKey = addDaysToKey(todayKey, WORKLOAD_WINDOW_DAYS - 1);
  const list = steps || [];
  const dueThisWeek = countDue(list, todayKey, endKey, true);
  let nextDue: string | null = null;
  for (const s of list) {
    if (!ownerHasWork(s)) continue;
    const key = stepDueKey(s);
    if (key && (!nextDue || key < nextDue)) nextDue = key;
  }
  const limit = activeStepLimitOf(person);
  return { inProgress: inProgressCount(list), dueThisWeek, limit, band: workloadBand(dueThisWeek, limit), nextDue };
}

/** A person suggestions can choose from, with their open steps. */
export interface OwnerCandidate {
  id: string;
  name: string;
  activeStepLimit?: number | null;
  steps: WorkloadStep[];
}

export interface OwnerPick<C extends OwnerCandidate = OwnerCandidate> {
  candidate: C;
  /** Steps due in the target step's window before this pick. */
  dueInWindow: number;
  inProgress: number;
  limit: number;
  /** True when this step takes them above their limit; they are still picked. */
  overLimit: boolean;
  /** Why this person, for a tooltip. */
  reason: string;
  /** "Over limit: Ashwin has 5 due this week." when overLimit, else null. */
  warning: string | null;
}

/**
 * The target step's 7-day window: the 7 IST days ending on its due date. With no due date,
 * or a due date within the current week, it is this week (today to today + 6, overdue included).
 */
export function targetWindow(targetDue: DateLike, now: DateLike = new Date()): { startKey: string; endKey: string; thisWeek: boolean } {
  const todayKey = istDateKey(now) as string;
  const thisWeekEnd = addDaysToKey(todayKey, WORKLOAD_WINDOW_DAYS - 1);
  const dueKey = istDateKey(targetDue);
  if (!dueKey || dueKey <= thisWeekEnd) return { startKey: todayKey, endKey: thisWeekEnd, thisWeek: true };
  return { startKey: addDaysToKey(dueKey, -(WORKLOAD_WINDOW_DAYS - 1)), endKey: dueKey, thisWeek: false };
}

const firstNameOf = (name: string) => String(name || "").trim().split(/\s+/)[0] || String(name || "");

/**
 * The one owner rule for every suggestion (autofill, import, Recommended Owner):
 * eligible, then fewest due in the target step's 7-day window, then fewest in progress,
 * then name, then id. Nobody is excluded for load: an over-limit pick is still returned,
 * with a warning. Returns null only when nobody is eligible.
 *
 * To spread work across a run, replace the picked candidate with `withPlannedStep(...)`
 * before the next call.
 */
export function pickOwner<C extends OwnerCandidate>(
  candidates: C[],
  opts: { targetDue?: DateLike; now?: DateLike; eligible?: (c: C) => boolean } = {},
): OwnerPick<C> | null {
  const now = opts.now ?? new Date();
  const eligible = opts.eligible ?? (() => true);
  const win = targetWindow(opts.targetDue, now);
  const scored = (candidates || [])
    .filter((c) => c && eligible(c))
    .map((c) => ({ c, due: countDue(c.steps, win.startKey, win.endKey, win.thisWeek), inProgress: inProgressCount(c.steps), limit: activeStepLimitOf(c) }));
  if (scored.length === 0) return null;
  scored.sort(
    (a, b) =>
      a.due - b.due ||
      a.inProgress - b.inProgress ||
      String(a.c.name || "").localeCompare(String(b.c.name || ""), "en", { sensitivity: "base" }) ||
      String(a.c.id).localeCompare(String(b.c.id)),
  );
  const best = scored[0];
  const after = best.due + 1;
  const overLimit = after > best.limit;
  const when = win.thisWeek ? "this week" : `in the week to ${formatShortDate(`${win.endKey}T12:00:00+05:30`, new Date(now as string | number | Date))}`;
  return {
    candidate: best.c,
    dueInWindow: best.due,
    inProgress: best.inProgress,
    limit: best.limit,
    overLimit,
    reason: `Fewest due ${when} (${best.due}), ${best.inProgress} in progress`,
    warning: overLimit ? `Over limit: ${firstNameOf(best.c.name)} has ${after} due ${when}.` : null,
  };
}

/** The candidate with one more planned step (Not Started, unlocked) due on `dueDate`. */
export function withPlannedStep<C extends OwnerCandidate>(candidate: C, dueDate: DateLike): C {
  const due = dueDate instanceof Date ? dueDate.toISOString() : dueDate;
  return { ...candidate, steps: [...(candidate.steps || []), { status: "Not Started", isLocked: false, dueDate: due }] };
}

// ==========================================
// Access v2 (Phase B): permission catalog, system roles, workflow config, resolver.
// Nothing in the app uses this yet; the parity test proves it matches the current rules
// for every role × action × calendar × owner/non-owner. Phase C switches the app to it.
// ==========================================

export const PERMISSION_AREAS = ["Planning", "Production", "Review", "Publishing", "Team", "Reports", "Chat", "Admin", "Settings"] as const;
export type PermissionArea = (typeof PERMISSION_AREAS)[number];

/**
 * Which workflow-config list a calendar-scoped permission is routed by: the person must be in
 * that list for the calendar (admin always is). Unrouted permissions are not calendar-scoped.
 */
export type PermissionRouting = "reviewers" | "planApprovers" | "posters";

export interface PermissionDef {
  key: string;
  area: PermissionArea;
  label: string;
  description: string;
  calendarScoped: boolean;
  routedBy?: PermissionRouting;
}

/** Catalog v2. `portal.view` is split into work.view_all, calendar.view, feedback.view_all and assignment.view. */
export const PERMISSION_CATALOG = [
  // Planning
  { key: "calendar.view", area: "Planning", label: "View plans", description: "Read calendar plans, rows and the Tracker (was part of portal.view).", calendarScoped: false },
  { key: "calendar.plan", area: "Planning", label: "Plan", description: "Create, edit and submit plans and rows.", calendarScoped: false },
  { key: "calendar.approve", area: "Planning", label: "Approve plans", description: "Approve or send back plans and rows on their calendars.", calendarScoped: true, routedBy: "planApprovers" },
  { key: "assignment.view", area: "Planning", label: "View assignments", description: "Read owner recommendations and assignment data (was part of portal.view).", calendarScoped: false },
  { key: "assignment.override", area: "Planning", label: "Assign owners", description: "Assign or override step owners and reschedule pieces.", calendarScoped: false },
  { key: "people.assign", area: "Planning", label: "Assign people", description: "Pick people for work.", calendarScoped: false },
  // Production
  { key: "work.view_all", area: "Production", label: "View all work", description: "Read every step and blocker, not only your own (was part of portal.view).", calendarScoped: false },
  { key: "work.create", area: "Production", label: "Create work", description: "Create standalone work items and uploads.", calendarScoped: false },
  { key: "work.request", area: "Production", label: "Request work", description: "Request work and read your own items.", calendarScoped: false },
  { key: "work.update.own", area: "Production", label: "Update own work", description: "Start, submit and update steps you own.", calendarScoped: false },
  { key: "work.manage_steps", area: "Production", label: "Manage steps", description: "Change a step's owner or date, skip steps.", calendarScoped: false },
  { key: "blocker.resolve.any", area: "Production", label: "Resolve any blocker", description: "Resolve or remind on blockers of steps you do not own.", calendarScoped: false },
  // Review
  { key: "review.decide", area: "Review", label: "Review", description: "Approve, request changes, rate, reopen and decide pauses on steps of your calendars (never your own).", calendarScoped: true, routedBy: "reviewers" },
  { key: "review.read_all", area: "Review", label: "Read all review text", description: "Read revision notes, ratings and clip threads on others' steps.", calendarScoped: false },
  { key: "feedback.view_all", area: "Review", label: "View feedback", description: "Read feedback and revision flags (was part of portal.view).", calendarScoped: false },
  { key: "feedback.give", area: "Review", label: "Give feedback", description: "Write feedback on others' work.", calendarScoped: false },
  { key: "feedback.respond", area: "Review", label: "Respond to feedback", description: "Reply to feedback on your work.", calendarScoped: false },
  { key: "revision.classify", area: "Review", label: "Classify revisions", description: "Set the root cause of flagged revisions on your calendars.", calendarScoped: true, routedBy: "reviewers" },
  // Publishing
  { key: "publish.post", area: "Publishing", label: "Post", description: "Own Post steps and mark pieces posted.", calendarScoped: true, routedBy: "posters" },
  { key: "publish.edit_live_link", area: "Publishing", label: "Edit live links", description: "Correct the live link of a posted piece.", calendarScoped: false },
  // Team
  { key: "people.view", area: "Team", label: "View people", description: "Read the people directory.", calendarScoped: false },
  { key: "people.manage_operational", area: "Team", label: "Manage operational fields", description: "Edit job role, preferences, capacity and department.", calendarScoped: false },
  { key: "team.profile.view", area: "Team", label: "View profiles", description: "Open team profiles.", calendarScoped: false },
  { key: "team.profile.report", area: "Team", label: "Profile reports", description: "View and download a person's profile report.", calendarScoped: false },
  // Reports
  { key: "analytics.team", area: "Reports", label: "Team analytics", description: "Dashboards and team metrics.", calendarScoped: false },
  { key: "report.view", area: "Reports", label: "View reports", description: "Live reports.", calendarScoped: false },
  { key: "report.configure", area: "Reports", label: "Configure reports", description: "Report settings (admin).", calendarScoped: false },
  // Chat
  { key: "chat.use", area: "Chat", label: "Chat", description: "Send messages and join channels.", calendarScoped: false },
  { key: "chat.read", area: "Chat", label: "Read chat", description: "Read channels without writing (read-only roles).", calendarScoped: false },
  { key: "chat.group.create", area: "Chat", label: "Create groups", description: "Create group channels.", calendarScoped: false },
  { key: "chat.moderate", area: "Chat", label: "Moderate", description: "Pin messages in any channel you are in.", calendarScoped: false },
  { key: "chat.mention_all", area: "Chat", label: "Mention @everyone", description: "Use @everyone.", calendarScoped: false },
  { key: "chat.share_asset", area: "Chat", label: "Share any asset", description: "Share outputs you do not own to chat.", calendarScoped: false },
  { key: "chat.revoke_share", area: "Chat", label: "Revoke any share", description: "Revoke a share someone else made.", calendarScoped: false },
  { key: "chat.manage_groups", area: "Chat", label: "Manage any group", description: "Edit, archive and manage members of groups you do not own.", calendarScoped: false },
  // Admin
  { key: "user.approve", area: "Admin", label: "Approve access", description: "Approve access requests.", calendarScoped: false },
  { key: "user.manage", area: "Admin", label: "Manage users", description: "Invite, edit and suspend users.", calendarScoped: false },
  { key: "automation.manage", area: "Admin", label: "Automation", description: "Automation rules (admin).", calendarScoped: false },
  // Settings
  { key: "settings.manage", area: "Settings", label: "Settings", description: "Departments and API docs (admin).", calendarScoped: false },
  { key: "settings.access.manage", area: "Settings", label: "Roles & access", description: "Assign roles and calendar scope; set reviewers, approvers and posters.", calendarScoped: false },
] as const satisfies readonly PermissionDef[];

export type PermissionKeyV2 = (typeof PERMISSION_CATALOG)[number]["key"];
export const PERMISSION_KEYS_V2 = PERMISSION_CATALOG.map((p) => p.key) as PermissionKeyV2[];
const PERMISSION_DEF = new Map<string, PermissionDef>(PERMISSION_CATALOG.map((p) => [p.key, p as PermissionDef]));
export const permissionDef = (key: string): PermissionDef | undefined => PERMISSION_DEF.get(key);

/**
 * Where portal.view was used in a route guard, the key that replaces it there, by API module.
 * In each guard the replacement's holders equal portal.view's, or the guard already lists a key
 * whose holders include them, so every guard admits exactly the same roles (parity test).
 */
export const PORTAL_VIEW_SPLIT: Record<string, PermissionKeyV2> = {
  workItems: "work.view_all",
  blockers: "work.view_all",
  calendar: "calendar.view",
  feedback: "feedback.view_all",
  assignment: "assignment.view",
  people: "people.view",
  reports: "report.view",
};

/**
 * Permissions that can never be used on your own work (no self-approval). Phase C5: classifying a
 * revision flag on your own step is blocked too, like every other decision.
 */
/** Nobody decides on their own work: versions, revision flags, and their own plans (Phase E fix). */
export const SELF_FORBIDDEN_PERMISSIONS: readonly string[] = ["review.decide", "revision.classify", "calendar.approve"];

export type DataScope = "all" | "own";
export interface SystemRoleDef {
  key: UserRole;
  /** Every key for admin (locked; never limited by calendar). */
  permissions: readonly string[];
  /** "own": sees only work they take part in; others' contact details hidden (fixed rules). */
  dataScope: DataScope;
  /** Every write refused except on their own account. */
  readOnly: boolean;
  /** Can own steps (workload, autofill, assignment candidates). */
  takesSteps: boolean;
  locked: boolean;
  /** false: others' email, phone and WhatsApp are hidden even with dataScope "all" (the Viewer). */
  contactDetails?: boolean;
}

const V2_VIEWER: PermissionKeyV2[] = [
  "calendar.view", "work.view_all", "feedback.view_all", "assignment.view",
  "people.view", "analytics.team", "report.view", "chat.read", "team.profile.view",
  "review.read_all", "team.profile.report",
];
const V2_LEAD: PermissionKeyV2[] = [
  "calendar.view", "work.view_all", "feedback.view_all", "assignment.view",
  "people.view", "people.assign", "calendar.approve", "feedback.give", "feedback.respond", "revision.classify",
  "assignment.override", "work.update.own", "analytics.team", "report.view",
  "chat.use", "chat.group.create", "chat.moderate", "team.profile.view",
  "review.decide", "review.read_all", "people.manage_operational", "team.profile.report",
  "chat.mention_all", "chat.share_asset", "chat.revoke_share",
];

/** The 7 fixed system roles (no custom roles). Mirrors ROLE_PERMISSIONS plus the hard-coded role rules. */
export const SYSTEM_ROLES: Record<UserRole, SystemRoleDef> = {
  admin: { key: "admin", permissions: [...PERMISSION_KEYS_V2], dataScope: "all", readOnly: false, takesSteps: false, locked: true },
  creative_head: { key: "creative_head", permissions: V2_VIEWER, dataScope: "all", readOnly: true, takesSteps: false, locked: false },
  production_head: { key: "production_head", permissions: V2_VIEWER, dataScope: "all", readOnly: true, takesSteps: false, locked: false },
  creative_lead: { key: "creative_lead", permissions: V2_LEAD, dataScope: "all", readOnly: false, takesSteps: false, locked: false },
  growth_lead: { key: "growth_lead", permissions: V2_LEAD, dataScope: "all", readOnly: false, takesSteps: false, locked: false },
  sm_manager: {
    key: "sm_manager",
    permissions: [
      "calendar.view", "calendar.plan", "work.create", "assignment.override", "work.update.own", "feedback.respond",
      "analytics.team", "report.view", "people.view", "chat.use", "chat.group.create", "chat.moderate", "team.profile.view",
      "work.manage_steps", "blocker.resolve.any", "publish.post", "publish.edit_live_link", "review.read_all",
      "chat.mention_all", "chat.share_asset",
    ],
    dataScope: "all",
    readOnly: false,
    takesSteps: true,
    locked: false,
  },
  executive: { key: "executive", permissions: ["work.update.own", "work.request", "feedback.respond", "chat.use"], dataScope: "own", readOnly: false, takesSteps: true, locked: false },
  /**
   * Read-only observer: sees the whole plan and every step's status (calendars, Tracker, Work Items,
   * Work Detail without private review text, Published, dashboard, reports, Project KPIs). No
   * contact details, no review text, no chat, no Team Workload, no profiles or profile reports, no
   * Settings or admin pages. Every write refused except their own account. Never owns, reviews,
   * approves or posts anything, so it never appears in pickers or routing lists.
   */
  viewer: {
    key: "viewer",
    permissions: ["calendar.view", "work.view_all", "analytics.team", "report.view"],
    dataScope: "all",
    readOnly: true,
    takesSteps: false,
    locked: false,
    contactDetails: false,
  },
};

/** People for a workflow slot: by role and/or by named user ids. */
export interface AccessAudience {
  roles: string[];
  userIds: string[];
}
export interface WorkflowConfigShape {
  calendar: string;
  reviewers: AccessAudience;
  planApprovers: AccessAudience;
  posters: AccessAudience;
  /**
   * Who decides (reviews, plan approvals) when nobody in the main list is active and eligible.
   * Active admins are always the final fallback: they decide on every calendar (locked role), and
   * they are notified when this list also has nobody active.
   */
  fallbackApprovers: AccessAudience;
  version?: number;
  /**
   * Set by the API resolver, never stored: the main list of this slot has nobody active and
   * eligible right now, so the fallback members decide on this calendar.
   */
  primaryInactive?: Partial<Record<"reviewers" | "planApprovers", boolean>>;
}
export const WORKFLOW_SLOTS = ["reviewers", "planApprovers", "posters", "fallbackApprovers"] as const;
export type WorkflowSlot = (typeof WORKFLOW_SLOTS)[number];

/** Today's rules as config: Ads → Marketing Growth Manager, others → Creative Manager; posters SM Manager; fallback admin. */
export function defaultWorkflowConfig(calendar: string | null | undefined): WorkflowConfigShape {
  const cal = calendar || "sm";
  const lead = deciderRoleFor(cal);
  return {
    calendar: cal,
    reviewers: { roles: [lead], userIds: [] },
    planApprovers: { roles: [lead], userIds: [] },
    posters: { roles: ["sm_manager"], userIds: [] },
    fallbackApprovers: { roles: ["admin"], userIds: [] },
    version: 0,
  };
}

export interface AccessUser {
  _id?: unknown;
  id?: unknown;
  userId?: unknown;
  role?: string | null;
  status?: string | null;
  jobRole?: string | null;
  /** Optional per-person calendar limit (decisions and queues only). */
  calendarScope?: string[] | null;
}
const accessUserId = (u: AccessUser | null | undefined) => String((u?.userId as any) || (u?._id as any) || (u?.id as any) || "");
const idString = (v: unknown) => String((v as any)?._id || v || "");

export const systemRoleOf = (user: AccessUser | null | undefined): SystemRoleDef | undefined =>
  (SYSTEM_ROLES as Record<string, SystemRoleDef>)[String(user?.role || "")];

export function audienceIncludes(audience: AccessAudience | null | undefined, user: AccessUser | null | undefined): boolean {
  if (!audience || !user) return false;
  const id = accessUserId(user);
  return (audience.roles || []).includes(String(user.role || "")) || (Boolean(id) && (audience.userIds || []).map(String).includes(id));
}

/** The calendar is inside the person's calendar limit (no limit = every calendar; admin is never limited). */
export function withinCalendarScope(user: AccessUser | null | undefined, calendar: string | null | undefined): boolean {
  if (!user || user.role === "admin") return true;
  const scope = user.calendarScope;
  return !scope || scope.length === 0 || scope.includes(calendar || "sm");
}

export interface CanContext {
  calendar?: string | null;
  ownerId?: unknown;
}

/**
 * The resolver. True when the user's system role holds the permission. For a calendar-scoped
 * permission checked with a calendar, the user must also be in that calendar's routing list
 * (reviewers / planApprovers / posters) and inside their calendar limit. Admin is locked: every
 * permission on every calendar. Nobody passes a self-forbidden permission on their own work.
 */
export function can(user: AccessUser | null | undefined, permission: string, ctx: CanContext = {}, config?: WorkflowConfigShape | null): boolean {
  const role = systemRoleOf(user);
  if (!role || user?.status === "suspended") return false;
  const owner = ctx.ownerId === undefined || ctx.ownerId === null ? "" : idString(ctx.ownerId);
  if (owner && owner === accessUserId(user) && SELF_FORBIDDEN_PERMISSIONS.includes(permission)) return false;
  if (role.locked) return true;
  if (!role.permissions.includes(permission)) return false;
  const def = permissionDef(permission);
  if (def?.routedBy && ctx.calendar !== undefined) {
    const cal = ctx.calendar || "sm";
    if (!withinCalendarScope(user, cal)) return false;
    const cfg = config && config.calendar === cal ? config : defaultWorkflowConfig(cal);
    if (audienceIncludes(cfg[def.routedBy], user)) return true;
    // The fallback decides while nobody in the main list is active and eligible (the API resolver
    // works that out and sets primaryInactive; a pure call without it never uses the fallback).
    const slot = def.routedBy;
    if ((slot === "reviewers" || slot === "planApprovers") && cfg.primaryInactive?.[slot]) {
      return audienceIncludes(cfg.fallbackApprovers, user);
    }
    return false;
  }
  return true;
}

/** The calendars this user reviews on (queues). Admin: all. */
export function decisionCalendars(user: AccessUser | null | undefined, configs?: Partial<Record<string, WorkflowConfigShape>>): string[] {
  if (!systemRoleOf(user) || user?.status === "suspended") return [];
  return CALENDAR_KEYS.filter((cal) => can(user, "review.decide", { calendar: cal }, configs?.[cal] || null));
}

export const dataScopeOf = (user: AccessUser | null | undefined): DataScope | null => systemRoleOf(user)?.dataScope ?? null;
export const isReadOnlyRole = (user: AccessUser | null | undefined): boolean => Boolean(systemRoleOf(user)?.readOnly);
export const takesSteps = (user: AccessUser | null | undefined): boolean => Boolean(systemRoleOf(user)?.takesSteps);
/** Fixed rule: "own"-scope roles never see others' contact details. */
export const seesContactDetails = (user: AccessUser | null | undefined): boolean =>
  dataScopeOf(user) === "all" && systemRoleOf(user)?.contactDetails !== false;

/**
 * Can this person own this step? Post: a poster for the step's calendar. Other steps: an own-scope
 * role that takes steps, by job role (JOB_ROLE_STEP_ELIGIBILITY). Preferences narrow it elsewhere.
 */
export function stepEligibility(
  user: AccessUser | null | undefined,
  step: { stageKey?: string | null; calendar?: string | null },
  config?: WorkflowConfigShape | null
): boolean {
  const role = systemRoleOf(user);
  if (!role || !role.takesSteps || user?.status === "suspended") return false;
  const stage = String(step?.stageKey || "");
  const cal = step?.calendar || "sm";
  if (stage === "Post") {
    const cfg = config && config.calendar === cal ? config : defaultWorkflowConfig(cal);
    return audienceIncludes(cfg.posters, user) && withinCalendarScope(user, cal);
  }
  if (role.dataScope !== "own") return false;
  return ((JOB_ROLE_STEP_ELIGIBILITY as Record<string, string[]>)[String(user?.jobRole || "")] || []).includes(stage);
}

// ==========================================
// Access Phase D: admin page helpers (pure).
// ==========================================

/** The permission a person or role needs to be named in each calendar slot. */
export const WORKFLOW_SLOT_PERMISSION: Record<WorkflowSlot, string> = {
  reviewers: "review.decide",
  planApprovers: "calendar.approve",
  posters: "publish.post",
  fallbackApprovers: "review.decide",
};
/**
 * Can this person's role fill a calendar slot? Reviewers, plan approvers and fallback: the role
 * holds the slot's permission. Posters: the role also takes steps, because a poster owns Post
 * steps (the locked admin can mark posted but never owns steps, so it does not count as a poster).
 * Status and calendar limit are checked separately.
 */
export function slotEligibleRole(role: string | null | undefined, slot: WorkflowSlot): boolean {
  const def = systemRoleOf({ role: role || "" });
  if (!def) return false;
  if (slot === "posters") return def.takesSteps && def.permissions.includes("publish.post");
  return can({ role: role || "", status: "active" }, WORKFLOW_SLOT_PERMISSION[slot]);
}

export const WORKFLOW_SLOT_LABELS: Record<WorkflowSlot, string> = {
  planApprovers: "Plans approved by",
  reviewers: "Work reviewed by",
  posters: "Posted by",
  fallbackApprovers: "Fallback",
};

/** True when this role's permissions include any calendar-routed one (so a calendar limit means something). */
export function roleHasCalendarScopedPermissions(role: string | null | undefined): boolean {
  const def = systemRoleOf({ role: role || "" });
  if (!def || def.locked) return false;
  return def.permissions.some((p) => Boolean(permissionDef(p)?.routedBy));
}

const calendarName = (key: string) => (CALENDARS as Record<string, CalendarDefinition>)[key]?.name || key;
const listCalendars = (keys: string[]) =>
  keys.length === CALENDAR_KEYS.length ? "every calendar" : keys.map(calendarName).join(", ");

/**
 * What a person gains and loses when their role or calendar limit changes, in catalog labels:
 * "Review on Ads Calendar", "Plan". Calendar-routed permissions list the calendars.
 */
export function describeAccessChange(
  before: AccessUser,
  after: AccessUser,
  configs?: Partial<Record<string, WorkflowConfigShape>>
): { gains: string[]; losses: string[] } {
  const gains: string[] = [];
  const losses: string[] = [];
  for (const p of PERMISSION_CATALOG as readonly PermissionDef[]) {
    if (p.routedBy) {
      const cals = (u: AccessUser) => CALENDAR_KEYS.filter((c) => can(u, p.key, { calendar: c }, configs?.[c] || null));
      const was = cals(before);
      const now = cals(after);
      const added = now.filter((c) => !was.includes(c));
      const removed = was.filter((c) => !now.includes(c));
      if (added.length) gains.push(`${p.label} on ${listCalendars(added)}`);
      if (removed.length) losses.push(`${p.label} on ${listCalendars(removed)}`);
    } else {
      const was = can(before, p.key);
      const now = can(after, p.key);
      if (now && !was) gains.push(p.label);
      if (was && !now) losses.push(p.label);
    }
  }
  return { gains, losses };
}

/** Role guide: what each system role can do, grouped by area (catalog labels). */
export function roleGuide(): Array<{ role: UserRole; label: string; locked: boolean; areas: Array<{ area: string; items: string[] }> }> {
  return ROLE_KEYS.map((role) => {
    const def = SYSTEM_ROLES[role];
    const areas = PERMISSION_AREAS.map((area) => ({
      area,
      items: (PERMISSION_CATALOG as readonly PermissionDef[])
        .filter((p) => p.area === area && def.permissions.includes(p.key))
        .map((p) => (p.routedBy ? `${p.label} (on the calendars where named)` : p.label)),
    })).filter((a) => a.items.length);
    return { role, label: ROLE_LABELS[role], locked: def.locked, areas };
  });
}

// ---------------------------------------------------------------------------
// Content Flow Tracker statuses (one row = one content piece). The Tracker's Status filter and
// the dashboard KPI cards use these same rules, so a card's number is the number of rows its
// link opens. The API sets the row flags (hasOverdue, hasBlocked, hasWaitingApproval, hasAtRisk …).
// ---------------------------------------------------------------------------

export const TRACKER_STATUS_OPTIONS = [
  { value: "all", label: "All planned rows" },
  { value: "overdue", label: "Overdue" },
  { value: "at_risk", label: "Due within 3 days" },
  { value: "done_late", label: "Done late" },
  { value: "blocked", label: "Blocked" },
  { value: "on_track", label: "On track" },
  { value: "posted", label: "Posted" },
  { value: "needs_owner", label: "Needs owner" },
  { value: "waiting_approval", label: "Waiting for approval" },
  { value: "not_approved", label: "Not approved yet" },
  { value: "paused", label: "Paused" },
  { value: "pause_requested", label: "Pause requested" },
] as const;
export type TrackerStatusKey = (typeof TRACKER_STATUS_OPTIONS)[number]["value"];
export const isTrackerStatusKey = (v: unknown): v is TrackerStatusKey =>
  TRACKER_STATUS_OPTIONS.some((s) => s.value === v);

/** Days ahead (IST calendar days, today included) that count as "Due within 3 days" / at risk. */
export const AT_RISK_DAYS = 3;

interface TrackerRowStep {
  stageKey?: string | null;
  status?: string | null;
  isSkipped?: boolean | null;
  isLocked?: boolean | null;
  awaitingReview?: boolean | null;
  dueDate?: DateLike;
  deadline?: DateLike;
  pauseState?: string | null;
  timeLabels?: ReadonlyArray<{ kind: string }> | null;
}

export interface TrackerRow {
  publishedAt?: DateLike;
  hasPostStage?: boolean;
  stages: TrackerRowStep[];
  hasOverdue?: boolean;
  hasAtRisk?: boolean;
  hasDoneLate?: boolean;
  hasBlocked?: boolean;
  hasNeedsOwner?: boolean;
  hasWaitingApproval?: boolean;
  hasPaused?: boolean;
  hasPauseRequested?: boolean;
}

const trackerStepDone = (s: TrackerRowStep) => Boolean(s.isSkipped) || isFinishedStepStatus(s.status);

/**
 * At risk: a step being worked on (unlocked, not done, not waiting on a reviewer, not already
 * overdue) whose due date is today or within the next AT_RISK_DAYS - 1 days (IST).
 */
export function stepIsAtRisk(step: TrackerRowStep, now: DateLike = new Date()): boolean {
  if (!step || trackerStepDone(step) || step.isLocked || step.awaitingReview) return false;
  if (step.timeLabels?.some((l) => l.kind === "overdue")) return false;
  const due = step.dueDate || step.deadline;
  if (!due) return false;
  const daysLeft = istDayDiff(due, now);
  return daysLeft !== null && daysLeft >= 0 && daysLeft < AT_RISK_DAYS;
}

/** A row whose plan row was not approved yet: it has no steps. */
export const trackerRowNotApproved = (p: TrackerRow) => !p.stages || p.stages.length === 0;

/** Posted: a publish date or a published Post step, or a design with no Post step whose steps are all done. */
export function trackerRowPosted(p: TrackerRow): boolean {
  if (p.publishedAt) return true;
  if (p.stages.some((s) => s.stageKey === "Post" && s.status === "Published")) return true;
  const hasPost = p.stages.some((s) => s.stageKey === "Post");
  return !hasPost && p.hasPostStage === false && p.stages.length > 0 && p.stages.every(trackerStepDone);
}

/**
 * Whether a row belongs under a Tracker status. With no status (or "all") every row matches;
 * the Tracker's plain view still hides rows that are not approved yet (see trackerRowShown).
 */
export function trackerRowMatchesStatus(p: TrackerRow, status: string): boolean {
  switch (status) {
    case "overdue":
      return Boolean(p.hasOverdue);
    case "at_risk":
      return Boolean(p.hasAtRisk);
    case "done_late":
      return Boolean(p.hasDoneLate);
    case "blocked":
      return Boolean(p.hasBlocked);
    case "posted":
      return trackerRowPosted(p);
    case "on_track":
      return !trackerRowNotApproved(p) && !trackerRowPosted(p) && !p.hasOverdue && !p.hasBlocked;
    case "needs_owner":
      return Boolean(p.hasNeedsOwner);
    case "waiting_approval":
      return Boolean(p.hasWaitingApproval);
    case "not_approved":
      return trackerRowNotApproved(p);
    case "paused":
      return Boolean(p.hasPaused) || p.stages.some((s) => s.pauseState === "paused");
    case "pause_requested":
      return Boolean(p.hasPauseRequested) || p.stages.some((s) => s.pauseState === "requested");
    default:
      return true;
  }
}

/** Rows the Tracker lists for a status: rows not approved yet show only under "all" and "not_approved". */
export function trackerRowShown(p: TrackerRow, status: string): boolean {
  if (status !== "all" && status !== "not_approved" && trackerRowNotApproved(p)) return false;
  return trackerRowMatchesStatus(p, status);
}

/** The dashboard KPI cards: each card's Tracker status. */
export const DASHBOARD_KPI_STATUSES = {
  planned: "all",
  completed: "posted",
  inProgress: "on_track",
  atRisk: "at_risk",
  blocked: "blocked",
  pendingApproval: "waiting_approval",
  overdue: "overdue",
} as const satisfies Record<string, TrackerStatusKey>;
export type DashboardKpiKey = keyof typeof DASHBOARD_KPI_STATUSES;

/** Count rows per dashboard KPI card with the Tracker's own rules. */
export function dashboardKpiCounts(rows: TrackerRow[]): Record<DashboardKpiKey, number> {
  const out = {} as Record<DashboardKpiKey, number>;
  for (const [key, status] of Object.entries(DASHBOARD_KPI_STATUSES) as Array<[DashboardKpiKey, string]>) {
    out[key] = rows.filter((r) => trackerRowShown(r, status)).length;
  }
  return out;
}
