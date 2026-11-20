import { ROLE_KEYS, STAGE_KEYS, can, dataScopeOf, isReadOnlyRole, seesContactDetails, stepEligibility, systemRoleOf, takesSteps } from '@mmp/shared';

/**
 * Synchronous access questions for services (Phase C), all answered by the shared resolver and
 * the system role definitions, never by comparing role names. Calendar-routed decisions
 * (review, plan approval, posting on a calendar) use the async resolver in lib/accessResolver.js.
 * Accepts a user/person object or a bare role key.
 */
const asUser = (u) => (typeof u === 'string' ? { role: u, status: 'active' } : u);

/** The role holds this permission (any calendar). Admin holds every one. */
export const hasPermission = (user, permission) => can(asUser(user), permission);
/** Sees only work they take part in (workers): the fixed privacy rules apply. */
export const isOwnScope = (user) => dataScopeOf(asUser(user)) === 'own';
/** Sees everyone and every step (leadership roles). */
export const seesAll = (user) => dataScopeOf(asUser(user)) === 'all';
/** Read-only role: every write refused except on their own account. */
export const isReadOnly = (user) => isReadOnlyRole(asUser(user));
/** Can own steps (workload, autofill, assignment candidates). */
export const canTakeSteps = (user) => takesSteps(asUser(user));
/** Others' email and phone (fixed rule: hidden from own-scope roles). */
export const canSeeContacts = (user) => seesContactDetails(asUser(user));
/** The role keys whose role holds a permission (for people queries). */
export const rolesWith = (permission) => ROLE_KEYS.filter((role) => can({ role, status: 'active' }, permission));
/** The role keys that can own steps. */
export const stepTakingRoles = () => ROLE_KEYS.filter((role) => takesSteps({ role }));
/** The role keys with own-scope (worker) privacy. */
export const ownScopeRoles = () => ROLE_KEYS.filter((role) => dataScopeOf({ role }) === 'own');
/** The locked system role (admin): every permission, never limited, may act on anyone's work. */
export const isSuperuser = (user) => Boolean(systemRoleOf(asUser(user))?.locked);
/** Roles never in assignment pools, workload or performance metrics: the locked admin and read-only roles. */
export const rolesOutsidePools = () => ROLE_KEYS.filter((role) => isSuperuser(role) || isReadOnly(role));
/** Leadership accounts a lead may not edit: holders of people.manage_operational (admin, leads) and read-only roles. */
export const isProtectedAccount = (user) => hasPermission(user, 'people.manage_operational') || isReadOnly(user);
/** A lead-level manager of operational fields (not the locked admin). */
export const isOperationalManager = (user) => hasPermission(user, 'people.manage_operational') && !isSuperuser(user);
/** Roles that can be named as a step owner in plans: those that take steps, plus the locked admin. */
export const ownerCandidateRoles = () => ROLE_KEYS.filter((role) => takesSteps({ role }) || isSuperuser(role));
/** Planners other than the locked admin (today: the SM Manager), for plan notices. */
export const plannerRoles = () => ROLE_KEYS.filter((role) => hasPermission(role, 'calendar.plan') && !isSuperuser(role));
/** Acts on deliverables (reviews or posts): admin, the leads and the SM Manager by default. */
export const handlesDeliverables = (user) => hasPermission(user, 'review.decide') || hasPermission(user, 'publish.post');
/** The steps a person can own on the default workflow (Post: posters; other steps: job role). */
export const eligibleSteps = (person) => STAGE_KEYS.filter((stageKey) => stepEligibility(person, { stageKey }));
