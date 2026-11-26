import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronUp, MessageSquare, PanelRightOpen, X } from 'lucide-react';
import { formatGridDate, ROW_WORKFLOW_LABELS } from '@mmp/shared';
import { OWNER_FIELD_BY_STAGE, STAGE_LABEL } from './columns';
import type { GridLine, GridPerson, GridRow } from './types';

/** One-tap reasons for sending a row back; the reviewer can add a note of their own. */
export const QUICK_REASONS = [
  'Change the posting date',
  'Make the topic clearer',
  'Use a different type',
  'Add more detail to the brief',
  'Change an owner or deadline',
] as const;

/** Reasons ticked plus the reviewer's note, as one message. */
export function composeMessage(reasons: string[], note: string): string {
  const parts = [...reasons, note.trim()].filter(Boolean);
  return parts.map((p) => (/[.!?]$/.test(p) ? p : `${p}.`)).join(' ');
}

type Tab = 'waiting' | 'changes' | 'approved' | 'all';
const TABS: { key: Tab; label: string }[] = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'changes', label: 'Sent back' },
  { key: 'approved', label: 'Approved' },
  { key: 'all', label: 'All' },
];
const inTab = (row: GridRow, tab: Tab) =>
  tab === 'all' ||
  (tab === 'waiting' && row.rowStatus === 'submitted') ||
  (tab === 'changes' && row.rowStatus === 'changes_requested') ||
  (tab === 'approved' && row.rowStatus === 'approved');

const STATUS: Record<GridRow['rowStatus'], { tone: string; label: string }> = {
  draft: { tone: 'status-not-started', label: 'Draft' },
  submitted: { tone: 'status-waiting', label: 'Waiting' },
  changes_requested: { tone: 'status-changes', label: 'Sent back' },
  approved: { tone: 'status-approved', label: 'Approved' },
};

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const initials = (n: string) =>
  n
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

/** Reasons + note form, used inline on a card and in the bulk dialog. */
const ChangeForm: React.FC<{
  idPrefix: string;
  busy: boolean;
  sendLabel: string;
  onSend: (message: string) => void;
  onCancel: () => void;
}> = ({ idPrefix, busy, sendLabel, onSend, onCancel }) => {
  const [reasons, setReasons] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => noteRef.current?.focus(), []);
  const message = composeMessage(reasons, note);
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (message && !busy) onSend(message);
      }}
    >
      <fieldset>
        <legend className="text-[13px] font-semibold text-ui-ink">What needs to change?</legend>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_REASONS.map((r) => {
            const on = reasons.includes(r);
            return (
              <button
                key={r}
                type="button"
                aria-pressed={on}
                onClick={() => setReasons((cur) => (on ? cur.filter((x) => x !== r) : [...cur, r]))}
                className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors ${
                  on ? 'border-ui-ink bg-ui-ink text-white' : 'border-ui-line bg-white text-ui-text hover:border-ui-ink/40'
                }`}
              >
                {r}
              </button>
            );
          })}
        </div>
      </fieldset>
      <div>
        <label htmlFor={`${idPrefix}-note`} className="text-[13px] font-medium text-ui-muted">
          Note <span className="font-normal">(optional if you picked a reason)</span>
        </label>
        <textarea
          id={`${idPrefix}-note`}
          ref={noteRef}
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="For example: move it to the 12th, after the event."
          className="ui-input ui-textarea mt-1 w-full resize-none"
        />
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={busy} className="ui-btn ui-btn-secondary h-10">
          Cancel
        </button>
        <button type="submit" disabled={!message || busy} className="ui-btn ui-btn-primary h-10">
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          {busy ? 'Sending…' : sendLabel}
        </button>
      </div>
    </form>
  );
};

interface Props {
  lines: GridLine[];
  people: GridPerson[];
  loading: boolean;
  busy: boolean;
  monthLabel: string;
  /** Approve these rows (the parent sends one request per plan). */
  onApprove: (rowIds: string[]) => Promise<boolean>;
  /** Send these rows back, each with its message. */
  onRequestChanges: (items: { rowId: string; comment: string }[]) => Promise<boolean>;
  onOpenDetails: (lineKey: string) => void;
  /** Whole monthly plan approval (existing rule and confirm dialog). */
  canApproveWhole: boolean;
  onApproveWhole: () => void;
  ownWaitingNote?: string;
}

/**
 * Reviewer screen for a month's plan: a queue of cards instead of the editing grid. Each waiting row
 * can be approved or sent back on the card (pick reasons, add a note); ticked rows are approved or
 * sent back together from the bar at the bottom.
 */
export const PlanGridReview: React.FC<Props> = ({
  lines,
  people,
  loading,
  busy,
  monthLabel,
  onApprove,
  onRequestChanges,
  onOpenDetails,
  canApproveWhole,
  onApproveWhole,
  ownWaitingNote,
}) => {
  const rows = useMemo(() => lines.filter((l): l is GridLine & { saved: GridRow } => Boolean(l.saved)), [lines]);
  const counts = useMemo(
    () => ({
      waiting: rows.filter((l) => l.saved.rowStatus === 'submitted').length,
      changes: rows.filter((l) => l.saved.rowStatus === 'changes_requested').length,
      approved: rows.filter((l) => l.saved.rowStatus === 'approved').length,
      all: rows.length,
    }),
    [rows]
  );
  const [tab, setTab] = useState<Tab>('waiting');
  const shown = rows.filter((l) => inTab(l.saved, tab));
  const decidable = (row: GridRow) => row.rowStatus === 'submitted' && !row.ownRow;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openForm, setOpenForm] = useState<string | null>(null); // rowId with the inline change form open
  const [bulkOpen, setBulkOpen] = useState(false);
  // Drop selections that are no longer decidable (after a decision or reload).
  useEffect(() => {
    setSelected((cur) => new Set([...cur].filter((id) => rows.some((l) => l.saved.rowId === id && decidable(l.saved)))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const decidableShown = shown.filter((l) => decidable(l.saved));
  const allShownSelected = decidableShown.length > 0 && decidableShown.every((l) => selected.has(l.saved.rowId));
  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const total = counts.all || 1;
  const pct = (n: number) => `${Math.round((n / total) * 100)}%`;

  const teamOf = (row: GridRow) =>
    row.stages.map((s) => {
      const ownerId = row.ownerIds[s];
      const name = ownerId ? people.find((p) => p._id === ownerId)?.name || String((row as unknown as Record<string, unknown>)[OWNER_FIELD_BY_STAGE[s]] || '') : String((row as unknown as Record<string, unknown>)[OWNER_FIELD_BY_STAGE[s]] || '');
      return { s, name, due: row.stepDeadlines[s] || '' };
    });

  return (
    <section aria-labelledby="plan-review-title" className="space-y-4 pb-24">
      {/* Summary: where the month's review stands */}
      <div className="glass-panel rounded-ui-panel p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="plan-review-title" className="text-base font-semibold text-ui-ink">
              Review · {monthLabel}
            </h2>
            <p className="text-[13px] text-ui-muted">
              {loading
                ? 'Loading…'
                : counts.waiting
                  ? `${counts.waiting} ${counts.waiting === 1 ? 'row is' : 'rows are'} waiting for your decision.`
                  : 'Nothing is waiting for review.'}
            </p>
          </div>
          <button
            type="button"
            className="ui-btn ui-btn-secondary h-10"
            disabled={!canApproveWhole || busy}
            title={ownWaitingNote || (!canApproveWhole && counts.waiting > 0 ? 'Some rows are still drafts or sent back, so approve rows one by one.' : undefined)}
            onClick={onApproveWhole}
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            Approve whole plan
          </button>
        </div>

        {counts.all > 0 && (
          <div>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-ui-line" aria-hidden="true">
              <span className="h-full bg-emerald-500" style={{ width: pct(counts.approved) }} />
              <span className="h-full bg-amber-400" style={{ width: pct(counts.waiting) }} />
              <span className="h-full bg-ui-coral" style={{ width: pct(counts.changes) }} />
            </div>
            <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ui-muted">
              <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-emerald-500" aria-hidden="true" />{counts.approved} approved</span>
              <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-amber-400" aria-hidden="true" />{counts.waiting} waiting</span>
              <span><span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-ui-coral" aria-hidden="true" />{counts.changes} sent back</span>
              <span>{counts.all - counts.approved - counts.waiting - counts.changes} drafts</span>
            </p>
          </div>
        )}
        {ownWaitingNote && <p className="text-xs text-ui-muted" data-testid="own-rows-note">{ownWaitingNote}</p>}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div role="tablist" aria-label="Rows to show" className="flex items-center rounded-full border border-ui-line bg-white/60 p-0.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={`inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors ${
                  tab === t.key ? 'bg-ui-ink text-white' : 'text-ui-muted hover:text-ui-ink'
                }`}
              >
                {t.label}
                <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${tab === t.key ? 'bg-white/20' : 'bg-ui-line'}`}>{counts[t.key]}</span>
              </button>
            ))}
          </div>
          {decidableShown.length > 0 && (
            <label className="inline-flex items-center gap-2 text-[13px] text-ui-text">
              <input
                type="checkbox"
                className="h-4 w-4 accent-ui-ink"
                checked={allShownSelected}
                onChange={(e) =>
                  setSelected((cur) => {
                    const n = new Set(cur);
                    for (const l of decidableShown) (e.target.checked ? n.add(l.saved.rowId) : n.delete(l.saved.rowId));
                    return n;
                  })
                }
              />
              Select all waiting ({decidableShown.length})
            </label>
          )}
        </div>
      </div>

      {/* Queue */}
      {shown.length === 0 && !loading ? (
        <div className="glass-card rounded-ui-card p-10 text-center">
          <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold text-ui-ink">{tab === 'waiting' ? 'All caught up' : 'No rows here'}</p>
          <p className="text-[13px] text-ui-muted">{tab === 'waiting' ? 'There is nothing waiting for your review right now.' : 'Try another tab.'}</p>
        </div>
      ) : (
        <ul className="space-y-3" aria-label="Rows to review">
          {shown.map((l) => {
            const row = l.saved;
            const can = decidable(row);
            const st = STATUS[row.rowStatus];
            const team = teamOf(row);
            const dues = team.map((t) => t.due).filter(Boolean).sort();
            const date = row.postingDate ? new Date(`${row.postingDate}T00:00:00Z`) : null;
            const formOpen = openForm === row.rowId;
            const workflow = row.workflow ? ROW_WORKFLOW_LABELS[row.workflow as keyof typeof ROW_WORKFLOW_LABELS] : '';
            return (
              <li
                key={l.key}
                className={`glass-card rounded-ui-card border transition-colors ${selected.has(row.rowId) ? 'border-ui-ink' : 'border-transparent'}`}
                aria-label={`${row.topic}, ${st.label}`}
              >
                <div className="flex gap-4 p-4 sm:p-5">
                  {/* Select + date */}
                  <div className="flex shrink-0 flex-col items-center gap-2">
                    {can ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-ui-ink"
                        aria-label={`Select ${row.topic}`}
                        checked={selected.has(row.rowId)}
                        onChange={() => toggle(row.rowId)}
                      />
                    ) : (
                      <span className="h-4 w-4" aria-hidden="true" />
                    )}
                    <div className="flex h-14 w-14 flex-col items-center justify-center rounded-2xl bg-white text-ui-ink shadow-ui-card" aria-hidden="true">
                      <span className="text-lg font-bold leading-none tabular-nums">{date ? date.getUTCDate() : '–'}</span>
                      <span className="mt-0.5 text-[10px] font-semibold uppercase text-ui-muted">
                        {date ? date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' }) : ''}
                      </span>
                    </div>
                  </div>

                  {/* Content */}
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className="text-[15px] font-semibold leading-snug text-ui-ink">{row.topic}</h3>
                        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ui-muted">
                          <span className="sr-only">Posting date {formatGridDate(row.postingDate)}.</span>
                          <span className="rounded-full bg-white px-2 py-0.5 font-medium text-ui-text">{row.type}</span>
                          {workflow && <span className="rounded-full bg-white px-2 py-0.5">{workflow}</span>}
                          {row.planKind === 'individual' && (
                            <span className="status-chip status-not-started text-[11px]" title={row.planCode ? `Individual work · ${row.planCode}` : 'Individual work'}>
                              Individual
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {row.ownRow && row.rowStatus === 'submitted' && (
                          <span className="status-chip status-not-started text-[11px]" title="You added or submitted this row: another approver decides it.">
                            Yours
                          </span>
                        )}
                        <span className={`status-chip ${st.tone} text-[11px]`}>{st.label}</span>
                      </div>
                    </div>

                    {row.brief ? (
                      <p className="line-clamp-2 text-[13px] leading-relaxed text-ui-text">{row.brief}</p>
                    ) : (
                      <p className="text-[13px] italic text-ui-muted">No brief.</p>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ui-muted">
                      <span className="flex -space-x-1.5" aria-hidden="true">
                        {team.map(({ s, name }) => (
                          <span
                            key={s}
                            title={`${STAGE_LABEL[s]}: ${name || 'no owner yet'}`}
                            className={`flex h-6 w-6 items-center justify-center rounded-full text-[9px] font-bold ring-2 ring-white ${
                              name ? 'bg-ui-ink text-white' : 'border border-dashed border-ui-coral bg-white text-ui-coral'
                            }`}
                          >
                            {name ? initials(name) : '?'}
                          </span>
                        ))}
                      </span>
                      <span>{team.map((t) => `${STAGE_LABEL[t.s]}${t.name ? ` · ${t.name}` : ''}`).join('  ·  ')}</span>
                      {dues.length > 0 && (
                        <span className="tabular-nums">
                          Due {dues[0] === dues[dues.length - 1] ? shortDate(dues[0]) : `${shortDate(dues[0])} – ${shortDate(dues[dues.length - 1])}`}
                        </span>
                      )}
                    </div>

                    {row.rowStatus === 'changes_requested' && row.reviewFeedback && (
                      <p className="status-tint status-changes rounded-ui-control px-3 py-1.5 text-xs">
                        <span className="font-semibold">Your note: </span>
                        {row.reviewFeedback}
                      </p>
                    )}

                    {/* Actions */}
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      {can && !formOpen && (
                        <>
                          <button
                            type="button"
                            className="ui-btn ui-btn-primary h-9 min-h-0 px-3.5"
                            disabled={busy}
                            onClick={() => onApprove([row.rowId])}
                            aria-label={`Approve ${row.topic}`}
                          >
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                            Approve
                          </button>
                          <button
                            type="button"
                            className="ui-btn ui-btn-secondary h-9 min-h-0 px-3.5"
                            disabled={busy}
                            onClick={() => setOpenForm(row.rowId)}
                            aria-label={`Request changes on ${row.topic}`}
                            aria-expanded={false}
                          >
                            <MessageSquare className="h-4 w-4" aria-hidden="true" />
                            Request changes
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="ui-btn h-9 min-h-0 px-3 text-ui-muted hover:text-ui-ink"
                        onClick={() => onOpenDetails(l.key)}
                        aria-label={`Details: ${row.topic}`}
                        title="All fields, history and suggested values"
                      >
                        <PanelRightOpen className="h-4 w-4" aria-hidden="true" />
                        Details
                      </button>
                    </div>
                  </div>
                </div>

                {formOpen && (
                  <div className="border-t border-ui-line bg-white/50 px-4 py-4 sm:px-5 rounded-b-ui-card">
                    <ChangeForm
                      idPrefix={`change-${row.rowId}`}
                      busy={busy}
                      sendLabel="Send back"
                      onCancel={() => setOpenForm(null)}
                      onSend={async (message) => {
                        const ok = await onRequestChanges([{ rowId: row.rowId, comment: message }]);
                        if (ok) setOpenForm(null);
                      }}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* Bulk bar: several rows at once */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-4 z-40 flex justify-center px-4" role="region" aria-label="Selected rows">
          <div className="w-full max-w-2xl rounded-ui-card border border-white/70 bg-white/95 shadow-ui-modal backdrop-blur-xl">
            {bulkOpen ? (
              <div className="p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-semibold text-ui-ink">Send {selected.size} {selected.size === 1 ? 'row' : 'rows'} back with one message</p>
                  <button type="button" className="ui-icon-btn h-9 w-9" aria-label="Close" onClick={() => setBulkOpen(false)}>
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
                <ChangeForm
                  idPrefix="change-bulk"
                  busy={busy}
                  sendLabel={`Send back (${selected.size})`}
                  onCancel={() => setBulkOpen(false)}
                  onSend={async (message) => {
                    const ok = await onRequestChanges([...selected].map((rowId) => ({ rowId, comment: message })));
                    if (ok) {
                      setBulkOpen(false);
                      setSelected(new Set());
                    }
                  }}
                />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="mr-auto text-sm font-semibold text-ui-ink">
                  {selected.size} selected
                </span>
                <button type="button" className="ui-btn h-9 min-h-0 px-3 text-ui-muted hover:text-ui-ink" onClick={() => setSelected(new Set())}>
                  <X className="h-4 w-4" aria-hidden="true" />
                  Clear
                </button>
                <button type="button" className="ui-btn ui-btn-secondary h-10" disabled={busy} onClick={() => setBulkOpen(true)}>
                  <ChevronUp className="h-4 w-4" aria-hidden="true" />
                  Request changes ({selected.size})
                </button>
                <button
                  type="button"
                  className="ui-btn ui-btn-primary h-10"
                  disabled={busy}
                  onClick={async () => {
                    const ok = await onApprove([...selected]);
                    if (ok) setSelected(new Set());
                  }}
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                  Approve ({selected.size})
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
