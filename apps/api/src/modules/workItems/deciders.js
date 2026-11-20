import { CALENDAR_KEYS, can as canPure } from '@mmp/shared';
import { Person } from '../people/model.js';
import * as access from '../../lib/accessResolver.js';

/**
 * Decisions routed by calendar (Phase C: through the access resolver). The work's current
 * calendar decides who may approve, review, rate, reopen, request changes and classify:
 * that calendar's reviewers in WorkflowConfig (default: the Growth Lead for Ads, the Creative
 * Lead for every other calendar), admin for all (locked). Plans: the calendar's plan approvers.
 * Nobody decides on their own work. A plan move updates the calendar, so pending items follow it.
 */

/** The calendar a step, row or plan belongs to now (missing = SM). */
export const calendarOf = (item) => (item && item.calendar) || 'sm';

function forbidden(code, message) {
  const error = new Error(message);
  error.statusCode = 403;
  error.code = code;
  return error;
}

/** True when the role holds the review permission on some calendar (both leads and admin by default). */
export const isDecider = (role) => canPure({ role, status: 'active' }, 'review.decide');

const ROUTING_NAME = { 'review.decide': 'reviewers', 'calendar.approve': 'plan approvers', 'revision.classify': 'reviewers' };

/**
 * Throws 403 unless this user may decide on work in this calendar:
 * - without the permission at all: `roleCode` (the caller's existing code, e.g. FORBIDDEN_APPROVAL);
 * - not routed to this calendar: WRONG_CALENDAR;
 * - on their own work (when ownerId is given and the permission forbids it): SELF_DECISION.
 */
export async function assertDecidesOn(
  user,
  calendar,
  {
    roleCode = 'FORBIDDEN_APPROVAL',
    roleMessage = 'Only a Creative Lead, a Growth Lead or an Admin can decide this.',
    permission = 'review.decide',
    ownerId,
  } = {}
) {
  if (!canPure(user, permission)) throw forbidden(roleCode, roleMessage);
  if (ownerId !== undefined && !canPure(user, permission, { ownerId })) {
    throw forbidden('SELF_DECISION', 'You cannot decide on your own work.');
  }
  if (!(await access.can(user, permission, { calendar }))) {
    throw forbidden('WRONG_CALENDAR', `You are not one of the ${ROUTING_NAME[permission] || 'deciders'} for this calendar (${calendar || 'sm'}).`);
  }
}

/** May this user decide (review.decide by default) on work in this calendar, not their own? */
export async function canDecideOn(user, calendar, { ownerId, permission = 'review.decide' } = {}) {
  return access.can(user, permission, { calendar, ownerId });
}

/** The active people who decide on this calendar (its reviewers), plus admin when asked. */
export async function decidersFor(calendar, { includeAdmin = false, plans = false } = {}) {
  const { primary } = plans ? await access.planApproversFor({ calendar }) : await access.reviewersFor({ calendar });
  if (!includeAdmin) return primary;
  const admins = await Person.find({ role: 'admin', status: 'active' });
  const seen = new Set(primary.map((p) => String(p._id)));
  return [...primary, ...admins.filter((a) => !seen.has(String(a._id)))];
}

/** For lists: the calendars this user decides on, or null when they see every calendar. */
export async function decisionCalendarFilter(user) {
  if (!canPure(user, 'review.decide')) return null; // non-deciders see every calendar
  const calendars = await access.decisionCalendars(user);
  return calendars.length === CALENDAR_KEYS.length ? null : calendars; // admin (all calendars) sees all
}

/** The calendars a role decides on, by role key only (people lists, KPIs). Admin: all. */
export async function decisionCalendarsForRole(role) {
  return access.decisionCalendars({ role, status: 'active' });
}

/** A Mongo filter on `calendar` for the given calendars (missing = SM). */
export function calendarQueryFor(calendars) {
  if (!calendars) return {};
  return calendars.includes('sm')
    ? { $or: [{ calendar: { $in: calendars } }, { calendar: null }, { calendar: { $exists: false } }] }
    : { calendar: { $in: calendars } };
}
