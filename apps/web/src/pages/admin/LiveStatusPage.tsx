import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Search, RefreshCw, History } from 'lucide-react';
import { ROLE_LABELS } from '@mmp/shared';
import { apiFetch } from '../../lib/api';
import { useSocket } from '../../hooks/useSocket';
import { Avatar } from '../../components/Avatar';
import { DataLoader } from '../../components/DataLoader';
import { ActivityFeed } from './ActivityFeed';

export type PresenceState = 'active' | 'away' | 'offline';

export interface PresencePerson {
  _id: string;
  name: string;
  role: string;
  jobRole?: string | null;
  department?: string | null;
  avatarUrl?: string | null;
  online: boolean;
  state: PresenceState;
  tabs: number;
  page?: string | null;
  since?: string;
  lastActiveAt?: string;
  lastSeenAt?: string | null;
  lastLoginAt?: string | null;
}

const PAGE_LABELS: Record<string, string> = {
  '/': 'Home',
  '/dashboard': 'Dashboard',
  '/calendar': 'Creative Calendar',
  '/my-work': 'My Work',
  '/work': 'Work',
  '/feedback': 'Review Hub',
  '/chat': 'Chat',
  '/team': 'Team Directory',
  '/workload': 'Team Workload',
  '/issues': 'Issues and Blockers',
  '/reports': 'Reports',
  '/published': 'Published',
  '/notifications': 'Notifications',
  '/settings': 'Settings',
  '/profile': 'Profile',
  '/admin': 'Admin',
};

export const pageLabel = (page?: string | null) => (page ? PAGE_LABELS[page] || page.slice(1).replace(/-/g, ' ') : null);

export function timeAgo(iso?: string | null, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

function duration(iso?: string, now = Date.now()): string {
  if (!iso) return '';
  const m = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min`;
}

const DOT: Record<PresenceState, string> = {
  active: 'bg-emerald-500',
  away: 'bg-amber-400',
  offline: 'bg-slate-300',
};

/** One line under the name: what the person is doing now, or when they were last here. */
export function statusLine(p: PresencePerson, now = Date.now()): string {
  if (p.state === 'active') return `Active${p.page ? ` · ${pageLabel(p.page)}` : ''}`;
  if (p.state === 'away') return `Away · portal open in the background${p.lastActiveAt ? `, last active ${timeAgo(p.lastActiveAt, now)}` : ''}`;
  if (p.lastSeenAt) return `Last seen ${timeAgo(p.lastSeenAt, now)}`;
  if (p.lastLoginAt) return `Last signed in ${timeAgo(p.lastLoginAt, now)}`;
  return 'Has not signed in yet';
}

type Filter = 'all' | 'online' | 'offline';
const ORDER: Record<PresenceState, number> = { active: 0, away: 1, offline: 2 };

const TONE: Record<PresenceState, string> = {
  active: 'text-emerald-700',
  away: 'text-amber-700',
  offline: 'text-ui-muted',
};

const isToday = (iso?: string | null) => Boolean(iso) && new Date(iso as string).toDateString() === new Date().toDateString();

export const LiveStatusPage: React.FC = () => {
  const [people, setPeople] = useState<PresencePerson[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('online');
  const [query, setQuery] = useState('');
  const [now, setNow] = useState(Date.now());
  const [feedActor, setFeedActor] = useState<{ _id: string; name: string } | null>(null);
  const { on, isConnected } = useSocket();

  const load = async () => {
    try {
      const res = await apiFetch<{ data: PresencePerson[] }>('/team/presence');
      setPeople(res.data || []);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Could not load live status.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // Times ("5 min ago") tick every 30 s; the full list is re-read every 2 minutes.
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const reload = setInterval(() => void load(), 120_000);
    return () => {
      clearInterval(tick);
      clearInterval(reload);
    };
  }, []);

  // Re-read after a reconnect (changes may have been missed while disconnected).
  useEffect(() => {
    if (isConnected) void load();
  }, [isConnected]);

  useEffect(
    () =>
      on('presence:changed', (change: Partial<PresencePerson> & { userId: string }) => {
        setNow(Date.now());
        setPeople((list) => {
          if (!list.some((p) => p._id === change.userId)) {
            void load(); // someone new (just approved)
            return list;
          }
          return list.map((p) =>
            p._id === change.userId
              ? {
                  ...p,
                  online: Boolean(change.online),
                  state: (change.state as PresenceState) || 'offline',
                  tabs: change.tabs ?? 0,
                  page: change.page ?? null,
                  since: change.since,
                  lastActiveAt: change.lastActiveAt,
                  lastSeenAt: change.online ? null : change.lastSeenAt ?? p.lastSeenAt ?? null,
                }
              : p,
          );
        });
      }),
    [on],
  );

  const counts = useMemo(
    () => ({
      active: people.filter((p) => p.state === 'active').length,
      away: people.filter((p) => p.state === 'away').length,
      offline: people.filter((p) => p.state === 'offline').length,
      today: people.filter((p) => p.online || isToday(p.lastSeenAt) || isToday(p.lastLoginAt)).length,
    }),
    [people],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => (filter === 'online' ? p.online : filter === 'offline' ? !p.online : true))
      .filter((p) => !q || [p.name, p.jobRole, p.department, ROLE_LABELS[p.role as keyof typeof ROLE_LABELS]].some((v) => String(v || '').toLowerCase().includes(q)))
      .sort((a, b) => {
        if (ORDER[a.state] !== ORDER[b.state]) return ORDER[a.state] - ORDER[b.state];
        if (a.state === 'offline') return (Date.parse(b.lastSeenAt || b.lastLoginAt || '') || 0) - (Date.parse(a.lastSeenAt || a.lastLoginAt || '') || 0);
        return a.name.localeCompare(b.name);
      });
  }, [people, filter, query]);

  const tabs: Array<{ key: Filter; label: string; count: number }> = [
    { key: 'online', label: 'Online', count: counts.active + counts.away },
    { key: 'offline', label: 'Offline', count: counts.offline },
    { key: 'all', label: 'Everyone', count: people.length },
  ];

  const stats: Array<{ key: string; label: string; value: number; hint: string; dot: string }> = [
    { key: 'active', label: 'Active now', value: counts.active, hint: 'Portal open and in use', dot: DOT.active },
    { key: 'away', label: 'Away', value: counts.away, hint: 'Open in a background tab', dot: DOT.away },
    { key: 'offline', label: 'Offline', value: counts.offline, hint: 'Not on the portal', dot: DOT.offline },
    { key: 'today', label: 'Seen today', value: counts.today, hint: `of ${people.length} people`, dot: 'bg-sky-500' },
  ];

  return (
    <div className="max-w-7xl mx-auto pb-16 space-y-6">
      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[28px] sm:text-[32px] leading-tight font-extrabold tracking-[-0.02em] text-ui-ink">Live Status</h1>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-white/70 text-ui-text">
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} aria-hidden="true" />
              {isConnected ? 'Live' : 'Reconnecting…'}
            </span>
          </div>
          <p className="text-[15px] text-ui-muted mt-1.5 max-w-[70ch]">Who is on the portal right now, and what has happened recently.</p>
        </div>
        <button type="button" onClick={() => void load()} className="ui-btn ui-btn-secondary bg-transparent h-11 self-start sm:self-auto">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {stats.map((s) => (
          <div key={s.key} className="glass-panel rounded-ui-panel px-5 py-4">
            <div className="flex items-center gap-2 text-[13px] font-semibold text-ui-muted">
              <span className={`w-2 h-2 rounded-full ${s.dot}`} aria-hidden="true" />
              {s.label}
            </div>
            <div className="mt-1.5 text-[28px] leading-none font-extrabold tracking-tight text-ui-ink tabular-nums">{loading ? '–' : s.value}</div>
            <div className="mt-1 text-xs text-ui-muted">{s.hint}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_420px] gap-6 items-start">
        {/* People */}
        <section className="glass-panel rounded-ui-panel" aria-labelledby="people-heading">
          <header className="px-5 pt-5 pb-4 flex flex-wrap items-center justify-between gap-3 border-b border-ui-line">
            <h2 id="people-heading" className="text-[17px] font-bold text-ui-ink flex items-center gap-2">
              <Activity className="w-4 h-4 text-ui-muted" aria-hidden="true" />
              People
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <div className="ui-tabs" role="tablist" aria-label="Show">
                {tabs.map((t) => (
                  <button key={t.key} type="button" role="tab" aria-selected={filter === t.key} onClick={() => setFilter(t.key)} className="ui-tab !min-h-[36px] !px-3">
                    {t.label}
                    <span className="tabular-nums opacity-70">{t.count}</span>
                  </button>
                ))}
              </div>
              <div className="relative">
                <Search className="w-4 h-4 text-ui-muted absolute left-3.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search people"
                  aria-label="Search name, role, department"
                  className="ui-input w-full sm:w-52 pl-10 pr-3"
                />
              </div>
            </div>
          </header>

          {loading ? (
            <div className="py-10">
              <DataLoader />
            </div>
          ) : error ? (
            <p className="px-5 py-10 text-center text-sm text-rose-600">{error}</p>
          ) : shown.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-ui-muted">
              {filter === 'online' && !query ? 'Nobody else is on the portal right now.' : 'No one matches.'}
            </p>
          ) : (
            <ul className="divide-y divide-[color:var(--ui-line)]">
              {shown.map((p) => {
                const picked = feedActor?._id === p._id;
                return (
                  <li key={p._id} className={`flex items-center gap-3 px-5 py-3 transition-colors ${picked ? 'bg-white/70' : 'hover:bg-white/50'}`}>
                    <Link to={`/team/${p._id}`} className="relative shrink-0" aria-label={`${p.name} profile`}>
                      <Avatar url={p.avatarUrl} name={p.name} userId={p._id} size="md" />
                      <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-white ${DOT[p.state]}`} title={p.state} />
                    </Link>
                    <div className="min-w-0 flex-1">
                      <Link to={`/team/${p._id}`} className="block text-sm font-semibold text-ui-ink truncate hover:underline">
                        {p.name}
                      </Link>
                      <span className="block text-xs text-ui-muted truncate">
                        {[p.jobRole || ROLE_LABELS[p.role as keyof typeof ROLE_LABELS] || p.role, p.department].filter(Boolean).join(' · ')}
                      </span>
                      <span className={`sm:hidden block text-xs font-medium truncate mt-0.5 ${TONE[p.state]}`}>{statusLine(p, now)}</span>
                    </div>
                    <div className="text-right shrink-0 max-w-[45%] hidden sm:block">
                      <span className={`block text-xs font-medium truncate ${TONE[p.state]}`}>{statusLine(p, now)}</span>
                      {p.online && (
                        <span className="block text-[11px] text-ui-muted">
                          Online for {duration(p.since, now)}
                          {p.tabs > 1 ? ` · ${p.tabs} tabs` : ''}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setFeedActor(picked ? null : { _id: p._id, name: p.name })}
                      aria-pressed={picked}
                      title={`Show activity of ${p.name}`}
                      aria-label={`Show activity of ${p.name}`}
                      className={`ui-icon-btn !w-9 !h-9 ${picked ? '!bg-ui-ink !text-white !border-transparent' : ''}`}
                    >
                      <History className="w-4 h-4" aria-hidden="true" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Recent activity */}
        <div className="lg:sticky lg:top-4">
          <ActivityFeed actor={feedActor} onClearActor={() => setFeedActor(null)} />
        </div>
      </div>
    </div>
  );
};

export default LiveStatusPage;
