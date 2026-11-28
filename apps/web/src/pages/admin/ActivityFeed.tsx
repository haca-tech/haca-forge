import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, X, LogIn, LogOut, ShieldAlert, Briefcase, CalendarDays, UserCog, Dot } from 'lucide-react';
import { apiFetch } from '../../lib/api';
import { useSocket } from '../../hooks/useSocket';
import { Avatar } from '../../components/Avatar';

export type FeedCategory = 'all' | 'sign_ins' | 'work' | 'plans' | 'people';

export interface FeedItem {
  _id: string;
  at: string;
  action: string;
  category: Exclude<FeedCategory, 'all'> | 'other';
  verb: string;
  actor: { _id: string; name: string; role: string; avatarUrl?: string | null } | null;
  asAdmin?: boolean;
  target: { label: string; link?: string } | null;
  fromStatus?: string;
  toStatus?: string;
  device?: string;
}

const CATEGORIES: Array<{ key: FeedCategory; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'sign_ins', label: 'Sign-ins' },
  { key: 'work', label: 'Work' },
  { key: 'plans', label: 'Plans' },
  { key: 'people', label: 'People' },
];

function iconFor(item: FeedItem) {
  if (item.action === 'auth.sign_in_failed') return { Icon: ShieldAlert, tone: 'text-rose-600 bg-rose-50' };
  if (item.action === 'auth.signed_in') return { Icon: LogIn, tone: 'text-emerald-700 bg-emerald-50' };
  if (item.action === 'auth.signed_out') return { Icon: LogOut, tone: 'text-slate-500 bg-slate-100' };
  if (item.category === 'work') return { Icon: Briefcase, tone: 'text-sky-700 bg-sky-50' };
  if (item.category === 'plans') return { Icon: CalendarDays, tone: 'text-violet-700 bg-violet-50' };
  if (item.category === 'people') return { Icon: UserCog, tone: 'text-amber-700 bg-amber-50' };
  return { Icon: Dot, tone: 'text-slate-500 bg-slate-100' };
}

/** "Today", "Yesterday" or "Mon, 24 Nov". */
export function dayLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

interface Props {
  actor?: { _id: string; name: string } | null;
  onClearActor?: () => void;
}

/** Recent activity across the portal (audit log), newest first, updated live. */
export const ActivityFeed: React.FC<Props> = ({ actor, onClearActor }) => {
  const [category, setCategory] = useState<FeedCategory>('all');
  const [items, setItems] = useState<FeedItem[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const { on } = useSocket();

  const queryFor = useCallback(
    (before?: string | null) => {
      const q = new URLSearchParams({ limit: '30' });
      if (category !== 'all') q.set('category', category);
      if (actor?._id) q.set('actorId', actor._id);
      if (before) q.set('before', before);
      return `/team/activity-feed?${q.toString()}`;
    },
    [category, actor?._id],
  );

  const loadFirst = useCallback(
    async (live = false) => {
      try {
        const res = await apiFetch<{ data: { items: FeedItem[]; nextBefore: string | null } }>(queryFor());
        const fresh = res.data.items;
        setItems((old) => {
          if (!live) return fresh;
          const known = new Set(old.map((i) => i._id));
          const added = fresh.filter((i) => !known.has(i._id)).map((i) => i._id);
          if (added.length) setFreshIds(new Set(added));
          const ids = new Set(fresh.map((i) => i._id));
          return [...fresh, ...old.filter((i) => !ids.has(i._id) && new Date(i.at) < new Date(fresh[fresh.length - 1]?.at || 0))];
        });
        if (!live) setNextBefore(res.data.nextBefore);
        setError(null);
      } catch (e: any) {
        setError(e?.message || 'Could not load activity.');
      } finally {
        setLoading(false);
      }
    },
    [queryFor],
  );

  useEffect(() => {
    setLoading(true);
    void loadFirst();
  }, [loadFirst]);

  // New events arrive in bursts (a plan save logs several): re-read once, a moment later.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () =>
      on('activity:new', () => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void loadFirst(true), 1200);
      }),
    [on, loadFirst],
  );
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const loadMore = async () => {
    if (!nextBefore) return;
    setLoadingMore(true);
    try {
      const res = await apiFetch<{ data: { items: FeedItem[]; nextBefore: string | null } }>(queryFor(nextBefore));
      setItems((old) => [...old, ...res.data.items.filter((i) => !old.some((o) => o._id === i._id))]);
      setNextBefore(res.data.nextBefore);
    } catch (e: any) {
      setError(e?.message || 'Could not load more activity.');
    } finally {
      setLoadingMore(false);
    }
  };

  const groups = useMemo(() => {
    const out: Array<{ day: string; items: FeedItem[] }> = [];
    for (const item of items) {
      const day = dayLabel(item.at);
      if (out[out.length - 1]?.day !== day) out.push({ day, items: [] });
      out[out.length - 1].items.push(item);
    }
    return out;
  }, [items]);

  return (
    <section className="glass-panel rounded-ui-panel flex flex-col min-h-0" aria-labelledby="activity-heading">
      <header className="px-5 pt-5 pb-3 space-y-3 border-b border-ui-line">
        <div className="flex items-center justify-between gap-2">
          <h2 id="activity-heading" className="text-[17px] font-bold text-ui-ink flex items-center gap-2">
            <History className="w-4 h-4 text-ui-muted" aria-hidden="true" />
            Recent activity
          </h2>
          {actor && (
            <span className="inline-flex items-center gap-1 rounded-full bg-white/80 border border-ui-line pl-2.5 pr-1 py-0.5 text-xs font-semibold text-ui-text">
              {actor.name}
              <button type="button" onClick={onClearActor} className="rounded-full p-1 hover:bg-slate-100" aria-label={`Show everyone, not only ${actor.name}`}>
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Activity type">
          {CATEGORIES.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={category === c.key}
              onClick={() => setCategory(c.key)}
              className={`h-8 px-3 rounded-full text-xs font-semibold border transition-colors ${
                category === c.key ? 'bg-ui-ink text-white border-transparent' : 'bg-white/60 text-ui-muted border-ui-line hover:text-ui-text'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      <div className="overflow-y-auto max-h-[calc(100vh-260px)] min-h-[320px]" aria-live="polite">
        {loading ? (
          <ul className="p-5 space-y-4" aria-label="Loading activity">
            {[0, 1, 2, 3, 4].map((i) => (
              <li key={i} className="flex gap-3 animate-pulse">
                <span className="w-8 h-8 rounded-full bg-slate-200/70" />
                <span className="flex-1 space-y-2 pt-1">
                  <span className="block h-3 w-3/4 rounded bg-slate-200/70" />
                  <span className="block h-2.5 w-1/3 rounded bg-slate-200/50" />
                </span>
              </li>
            ))}
          </ul>
        ) : error ? (
          <p className="p-6 text-center text-sm text-rose-600">{error}</p>
        ) : items.length === 0 ? (
          <p className="p-8 text-center text-sm text-ui-muted">No activity yet{actor ? ` for ${actor.name}` : ''}.</p>
        ) : (
          <>
            {groups.map((g) => (
              <div key={g.day}>
                <h3 className="sticky top-0 z-[1] bg-white/85 backdrop-blur px-5 py-1.5 text-[11px] font-bold uppercase tracking-wider text-ui-muted border-b border-ui-line">
                  {g.day}
                </h3>
                <ol className="px-5">
                  {g.items.map((item) => {
                    const { Icon, tone } = iconFor(item);
                    return (
                      <li
                        key={item._id}
                        className={`flex gap-3 py-3 border-b border-ui-line last:border-0 transition-colors ${freshIds.has(item._id) ? 'bg-emerald-50/60 -mx-5 px-5' : ''}`}
                      >
                        <span className="relative shrink-0 h-8">
                          <Avatar url={item.actor?.avatarUrl} name={item.actor?.name || 'System'} userId={item.actor?._id} size="sm" />
                          <span className={`absolute -bottom-1 -right-1 w-[18px] h-[18px] rounded-full ring-2 ring-white flex items-center justify-center ${tone}`}>
                            <Icon className="w-2.5 h-2.5" aria-hidden="true" />
                          </span>
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] leading-snug text-ui-text">
                            <span className="font-semibold text-ui-ink">{item.actor?.name || 'System'}</span>{' '}
                            {item.verb}
                            {item.target && (
                              <>
                                {' '}
                                {item.target.link ? (
                                  <Link to={item.target.link} className="font-semibold text-ui-ink hover:underline">
                                    {item.target.label}
                                  </Link>
                                ) : (
                                  <span className="font-semibold text-ui-ink">{item.target.label}</span>
                                )}
                              </>
                            )}
                          </p>
                          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ui-muted">
                            <time dateTime={item.at}>{clock(item.at)}</time>
                            {item.device && <span>· {item.device}</span>}
                            {(item.fromStatus || item.toStatus) && (
                              <span className="inline-flex items-center gap-1 rounded-md bg-white/80 border border-ui-line px-1.5 py-0.5 capitalize">
                                {item.fromStatus && <span>{item.fromStatus}</span>}
                                {item.fromStatus && item.toStatus && <span aria-label="to">→</span>}
                                {item.toStatus && <span className="font-semibold text-ui-text">{item.toStatus}</span>}
                              </span>
                            )}
                            {item.asAdmin && <span className="rounded-md bg-slate-100 px-1.5 py-0.5 font-semibold">as admin</span>}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
            ))}
            {nextBefore && (
              <div className="p-4 text-center">
                <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="ui-btn ui-btn-secondary w-full">
                  {loadingMore ? 'Loading…' : 'Show older activity'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};
