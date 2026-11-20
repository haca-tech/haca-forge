import React, { useCallback, useEffect, useState } from 'react';
import { PlayCircle, Send } from 'lucide-react';
import { apiFetch } from '../../../lib/api';
import { StepSubmitDialog } from '../../../components/StepSubmitDialog';
import { timeAgo } from '../FeedbackPage';

/**
 * Review Studio in "my review" mode: the step owner reads and replies; decisions stay with the
 * leads. Status, decision and rating messages come from the Review Hub step timeline, which
 * already follows the Phase 3 privacy rules.
 */

interface TimelineEvent {
  kind: string;
  at: string;
  by?: string;
  version?: number;
  message?: string;
  rootCause?: string | null;
  rating?: number | null;
}
export interface OwnerTimeline {
  step: { _id: string; title: string; stageKey: string; status: string; reviewState: string | null; version: number | null };
  mainAction: { kind: string; href?: string };
  events: TimelineEvent[];
}

/** The step's timeline for the owner; reload after an action. */
export function useOwnerTimeline(workItemId: string | null, enabled: boolean) {
  const [data, setData] = useState<OwnerTimeline | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!enabled || !workItemId) return;
    let alive = true;
    apiFetch<{ data: OwnerTimeline }>(`/api/review-hub/steps/${workItemId}/timeline`)
      .then((res) => alive && setData(res.data))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [workItemId, enabled, reload]);
  return { data, refresh: useCallback(() => setReload((k) => k + 1), []) };
}

const lastOf = (events: TimelineEvent[], kinds: string[]) => [...events].reverse().find((e) => kinds.includes(e.kind));

/**
 * The comments that request-revision saved for its note. They carry no marker, so each is
 * matched to a "changes requested" event: a first comment (no pin) with the same text, written
 * within two minutes of the decision. Returns event time -> comment id.
 */
export function revisionRequestComments(
  timeline: OwnerTimeline | null,
  comments: Array<{ id: string; content?: string; text?: string; createdAt: string; parentId?: string | null; anchor?: { type?: string } | null }>,
): Map<string, string> {
  const found = new Map<string, string>();
  if (!timeline) return found;
  const used = new Set<string>();
  for (const e of timeline.events) {
    if (e.kind !== 'changes_requested' || !e.message) continue;
    const at = new Date(e.at).getTime();
    const match = comments.find(
      (c) =>
        !c.parentId &&
        !c.anchor?.type &&
        !used.has(c.id) &&
        (c.content ?? c.text ?? '').trim() === e.message!.trim() &&
        Math.abs(new Date(c.createdAt).getTime() - at) <= 2 * 60 * 1000,
    );
    if (match) {
      used.add(match.id);
      found.set(e.at, match.id);
    }
  }
  return found;
}

/** "Waiting for review" | "Changes requested" | "Approved ★4" | "Rework in progress", with a tone. */
export function ownerStatus(t: OwnerTimeline | null): { label: string; tone: string; since: string } {
  if (!t) return { label: '', tone: 'status-not-started', since: '' };
  const { step, events } = t;
  if (step.status === 'Approved' || step.status === 'Published') {
    const approved = lastOf(events, ['approved']);
    return { label: `Approved${approved?.rating ? ` ★${approved.rating}` : ''}`, tone: 'status-approved', since: approved ? `approved ${timeAgo(approved.at)}` : '' };
  }
  if (step.reviewState === 'changes_requested') {
    const sent = lastOf(events, ['changes_requested']);
    return { label: 'Changes requested', tone: 'status-changes', since: sent ? `sent back ${timeAgo(sent.at)}` : '' };
  }
  if (step.reviewState === 'rework_in_progress') {
    const started = lastOf(events, ['rework_started']);
    return { label: 'Rework in progress', tone: 'status-in-progress', since: started ? `started ${timeAgo(started.at)}` : '' };
  }
  const submitted = lastOf(events, ['submitted']);
  return { label: 'Waiting for review', tone: 'status-waiting', since: submitted ? `waiting ${timeAgo(submitted.at).replace(' ago', '')}` : '' };
}

/** Header strip: step, version selector, review status chip and the waiting time. */
export const OwnerReviewHeader: React.FC<{
  timeline: OwnerTimeline | null;
  versions: Array<{ id: string; versionNumber: number }>;
  activeVersionId: string;
  onSelectVersion: (id: string) => void;
}> = ({ timeline, versions, activeVersionId, onSelectVersion }) => {
  const status = ownerStatus(timeline);
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2 border-b border-ui-line bg-white/60 text-sm" data-testid="owner-review-header">
      <span className="font-semibold text-ui-ink break-words">{timeline?.step.title || 'My review'}</span>
      {timeline?.step.stageKey && <span className="status-chip status-not-started text-[11px]">{timeline.step.stageKey}</span>}
      {status.label && (
        <span className={`status-chip ${status.tone} text-[11px]`} data-testid="owner-review-status">
          {status.label}
        </span>
      )}
      {status.since && <span className="text-xs text-ui-muted">{status.since}</span>}
      {versions.length > 0 && (
        <span className="ml-auto flex items-center gap-1.5">
          <label htmlFor="owner-version" className="text-xs text-ui-muted">
            Version
          </label>
          <select id="owner-version" className="ui-select h-11" value={activeVersionId} onChange={(e) => onSelectVersion(e.target.value)}>
            {[...versions]
              .sort((a, b) => b.versionNumber - a.versionNumber)
              .map((v) => (
                <option key={v.id} value={v.id}>
                  v{v.versionNumber}
                </option>
              ))}
          </select>
        </span>
      )}
    </div>
  );
};

/** Bottom bar: the lead's decision (and rating) message, then the owner's next action. */
export const OwnerReviewBar: React.FC<{
  timeline: OwnerTimeline | null;
  onChanged: () => void;
  /** Event time -> the revision-request comment in the thread. */
  revisionComments?: Map<string, string>;
  onShowComment?: (commentId: string) => void;
}> = ({ timeline, onChanged, revisionComments, onShowComment }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resubmitting, setResubmitting] = useState(false);
  if (!timeline) return null;
  const { step, mainAction, events } = timeline;
  const decision = lastOf(events, ['changes_requested', 'approved']);
  // The revision note is already in the thread: link to it instead of repeating it.
  const requestCommentId = decision?.kind === 'changes_requested' ? revisionComments?.get(decision.at) : undefined;
  const startRework = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/work/${step._id}/transition`, { method: 'POST', body: JSON.stringify({ toStatus: 'In Progress' }) });
      onChanged();
    } catch (err: any) {
      setError(err?.message || 'Could not start rework.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-ui-line bg-ui-card/95 px-3 sm:px-4 py-3 space-y-2 flex-shrink-0" data-testid="owner-review-bar">
      {decision ? (
        <div className="text-sm" data-testid="owner-decision">
          <p className="font-semibold text-ui-ink">
            {decision.kind === 'approved' ? 'Approved' : 'Changes requested'}
            {decision.by ? ` by ${decision.by}` : ''}
            {decision.version ? ` (version ${decision.version})` : ''}
            {decision.kind === 'approved' && decision.rating ? (
              <span className="ml-2" aria-label={`Rated ${decision.rating} out of 5`}>
                {'★'.repeat(decision.rating)}
                {'☆'.repeat(5 - decision.rating)}
              </span>
            ) : null}
          </p>
          {requestCommentId ? (
            <a
              href={`#comment-${requestCommentId}`}
              onClick={(e) => {
                e.preventDefault();
                onShowComment?.(requestCommentId);
              }}
              className="inline-flex items-center min-h-[44px] font-semibold text-ui-ink underline underline-offset-2"
              data-testid="see-revision-request"
            >
              See revision request
            </a>
          ) : (
            decision.message && <p className="text-ui-text whitespace-pre-wrap break-words">{decision.message}</p>
          )}
          {decision.rootCause && <p className="text-xs text-ui-muted">Root cause: {decision.rootCause}</p>}
        </div>
      ) : (
        <p className="text-sm text-ui-muted">No decision yet. The lead reviews this version.</p>
      )}
      {error && (
        <p role="alert" className="text-xs font-semibold text-ui-ink">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {mainAction.kind === 'start_rework' && (
          <button type="button" disabled={busy} onClick={startRework} className="ui-btn ui-btn-primary h-11 gap-1.5">
            <PlayCircle className="w-4 h-4" aria-hidden="true" /> {busy ? 'Starting…' : 'Start rework'}
          </button>
        )}
        {mainAction.kind === 'resubmit' && (
          <button type="button" onClick={() => setResubmitting(true)} className="ui-btn ui-btn-primary h-11 gap-1.5">
            <Send className="w-4 h-4" aria-hidden="true" /> Resubmit link
          </button>
        )}
      </div>
      {resubmitting && (
        <StepSubmitDialog
          step={{ _id: step._id, title: step.title, stageKey: step.stageKey }}
          resubmit
          onClose={() => setResubmitting(false)}
          onDone={async () => {
            setResubmitting(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
};
