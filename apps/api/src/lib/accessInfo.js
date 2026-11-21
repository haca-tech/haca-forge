import { CALENDAR_KEYS, systemRoleOf } from '@mmp/shared';
import * as access from './accessResolver.js';

/** Calendar-routed permissions whose calendars the web needs (review, plan approval, posting). */
const ROUTED = ['review.decide', 'calendar.approve', 'revision.classify', 'publish.post'];

/**
 * The access block sent with /auth/me and login (Phase C): the user's catalog-v2 permissions,
 * for each routed permission the calendars where it applies (from WorkflowConfig and the
 * person's calendar limit), the role attributes, and the calendar limit. The web decides with
 * this; the API keeps every check of its own.
 */
export async function buildAccessInfo(user) {
  const role = systemRoleOf(user);
  if (!role || user?.status === 'suspended') {
    return { permissions: [], calendars: {}, dataScope: 'own', readOnly: true, takesSteps: false, superuser: false, calendarScope: null };
  }
  const calendars = {};
  for (const perm of ROUTED) {
    const allowed = [];
    for (const calendar of CALENDAR_KEYS) if (await access.can(user, perm, { calendar })) allowed.push(calendar);
    calendars[perm] = allowed;
  }
  return {
    permissions: [...role.permissions],
    calendars,
    dataScope: role.dataScope,
    readOnly: role.readOnly,
    takesSteps: role.takesSteps,
    superuser: role.locked,
    calendarScope: Array.isArray(user.calendarScope) && user.calendarScope.length ? [...user.calendarScope] : null,
  };
}
