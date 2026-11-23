import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, PauseCircle, XCircle } from 'lucide-react';
import { CALENDAR_LIST, formatShortDateTime } from '@mmp/shared';
import { apiFetch } from '../../lib/api';
import { RejectPauseDialog, pauseApi, shortDay } from '../../components/pause/PauseControls';

import { DataLoader } from '../../components/DataLoader';
interface PendingItem {
  _id: string;
  workItem: { _id: string; title: string; stageKey?: string; status?: string; calendar: string };
  owner: { _id: string; name: string };
  reasonLabel: string;
  note: string;
  urgentStep: { _id: string; title: string } | null;
  pauseUntil: string | null;
  requestedAt: string;
  canDecide: boolean;
}

const calendarName = (key: string) => CALENDAR_LIST.find((c) => c.id === key)?.name || key;

/**
 * Pause requests waiting for a decision: each lead sees the calendars they decide (Growth
 * Lead: Ads; Creative Manager: the rest), admin and the read-only heads see all (heads without
 * actions). Approve, or reject with an optional message.
 */
export const PauseRequestsTab: React.FC<{ onCount?: (n: number) => void }> = ({ onCount }) => {
  const [items, setItems] = useState<PendingItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<PendingItem | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async () => {
    try {
      const res = await apiFetch<{ data: PendingItem[] }>('/api/work/pause-requests');
      const list = Array.isArray(res?.data) ? res.data : [];
      setItems(list);
      onCount?.(list.length);
    } catch (err: any) {
      setError(err?.message || 'Could not load pause requests.');
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (item: PendingItem, decision: 'approve' | 'reject', message?: string) => {
    setBusyId(item._id);
    setError(null);
    try {
      await pauseApi.decide(item.workItem._id, decision, message);
      setDone(decision === 'approve' ? `Approved: "${item.workItem.title}" is paused.` : `Rejected: "${item.workItem.title}" stays In Progress.`);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not save the decision.');
      await load();
    } finally {
      setBusyId(null);
    }
  };

  if (!items && !error) return (
    <div className="glass-card">
      <DataLoader label="Loading pause requests…" />
    </div>
  );

  return (
    <div className="space-y-3" data-testid="pause-requests-tab">
      {done && <p role="status" className="p-3 status-tint status-approved rounded-xl text-xs font-semibold">{done}</p>}
      {error && <p role="alert" className="p-3 status-tint status-changes rounded-xl text-xs font-semibold">{error}</p>}
      {items && items.length === 0 && (
        <div className="glass-card p-10 text-center space-y-2">
          <PauseCircle className="w-8 h-8 mx-auto text-ui-muted" aria-hidden="true" />
          <p className="text-sm font-semibold text-ui-ink">No pause requests waiting</p>
        </div>
      )}
      <ul className="space-y-3" aria-label="Pause requests">
        {(items || []).map((r) => (
          <li key={r._id} className="glass-card p-4 space-y-2 min-w-0">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <Link to={`/work/${r.workItem._id}`} className="text-sm font-semibold text-ui-ink hover:underline break-words">{r.workItem.title}</Link>
                <p className="text-xs text-ui-muted">
                  {r.owner.name} · {calendarName(r.workItem.calendar)} · asked {formatShortDateTime(r.requestedAt)}
                </p>
              </div>
              {r.workItem.status !== 'In Progress' && <span className="status-chip status-waiting text-[11px]">Step is {r.workItem.status}</span>}
            </div>
            <p className="text-sm text-ui-text break-words">
              <span className="font-semibold">{r.reasonLabel}{r.urgentStep ? ` (${r.urgentStep.title})` : ''}:</span> {r.note}
            </p>
            {r.pauseUntil && <p className="text-xs text-ui-muted">Until {shortDay(r.pauseUntil)}</p>}
            {r.canDecide && (
              <div className="flex flex-wrap gap-2 pt-1">
                <button type="button" disabled={busyId === r._id} onClick={() => decide(r, 'approve')} className="ui-btn ui-btn-primary h-11 gap-1.5" aria-label={`Approve pause: ${r.workItem.title}`}>
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Approve
                </button>
                <button type="button" disabled={busyId === r._id} onClick={() => setRejecting(r)} className="ui-btn ui-btn-secondary h-11 gap-1.5" aria-label={`Reject pause: ${r.workItem.title}`}>
                  <XCircle className="w-4 h-4" aria-hidden="true" /> Reject
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {rejecting && (
        <RejectPauseDialog
          stepTitle={rejecting.workItem.title}
          busy={busyId === rejecting._id}
          onClose={() => setRejecting(null)}
          onReject={(message) => {
            const r = rejecting;
            setRejecting(null);
            decide(r, 'reject', message);
          }}
        />
      )}
    </div>
  );
};
