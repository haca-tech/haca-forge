import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  ExternalLink,
  Flag,
  History,
  Inbox,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  StickyNote,
  X,
} from 'lucide-react';
import {
  CALENDAR_LIST,
  CANONICAL_REVISION_ROOT_CAUSES,
  formatShortDate,
  formatShortDateTime,
  isApprover,
  isReadOnlyViewer,
  type CanonicalRevisionRootCause,
} from '@mmp/shared';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { TimeLabelChips, type TimeLabel } from '../../components/TimeLabelChips';
import { StepSubmitDialog } from '../../components/StepSubmitDialog';
import { PlansApprovalTab } from './PlansApprovalTab';
import { PauseRequestsTab } from './PauseRequestsTab';

/**
 * Review Hub: an inbox of review rounds and their history. Decisions happen in Review Studio
 * and Work Detail; owners answer with Start rework and Resubmit link. Leads see the calendars
 * they decide, admin and the read-only heads see everything (the heads without actions),
 * workers see their own steps. Read from GET /api/review-hub and its step timeline.
 */

interface HubItem {
  workItemId: string;
  title: string;
  stageKey: string;
  type: string;
  calendar: string;
  owner: { _id: string; name: string };
  status: string;
  reviewState: string | null;
  statusLabel: string;
  version: number | null;
  submittedAt: string | null;
  decidedAt: string | null;
  revisions: number;
  revisionsLabel: string;
  timeLabels: TimeLabel[];
  flag: { _id: string; flaggedAt: string; revisionsCount: number } | null;
}
interface HubData {
  viewer: 'lead' | 'admin' | 'viewer' | 'worker';
  tab: string;
  tabs: Array<{ key: string; label: string; count: number }>;
  items: HubItem[];
}
interface TimelineEvent {
  kind: string;
  at: string;
  by?: string;
  version?: number;
  links?: Array<{ url: string; kind: string }>;
  note?: string;
  message?: string;
  rootCause?: string | null;
  rating?: number | null;
  reason?: string;
  pauseUntil?: string | null;
  cancelReason?: string;
  round?: number;
  revisions?: number;
  isResponse?: boolean;
}
interface Timeline {
  step: {
    _id: string;
    title: string;
    stageKey: string;
    type: string;
    calendar: string;
    owner: { _id: string; name: string };
    status: string;
    reviewState: string | null;
    statusLabel: string;
    version: number | null;
    dueDate: string | null;
    revisions: number;
    revisionsLabel: string;
  };
  mainAction: { kind: 'open_review_studio' | 'classify' | 'start_rework' | 'resubmit' | 'open_work_detail'; href?: string; flagId?: string };
  events: TimelineEvent[];
}

const calendarName = (key: string) => CALENDAR_LIST.find((c) => c.id === key)?.name || key;
const TAB_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  waiting: Clock,
  changes: MessageSquare,
  pauses: PauseCircle,
  plans: Inbox,
  flagged: Flag,
  history: History,
  needs_action: MessageSquare,
};

/** "3h ago", "2d ago", "just now". */
export function timeAgo(value: string | null | undefined, now = Date.now()): string {
  if (!value) return '';
  const ms = now - new Date(value).getTime();
  if (ms < 60000) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function itemWhen(item: HubItem, tab: string): string {
  if (tab === 'history') return item.decidedAt ? `approved ${formatShortDate(item.decidedAt)}` : '';
  if (tab === 'changes' || tab === 'needs_action') return item.decidedAt ? `sent back ${timeAgo(item.decidedAt)}` : '';
  if (tab === 'flagged') return item.flag ? `flagged ${timeAgo(item.flag.flaggedAt)}` : '';
  return item.submittedAt ? `submitted ${timeAgo(item.submittedAt)}` : '';
}

/** One timeline line: what happened, who, and the text when this viewer may read it. */
function describe(e: TimelineEvent): { icon: React.ComponentType<{ className?: string }>; title: string; body?: string; extra?: React.ReactNode } {
  const by = e.by ? ` by ${e.by}` : '';
  switch (e.kind) {
    case 'submitted':
      return {
        icon: Send,
        title: `Version ${e.version} submitted${by}`,
        body: e.note,
        extra: e.links?.length ? (
          <ul className="space-y-0.5">
            {e.links.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-ui-ink underline underline-offset-2 break-all">
                  Open link <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              </li>
            ))}
          </ul>
        ) : null,
      };
    case 'changes_requested':
      return { icon: RotateCcw, title: `Changes requested${by} (version ${e.version})`, body: e.message, extra: e.rootCause ? <p className="text-xs text-ui-muted">Root cause: {e.rootCause}</p> : null };
    case 'rework_started':
      return { icon: PlayCircle, title: `Rework started${by}` };
    case 'approved':
      return {
        icon: CheckCircle2,
        title: `Approved${by} (version ${e.version})`,
        body: e.message,
        extra: e.rating ? <p className="text-xs text-ui-ink" aria-label={`Rated ${e.rating} out of 5`}>{'★'.repeat(e.rating)}{'☆'.repeat(5 - e.rating)}</p> : null,
      };
    case 'reopened':
      return { icon: RotateCcw, title: `Reopened${by}`, body: e.message };
    case 'pause_requested':
      return { icon: PauseCircle, title: `Pause requested${by}: ${e.reason || ''}`, body: e.note, extra: e.pauseUntil ? <p className="text-xs text-ui-muted">Until {e.pauseUntil}</p> : null };
    case 'pause_approved':
      return { icon: PauseCircle, title: `Pause approved${by}`, body: e.message };
    case 'pause_rejected':
      return { icon: PauseCircle, title: `Pause not approved${by}`, body: e.message };
    case 'pause_cancelled':
      return { icon: PauseCircle, title: e.cancelReason === 'cancelled_on_submit' ? 'Pause request withdrawn (step submitted)' : e.cancelReason === 'reassigned' ? 'Pause request cancelled (step reassigned)' : 'Pause request cancelled' };
    case 'pause_resumed':
      return { icon: PlayCircle, title: `Resumed${by}` };
    case 'flagged':
      return { icon: Flag, title: `Flagged: reached round 4 (${e.revisions} change requests)` };
    case 'classified':
      return { icon: Flag, title: `Root cause classified${by}`, body: e.rootCause || undefined };
    case 'earlier_note':
      return { icon: StickyNote, title: `Earlier note${by}${e.round ? ` (round ${e.round})` : ''}`, body: e.message };
    default:
      return { icon: Clock, title: e.kind };
  }
}

/** Classify the root cause of a flagged step (the 7 canonical causes). */
const ClassifyDialog: React.FC<{ title: string; busy: boolean; onClose: () => void; onSave: (cause: CanonicalRevisionRootCause, notes: string) => void }> = ({ title, busy, onClose, onSave }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const [cause, setCause] = useState<CanonicalRevisionRootCause>(CANONICAL_REVISION_ROOT_CAUSES[0]);
  const [notes, setNotes] = useState('');
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="classify-title" className="glass-modal w-full max-w-md p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="classify-title" className="text-base font-bold text-ui-ink">Classify root cause</h2>
            <p className="text-sm text-ui-muted break-words">{title}</p>
          </div>
          <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="classify-cause" className="block text-[13px] font-medium text-ui-muted">Root cause</label>
          <select id="classify-cause" className="ui-select h-11 w-full" value={cause} onChange={(e) => setCause(e.target.value as CanonicalRevisionRootCause)}>
            {CANONICAL_REVISION_ROOT_CAUSES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <label htmlFor="classify-notes" className="block text-[13px] font-medium text-ui-muted">Notes (optional)</label>
          <textarea id="classify-notes" className="ui-input ui-textarea w-full min-h-[72px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="ui-btn ui-btn-secondary h-11">Cancel</button>
          <button type="button" disabled={busy} onClick={() => onSave(cause, notes.trim())} className="ui-btn ui-btn-primary h-11">{busy ? 'Saving…' : 'Save root cause'}</button>
        </div>
      </div>
    </div>
  );
};

/** The step's header, its one main action, and its timeline. */
const DetailPanel: React.FC<{ workItemId: string; onBack: () => void; onChanged: () => void }> = ({ workItemId, onBack, onChanged }) => {
  const navigate = useNavigate();
  const [data, setData] = useState<Timeline | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [resubmitting, setResubmitting] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const res = await apiFetch<{ data: Timeline }>(`/api/review-hub/steps/${workItemId}/timeline`);
      setData(res.data);
    } catch (err: any) {
      setError(err?.message || 'Could not load this step.');
    }
  };
  useEffect(() => {
    setData(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workItemId]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  if (!data) {
    return (
      <section className="glass-card p-5" aria-label="Step details">
        {error ? <p role="alert" className="text-sm text-ui-ink">{error}</p> : <p className="text-sm text-ui-muted">Loading…</p>}
      </section>
    );
  }
  const { step, mainAction, events } = data;
  const action = (() => {
    switch (mainAction.kind) {
      case 'open_review_studio':
        return (
          <button type="button" className="ui-btn ui-btn-primary h-11 gap-1.5" onClick={() => navigate(mainAction.href!)}>
            <Sparkles className="w-4 h-4" aria-hidden="true" /> Open in Review Studio
          </button>
        );
      case 'classify':
        return (
          <button type="button" className="ui-btn ui-btn-primary h-11 gap-1.5" onClick={() => setClassifying(true)}>
            <Flag className="w-4 h-4" aria-hidden="true" /> Classify root cause
          </button>
        );
      case 'start_rework':
        return (
          <button type="button" disabled={busy} className="ui-btn ui-btn-primary h-11 gap-1.5" onClick={() => run(() => apiFetch(`/api/work/${step._id}/transition`, { method: 'POST', body: JSON.stringify({ toStatus: 'In Progress' }) }))}>
            <PlayCircle className="w-4 h-4" aria-hidden="true" /> Start rework
          </button>
        );
      case 'resubmit':
        return (
          <button type="button" className="ui-btn ui-btn-primary h-11 gap-1.5" onClick={() => setResubmitting(true)}>
            <Send className="w-4 h-4" aria-hidden="true" /> Resubmit link
          </button>
        );
      default:
        return (
          <Link to={`/work/${step._id}`} className="ui-btn ui-btn-secondary h-11 gap-1.5">
            Open Work Detail <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          </Link>
        );
    }
  })();

  return (
    <section className="glass-card p-4 sm:p-5 space-y-4 min-w-0" aria-labelledby="hub-detail-title">
      <button type="button" onClick={onBack} className="lg:hidden inline-flex items-center gap-1 min-h-[44px] text-sm font-semibold text-ui-ink">
        <ArrowLeft className="w-4 h-4" aria-hidden="true" /> Back to list
      </button>
      <header className="space-y-2">
        <h2 id="hub-detail-title" className="text-base font-bold text-ui-ink break-words">{step.title}</h2>
        <div className="flex flex-wrap gap-1.5">
          <span className="status-chip status-not-started text-[11px]">{step.stageKey}</span>
          <span className="status-chip status-not-started text-[11px]">{step.type}</span>
          <span className="status-chip status-in-progress text-[11px]">{calendarName(step.calendar)}</span>
          <span className="status-chip status-waiting text-[11px]" data-testid="hub-status">{step.statusLabel}</span>
        </div>
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-sm">
          <div><dt className="text-[11px] text-ui-muted">Owner</dt><dd className="text-ui-ink">{step.owner.name || '—'}</dd></div>
          <div><dt className="text-[11px] text-ui-muted">Version</dt><dd className="text-ui-ink">{step.version ? `v${step.version}` : '—'}</dd></div>
          <div><dt className="text-[11px] text-ui-muted">Due</dt><dd className="text-ui-ink">{step.dueDate ? formatShortDate(step.dueDate) : '—'}</dd></div>
          <div><dt className="text-[11px] text-ui-muted">Revisions</dt><dd className="text-ui-ink" data-testid="hub-revisions">{step.revisionsLabel}</dd></div>
        </dl>
      </header>
      <div className="flex flex-wrap gap-2" data-testid="hub-main-action">{action}</div>
      {error && <p role="alert" className="p-3 rounded-xl status-tint status-changes text-xs font-semibold">{error}</p>}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ui-muted mb-2">Timeline</h3>
        {events.length === 0 ? (
          <p className="text-sm text-ui-muted">Nothing has been submitted yet.</p>
        ) : (
          <ol className="space-y-3" aria-label="Review timeline">
            {events.map((e, i) => {
              const d = describe(e);
              const Icon = d.icon;
              return (
                <li key={i} className="flex gap-3" data-kind={e.kind}>
                  <span className="mt-0.5 w-7 h-7 rounded-full bg-white/80 border border-ui-line flex items-center justify-center shrink-0">
                    <Icon className="w-3.5 h-3.5 text-ui-ink" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 space-y-1">
                    <p className="text-sm font-semibold text-ui-ink break-words">{d.title}</p>
                    <p className="text-[11px] text-ui-muted">{formatShortDateTime(e.at)}</p>
                    {d.body ? <p className="text-sm text-ui-text whitespace-pre-wrap break-words">{d.body}</p> : null}
                    {d.extra}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      {classifying && mainAction.flagId && (
        <ClassifyDialog
          title={step.title}
          busy={busy}
          onClose={() => setClassifying(false)}
          onSave={(cause, notes) => {
            setClassifying(false);
            run(() => apiFetch(`/api/revisions/flags/${mainAction.flagId}/classify`, { method: 'POST', body: JSON.stringify({ rootCause: cause, rootCauseNotes: notes }) }));
          }}
        />
      )}
      {resubmitting && (
        <StepSubmitDialog
          step={{ _id: step._id, title: step.title, stageKey: step.stageKey }}
          resubmit
          onClose={() => setResubmitting(false)}
          onDone={async () => {
            setResubmitting(false);
            await load();
            onChanged();
          }}
        />
      )}
    </section>
  );
};

export const FeedbackPage: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || '';
  const q = params.get('q') || '';
  const calendar = params.get('calendar') || '';
  const selected = params.get('step') || '';
  const [data, setData] = useState<HubData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [qDraft, setQDraft] = useState(q);
  const [reloadKey, setReloadKey] = useState(0);
  const canOpenStudio = isApprover(user?.role) || user?.role === 'admin';

  const setParam = (next: Record<string, string>) => {
    const out = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v) out.set(k, v);
      else out.delete(k);
    }
    setParams(out, { replace: true });
  };

  useEffect(() => {
    let alive = true;
    const query = new URLSearchParams();
    if (tab) query.set('tab', tab);
    if (q) query.set('q', q);
    if (calendar) query.set('calendar', calendar);
    apiFetch<{ data: HubData }>(`/api/review-hub${query.toString() ? `?${query}` : ''}`)
      .then((res) => alive && setData(res.data))
      .catch((err) => alive && setError(err?.message || 'Could not load the Review Hub.'));
    return () => {
      alive = false;
    };
  }, [tab, q, calendar, reloadKey]);

  useEffect(() => setQDraft(q), [q]);
  useEffect(() => {
    if (qDraft === q) return;
    const t = setTimeout(() => setParam({ q: qDraft, step: '' }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  const activeTab = data?.tab || tab;
  const isListTab = !['pauses', 'plans'].includes(activeTab);
  const readOnly = isReadOnlyViewer(user?.role);
  const items = useMemo(() => data?.items || [], [data]);

  return (
    <div className="space-y-4 pb-12 min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-ui-ink">Review Hub</h1>
          <p className="text-sm text-ui-muted">
            {data?.viewer === 'worker'
              ? 'Your steps in review: what needs you, what waits for a lead, and what is done.'
              : readOnly
                ? 'Every review round, read-only.'
                : 'What waits for a decision, what went back, and what is done. Decide in Review Studio or Work Detail.'}
          </p>
        </div>
        {canOpenStudio && (
          <button type="button" onClick={() => navigate('/feedback/review-studio')} className="ui-btn ui-btn-primary h-11 gap-2">
            <Sparkles className="w-4 h-4" aria-hidden="true" /> Open Review Studio
          </button>
        )}
      </div>

      <div className="ui-tabs flex-wrap max-w-full rounded-ui-card" role="tablist" aria-label="Review Hub tabs">
        {(data?.tabs || []).map((t) => {
          const Icon = TAB_ICON[t.key] || Inbox;
          const active = t.key === activeTab;
          return (
            <button key={t.key} type="button" role="tab" aria-selected={active} onClick={() => setParam({ tab: t.key, step: '' })} className={`ui-tab gap-2 ${active ? 'is-active' : ''}`}>
              <Icon className="w-4 h-4" aria-hidden="true" />
              {t.label} <span className="tabular-nums" data-testid={`tab-count-${t.key}`}>({t.count})</span>
            </button>
          );
        })}
      </div>

      {isListTab && (
        <div className="glass-card p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-[1fr_220px] gap-3" role="search" aria-label="Filter the Review Hub">
          <div className="min-w-0">
            <label htmlFor="hub-q" className="block text-[12px] font-medium text-ui-muted mb-1">Search</label>
            <div className="relative">
              <Search className="w-4 h-4 text-ui-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
              <input id="hub-q" type="search" className="ui-input h-11 w-full pl-9" placeholder="Title or owner" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />
            </div>
          </div>
          <div className="min-w-0">
            <label htmlFor="hub-calendar" className="block text-[12px] font-medium text-ui-muted mb-1">Calendar</label>
            <select id="hub-calendar" className="ui-select h-11 w-full" value={calendar} onChange={(e) => setParam({ calendar: e.target.value, step: '' })}>
              <option value="">All calendars</option>
              {CALENDAR_LIST.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {error && <p role="alert" className="p-3 status-tint status-changes rounded-xl text-xs font-semibold">{error}</p>}

      {activeTab === 'pauses' && <PauseRequestsTab onCount={(n) => setData((d) => (d ? { ...d, tabs: d.tabs.map((t) => (t.key === 'pauses' ? { ...t, count: n } : t)) } : d))} />}
      {activeTab === 'plans' && <PlansApprovalTab />}

      {isListTab && data && (
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-4 items-start">
          <div className={`${selected ? 'hidden lg:block' : ''} min-w-0`}>
            {items.length === 0 ? (
              <div className="glass-card p-8 text-center text-sm text-ui-muted">Nothing here.</div>
            ) : (
              <ul className="space-y-2" aria-label={(data.tabs.find((t) => t.key === activeTab)?.label || 'Steps')}>
                {items.map((it) => {
                  const active = it.workItemId === selected;
                  return (
                    <li key={it.workItemId}>
                      <button
                        type="button"
                        onClick={() => setParam({ step: it.workItemId })}
                        aria-current={active ? 'true' : undefined}
                        className={`w-full text-left glass-card p-3 space-y-1.5 min-w-0 ${active ? 'border-2 border-ui-ink' : ''}`}
                      >
                        <span className="block text-sm font-semibold text-ui-ink break-words">{it.title}</span>
                        <span className="flex flex-wrap gap-1.5">
                          <span className="status-chip status-not-started text-[11px]">{it.stageKey}</span>
                          <span className="status-chip status-not-started text-[11px]">{it.type}</span>
                          <span className="status-chip status-in-progress text-[11px]">{calendarName(it.calendar)}</span>
                          <TimeLabelChips labels={it.timeLabels} showOnTime={false} />
                        </span>
                        <span className="block text-xs text-ui-muted">
                          {it.owner.name}
                          {it.version ? ` · v${it.version}` : ''}
                          {itemWhen(it, activeTab) ? ` · ${itemWhen(it, activeTab)}` : ''}
                          {` · ${it.revisionsLabel}`}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          {selected ? (
            <DetailPanel workItemId={selected} onBack={() => setParam({ step: '' })} onChanged={() => setReloadKey((k) => k + 1)} />
          ) : (
            <div className="hidden lg:block glass-card p-8 text-center text-sm text-ui-muted">Choose a step to see its review timeline.</div>
          )}
        </div>
      )}
    </div>
  );
};

export default FeedbackPage;
