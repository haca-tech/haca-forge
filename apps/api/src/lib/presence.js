/**
 * Live presence: who has the portal open right now, kept in memory from the Socket.IO
 * connections (one entry per open tab). Admins (user.manage) watch it on the Live Status page.
 *
 * - online: at least one tab connected; "active" when one of them is visible, "away" when
 *   every tab is in the background.
 * - lastSeenAt: saved on the person when their last tab closes, so offline people show
 *   "last seen 2h ago".
 *
 * Memory only: the API runs as one instance. After a restart, tabs reconnect within seconds.
 */
import { Person } from '../modules/people/model.js';
import { logger } from './logger.js';

export const PRESENCE_ROOM = 'presence:watchers';

/** userId -> Map(socketId -> { connectedAt, state, page, lastActiveAt }) */
const tabs = new Map();
let io = null;

export function setPresenceServer(server) {
  io = server;
}

/** A page path without ids or query, e.g. "/calendar" or "/team". */
export function cleanPage(page) {
  if (typeof page !== 'string' || !page.startsWith('/')) return null;
  const first = page.split(/[?#]/)[0].split('/').filter(Boolean)[0];
  return first ? `/${first.slice(0, 40).replace(/[^a-z0-9-]/gi, '')}` : '/';
}

function summary(userId) {
  const list = [...(tabs.get(userId)?.values() || [])];
  if (!list.length) return { userId, online: false, state: 'offline', tabs: 0 };
  const active = list.filter((t) => t.state === 'active');
  const latest = (active.length ? active : list).reduce((a, b) => (b.lastActiveAt > a.lastActiveAt ? b : a));
  return {
    userId,
    online: true,
    state: active.length ? 'active' : 'away',
    tabs: list.length,
    page: latest.page,
    since: new Date(Math.min(...list.map((t) => t.connectedAt))).toISOString(),
    lastActiveAt: new Date(Math.max(...list.map((t) => t.lastActiveAt))).toISOString(),
  };
}

function broadcast(userId, extra = {}) {
  io?.to(PRESENCE_ROOM).emit('presence:changed', { ...summary(userId), ...extra });
}

export function presenceConnected(socket) {
  const userId = socket.user?.userId;
  if (!userId) return;
  const now = Date.now();
  if (!tabs.has(userId)) tabs.set(userId, new Map());
  tabs.get(userId).set(socket.id, { connectedAt: now, lastActiveAt: now, state: 'active', page: null });
  broadcast(userId);
}

/** From the browser: { state: 'active' | 'away', page: location.pathname }. */
export function presenceUpdated(socket, data) {
  const tab = tabs.get(socket.user?.userId)?.get(socket.id);
  if (!tab) return;
  const state = data?.state === 'away' ? 'away' : 'active';
  const page = cleanPage(data?.page) ?? tab.page;
  if (state === tab.state && page === tab.page) return;
  tab.state = state;
  tab.page = page;
  if (state === 'active') tab.lastActiveAt = Date.now();
  broadcast(socket.user.userId);
}

export function presenceDisconnected(socket) {
  const userId = socket.user?.userId;
  const userTabs = tabs.get(userId);
  if (!userTabs?.delete(socket.id)) return;
  if (userTabs.size) return broadcast(userId);
  tabs.delete(userId);
  const lastSeenAt = new Date();
  broadcast(userId, { lastSeenAt: lastSeenAt.toISOString() });
  Person.updateOne({ _id: userId }, { $set: { lastSeenAt } }).catch((err) =>
    logger.warn({ err: err.message }, 'presence: could not save lastSeenAt'),
  );
}

/** Everyone with an account (not suspended), with their live state, online people first. */
export async function presenceList() {
  const people = await Person.find({ status: { $ne: 'suspended' } })
    .select('name preferredName role jobRole avatarUrl status lastSeenAt lastLoginAt departmentId')
    .populate('departmentId', 'name')
    .lean();
  const order = { active: 0, away: 1, offline: 2 };
  return people
    .map((p) => {
      const live = summary(String(p._id));
      return {
        _id: String(p._id),
        name: p.preferredName || p.name,
        role: p.role,
        jobRole: p.jobRole || null,
        department: p.departmentId?.name || null,
        avatarUrl: p.avatarUrl || null,
        lastSeenAt: live.online ? null : p.lastSeenAt || null,
        lastLoginAt: p.lastLoginAt || null,
        ...live,
        userId: undefined,
      };
    })
    .sort((a, b) => order[a.state] - order[b.state] || String(a.name).localeCompare(String(b.name)));
}

/** Tests only. */
export function resetPresence() {
  tabs.clear();
}
