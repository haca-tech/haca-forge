import { CALENDARS, CALENDAR_KEYS, ROLE_KEYS, can as canPure } from '@mmp/shared';
import { Person } from '../people/model.js';
import { WorkItem } from '../workItems/model.js';
import { PauseRequest } from '../workItems/pauseRequest.model.js';
import { ContentPiece } from '../calendar/contentPiece.model.js';
import { countAwaitingReview } from '../workItems/reviewState.js';
import { calendarQueryFor } from '../workItems/deciders.js';
import { createNotification } from '../notifications/service.js';
import { sendAccessChanged } from './personAccess.service.js';
import * as access from '../../lib/accessResolver.js';

/**
 * Who decides, approves and posts where, before and after an access change (a person's role,
 * status or limit, or a calendar's settings). After the change:
 * - every user whose decide / approve / post calendars changed gets `access:changed` (their tabs
 *   reload /auth/me), including fallback people who start or stop acting and admins;
 * - every person newly responsible for a calendar's reviews or plan approvals (in the people the
 *   resolver notifies: the main list, else the fallback, else the admins) is told once about the
 *   work already waiting there.
 */
const ROUTED = { review: 'review.decide', approve: 'calendar.approve', post: 'publish.post' };
const calName = (c) => CALENDARS[c]?.name || c;
const idOf = (v) => String(v?._id || v || '');

const routedRoles = () => ROLE_KEYS.filter((role) => Object.values(ROUTED).some((p) => canPure({ role, status: 'active' }, p)));

/** A snapshot: each person's calendars per routed permission, and who is responsible per calendar. */
export async function snapshotAccess(extraIds = []) {
  const people = await Person.find({ $or: [{ status: 'active', role: { $in: routedRoles() } }, { _id: { $in: extraIds.filter(Boolean) } }] })
    .select('name role status calendarScope')
    .lean();
  const calendars = {};
  for (const p of people) {
    const entry = {};
    for (const [key, perm] of Object.entries(ROUTED)) {
      entry[key] = [];
      for (const calendar of CALENDAR_KEYS) if (await access.can(p, perm, { calendar })) entry[key].push(calendar);
    }
    calendars[idOf(p)] = entry;
  }
  const responsible = { review: {}, approve: {} };
  for (const calendar of CALENDAR_KEYS) {
    responsible.review[calendar] = (await access.reviewersFor({ calendar })).people.map(idOf);
    responsible.approve[calendar] = (await access.planApproversFor({ calendar })).people.map(idOf);
  }
  return { calendars, responsible };
}

/** What is waiting on a calendar for its reviewers / plan approvers. */
async function waitingOn(calendar) {
  const inCal = calendarQueryFor([calendar]);
  const stepIds = (await WorkItem.find(inCal).select('_id').lean()).map((s) => s._id);
  return {
    reviews: await countAwaitingReview(inCal),
    pauses: await PauseRequest.countDocuments({ status: 'pending', workItemId: { $in: stepIds } }),
    rows: await ContentPiece.countDocuments({ ...inCal, rowStatus: 'submitted' }),
  };
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Compares two snapshots: sends access:changed to everyone whose calendars or responsibility
 * changed, and notifies each newly responsible person once about the work already waiting.
 * Returns { changed: [ids], notified: [ids] }.
 */
export async function applyAccessDiff(before, after, { alreadyTold = [] } = {}) {
  const ids = new Set([...Object.keys(before.calendars), ...Object.keys(after.calendars)]);
  const changed = new Set();
  for (const id of ids) {
    if (JSON.stringify(before.calendars[id] || null) !== JSON.stringify(after.calendars[id] || null)) changed.add(id);
  }
  // Newly responsible, per person: the calendars where they now get reviews / plan approvals.
  const gained = new Map();
  for (const kind of ['review', 'approve']) {
    for (const calendar of CALENDAR_KEYS) {
      const was = new Set(before.responsible[kind][calendar] || []);
      const now = new Set(after.responsible[kind][calendar] || []);
      for (const id of now) {
        if (was.has(id)) continue;
        changed.add(id);
        if (!gained.has(id)) gained.set(id, {});
        (gained.get(id)[calendar] ||= new Set()).add(kind);
      }
      for (const id of was) if (!now.has(id)) changed.add(id);
    }
  }
  // People already told by the change itself (the changed person: access:changed, then their
  // sockets reset) are not sent a second event.
  for (const id of alreadyTold) changed.delete(String(id));
  sendAccessChanged([...changed]);

  const notified = [];
  const waitCache = new Map();
  for (const [id, byCalendar] of gained) {
    const lines = [];
    const meta = {};
    for (const [calendar, kinds] of Object.entries(byCalendar)) {
      if (!waitCache.has(calendar)) waitCache.set(calendar, await waitingOn(calendar));
      const w = waitCache.get(calendar);
      const parts = [];
      if (kinds.has('review') && w.reviews) parts.push(plural(w.reviews, 'waiting review'));
      if (kinds.has('review') && w.pauses) parts.push(plural(w.pauses, 'pause request'));
      if (kinds.has('approve') && w.rows) parts.push(plural(w.rows, 'plan row'));
      if (!parts.length) continue;
      lines.push({ calendar, parts });
      meta[calendar] = { reviews: kinds.has('review') ? w.reviews : 0, pauses: kinds.has('review') ? w.pauses : 0, rows: kinds.has('approve') ? w.rows : 0 };
    }
    if (!lines.length) continue;
    const single = lines.length === 1;
    await createNotification({
      recipient: id,
      type: 'access_rerouted',
      title: single ? `${calName(lines[0].calendar)}: decisions now come to you` : 'Decisions now come to you',
      message: single
        ? `You now decide on ${calName(lines[0].calendar)}: ${lines[0].parts.join(', ')} moved to you.`
        : `You now decide on ${lines.map((l) => `${calName(l.calendar)} (${l.parts.join(', ')})`).join('; ')}.`,
      link: '/feedback',
      metadata: single ? { calendar: lines[0].calendar, ...meta[lines[0].calendar] } : { calendars: meta },
    });
    notified.push(id);
  }
  return { changed: [...changed], notified };
}
