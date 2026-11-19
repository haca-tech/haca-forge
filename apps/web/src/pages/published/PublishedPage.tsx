import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ExternalLink, Maximize2, Megaphone, Pencil, Search, X } from 'lucide-react';
import {
  CALENDAR_LIST,
  DELIVERABLE_TYPE_KEYS,
  ROW_WORKFLOWS,
  ROW_WORKFLOW_LABELS,
  formatShortDate,
  monthKeyInAppTz,
  type EmbedInfo,
} from '@mmp/shared';
import { apiFetch } from '../../lib/api';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { EmbedFrame, safeHref } from './EmbedFrame';
import { useAuth } from '../../context/AuthContext';
import { EditLiveLinkDialog, canEditLiveLink } from '../../components/EditLiveLinkDialog';

export interface PublishedItem {
  id: string;
  title: string;
  type: string;
  workflow: string | null;
  workflowLabel: string;
  calendar: string;
  postedAt: string;
  liveUrl: string;
  embed: EmbedInfo;
  /** What the card shows: the live post, or the approved final output when the live link does not embed. */
  preview?: { source: 'live' | 'final'; embed: EmbedInfo; label?: string };
  credits: { step: string; name: string }[];
}
interface PublishedResponse {
  items: PublishedItem[];
  total: number;
  page: number;
  pages: number;
}

const STEP_LABEL: Record<string, string> = { Script: 'Script', Content: 'Content', Shoot: 'Shoot', Design: 'Design', Edit: 'Edit', Post: 'Posted by' };
const calendarName = (key: string) => CALENDAR_LIST.find((c) => c.id === key)?.name || key;

/** Filters live in the URL. No month in the URL = this month; month=all = every month. */
function filtersFrom(params: URLSearchParams) {
  const month = params.get('month') || monthKeyInAppTz();
  return {
    month,
    calendar: params.get('calendar') || '',
    type: params.get('type') || '',
    workflow: params.get('workflow') || '',
    q: params.get('q') || '',
    page: Math.max(1, Number(params.get('page')) || 1),
  };
}
type Filters = ReturnType<typeof filtersFrom>;

const Credits: React.FC<{ credits: PublishedItem['credits'] }> = ({ credits }) =>
  credits.length ? (
    <ul className="text-xs text-ui-text space-y-0.5" aria-label="Credits">
      {credits.map((c, i) => (
        <li key={i}>
          <span className="text-ui-muted">{STEP_LABEL[c.step] || c.step}:</span> {c.name}
        </li>
      ))}
    </ul>
  ) : null;

const Chips: React.FC<{ item: PublishedItem }> = ({ item }) => (
  <div className="flex flex-wrap gap-1.5">
    <span className="status-chip status-not-started text-[11px]">{item.workflowLabel || item.type}</span>
    <span className="status-chip status-in-progress text-[11px]">{calendarName(item.calendar)}</span>
  </div>
);

/** The larger view: the embed, credits and "Open original ↗". */
const PublishedDialog: React.FC<{ item: PublishedItem; onClose: () => void }> = ({ item, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const href = safeHref(item.liveUrl);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="published-dialog-title" className="glass-modal w-full max-w-lg max-h-[92vh] overflow-y-auto p-4 sm:p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="published-dialog-title" className="text-base font-bold text-ui-ink break-words">{item.title}</h2>
            <p className="text-sm text-ui-muted">Posted {formatShortDate(item.postedAt)}</p>
          </div>
          <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <EmbedFrame embed={(item.preview || item).embed} caption={item.preview?.label} liveUrl={item.liveUrl} title={item.title} eager size="large" />
        <Chips item={item} />
        <Credits credits={item.credits} />
        {href && (
          <a href={href} target="_blank" rel="noopener noreferrer" className="ui-btn ui-btn-primary h-11 w-full gap-1.5">
            Open original <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>
    </div>
  );
};

/**
 * Published: every posted deliverable with its live post embedded (Instagram, YouTube,
 * Facebook, LinkedIn) or a link card. Newest first. Workers see only pieces they worked on
 * (the API decides). Nothing is sorted, grouped or counted by person.
 */
export const PublishedPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const f = useMemo(() => filtersFrom(params), [params]);
  const [data, setData] = useState<PublishedResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PublishedItem | null>(null);
  const [editing, setEditing] = useState<PublishedItem | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const { user } = useAuth();
  const canEdit = canEditLiveLink(user?.role);
  const [qDraft, setQDraft] = useState(f.q);

  const apiQuery = useMemo(() => {
    const q = new URLSearchParams();
    if (f.month !== 'all') q.set('month', f.month);
    for (const k of ['calendar', 'type', 'workflow', 'q'] as const) if (f[k]) q.set(k, f[k]);
    q.set('page', String(f.page));
    return q.toString();
  }, [f]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    apiFetch<{ data: PublishedResponse }>(`/api/published?${apiQuery}`)
      .then((res) => alive && setData(res.data))
      .catch((err) => alive && setError(err?.message || 'Could not load published posts.'))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [apiQuery, reloadKey]);

  // Search is typed freely and written to the URL after a short pause.
  useEffect(() => setQDraft(f.q), [f.q]);
  useEffect(() => {
    if (qDraft === f.q) return;
    const t = setTimeout(() => update({ q: qDraft }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  const update = (next: Partial<Filters>) => {
    const merged = { ...f, ...next, page: next.page ?? 1 };
    const out = new URLSearchParams();
    if (merged.month && merged.month !== monthKeyInAppTz()) out.set('month', merged.month);
    for (const k of ['calendar', 'type', 'workflow', 'q'] as const) if (merged[k]) out.set(k, merged[k]);
    if (merged.page > 1) out.set('page', String(merged.page));
    setParams(out, { replace: true });
  };

  const select = (id: string, label: string, value: string, onChange: (v: string) => void, options: { value: string; label: string }[], allLabel: string) => (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-[12px] font-medium text-ui-muted mb-1">{label}</label>
      <select id={id} className="ui-select h-11 w-full" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{allLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );

  const items = data?.items || [];
  const total = data?.total ?? 0;
  const monthText = f.month === 'all' ? 'all months' : new Date(`${f.month}-01T00:00:00Z`).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="space-y-4 pb-12 min-w-0">
      <div className="flex items-center gap-2">
        <Megaphone className="w-5 h-5 text-ui-ink" aria-hidden="true" />
        <h1 className="text-lg font-bold text-ui-ink">Published</h1>
      </div>

      <div className="glass-card p-4 sm:p-5 space-y-3" role="search" aria-label="Filter published posts">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <div className="min-w-0 sm:col-span-2 lg:col-span-1">
            <label htmlFor="pub-q" className="block text-[12px] font-medium text-ui-muted mb-1">Search</label>
            <div className="relative">
              <Search className="w-4 h-4 text-ui-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input id="pub-q" type="search" className="ui-input h-11 w-full pl-9" placeholder="Topic" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor="pub-month" className="block text-[12px] font-medium text-ui-muted mb-1">Month</label>
            <div className="flex gap-2">
              <input
                id="pub-month"
                type="month"
                className="ui-input h-11 w-full min-w-0"
                value={f.month === 'all' ? '' : f.month}
                onChange={(e) => update({ month: e.target.value || 'all' })}
              />
              {f.month !== 'all' && (
                <button type="button" className="ui-btn ui-btn-secondary h-11 shrink-0" onClick={() => update({ month: 'all' })}>
                  All
                </button>
              )}
            </div>
          </div>
          {select('pub-calendar', 'Calendar', f.calendar, (v) => update({ calendar: v }), CALENDAR_LIST.map((c) => ({ value: c.id, label: c.name })), 'All calendars')}
          {select('pub-type', 'Type', f.type, (v) => update({ type: v }), DELIVERABLE_TYPE_KEYS.map((t) => ({ value: t, label: t })), 'All types')}
          {select('pub-workflow', 'Workflow', f.workflow, (v) => update({ workflow: v }), ROW_WORKFLOWS.map((w) => ({ value: w, label: ROW_WORKFLOW_LABELS[w] })), 'All workflows')}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-ui-line">
          <span className="text-[13px] font-semibold text-ui-ink" data-testid="published-count" aria-live="polite">
            {loading ? 'Loading…' : `${total} ${total === 1 ? 'post' : 'posts'} · ${monthText}`}
          </span>
        </div>
      </div>

      {error && <p role="alert" className="status-tint status-changes rounded-ui-control px-3 py-2 text-sm">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <div className="glass-card p-10 text-center space-y-2">
          <Megaphone className="w-8 h-8 mx-auto text-ui-muted" aria-hidden="true" />
          <p className="text-sm font-semibold text-ui-ink">
            {f.month === 'all' && !f.calendar && !f.type && !f.workflow && !f.q ? 'Nothing published yet' : 'Nothing published yet for this month'}
          </p>
          {(f.calendar || f.type || f.workflow || f.q) && <p className="text-xs text-ui-muted">Try clearing a filter.</p>}
        </div>
      )}

      {/* Cards in a row stretch to the same height: 1 column on a phone, 2 on a tablet, 3–4 on a desktop. */}
      <ul className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 items-stretch" aria-label="Published posts">
        {items.map((item) => (
          <li key={item.id} className="glass-card rounded-ui-card p-3 flex flex-col gap-2 min-w-0 h-full">
            <EmbedFrame embed={(item.preview || item).embed} caption={item.preview?.label} liveUrl={item.liveUrl} title={item.title} />
            {/* Title (up to 2 lines) with the edit and expand buttons on its first line. */}
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 pt-3">
                <h2 className="text-sm font-semibold leading-5 text-ui-ink break-words line-clamp-2">
                  <button type="button" className="text-left hover:underline" title={item.title} onClick={() => setOpen(item)}>
                    {item.title}
                  </button>
                </h2>
                <p className="text-xs text-ui-muted">Posted {formatShortDate(item.postedAt)}</p>
              </div>
              <div className="flex shrink-0">
                {canEdit && (
                  <button type="button" className="ui-icon-btn h-11 w-11" aria-label={`Edit live link: ${item.title}`} onClick={() => setEditing(item)}>
                    <Pencil className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
                <button type="button" className="ui-icon-btn h-11 w-11" aria-label={`Open larger view: ${item.title}`} onClick={() => setOpen(item)}>
                  <Maximize2 className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>
            <Chips item={item} />
            <Credits credits={item.credits} />
            {/* The card's only "Open original", pinned to the bottom (an embed can load yet show the site's own "not available" page). */}
            {safeHref(item.liveUrl) && (
              <a
                href={safeHref(item.liveUrl)!}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-auto self-start inline-flex items-center gap-1 min-h-[44px] text-xs font-semibold text-ui-ink underline underline-offset-2"
              >
                Open original <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab): {item.title}</span>
              </a>
            )}
          </li>
        ))}
      </ul>

      {data && data.pages > 1 && (
        <nav className="flex items-center justify-center gap-2" aria-label="Pages">
          <button type="button" className="ui-btn ui-btn-secondary h-11" disabled={f.page <= 1} onClick={() => update({ page: f.page - 1 })}>Previous</button>
          <span className="text-sm text-ui-muted">Page {data.page} of {data.pages}</span>
          <button type="button" className="ui-btn ui-btn-secondary h-11" disabled={f.page >= data.pages} onClick={() => update({ page: f.page + 1 })}>Next</button>
        </nav>
      )}

      {open && <PublishedDialog item={open} onClose={() => setOpen(null)} />}
      {editing && (
        <EditLiveLinkDialog
          pieceId={editing.id}
          title={editing.title}
          currentUrl={editing.liveUrl}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReloadKey((k) => k + 1);
          }}
        />
      )}
    </div>
  );
};

export default PublishedPage;
