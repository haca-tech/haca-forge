import mongoose from 'mongoose';
import { CALENDAR_KEYS, ROLE_KEYS, normalizeRole } from '@mmp/shared';
import { Person } from '../people/model.js';
import { AccessChange } from './accessChange.model.js';
import { getSocketServer, disconnectUserSockets } from '../../lib/socketHub.js';

/**
 * The ONE way to change a person's role, status or calendar limit (Phase C4). It validates,
 * saves through the model (so the last-active-admin guard runs), records each field in the
 * AccessChange history, tells the person's open tabs (`access:changed`, so menus refresh
 * without signing out) and then closes their sockets (the reconnect handshake re-checks them).
 * No other code writes these fields; a guard test enforces it.
 */

const STATUSES = ['invited', 'active', 'suspended'];
/** How long the person's sockets stay open after `access:changed`, so the event is delivered first. */
export const DISCONNECT_DELAY_MS = 400;

function badRequest(message, field) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VALIDATION_ERROR';
  error.details = { field };
  return error;
}

const normScope = (v) => {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) throw badRequest('calendarScope must be a list of calendars.', 'calendarScope');
  const list = [...new Set(v.map(String))];
  const bad = list.filter((c) => !CALENDAR_KEYS.includes(c));
  if (bad.length) throw badRequest(`Unknown calendar: ${bad.join(', ')}`, 'calendarScope');
  return list.length ? list.sort() : null;
};
const scopeOf = (p) => (Array.isArray(p.calendarScope) && p.calendarScope.length ? [...p.calendarScope].sort() : null);
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Tell these users' open tabs that their access changed (they reload /auth/me). */
export function sendAccessChanged(userIds, { disconnect = false } = {}) {
  const io = getSocketServer();
  const ids = [...new Set((userIds || []).map(String).filter(Boolean))];
  for (const id of ids) {
    io?.to(`user:${id}`).emit('access:changed', { at: new Date().toISOString() });
    if (disconnect) setTimeout(() => disconnectUserSockets(id), DISCONNECT_DELAY_MS).unref?.();
  }
  return ids;
}

/**
 * Changes role / status / calendarScope (only the keys given). Returns the saved person.
 * `changes.calendarScope`: a list of calendar keys, or null/[] for no limit (every calendar).
 */
export async function changePersonAccess(personOrId, changes = {}, actor = null, { note = '', session } = {}) {
  const person = personOrId instanceof mongoose.Model ? personOrId : await Person.findById(personOrId);
  if (!person) {
    const error = new Error('Person not found');
    error.statusCode = 404;
    error.code = 'NOT_FOUND';
    throw error;
  }
  const before = { role: person.role, status: person.status, calendarScope: scopeOf(person) };
  const after = { ...before };
  if ('role' in changes && changes.role !== undefined) {
    const role = normalizeRole(changes.role);
    if (!ROLE_KEYS.includes(role)) throw badRequest(`Unknown role: ${changes.role}`, 'role');
    after.role = role;
  }
  if ('status' in changes && changes.status !== undefined) {
    if (!STATUSES.includes(changes.status)) throw badRequest(`Unknown status: ${changes.status}`, 'status');
    after.status = changes.status;
  }
  if ('calendarScope' in changes) after.calendarScope = normScope(changes.calendarScope);

  const changed = ['role', 'status', 'calendarScope'].filter((k) => !same(before[k], after[k]));
  if (!changed.length) return person;

  person.role = after.role;
  person.status = after.status;
  person.calendarScope = after.calendarScope || undefined;
  await person.save({ session }); // the last-active-admin guard runs here

  const actorId = actor?._id || actor?.id || actor?.userId || null;
  await AccessChange.insertMany(
    changed.map((field) => ({ actorId, entityType: 'person', entityId: String(person._id), field, before: before[field], after: after[field], note })),
    { session }
  );
  sendAccessChanged([person._id], { disconnect: true });
  return person;
}
