import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CALENDARS,
  CALENDAR_KEYS,
  ROLE_KEYS,
  ROLE_LABELS,
  WORKFLOW_SLOTS,
  WORKFLOW_SLOT_LABELS,
  roleGuide,
  roleHasCalendarScopedPermissions,
  type UserRole,
} from '@mmp/shared';
import { AlertTriangle, CheckCircle2, History, Lock, RotateCcw, Search, ShieldCheck, X, XCircle } from 'lucide-react';
import { apiFetch, ApiError } from '../../lib/api';
import { confirmDialog, toast } from '../../lib/uiFeedback';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { useAuth } from '../../context/AuthContext';

/**
 * Access & Approvals (Access Phase D, admin only): people's roles and calendar limits, who
 * approves plans / reviews / posts on each calendar, the history of every change (with
 * restore for calendar settings) and a read-only guide to the seven roles.
 */

type Slot = (typeof WORKFLOW_SLOTS)[number];
interface Audience { roles: string[]; userIds: string[] }
type SlotConfig = Record<Slot, Audience>;
interface PersonRow {
  _id: string;
  name: string;
  email: string;
  jobRole: string;
  role: UserRole;
  status: 'active' | 'invited' | 'suspended';
  calendarScope: string[] | null;
  lastActive: string | null;
  calendarLimitApplies: boolean;
}
interface HealthItem { slot: string; message: string }
interface Health { ok: boolean; errors: HealthItem[]; warnings: HealthItem[]; resolved: Record<Slot, Array<{ _id: string; name: string }>> }
interface CalendarView {
  calendar: string;
  name: string;
  config: SlotConfig;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  namedPeople: Array<{ _id: string; name: string; role: string; status: string }>;
  health: Health;
}
interface SlotOption { permission: string; roles: string[]; people: Array<{ _id: string; name: string; role: string; calendarScope: string[] | null }> }
interface CalendarPreview { health: Health; sentences: string[]; counts: Record<string, number> }
interface HistoryRow {
  _id: string;
  at: string;
  actor: string;
  type: 'person' | 'workflow_config';
  subject: string;
  entityId: string;
  field: string;
  before: unknown;
  after: unknown;
  reason: string;
  version: number | null;
  canRestore: boolean;
}

const TABS = [
  { id: 'people', label: 'People & Roles' },
  { id: 'calendars', label: 'Calendar Approvals' },
  { id: 'history', label: 'History' },
  { id: 'guide', label: 'Role Guide' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const calName = (key: string) => (CALENDARS as Record<string, { name: string }>)[key]?.name || key;
const roleLabel = (role: string) => (ROLE_LABELS as Record<string, string>)[role] || role;
const scopeLabel = (scope: string[] | null | undefined) => (scope && scope.length ? scope.map(calName).join(', ') : 'All calendars');
const STATUS_LABELS: Record<string, string> = { active: 'Active', invited: 'Invited', suspended: 'Suspended' };
const errorMessage = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : 'Something went wrong.');

function timeAgo(iso: string | null) {
  if (!iso) return 'Never';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Runs `fn` after `deps` stop changing for `ms`. */
function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export const AccessApprovalsPage: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'people') as TabId;
  const setTab = (id: TabId) => setParams(id === 'people' ? {} : { tab: id }, { replace: false });

  return (
    <div className="space-y-6 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
      <div>
        <h1 className="text-[28px] sm:text-[32px] leading-tight font-extrabold tracking-[-0.02em] text-ui-ink flex items-center gap-3">
          <ShieldCheck className="w-7 h-7 shrink-0" aria-hidden="true" />
          Access &amp; Approvals
        </h1>
        <p className="text-xs sm:text-sm text-ui-muted mt-1">Who can do what, and who approves, reviews and posts on each calendar.</p>
      </div>
      <div className="ui-tabs flex-wrap max-w-full rounded-ui-card" role="tablist" aria-label="Access & Approvals sections">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`ui-tab ${tab === t.id ? 'is-active' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'people' && <PeopleTab />}
      {tab === 'calendars' && <CalendarsTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'guide' && <RoleGuideTab />}
    </div>
  );
};

// ------------------------------------------------------------------ People & Roles

const PeopleTab: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const search = params.get('q') || '';
  const role = params.get('role') || '';
  const status = params.get('status') || '';
  const openId = params.get('person');
  const [searchInput, setSearchInput] = useState(search);
  const debouncedSearch = useDebounced(searchInput);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const [loading, setLoading] = useState(true);

  const setParam = useCallback(
    (key: string, value: string) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(key, value);
        else next.delete(key);
        return next;
      }, { replace: true });
    },
    [setParams]
  );
  useEffect(() => {
    if (debouncedSearch !== search) setParam('q', debouncedSearch);
  }, [debouncedSearch, search, setParam]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ search, role, status });
      const res = await apiFetch<{ data: PersonRow[] }>(`/access-admin/people?${qs}`);
      setPeople(res.data);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [search, role, status]);
  useEffect(() => {
    load();
  }, [load]);

  const open = people.find((p) => p._id === openId) || null;

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 flex flex-col md:flex-row gap-3 md:items-center">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ui-muted" aria-hidden="true" />
          <input className="ui-input w-full pl-8" placeholder="Search name, email or job role" aria-label="Search people" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} />
        </div>
        <select className="ui-select" aria-label="Filter by role" value={role} onChange={(e) => setParam('role', e.target.value)}>
          <option value="">All roles</option>
          {ROLE_KEYS.map((r) => (
            <option key={r} value={r}>{roleLabel(r)}</option>
          ))}
        </select>
        <select className="ui-select" aria-label="Filter by status" value={status} onChange={(e) => setParam('status', e.target.value)}>
          <option value="">All statuses</option>
          {Object.entries(STATUS_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="py-16 text-center text-xs text-ui-muted animate-pulse">Loading people…</div>
      ) : !people.length ? (
        <div className="glass-card p-10 text-center text-sm text-ui-muted">Nobody matches these filters.</div>
      ) : (
        <>
          <div className="glass-card overflow-hidden hidden md:block">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-ui-muted border-b border-ui-line">
                <tr>
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Job role</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                  <th className="px-4 py-3 font-semibold">Calendar limit</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Last active</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p._id} className="border-b border-ui-line last:border-0 hover:bg-ui-card-hover cursor-pointer" onClick={() => setParam('person', p._id)}>
                    <td className="px-4 py-3">
                      <button type="button" className="font-semibold text-ui-ink text-left hover:underline" onClick={(e) => { e.stopPropagation(); setParam('person', p._id); }}>
                        {p.name}
                      </button>
                      <div className="text-xs text-ui-muted">{p.email}</div>
                    </td>
                    <td className="px-4 py-3 text-ui-text">{p.jobRole || '—'}</td>
                    <td className="px-4 py-3">{roleLabel(p.role)}</td>
                    <td className="px-4 py-3 text-ui-text">{p.calendarLimitApplies ? scopeLabel(p.calendarScope) : '—'}</td>
                    <td className="px-4 py-3"><StatusChip status={p.status} /></td>
                    <td className="px-4 py-3 text-ui-muted">{timeAgo(p.lastActive)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden space-y-3">
            {people.map((p) => (
              <li key={p._id}>
                <button type="button" className="glass-card p-4 w-full text-left" onClick={() => setParam('person', p._id)}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-ui-ink truncate">{p.name}</div>
                      <div className="text-xs text-ui-muted truncate">{p.jobRole || p.email}</div>
                    </div>
                    <StatusChip status={p.status} />
                  </div>
                  <div className="mt-2 text-xs text-ui-text">
                    {roleLabel(p.role)}
                    {p.calendarLimitApplies && <> · {scopeLabel(p.calendarScope)}</>}
                    <span className="text-ui-muted"> · {timeAgo(p.lastActive)}</span>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && <PersonPanel person={open} onClose={() => setParam('person', '')} onSaved={load} />}
    </div>
  );
};

const StatusChip: React.FC<{ status: string }> = ({ status }) => (
  <span className={`status-chip text-xs font-semibold px-2.5 py-0.5 ${status === 'active' ? 'status-approved' : status === 'suspended' ? 'status-blocked' : 'status-waiting'}`}>
    {STATUS_LABELS[status] || status}
  </span>
);

interface PersonPreview {
  gains: string[];
  losses: string[];
  blocked: { code: string; message: string } | null;
}

const PersonPanel: React.FC<{ person: PersonRow; onClose: () => void; onSaved: () => void }> = ({ person, onClose, onSaved }) => {
  const { user } = useAuth();
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, true, onClose);
  const isSelf = String((user as { _id?: string; id?: string } | null)?._id || (user as { id?: string } | null)?.id || '') === person._id;
  const [role, setRole] = useState<UserRole>(person.role);
  const [status, setStatus] = useState(person.status);
  const [limited, setLimited] = useState<boolean>(Boolean(person.calendarScope?.length));
  const [scope, setScope] = useState<string[]>(person.calendarScope || []);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<PersonPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const limitApplies = roleHasCalendarScopedPermissions(role);

  const nextScope = limitApplies && limited && scope.length ? [...scope].sort() : null;
  const changed = role !== person.role || status !== person.status || JSON.stringify(nextScope) !== JSON.stringify(person.calendarScope ? [...person.calendarScope].sort() : null);
  const body = useMemo(() => ({ role, status, calendarScope: nextScope }), [role, status, nextScope?.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const debounced = useDebounced(body, 250);

  useEffect(() => {
    let live = true;
    if (!changed) {
      setPreview(null);
      return;
    }
    apiFetch<{ data: PersonPreview }>(`/access-admin/people/${person._id}/preview`, { method: 'POST', body: JSON.stringify(debounced) })
      .then((r) => live && setPreview(r.data))
      .catch((e) => live && setPreview({ gains: [], losses: [], blocked: { code: 'ERROR', message: errorMessage(e) } }));
    return () => {
      live = false;
    };
  }, [debounced, person._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canSave = changed && reason.trim().length >= 3 && !preview?.blocked && !saving;
  const save = async () => {
    setSaving(true);
    try {
      await apiFetch(`/access-admin/people/${person._id}`, { method: 'PATCH', body: JSON.stringify({ ...body, reason: reason.trim() }) });
      toast.success(`${person.name}'s access is updated. They see the change straight away.`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const first = person.name.split(' ')[0];
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="presentation">
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/30" onClick={onClose} tabIndex={-1} />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="person-panel-title" className="relative h-full w-full sm:max-w-md bg-ui-card shadow-xl overflow-y-auto p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="person-panel-title" className="text-lg font-bold text-ui-ink truncate">{person.name}</h2>
            <p className="text-xs text-ui-muted truncate">{person.jobRole || person.email}</p>
          </div>
          <button type="button" className="ui-btn ui-btn-secondary h-9 w-9 p-0" aria-label="Close panel" onClick={onClose}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-ui-text">Role</span>
          <select className="ui-select w-full" value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as UserRole)}>
            {ROLE_KEYS.map((r) => (
              <option key={r} value={r}>{roleLabel(r)}</option>
            ))}
          </select>
          {isSelf && <span className="text-xs text-ui-muted flex items-center gap-1"><Lock className="w-3 h-3" aria-hidden="true" /> You can't change your own role or status. Ask another admin.</span>}
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-ui-text">Status</span>
          <select className="ui-select w-full" value={status} disabled={isSelf} onChange={(e) => setStatus(e.target.value as PersonRow['status'])}>
            {Object.entries(STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>

        {limitApplies && (
          <fieldset className="space-y-2">
            <legend className="text-xs font-semibold text-ui-text">Calendar limit</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="limit" checked={!limited} onChange={() => setLimited(false)} /> All calendars
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="limit" checked={limited} onChange={() => setLimited(true)} /> Only selected calendars
            </label>
            {limited && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pl-6">
                {CALENDAR_KEYS.map((c) => (
                  <label key={c} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={scope.includes(c)} onChange={(e) => setScope((s) => (e.target.checked ? [...s, c] : s.filter((x) => x !== c)))} />
                    {calName(c)}
                  </label>
                ))}
                {!scope.length && <p className="text-xs text-ui-muted sm:col-span-2">Pick at least one, or choose All calendars.</p>}
              </div>
            )}
          </fieldset>
        )}

        <label className="block space-y-1.5">
          <span className="text-xs font-semibold text-ui-text">Reason <span className="text-ui-muted font-normal">(required, kept in History)</span></span>
          <textarea className="ui-input w-full min-h-[72px]" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this changing?" />
        </label>

        {changed && preview && (
          <div className="rounded-ui-card border border-ui-line p-4 space-y-3 text-sm" aria-live="polite">
            {preview.blocked ? (
              <p className="flex gap-2 text-ui-coral"><XCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />{preview.blocked.message}</p>
            ) : (
              <>
                <div>
                  <p className="font-semibold text-ui-ink">{first} will be able to:</p>
                  {preview.gains.length ? <ul className="list-disc pl-5 text-ui-text">{preview.gains.map((g) => <li key={g}>{g}</li>)}</ul> : <p className="text-ui-muted">Nothing new.</p>}
                </div>
                <div>
                  <p className="font-semibold text-ui-ink">They will lose:</p>
                  {preview.losses.length ? <ul className="list-disc pl-5 text-ui-text">{preview.losses.map((g) => <li key={g}>{g}</li>)}</ul> : <p className="text-ui-muted">Nothing.</p>}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex gap-2 justify-end pt-2">
          <button type="button" className="ui-btn ui-btn-secondary h-10" onClick={onClose}>Cancel</button>
          <button type="button" className="ui-btn ui-btn-primary h-10" disabled={!canSave} onClick={save}>{saving ? 'Saving…' : 'Save access'}</button>
        </div>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------ Calendar Approvals

const emptyConfig = (): SlotConfig => Object.fromEntries(WORKFLOW_SLOTS.map((s) => [s, { roles: [], userIds: [] }])) as unknown as SlotConfig;
const sameAudience = (a: Audience, b: Audience) =>
  JSON.stringify([[...a.roles].sort(), [...a.userIds].sort()]) === JSON.stringify([[...b.roles].sort(), [...b.userIds].sort()]);

const CalendarsTab: React.FC = () => {
  const [data, setData] = useState<{ calendars: CalendarView[]; options: Record<Slot, SlotOption> } | null>(null);
  const load = useCallback(async () => {
    try {
      const res = await apiFetch<{ data: { calendars: CalendarView[]; options: Record<Slot, SlotOption> } }>('/access-admin/calendars');
      setData(res.data);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <div className="py-16 text-center text-xs text-ui-muted animate-pulse">Loading calendars…</div>;
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      {data.calendars.map((c) => (
        <CalendarCard key={`${c.calendar}-${c.version}`} view={c} options={data.options} onSaved={load} />
      ))}
    </div>
  );
};

const CalendarCard: React.FC<{ view: CalendarView; options: Record<Slot, SlotOption>; onSaved: () => void }> = ({ view, options, onSaved }) => {
  const [draft, setDraft] = useState<SlotConfig>(() => ({ ...emptyConfig(), ...view.config }));
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<CalendarPreview | null>(null);
  const [saving, setSaving] = useState(false);
  const changedSlots = WORKFLOW_SLOTS.filter((s) => !sameAudience(draft[s], view.config[s]));
  const changes = useMemo(() => Object.fromEntries(changedSlots.map((s) => [s, draft[s]])), [JSON.stringify(draft)]); // eslint-disable-line react-hooks/exhaustive-deps
  const debounced = useDebounced(changes, 250);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of view.namedPeople) m.set(p._id, p.name);
    for (const s of WORKFLOW_SLOTS) for (const p of options[s].people) m.set(p._id, p.name);
    return m;
  }, [view.namedPeople, options]);

  useEffect(() => {
    let live = true;
    if (!Object.keys(debounced).length) {
      setPreview(null);
      return;
    }
    apiFetch<{ data: CalendarPreview }>(`/access-admin/calendars/${view.calendar}/preview`, { method: 'POST', body: JSON.stringify({ changes: debounced }) })
      .then((r) => live && setPreview(r.data))
      .catch((e) => toast.error(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [debounced, view.calendar]);

  const health = changedSlots.length ? preview?.health : view.health;
  const pending = changedSlots.length > 0 && (!preview || JSON.stringify(debounced) !== JSON.stringify(changes));
  const canSave = changedSlots.length > 0 && !pending && Boolean(health?.ok) && reason.trim().length >= 3 && !saving;

  const update = (slot: Slot, a: Audience) => setDraft((d) => ({ ...d, [slot]: a }));
  const save = async () => {
    const ok = await confirmDialog({
      title: `Save ${view.name} settings?`,
      message: (
        <ul className="list-disc pl-5 space-y-1">
          {(preview?.sentences || []).map((s) => <li key={s}>{s}</li>)}
        </ul>
      ),
      confirmLabel: 'Save settings',
    });
    if (!ok) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ data: { sentences: string[]; notified: number; movedPosts: number } }>(`/access-admin/calendars/${view.calendar}`, {
        method: 'PUT',
        // The version this card shows: if someone saved in between, the API answers 409.
        body: JSON.stringify({ changes, reason: reason.trim(), version: view.version }),
      });
      toast.success(`${view.name} saved.${res.data.notified ? ` ${res.data.notified} ${res.data.notified === 1 ? 'person was' : 'people were'} told what now comes to them.` : ''}`);
      setReason('');
      onSaved();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SETTINGS_CHANGED') {
        toast.error(`${view.name}: settings changed — reload. Someone saved them a moment ago; the latest settings are shown now.`);
        onSaved();
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setSaving(false);
    }
  };

  const order: Slot[] = ['planApprovers', 'reviewers', 'posters', 'fallbackApprovers'];
  return (
    <section className="glass-card p-4 sm:p-5 space-y-4 min-w-0" aria-labelledby={`cal-${view.calendar}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id={`cal-${view.calendar}`} className="text-base font-bold text-ui-ink">{view.name}</h2>
          <p className="text-xs text-ui-muted">
            Version {view.version}
            {view.updatedBy ? ` · changed by ${view.updatedBy}` : ''}
            {view.updatedAt ? ` · ${timeAgo(view.updatedAt)}` : ''}
          </p>
        </div>
        <HealthBadge health={health} pending={pending} />
      </div>

      <ol className="space-y-3">
        {order.map((slot, i) => (
          <li key={slot} className="space-y-1.5">
            <div className="text-xs font-semibold text-ui-text">
              {i > 0 && <span className="text-ui-muted mr-1" aria-hidden="true">→</span>}
              {WORKFLOW_SLOT_LABELS[slot]}
              {changedSlots.includes(slot) && <span className="ml-2 text-ui-blue font-normal">changed</span>}
            </div>
            <AudiencePicker slot={slot} calendar={view.calendar} value={draft[slot]} option={options[slot]} names={names} onChange={(a) => update(slot, a)} />
            {health && [...health.errors, ...health.warnings].filter((h) => h.slot === slot).map((h) => (
              <p key={h.message} className={`text-xs flex gap-1.5 ${health.errors.includes(h) ? 'text-ui-coral' : 'text-amber-600'}`}>
                {health.errors.includes(h) ? <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />}
                {h.message}
              </p>
            ))}
          </li>
        ))}
      </ol>

      {changedSlots.length > 0 && (
        <div className="space-y-3 border-t border-ui-line pt-4">
          {preview && (
            <ul className="text-sm text-ui-text list-disc pl-5 space-y-1" aria-live="polite">
              {preview.sentences.map((s) => <li key={s}>{s}</li>)}
            </ul>
          )}
          <label className="block space-y-1.5">
            <span className="text-xs font-semibold text-ui-text">Reason <span className="text-ui-muted font-normal">(required)</span></span>
            <input className="ui-input w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this changing?" />
          </label>
          <div className="flex flex-wrap gap-2 justify-end">
            <button type="button" className="ui-btn ui-btn-secondary h-10" onClick={() => { setDraft({ ...emptyConfig(), ...view.config }); setReason(''); }}>Discard</button>
            <button type="button" className="ui-btn ui-btn-primary h-10" disabled={!canSave} onClick={save} title={health && !health.ok ? 'Fix the health check first' : undefined}>
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
          {health && !health.ok && <p className="text-xs text-ui-coral text-right">Saving is blocked until every check passes.</p>}
        </div>
      )}
    </section>
  );
};

const HealthBadge: React.FC<{ health?: Health; pending: boolean }> = ({ health, pending }) => {
  if (pending || !health) return <span className="status-chip status-waiting text-xs px-2.5 py-0.5">Checking…</span>;
  if (!health.ok) return <span className="status-chip status-blocked text-xs px-2.5 py-0.5 flex items-center gap-1"><XCircle className="w-3.5 h-3.5" aria-hidden="true" />{health.errors.length} problem{health.errors.length === 1 ? '' : 's'}</span>;
  if (health.warnings.length) return <span className="status-chip status-waiting text-xs px-2.5 py-0.5 flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />Healthy, {health.warnings.length} note{health.warnings.length === 1 ? '' : 's'}</span>;
  return <span className="status-chip status-approved text-xs px-2.5 py-0.5 flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />Healthy</span>;
};

const AudiencePicker: React.FC<{
  slot: Slot;
  calendar: string;
  value: Audience;
  option: SlotOption;
  names: Map<string, string>;
  onChange: (a: Audience) => void;
}> = ({ slot, calendar, value, option, names, onChange }) => {
  const roles = option.roles.filter((r) => !value.roles.includes(r));
  const people = option.people.filter((p) => !value.userIds.includes(p._id));
  const add = (v: string) => {
    if (!v) return;
    const [kind, id] = v.split(':');
    if (kind === 'role') onChange({ ...value, roles: [...value.roles, id] });
    else onChange({ ...value, userIds: [...value.userIds, id] });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 min-w-0">
      {value.roles.map((r) => (
        <Chip key={`r-${r}`} label={`${roleLabel(r)} (role)`} onRemove={() => onChange({ ...value, roles: value.roles.filter((x) => x !== r) })} />
      ))}
      {value.userIds.map((id) => (
        <Chip key={`p-${id}`} label={names.get(id) || 'Unknown person'} onRemove={() => onChange({ ...value, userIds: value.userIds.filter((x) => x !== id) })} />
      ))}
      {!value.roles.length && !value.userIds.length && <span className="text-xs text-ui-muted italic">Nobody</span>}
      <select className="ui-select h-8 text-xs w-36 max-w-full" aria-label={`Add to ${WORKFLOW_SLOT_LABELS[slot]} on ${calName(calendar)}`} value="" onChange={(e) => add(e.target.value)}>
        <option value="">+ Add</option>
        {roles.length > 0 && (
          <optgroup label="Roles">
            {roles.map((r) => <option key={r} value={`role:${r}`}>{roleLabel(r)}</option>)}
          </optgroup>
        )}
        {people.length > 0 && (
          <optgroup label="People">
            {people.map((p) => (
              <option key={p._id} value={`person:${p._id}`}>
                {p.name} · {roleLabel(p.role)}
                {p.calendarScope && !p.calendarScope.includes(calendar) ? ' (limited to other calendars)' : ''}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
};

const Chip: React.FC<{ label: string; onRemove: () => void }> = ({ label, onRemove }) => (
  <span className="inline-flex items-center gap-1 rounded-full border border-ui-line bg-ui-card-hover pl-2.5 pr-1 py-0.5 text-xs text-ui-ink">
    {label}
    <button type="button" className="rounded-full p-0.5 hover:bg-ui-line" aria-label={`Remove ${label}`} onClick={onRemove}>
      <X className="w-3 h-3" aria-hidden="true" />
    </button>
  </span>
);

// ------------------------------------------------------------------ History

const HistoryTab: React.FC = () => {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') || '';
  const calendar = params.get('calendar') || '';
  const personId = params.get('who') || '';
  const [rows, setRows] = useState<HistoryRow[] | null>(null);
  const [people, setPeople] = useState<PersonRow[]>([]);
  const setParam = (key: string, value: string) =>
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ type, calendar, person: personId });
      const res = await apiFetch<{ data: HistoryRow[] }>(`/access-admin/history?${qs}`);
      setRows(res.data);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }, [type, calendar, personId]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    apiFetch<{ data: PersonRow[] }>('/access-admin/people').then((r) => setPeople(r.data)).catch(() => {});
  }, []);
  const nameOf = useMemo(() => new Map(people.map((p) => [p._id, p.name])), [people]);

  const show = (row: HistoryRow, v: unknown): string => {
    if (v == null) return row.field === 'calendarScope' ? 'All calendars' : '—';
    if (row.field === 'role') return roleLabel(String(v));
    if (row.field === 'status') return STATUS_LABELS[String(v)] || String(v);
    if (row.field === 'calendarScope') return scopeLabel(v as string[]);
    const a = v as Audience;
    const parts = [...(a.roles || []).map((r) => `${roleLabel(r)} (role)`), ...(a.userIds || []).map((id) => nameOf.get(id) || 'Unknown person')];
    return parts.join(', ') || 'Nobody';
  };
  const fieldLabel = (row: HistoryRow) =>
    row.type === 'person'
      ? ({ role: 'Role', status: 'Status', calendarScope: 'Calendar limit' } as Record<string, string>)[row.field] || row.field
      : WORKFLOW_SLOT_LABELS[row.field as Slot] || row.field;

  const restore = async (row: HistoryRow) => {
    try {
      const pre = await apiFetch<{ data: CalendarPreview }>(`/access-admin/history/${row._id}/restore`, { method: 'POST', body: JSON.stringify({ preview: true }) });
      if (!pre.data.health.ok) {
        toast.error(`Can't restore: ${pre.data.health.errors.map((e) => e.message).join(' ')}`);
        return;
      }
      const ok = await confirmDialog({
        title: `Restore ${row.subject} to before version ${row.version ?? ''}?`,
        message: <ul className="list-disc pl-5 space-y-1">{pre.data.sentences.map((s) => <li key={s}>{s}</li>)}</ul>,
        confirmLabel: 'Restore this version',
      });
      if (!ok) return;
      await apiFetch(`/access-admin/history/${row._id}/restore`, { method: 'POST', body: JSON.stringify({ reason: `Restored the settings from before version ${row.version ?? ''}` }) });
      toast.success(`${row.subject} settings restored.`);
      load();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 flex flex-col md:flex-row gap-3">
        <select className="ui-select" aria-label="Filter by type" value={type} onChange={(e) => setParam('type', e.target.value)}>
          <option value="">All changes</option>
          <option value="person">Roles, status and calendar limits</option>
          <option value="workflow_config">Calendar settings</option>
        </select>
        <select className="ui-select" aria-label="Filter by calendar" value={calendar} onChange={(e) => setParam('calendar', e.target.value)}>
          <option value="">All calendars</option>
          {CALENDAR_KEYS.map((c) => <option key={c} value={c}>{calName(c)}</option>)}
        </select>
        <select className="ui-select" aria-label="Filter by person" value={personId} onChange={(e) => setParam('who', e.target.value)}>
          <option value="">Everyone</option>
          {people.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
        </select>
      </div>
      {!rows ? (
        <div className="py-16 text-center text-xs text-ui-muted animate-pulse">Loading history…</div>
      ) : !rows.length ? (
        <div className="glass-card p-10 text-center text-sm text-ui-muted">No changes yet.</div>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r._id} className="glass-card p-4 flex flex-col sm:flex-row sm:items-start gap-3">
              <History className="w-4 h-4 text-ui-muted shrink-0 mt-1 hidden sm:block" aria-hidden="true" />
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm text-ui-ink">
                  <span className="font-semibold">{r.subject}</span> · {fieldLabel(r)}
                  {r.version != null && <span className="text-ui-muted"> · version {r.version}</span>}
                </p>
                <p className="text-sm text-ui-text break-words">
                  <span className="line-through text-ui-muted">{show(r, r.before)}</span> → <span className="font-medium">{show(r, r.after)}</span>
                </p>
                <p className="text-xs text-ui-muted">
                  {r.actor} · {new Date(r.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}
                  {r.reason && <> · “{r.reason}”</>}
                </p>
              </div>
              {r.canRestore && (
                <button type="button" className="ui-btn ui-btn-secondary h-9 gap-1.5 self-start" onClick={() => restore(r)}>
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> Restore this version
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

// ------------------------------------------------------------------ Role Guide

const RoleGuideTab: React.FC = () => {
  const guide = useMemo(() => roleGuide(), []);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      {guide.map((r) => (
        <section key={r.role} className="glass-card p-5 space-y-3" aria-labelledby={`guide-${r.role}`}>
          <h2 id={`guide-${r.role}`} className="text-base font-bold text-ui-ink flex items-center gap-2">
            {r.label}
            {r.locked && <span className="status-chip status-waiting text-xs px-2 py-0.5 flex items-center gap-1"><Lock className="w-3 h-3" aria-hidden="true" />Locked: everything</span>}
          </h2>
          {r.areas.map((a) => (
            <div key={a.area}>
              <h3 className="text-xs font-semibold text-ui-muted uppercase tracking-wide">{a.area}</h3>
              <ul className="text-sm text-ui-text list-disc pl-5">
                {a.items.map((i) => <li key={i}>{i}</li>)}
              </ul>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
};

export default AccessApprovalsPage;
