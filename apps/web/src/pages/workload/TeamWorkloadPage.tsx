import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Pencil, Search, Sparkles, Users, X, ExternalLink } from 'lucide-react';
import { WORK_TYPES, WORK_PREFERENCES, formatShortDate, type WorkType, type SimpleWorkloadBand } from '@mmp/shared';
import { apiFetch } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { Avatar } from '../../components/Avatar';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { displayStatus, statusClass, statusTone } from '../../lib/statusTone';
import { BandChip, countsText, type WorkloadFigures, type WorkloadList, type WorkloadRow } from '../../lib/workload';

import { DataLoader } from '../../components/DataLoader';
/**
 * Team Workload (step counts). A planning view: how many steps each person has in progress
 * and due this week, against their limit. Rows are sorted by name, never ranked by load.
 * No hours or percentages.
 */

const BANDS: SimpleWorkloadBand[] = ['Available', 'Busy', 'Over'];
const BAND_KEY: Record<SimpleWorkloadBand, 'available' | 'busy' | 'over'> = { Available: 'available', Busy: 'busy', Over: 'over' };

interface PanelData {
  person: { _id: string; name: string; jobRole: string };
  workload: WorkloadFigures;
  steps: Array<{ _id: string; title: string; stageKey: string; status: string; paused: boolean; latestVersionStatus: string | null; dueDate: string | null; project: { name: string; code: string } | null }>;
}

interface Recommendation {
  recommendedPerson: { _id: string; name: string } | null;
  recommendedMetrics?: WorkloadFigures & { overLimit?: boolean };
  rationale: string;
  overLimitWarning?: string | null;
}

/** Side panel: that person's open steps, each linking to Work Detail. */
const PersonPanel: React.FC<{ personId: string; onClose: () => void }> = ({ personId, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setData(null);
    apiFetch<{ data: PanelData }>(`/api/workload/${personId}/steps`)
      .then((res) => alive && setData(res.data))
      .catch((err) => alive && setError(err?.message || 'Could not load the steps.'));
    return () => {
      alive = false;
    };
  }, [personId]);
  return (
    <div className="fixed inset-0 z-[60] flex justify-end ui-scrim" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="wl-panel-title"
        className="glass-modal h-full w-full max-w-md overflow-y-auto p-5 space-y-4 rounded-none sm:rounded-l-ui-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="wl-panel-title" className="text-base font-bold text-ui-ink break-words">{data?.person.name || 'Open steps'}</h2>
            {data && <p className="text-sm text-ui-muted">{countsText(data.workload)} · limit {data.workload.limit}</p>}
          </div>
          <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        {error && <p role="alert" className="text-sm text-ui-ink">{error}</p>}
        {!data && !error && <DataLoader label="Loading…" />}
        {data && data.steps.length === 0 && <p className="text-sm text-ui-muted">No open steps.</p>}
        {data && data.steps.length > 0 && (
          <ul className="space-y-2" aria-label="Open steps">
            {data.steps.map((s) => (
              <li key={s._id}>
                <Link to={`/work/${s._id}`} className="block glass-card p-3 space-y-1 hover:border-ui-ink">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-semibold text-ui-ink break-words">{s.stageKey}</span>
                    <ExternalLink className="w-3.5 h-3.5 text-ui-muted shrink-0" aria-hidden="true" />
                  </span>
                  <span className="block text-xs text-ui-muted break-words">{s.project?.name || s.title}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={`status-chip ${statusClass(statusTone(s.status))} text-[11px]`}>{s.paused ? 'Paused' : displayStatus({ status: s.status })}</span>
                    {s.status === 'Feedback' && s.latestVersionStatus === 'changes_requested' && <span className="status-chip status-changes text-[11px]">Changes requested</span>}
                    <span className="text-ui-muted">{s.dueDate ? `Due ${formatShortDate(s.dueDate)}` : 'No due date'}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/** Edit one person's active-step limit (admin and the leads). */
const LimitDialog: React.FC<{ row: WorkloadRow; onClose: () => void; onSaved: () => void }> = ({ row, onClose, onSaved }) => {
  const ref = useRef<HTMLFormElement>(null);
  useDialogFocus(ref, true, onClose);
  const [value, setValue] = useState(String(row.limit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/api/workload/${row._id}/limit`, { method: 'PUT', body: JSON.stringify({ limit: Number(value) }) });
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'Could not save the limit.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <form ref={ref} onSubmit={save} role="dialog" aria-modal="true" aria-labelledby="wl-limit-title" className="glass-modal w-full max-w-sm p-5 space-y-4">
        <h2 id="wl-limit-title" className="text-base font-bold text-ui-ink">Active-step limit: {row.name}</h2>
        <p className="text-sm text-ui-muted">Steps due in a week before this person shows as Over. Default 4.</p>
        <div className="space-y-1.5">
          <label htmlFor="wl-limit" className="block text-[13px] font-medium text-ui-muted">Limit</label>
          <input id="wl-limit" type="number" min={1} max={20} step={1} required className="ui-input h-11 w-full" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        {error && <p role="alert" className="text-xs font-semibold text-ui-ink">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="ui-btn ui-btn-secondary h-11">Cancel</button>
          <button type="submit" disabled={busy} className="ui-btn ui-btn-primary h-11">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
};

/** Suggest an owner with the shared rule (same as autofill and the Tracker). */
const RecommendDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const [workType, setWorkType] = useState<WorkType>('Reel');
  const [stageKey, setStageKey] = useState('none');
  const [deadline, setDeadline] = useState('');
  const [result, setResult] = useState<Recommendation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<{ data: Recommendation }>('/api/assignment/recommend', {
        method: 'POST',
        body: JSON.stringify({ workType, stageKey: stageKey !== 'none' ? stageKey : undefined, deadline: deadline ? new Date(`${deadline}T12:00:00+05:30`).toISOString() : undefined }),
      });
      setResult(res.data);
    } catch (err: any) {
      setError(err?.message || 'Could not suggest an owner.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 ui-scrim">
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="wl-rec-title" className="glass-modal w-full max-w-lg p-5 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="wl-rec-title" className="text-base font-bold text-ui-ink">Suggest an owner</h2>
            <p className="text-sm text-ui-muted">Eligible people first, then fewest steps due that week, then fewest in progress.</p>
          </div>
          <button type="button" onClick={onClose} className="ui-icon-btn h-11 w-11 shrink-0" aria-label="Close">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={run} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="wl-rec-type" className="block text-[13px] font-medium text-ui-muted mb-1">Work type</label>
            <select id="wl-rec-type" className="ui-select h-11 w-full" value={workType} onChange={(e) => setWorkType(e.target.value as WorkType)}>
              {WORK_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="wl-rec-step" className="block text-[13px] font-medium text-ui-muted mb-1">Step</label>
            <select id="wl-rec-step" className="ui-select h-11 w-full" value={stageKey} onChange={(e) => setStageKey(e.target.value)}>
              <option value="none">Any (by department)</option>
              {WORK_PREFERENCES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="wl-rec-due" className="block text-[13px] font-medium text-ui-muted mb-1">Due date</label>
            <input id="wl-rec-due" type="date" className="ui-input h-11 w-full" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
          </div>
          <div className="sm:col-span-3 flex justify-end">
            <button type="submit" disabled={busy} className="ui-btn ui-btn-primary h-11 gap-2">
              <Sparkles className="w-4 h-4" aria-hidden="true" /> {busy ? 'Finding…' : 'Suggest'}
            </button>
          </div>
        </form>
        {error && <p role="alert" className="text-xs font-semibold text-ui-ink">{error}</p>}
        {result && (
          <div className={`p-4 rounded-2xl space-y-2 ${result.overLimitWarning ? 'band-tint band-overloaded' : 'bg-white/70'}`} data-testid="wl-rec-result">
            <p className="text-sm font-semibold text-ui-ink">{result.rationale}</p>
            {result.recommendedMetrics && (
              <p className="flex flex-wrap items-center gap-2 text-xs text-ui-ink">
                <BandChip band={result.recommendedMetrics.band} /> {countsText(result.recommendedMetrics)} · limit {result.recommendedMetrics.limit}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const TeamWorkloadPage: React.FC = () => {
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const band = (params.get('band') || '') as SimpleWorkloadBand | '';
  const jobRole = params.get('jobRole') || '';
  const q = params.get('q') || '';
  const [qDraft, setQDraft] = useState(q);
  const [data, setData] = useState<WorkloadList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [panelFor, setPanelFor] = useState<string | null>(null);
  const [limitFor, setLimitFor] = useState<WorkloadRow | null>(null);
  const [recommendOpen, setRecommendOpen] = useState(false);

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
    apiFetch<{ data: WorkloadList }>('/api/workload')
      .then((res) => alive && setData(res.data))
      .catch((err) => alive && setError(err?.message || 'Could not load the workload.'));
    return () => {
      alive = false;
    };
  }, [reload]);

  useEffect(() => setQDraft(q), [q]);
  useEffect(() => {
    if (qDraft === q) return;
    const t = setTimeout(() => setParam({ q: qDraft }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft]);

  // Filtered here so the summary chips (job role + search) can count every band.
  const inView = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.people || []).filter((p) => (!jobRole || p.jobRole === jobRole) && (!needle || p.name.toLowerCase().includes(needle)));
  }, [data, jobRole, q]);
  const rows = useMemo(() => inView.filter((p) => !band || p.band === band), [inView, band]);
  const counts = useMemo(() => {
    const c = { available: 0, busy: 0, over: 0 };
    for (const p of inView) c[BAND_KEY[p.band]] += 1;
    return c;
  }, [inView]);
  const jobRoles = data?.jobRoles || [];

  return (
    <div className="space-y-4 pb-12 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-ui-ink">Team Workload</h1>
          <p className="text-sm text-ui-muted">Steps in progress and due this week, against each person's limit. A planning view, sorted by name.</p>
        </div>
        {hasPermission('assignment.override') && (
          <button type="button" onClick={() => setRecommendOpen(true)} className="ui-btn ui-btn-primary h-11 gap-2">
            <Sparkles className="w-4 h-4" aria-hidden="true" /> Suggest an owner
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by band">
        {BANDS.map((b) => {
          const active = band === b;
          return (
            <button
              key={b}
              type="button"
              aria-pressed={active}
              onClick={() => setParam({ band: active ? '' : b })}
              className={`band-chip band-tint ${active ? 'ring-2 ring-ui-ink' : ''} min-h-[44px] px-3 inline-flex items-center gap-2 text-sm font-semibold ${b === 'Over' ? 'band-overloaded' : b === 'Busy' ? 'band-high' : 'band-healthy'}`}
              data-testid={`wl-chip-${b}`}
            >
              {b} <span className="tabular-nums">{counts[BAND_KEY[b]]}</span>
            </button>
          );
        })}
      </div>

      <div className="glass-card p-3 sm:p-4 grid grid-cols-1 sm:grid-cols-3 gap-3" role="search" aria-label="Filter the team">
        <div>
          <label htmlFor="wl-q" className="block text-[12px] font-medium text-ui-muted mb-1">Search</label>
          <div className="relative">
            <Search className="w-4 h-4 text-ui-muted absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" aria-hidden="true" />
            <input id="wl-q" type="search" className="ui-input h-11 w-full pl-9" placeholder="Name" value={qDraft} onChange={(e) => setQDraft(e.target.value)} />
          </div>
        </div>
        <div>
          <label htmlFor="wl-role" className="block text-[12px] font-medium text-ui-muted mb-1">Job role</label>
          <select id="wl-role" className="ui-select h-11 w-full" value={jobRole} onChange={(e) => setParam({ jobRole: e.target.value })}>
            <option value="">All job roles</option>
            {jobRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="wl-band" className="block text-[12px] font-medium text-ui-muted mb-1">Band</label>
          <select id="wl-band" className="ui-select h-11 w-full" value={band} onChange={(e) => setParam({ band: e.target.value })}>
            <option value="">All bands</option>
            {BANDS.map((b) => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>
      </div>

      {error && <p role="alert" className="p-3 rounded-xl status-tint status-changes text-xs font-semibold">{error}</p>}
      {!data && !error && (
        <div className="glass-card">
          <DataLoader label="Loading…" />
        </div>
      )}
      {data && rows.length === 0 && (
        <div className="glass-card p-8 text-center text-sm text-ui-muted">
          <Users className="w-8 h-8 mx-auto mb-2 text-ui-muted" aria-hidden="true" /> Nobody matches these filters.
        </div>
      )}

      {data && rows.length > 0 && (
        <ul className="glass-card divide-y divide-ui-line p-0 overflow-hidden" aria-label="Team workload">
          {rows.map((p) => (
            <li key={p._id} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 p-3 sm:px-4" data-testid="wl-row">
              <button type="button" onClick={() => setPanelFor(p._id)} className="flex items-center gap-3 min-w-0 flex-1 text-left min-h-[44px]" aria-label={`${p.name}: open steps`}>
                <Avatar url={p.avatarUrl} name={p.name} userId={p._id} size="sm" />
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ui-ink break-words">{p.name}</span>
                  <span className="block text-xs text-ui-muted">{p.jobRole || p.role}</span>
                </span>
              </button>
              <span className="text-sm text-ui-ink sm:w-60" data-testid="wl-counts">{countsText(p)}</span>
              <span className="text-xs text-ui-muted sm:w-28">{p.nextDue ? `Next due ${formatShortDate(`${p.nextDue}T12:00:00+05:30`)}` : 'Nothing due'}</span>
              <span className="flex items-center gap-2 sm:w-36 sm:justify-end">
                <BandChip band={p.band} />
                <span className="text-[11px] text-ui-muted">limit {p.limit}</span>
                {data.canEditLimit && (
                  <button type="button" onClick={() => setLimitFor(p)} className="ui-icon-btn h-9 w-9" aria-label={`Change ${p.name}'s limit`}>
                    <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {panelFor && <PersonPanel personId={panelFor} onClose={() => setPanelFor(null)} />}
      {limitFor && (
        <LimitDialog
          row={limitFor}
          onClose={() => setLimitFor(null)}
          onSaved={() => {
            setLimitFor(null);
            setReload((k) => k + 1);
          }}
        />
      )}
      {recommendOpen && <RecommendDialog onClose={() => setRecommendOpen(false)} />}
    </div>
  );
};

export default TeamWorkloadPage;
