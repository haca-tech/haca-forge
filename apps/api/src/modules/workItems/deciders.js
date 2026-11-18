import { canDecide, deciderRoleFor, decisionCalendarsFor, isApprover, normalizeRole } from '@mmp/shared';
import { Person } from '../people/model.js';

/**
 * Phase 13: approvals routed by calendar. The work's current calendar decides who may
 * approve, review, rate, reopen, request changes and classify: the Growth Lead for Ads,
 * the Creative Lead for every other calendar, admin for all as a backup. Nobody decides
 * on their own work. A step, a plan row and standalone work all carry their calendar
 * (default SM), and a plan move updates it, so pending items follow the move.
 */

/** The calendar a step, row or plan belongs to now (missing = SM). */
export const calendarOf = (item) => (item && item.calendar) || 'sm';

function forbidden(code, message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = code;
  return error;
}

/** True when the role decides on some calendar (both leads and admin). */
export const isDecider = (role) => normalizeRole(role) === 'admin' || isApprover(role);

/**
 * Throws 403 unless this user may decide on work in this calendar:
 * - not a lead or admin: `roleCode` (the caller's existing code, e.g. FORBIDDEN_APPROVAL);
 * - the other lead's calendar: WRONG_CALENDAR.
 * Self-review is checked by the caller, which knows the owner.
 */
export function assertDecidesOn(user, calendar, { roleCode = 'FORBIDDEN_APPROVAL', roleMessage = 'Only a Creative Lead, a Growth Lead or an Admin can decide this.' } = {}) {
  const role = normalizeRole(user?.role);
  if (!isDecider(role)) throw forbidden(roleCode, roleMessage);
  if (!canDecide(role, calendar)) {
    const lead = deciderRoleFor(calendar) === 'growth_lead' ? 'the Growth Lead' : 'the Creative Lead';
    throw forbidden('WRONG_CALENDAR', `This is ${calendar === 'ads' ? 'Ads' : 'non-Ads'} work: ${lead} (or an Admin) decides it.`);
  }
}

/** The active people who decide on this calendar: its lead, plus admin when asked. */
export async function decidersFor(calendar, { includeAdmin = false } = {}) {
  const roles = [deciderRoleFor(calendar)];
  if (includeAdmin) roles.push('admin');
  return Person.find({ role: { $in: roles }, status: 'active' });
}

/** For lists: the calendars this user decides on, or null when they see every calendar. */
export function decisionCalendarFilter(user) {
  const role = normalizeRole(user?.role);
  if (!isApprover(role)) return null;
  return decisionCalendarsFor(role);
}

/** A Mongo filter on `calendar` for the calendars this lead decides on (missing = SM). */
export function calendarQueryFor(calendars) {
  if (!calendars) return {};
  return calendars.includes('sm')
    ? { $or: [{ calendar: { $in: calendars } }, { calendar: null }, { calendar: { $exists: false } }] }
    : { calendar: { $in: calendars } };
}
