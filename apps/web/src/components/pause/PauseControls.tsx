import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Hourglass, PauseCircle, PlayCircle, X, XCircle } from 'lucide-react';
import { PAUSE_NOTE_MAX, PAUSE_REASON_LABELS, formatDuration, istDateKey, type PauseReason } from '@mmp/shared';
import { apiFetch } from '../../lib/api';
import { useDialogFocus } from '../../lib/useDialogFocus';

/** A request as the API shows it on Work Detail and My Work. */
export interface PauseRequestView {
  _id: string;
  reason: PauseReason;
  reasonLabel: string;
  note: string;
  urgentStep: { _id: string; title: string } | null;
  pauseUntil: string | null;
  requestedAt: string;
  decidedAt?: string | null;
  decisionMessage?: string;
}
export interface PauseInfo {
  state: 'requested' | 'paused' | null;
  request: PauseRequestView | null;
  active: PauseRequestView | null;
  lastRejected: PauseRequestView | null;
  count: number;
  totalMs: number;
  canRequest: boolean;
  canCancel: boolean;
  canDecide: boolean;
  canResume: boolean;
}

/** "16 Nov" for an IST date key. */
export function shortDay(key: string | null | undefined): string {
  if (!key) return '';
  const d = new Date(`${key}T00:00:00Z`);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

const reasonLine = (r: PauseRequestView) =>
  `${r.reasonLabel}${r.urgentStep?.title ? ` (${r.urgentStep.title})` : ''}: ${r.note}`;

export const pauseApi = {
  request: (id: string, body: Record<string, unknown>) => apiFetch(`/api/work/${id}/pause-request`, { method: 'POST', body: JSON.stringify(body) }),
  cancel: (id: string) => apiFetch(`/api/work/${id}/pause-request/cancel`, { method: 'POST' }),
  decide: (id: string, decision: 'approve' | 'reject', message?: string) =>
    apiFetch(`/api/work/${id}/pause-request/decide`, { method: 'POST', body: JSON.stringify({ decision, message: message || undefined }) }),
  resume: (id: string) => apiFetch(`/api/work/${id}/resume`, { method: 'POST' }),
};

/** "Request pause": reason, optional urgent step, a short note and an optional "pause until" date. */
export const RequestPauseDialog: React.FC<{
  stepId: string;
  stepTitle: string;
  /** The worker's own open steps (the urgent one can be picked from these). */
  openSteps?: Array<{ _id: string; title: string }>;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}> = ({ stepId, stepTitle, openSteps = [], onClose, onDone }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const [reason, setReason] = useState<PauseReason>('urgent_task');
  const [urgentStepId, setUrgentStepId] = useState('');
  const [note, setNote] = useState('');
  const [until, setUntil] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tomorrow = (() => {
    const d = new Date(`${istDateKey(new Date())}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const noteError = !note.trim() ? 'Add a short note for the lead.' : note.length > PAUSE_NOTE_MAX ? `Keep it under ${PAUSE_NOTE_MAX} characters.` : null;
  const urgentChoices = openSteps.filter((s) => s._id !== stepId);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setShowErrors(true);
    setError(null);
    if (noteError) return;
    setBusy(true);
    try {
      await pauseApi.request(stepId, {
        reason,
        note: note.trim(),
        urgentStepId: reason === 'urgent_task' && urgentStepId ? urgentStepId : undefined,
        pauseUntil: until || undefined,
      });
      await onDone();
    } catch (err: any) {
      setError(err?.message || 'Could not send the request.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="request-pause-title" className="glass-modal w-full max-w-md p-5 max-h-[92vh] overflow-y-auto">
        <form onSubmit={submit} className="space-y-4" noValidate>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id="request-pause-title" className="text-base font-bold text-ui-ink">Request pause</h2>
              <p className="text-sm text-ui-muted break-words">{stepTitle}</p>
            </div>
            <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
              <X className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
          <p className="text-xs text-ui-muted">The step's lead decides. Work time keeps counting until the pause is approved; the due date does not change.</p>
          <fieldset className="space-y-2">
            <legend className="text-[13px] font-medium text-ui-muted">Reason</legend>
            <div className="flex flex-wrap gap-2">
              {(['urgent_task', 'other'] as PauseReason[]).map((r) => (
                <label key={r} className={`inline-flex items-center gap-2 min-h-[44px] px-3 rounded-full border cursor-pointer ${reason === r ? 'border-ui-ink bg-white' : 'border-ui-line bg-white/60'}`}>
                  <input type="radio" name="pause-reason" value={r} checked={reason === r} onChange={() => setReason(r)} />
                  <span className="text-sm text-ui-ink">{PAUSE_REASON_LABELS[r]}</span>
                </label>
              ))}
            </div>
          </fieldset>
          {reason === 'urgent_task' && urgentChoices.length > 0 && (
            <div className="space-y-1.5">
              <label htmlFor="pause-urgent-step" className="block text-[13px] font-medium text-ui-muted">The urgent step (optional)</label>
              <select id="pause-urgent-step" className="ui-select h-11 w-full" value={urgentStepId} onChange={(e) => setUrgentStepId(e.target.value)}>
                <option value="">Not one of my steps</option>
                {urgentChoices.map((s) => <option key={s._id} value={s._id}>{s.title}</option>)}
              </select>
            </div>
          )}
          <div className="space-y-1.5">
            <label htmlFor="pause-note" className="block text-[13px] font-medium text-ui-muted">Note for the lead</label>
            <textarea
              id="pause-note"
              className="ui-input ui-textarea w-full min-h-[80px]"
              value={note}
              maxLength={PAUSE_NOTE_MAX + 50}
              onChange={(e) => setNote(e.target.value)}
              aria-invalid={showErrors && noteError ? true : undefined}
              aria-describedby={showErrors && noteError ? 'pause-note-error' : undefined}
            />
            {showErrors && noteError && <p id="pause-note-error" role="alert" className="text-xs text-red-700">{noteError}</p>}
          </div>
          <div className="space-y-1.5">
            <label htmlFor="pause-until" className="block text-[13px] font-medium text-ui-muted">Pause until (optional)</label>
            <input id="pause-until" type="date" className="ui-input h-11 w-full" min={tomorrow} value={until} onChange={(e) => setUntil(e.target.value)} aria-describedby="pause-until-hint" />
            <p id="pause-until-hint" className="text-xs text-ui-muted">You get a reminder that morning. The pause never ends by itself.</p>
          </div>
          {error && <p role="alert" className="p-3 rounded-xl status-tint status-changes text-xs font-semibold">{error}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <button type="button" onClick={onClose} className="ui-btn ui-btn-secondary h-11">Cancel</button>
            <button type="submit" disabled={busy} className="ui-btn ui-btn-primary h-11">{busy ? 'Sending…' : 'Send request'}</button>
          </div>
        </form>
      </div>
    </div>
  );
};

/** Reject with an optional message. */
export const RejectPauseDialog: React.FC<{ stepTitle: string; busy: boolean; onClose: () => void; onReject: (message: string) => void }> = ({ stepTitle, busy, onClose, onReject }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const [message, setMessage] = useState('');
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="reject-pause-title" className="glass-modal w-full max-w-md p-5 space-y-4">
        <h2 id="reject-pause-title" className="text-base font-bold text-ui-ink">Reject pause request</h2>
        <p className="text-sm text-ui-muted break-words">{stepTitle}: the step stays In Progress and its time keeps counting.</p>
        <div className="space-y-1.5">
          <label htmlFor="reject-pause-message" className="block text-[13px] font-medium text-ui-muted">Message to the worker (optional)</label>
          <textarea id="reject-pause-message" className="ui-input ui-textarea w-full min-h-[72px]" value={message} maxLength={PAUSE_NOTE_MAX} onChange={(e) => setMessage(e.target.value)} />
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className="ui-btn ui-btn-secondary h-11">Cancel</button>
          <button type="button" disabled={busy} onClick={() => onReject(message.trim())} className="ui-btn ui-btn-primary h-11">{busy ? 'Sending…' : 'Reject request'}</button>
        </div>
      </div>
    </div>
  );
};

/**
 * The step's pause state with the actions this viewer may take: Request pause (owner),
 * "Pause requested" with Cancel (owner) or Approve / Reject (the step's lead), and "Paused"
 * with Resume (owner, the lead, admin). Read-only viewers see the state only.
 */
export const PausePanel: React.FC<{
  stepId: string;
  stepTitle: string;
  pause?: PauseInfo | null;
  showStats?: boolean;
  /** For the urgent-step picker; loaded from My Work when not given. */
  openSteps?: Array<{ _id: string; title: string }>;
  onChanged: () => void | Promise<void>;
}> = ({ stepId, stepTitle, pause, showStats = false, openSteps, onChanged }) => {
  const [asking, setAsking] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mySteps, setMySteps] = useState<Array<{ _id: string; title: string }> | null>(openSteps || null);

  useEffect(() => {
    if (!asking || mySteps) return;
    apiFetch<{ data: any }>('/api/my-work')
      .then((res) => {
        const d = res?.data || {};
        const all = [...(d.overdue || []), ...(d.today || []), ...(d.thisWeek || []), ...(d.upcoming || [])];
        setMySteps(all.map((s: any) => ({ _id: String(s._id), title: s.title })));
      })
      .catch(() => setMySteps([]));
  }, [asking, mySteps]);

  if (!pause) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onChanged();
    } catch (err: any) {
      setError(err?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };
  const stats = showStats && pause.count > 0 && (
    <p className="text-xs text-ui-muted" data-testid="pause-stats">
      Paused {pause.count} {pause.count === 1 ? 'time' : 'times'} · {formatDuration(pause.totalMs)}
    </p>
  );

  return (
    <div className="space-y-2" data-testid="pause-panel">
      {pause.state === 'requested' && pause.request && (
        <section role="region" aria-label="Pause requested" className="status-tint status-waiting rounded-ui-card p-3 space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ui-ink">
            <Hourglass className="w-4 h-4" aria-hidden="true" /> Pause requested
          </p>
          <p className="text-sm text-ui-text break-words">{reasonLine(pause.request)}</p>
          {pause.request.pauseUntil && <p className="text-xs text-ui-muted">Until {shortDay(pause.request.pauseUntil)}</p>}
          <p className="text-xs text-ui-muted">Waiting for the step's lead. Work time keeps counting until it is approved.</p>
          <div className="flex flex-wrap gap-2">
            {pause.canCancel && (
              <button type="button" disabled={busy} onClick={() => run(() => pauseApi.cancel(stepId))} className="ui-btn ui-btn-secondary h-11">
                Cancel request
              </button>
            )}
            {pause.canDecide && (
              <>
                <button type="button" disabled={busy} onClick={() => run(() => pauseApi.decide(stepId, 'approve'))} className="ui-btn ui-btn-primary h-11 gap-1.5">
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Approve pause
                </button>
                <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="ui-btn ui-btn-secondary h-11 gap-1.5">
                  <XCircle className="w-4 h-4" aria-hidden="true" /> Reject
                </button>
              </>
            )}
          </div>
        </section>
      )}
      {pause.state === 'paused' && (
        <section role="region" aria-label="Paused" className="status-tint status-changes rounded-ui-card p-3 space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ui-ink">
            <PauseCircle className="w-4 h-4" aria-hidden="true" /> Paused
          </p>
          {pause.active && <p className="text-sm text-ui-text break-words">{reasonLine(pause.active)}</p>}
          {pause.active?.pauseUntil && <p className="text-xs text-ui-muted">Until {shortDay(pause.active.pauseUntil)} (a reminder that morning; resume when ready)</p>}
          <p className="text-xs text-ui-muted">Work time is stopped. The due date has not changed.</p>
          {pause.canResume && (
            <button type="button" disabled={busy} onClick={() => run(() => pauseApi.resume(stepId))} className="ui-btn ui-btn-primary h-11 gap-1.5">
              <PlayCircle className="w-4 h-4" aria-hidden="true" /> Resume
            </button>
          )}
        </section>
      )}
      {!pause.state && pause.lastRejected && (
        <p className="text-xs text-ui-muted" data-testid="pause-rejected">
          Last pause request not approved{pause.lastRejected.decisionMessage ? `: ${pause.lastRejected.decisionMessage}` : '.'}
        </p>
      )}
      {!pause.state && pause.canRequest && (
        <button type="button" onClick={() => setAsking(true)} className="ui-btn ui-btn-secondary h-11 gap-1.5">
          <PauseCircle className="w-4 h-4" aria-hidden="true" /> Request pause
        </button>
      )}
      {stats}
      {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
      {asking && (
        <RequestPauseDialog
          stepId={stepId}
          stepTitle={stepTitle}
          openSteps={mySteps || []}
          onClose={() => setAsking(false)}
          onDone={async () => {
            setAsking(false);
            await onChanged();
          }}
        />
      )}
      {rejecting && (
        <RejectPauseDialog
          stepTitle={stepTitle}
          busy={busy}
          onClose={() => setRejecting(false)}
          onReject={(message) => {
            setRejecting(false);
            run(() => pauseApi.decide(stepId, 'reject', message));
          }}
        />
      )}
    </div>
  );
};
