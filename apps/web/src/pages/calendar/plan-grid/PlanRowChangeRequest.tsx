import React, { useEffect, useRef, useState } from 'react';
import { History, Wand2 } from 'lucide-react';
import {
  ROW_WORKFLOW_LABELS,
  defaultWorkflowFor,
  formatGridDate,
  workflowOptionsFor,
  type PlanRowSuggestions,
  type RowWorkflow,
} from '@mmp/shared';
import { apiFetch } from '../../../lib/api';
import { useDialogFocus } from '../../../lib/useDialogFocus';
import type { GridRow, RowChangeRequest } from './types';

/**
 * Phase 13: a lead's change request on a plan row. The lead writes what should change and may
 * suggest new values; the SM Manager sees "current → suggested" for each value, applies the
 * suggestion (or edits by hand) and resubmits. The row history keeps every request.
 */

const FIELD_LABEL: Record<keyof PlanRowSuggestions, string> = {
  postingDate: 'Posting date',
  topic: 'Topic',
  type: 'Type',
  workflow: 'Workflow',
  brief: 'Brief',
};
const FIELD_ORDER: (keyof PlanRowSuggestions)[] = ['postingDate', 'topic', 'type', 'workflow', 'brief'];

function showValue(field: keyof PlanRowSuggestions, value: string | null | undefined): string {
  if (!value) return '—';
  if (field === 'postingDate') return formatGridDate(value);
  if (field === 'workflow') return ROW_WORKFLOW_LABELS[value as RowWorkflow] || value;
  return value;
}

function currentOf(row: GridRow, field: keyof PlanRowSuggestions): string {
  if (field === 'type') return row.type;
  if (field === 'workflow') return row.workflow || '';
  return String(row[field] ?? '');
}

/** "16 Nov → 18 Nov" lines: each suggested value next to the row's value now. */
export const SuggestionList: React.FC<{ row: GridRow; suggestions: PlanRowSuggestions; before?: Partial<Record<keyof PlanRowSuggestions, string>> }> = ({
  row,
  suggestions,
  before,
}) => {
  const fields = FIELD_ORDER.filter((f) => suggestions[f]);
  if (!fields.length) return null;
  return (
    <dl className="space-y-1">
      {fields.map((f) => (
        <div key={f} className="text-sm">
          <dt className="inline font-semibold text-ui-ink">{FIELD_LABEL[f]}: </dt>
          <dd className="inline text-ui-text break-words">
            <span>{showValue(f, before ? before[f] : currentOf(row, f))}</span>
            <span> → </span>
            <strong className="text-ui-ink">{showValue(f, suggestions[f])}</strong>
          </dd>
        </div>
      ))}
    </dl>
  );
};

/** What the SM Manager sees on a row sent back: the message, the suggestion, Apply. */
export const ChangeRequestBanner: React.FC<{
  row: GridRow;
  request: RowChangeRequest;
  canApply: boolean;
  isBusy: boolean;
  onApply?: () => void;
}> = ({ row, request, canApply, isBusy, onApply }) => {
  const hasSuggestion = FIELD_ORDER.some((f) => request.suggestions?.[f]);
  return (
    <section aria-labelledby="row-change-request-title" className="status-tint status-changes rounded-ui-card p-3 space-y-2">
      <h3 id="row-change-request-title" className="text-xs font-semibold text-ui-ink">Changes requested</h3>
      <p className="text-sm text-ui-text whitespace-pre-wrap">{request.message}</p>
      {hasSuggestion && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-ui-ink">Suggested values</p>
          <SuggestionList row={row} suggestions={request.suggestions} />
        </div>
      )}
      {canApply && (
        <div className="space-y-2">
          {hasSuggestion && onApply && (
            <button type="button" className="ui-btn ui-btn-primary h-11 w-full sm:w-auto" disabled={isBusy} onClick={onApply}>
              <Wand2 className="w-4 h-4" aria-hidden="true" />
              Apply suggestion
            </button>
          )}
          <p className="text-xs text-ui-muted">
            {hasSuggestion ? 'Or edit the row by hand below.' : 'Edit the row below.'} Then resubmit it: it goes back to the same lead.
          </p>
        </div>
      )}
    </section>
  );
};

/** The lead's optional suggested values, next to the row's values now. */
export const SuggestFields: React.FC<{
  row: GridRow;
  month: string;
  types: string[];
  value: PlanRowSuggestions;
  errors?: Partial<Record<keyof PlanRowSuggestions, string>>;
  onChange: (next: PlanRowSuggestions) => void;
}> = ({ row, month, types, value, errors = {}, onChange }) => {
  const set = (k: keyof PlanRowSuggestions, v: string) => onChange({ ...value, [k]: v });
  const typeNow = value.type || row.type;
  const workflowChoices = workflowOptionsFor(typeNow);
  const [y, m] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const hint = (k: keyof PlanRowSuggestions) => `Now: ${showValue(k, currentOf(row, k))}`;
  const err = (k: keyof PlanRowSuggestions, id: string) =>
    errors[k] ? <p id={`${id}-error`} className="text-xs text-ui-ink status-tint status-changes rounded-ui-control px-2 py-1">{errors[k]}</p> : null;
  const described = (k: keyof PlanRowSuggestions, id: string) => ({
    'aria-invalid': errors[k] ? true : undefined,
    'aria-describedby': `${id}-hint${errors[k] ? ` ${id}-error` : ''}`,
  });
  return (
    <fieldset className="space-y-3">
      <legend className="text-xs font-semibold text-ui-text">Suggest new values (optional)</legend>
      <div className="space-y-1">
        <label htmlFor="suggest-date" className="block text-xs font-semibold text-ui-text">Posting date</label>
        <input
          id="suggest-date"
          type="date"
          className="ui-input h-11 w-full"
          min={`${month}-01`}
          max={`${month}-${String(lastDay).padStart(2, '0')}`}
          value={value.postingDate || ''}
          onChange={(e) => set('postingDate', e.target.value)}
          {...described('postingDate', 'suggest-date')}
        />
        <p id="suggest-date-hint" className="text-xs text-ui-muted">{hint('postingDate')}</p>
        {err('postingDate', 'suggest-date')}
      </div>
      <div className="space-y-1">
        <label htmlFor="suggest-topic" className="block text-xs font-semibold text-ui-text">Topic</label>
        <input id="suggest-topic" className="ui-input h-11 w-full" value={value.topic || ''} onChange={(e) => set('topic', e.target.value)} {...described('topic', 'suggest-topic')} />
        <p id="suggest-topic-hint" className="text-xs text-ui-muted break-words">{hint('topic')}</p>
        {err('topic', 'suggest-topic')}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label htmlFor="suggest-type" className="block text-xs font-semibold text-ui-text">Type</label>
          <select
            id="suggest-type"
            className="ui-select h-11 w-full"
            value={value.type || ''}
            // A new type starts at its default workflow, as in the row editor.
            onChange={(e) => onChange({ ...value, type: e.target.value, workflow: e.target.value ? defaultWorkflowFor(e.target.value) ?? '' : '' })}
            {...described('type', 'suggest-type')}
          >
            <option value="">Keep {row.type}</option>
            {types.filter((t) => t !== row.type).map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <p id="suggest-type-hint" className="text-xs text-ui-muted">{hint('type')}</p>
          {err('type', 'suggest-type')}
        </div>
        {workflowChoices.length > 0 && (
          <div className="space-y-1">
            <label htmlFor="suggest-workflow" className="block text-xs font-semibold text-ui-text">Workflow</label>
            <select id="suggest-workflow" className="ui-select h-11 w-full" value={value.workflow || ''} onChange={(e) => set('workflow', e.target.value)} {...described('workflow', 'suggest-workflow')}>
              {!value.type && <option value="">Keep {showValue('workflow', row.workflow || '')}</option>}
              {workflowChoices.map((w) => <option key={w} value={w}>{ROW_WORKFLOW_LABELS[w]}</option>)}
            </select>
            <p id="suggest-workflow-hint" className="text-xs text-ui-muted">{hint('workflow')}</p>
            {err('workflow', 'suggest-workflow')}
          </div>
        )}
      </div>
      <div className="space-y-1">
        <label htmlFor="suggest-brief" className="block text-xs font-semibold text-ui-text">Brief</label>
        <textarea id="suggest-brief" className="ui-input ui-textarea w-full min-h-[72px]" value={value.brief || ''} onChange={(e) => set('brief', e.target.value)} {...described('brief', 'suggest-brief')} />
        <p id="suggest-brief-hint" className="text-xs text-ui-muted line-clamp-2 break-words">{hint('brief')}</p>
        {err('brief', 'suggest-brief')}
      </div>
    </fieldset>
  );
};

/** Only the suggested values that were filled in and differ from the row now. */
export function cleanSuggestions(row: GridRow, value: PlanRowSuggestions): PlanRowSuggestions | undefined {
  const out: PlanRowSuggestions = {};
  for (const f of FIELD_ORDER) {
    const v = (value[f] || '').trim();
    if (v && v !== currentOf(row, f)) out[f] = v;
  }
  // A workflow only counts when the type allows a choice.
  if (out.workflow && !workflowOptionsFor(out.type || row.type).length) delete out.workflow;
  return Object.keys(out).length ? out : undefined;
}

interface HistoryEvent {
  action: 'changes_requested' | 'suggestion_applied' | 'resubmitted' | 'approved';
  at: string;
  by: { name: string; role: string } | null;
  message: string;
  suggestions: PlanRowSuggestions | null;
  applied: PlanRowSuggestions | null;
  before: PlanRowSuggestions | null;
  withPlan: boolean;
}

const EVENT_LABEL: Record<HistoryEvent['action'], string> = {
  changes_requested: 'Changes requested',
  suggestion_applied: 'Suggestion applied',
  resubmitted: 'Resubmitted',
  approved: 'Approved',
};

/** The row's history: every request, applied suggestion, resubmit and approval. */
export const RowHistory: React.FC<{ planId: string; row: GridRow; refreshKey?: string }> = ({ planId, row, refreshKey }) => {
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    apiFetch<{ data: HistoryEvent[] }>(`/api/calendar-plans/${planId}/rows/${row.rowId}/history`)
      .then((res) => alive && setEvents(Array.isArray(res?.data) ? res.data : []))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [planId, row.rowId, refreshKey]);
  if (failed || !events || events.length === 0) return null;
  return (
    <section aria-labelledby="row-history-title" className="space-y-2">
      <h3 id="row-history-title" className="flex items-center gap-1.5 text-xs font-semibold text-ui-text">
        <History className="w-3.5 h-3.5" aria-hidden="true" />
        Row history
      </h3>
      <ol className="space-y-2">
        {events.map((e, i) => (
          <li key={i} className="glass-card rounded-ui-card p-3 space-y-1">
            <p className="text-sm text-ui-ink">
              <span className="font-semibold">{EVENT_LABEL[e.action]}</span>
              {e.withPlan ? (e.action === 'resubmitted' ? ' with the plan' : ' on the whole plan') : ''}
              {e.by ? ` · ${e.by.name}` : ''}
            </p>
            <p className="text-xs text-ui-muted">{new Date(e.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
            {e.message && e.action === 'changes_requested' && <p className="text-sm text-ui-text whitespace-pre-wrap">{e.message}</p>}
            {e.action === 'changes_requested' && e.suggestions && <SuggestionList row={row} suggestions={e.suggestions} before={e.before || undefined} />}
            {e.action === 'suggestion_applied' && e.applied && (
              <p className="text-sm text-ui-text">
                Applied: {FIELD_ORDER.filter((f) => e.applied?.[f]).map((f) => `${FIELD_LABEL[f]} ${showValue(f, e.applied?.[f])}`).join(', ')}
              </p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
};

/** Whole-plan Request changes: one message to every submitted row; approved rows are untouched. */
export const PlanChangesDialog: React.FC<{
  submittedCount: number;
  isBusy: boolean;
  onSend: (message: string) => void;
  onCancel: () => void;
}> = ({ submittedCount, isBusy, onSend, onCancel }) => {
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useDialogFocus(ref, true, onCancel, { initialFocusRef: inputRef });
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="plan-changes-title" className="glass-modal w-full max-w-md p-5 space-y-4">
        <h2 id="plan-changes-title" className="text-base font-bold text-ui-ink">Request changes on the plan</h2>
        <p className="text-sm text-ui-text">
          All {submittedCount} submitted {submittedCount === 1 ? 'row goes' : 'rows go'} back to the SM Manager with this message. Approved rows stay approved.
        </p>
        <div className="space-y-1">
          <label htmlFor="plan-changes-message" className="block text-xs font-semibold text-ui-text">What should change</label>
          <textarea
            ref={inputRef}
            id="plan-changes-message"
            className="ui-input ui-textarea w-full min-h-[96px]"
            value={message}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'plan-changes-error' : undefined}
            onChange={(e) => {
              setMessage(e.target.value);
              setError(null);
            }}
          />
          {error && <p id="plan-changes-error" className="text-xs text-ui-ink status-tint status-changes rounded-ui-control px-2 py-1">{error}</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel} className="ui-btn ui-btn-secondary h-11">Cancel</button>
          <button
            type="button"
            disabled={isBusy}
            className="ui-btn ui-btn-primary h-11"
            onClick={() => {
              if (!message.trim()) {
                setError('Write what should change before sending the plan back.');
                return;
              }
              onSend(message.trim());
            }}
          >
            {isBusy ? 'Sending…' : 'Send back'}
          </button>
        </div>
      </div>
    </div>
  );
};
