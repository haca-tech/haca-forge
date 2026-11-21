import { CALENDAR_KEYS, SELF_FORBIDDEN_PERMISSIONS, can as canPure, permissionDef, systemRoleOf, type AccessUser } from '@mmp/shared';

/**
 * What the signed-in user may do, from /auth/me (Phase C3): their catalog-v2 permissions, and
 * for each calendar-routed permission (review, plan approval, posting) the calendars where it
 * applies. Screens ask `can(permission, { calendar, ownerId })` and the role attributes below,
 * never role names. When /auth/me sent no access block (older responses, unit tests), it is
 * computed from the role with the shared resolver and today's default workflow config.
 */
export interface AccessInfo {
  permissions: string[];
  /** Calendars where each calendar-routed permission applies (review.decide, calendar.approve, ...). */
  calendars: Record<string, string[]>;
  dataScope: 'all' | 'own';
  readOnly: boolean;
  takesSteps: boolean;
  /** The locked admin role. */
  superuser: boolean;
  /** Optional per-person calendar limit (decisions and queues). */
  calendarScope?: string[] | null;
}

const ROUTED = ['review.decide', 'calendar.approve', 'revision.classify', 'publish.post'];

/** Access computed from a user's role with the default workflow config. */
export function accessFromUser(user: AccessUser | null | undefined): AccessInfo | null {
  const role = systemRoleOf(user);
  if (!user || !role) return null;
  const calendars: Record<string, string[]> = {};
  for (const perm of ROUTED) calendars[perm] = CALENDAR_KEYS.filter((calendar) => canPure(user, perm, { calendar }));
  return {
    permissions: [...role.permissions],
    calendars,
    dataScope: role.dataScope,
    readOnly: role.readOnly,
    takesSteps: role.takesSteps,
    superuser: role.locked,
    calendarScope: user.calendarScope ?? null,
  };
}

export interface Access {
  info: AccessInfo | null;
  /** Holds the permission; with a calendar, also routed to that calendar; never on your own work for review.decide. */
  can: (permission: string, ctx?: { calendar?: string | null; ownerId?: unknown }) => boolean;
  seesAll: boolean;
  isOwnScope: boolean;
  isReadOnly: boolean;
  takesSteps: boolean;
  isSuperuser: boolean;
  /** Where this user lands after signing in. */
  homePath: string;
}

const idString = (v: unknown) => String((v as any)?._id || v || '');

export function makeAccess(info: AccessInfo | null, user: AccessUser | null | undefined): Access {
  const me = idString((user as any)?._id || (user as any)?.id || (user as any)?.userId);
  const can: Access['can'] = (permission, ctx = {}) => {
    if (!info || !info.permissions.includes(permission)) return false;
    if (SELF_FORBIDDEN_PERMISSIONS.includes(permission) && ctx.ownerId && me && idString(ctx.ownerId) === me) return false;
    if (ctx.calendar !== undefined && permissionDef(permission)?.routedBy) {
      return (info.calendars[permission] || []).includes(ctx.calendar || 'sm');
    }
    return true;
  };
  const isOwnScope = info?.dataScope === 'own';
  return {
    info,
    can,
    seesAll: info?.dataScope === 'all',
    isOwnScope,
    isReadOnly: Boolean(info?.readOnly),
    takesSteps: Boolean(info?.takesSteps),
    isSuperuser: Boolean(info?.superuser),
    homePath: isOwnScope ? '/my-work' : '/dashboard',
  };
}

/** About another person's role (a profile, a comment author): role attributes and non-routed permissions. */
export const roleAccess = (role: string | null | undefined) => makeAccess(accessFromUser({ role: role || '', status: 'active' }), null);

/** Where a user with this role lands after signing in. */
export const homePathFor = (user: AccessUser | null | undefined) => makeAccess(accessFromUser(user), user).homePath;
