import { getStepStatusLabel, ROLE_LABELS, DASHBOARD_KPI_STATUSES, type DashboardKpiKey, type UserRole } from '@mmp/shared';
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../../lib/api';
import { overdueLabel } from '../../components/OverdueChip';
import { displayStatus, statusClass, statusTone, roleClass, type StatusTone } from '../../lib/statusTone';
import { useAuth } from '../../context/AuthContext';
import { useGlobalFilter } from '../../context/GlobalFilterContext';
import { GlobalFilterBar } from '../../components/GlobalFilterBar';
import {
  CheckCircle2,
  Clock,
  AlertTriangle,
  ShieldAlert,
  Users,
  ChevronRight,
  Plus,
  Activity,
  Layers,
  Calendar,
  FileCheck,
  TrendingUp,
  AlertOctagon,
  ArrowUpRight,
} from 'lucide-react';
import { useAccess } from '../../lib/access';

import { DataLoader } from '../../components/DataLoader';
interface DashboardData {
  scope: {
    profileId: string;
    departmentId: string;
    ownerId: string;
    month: string;
    userRole: string;
  };
  monthPlanStatus: {
    selectedMonth: string;
    activePlanStatus: string;
    totalPlans: number;
    plannedPieces: number;
    donePieces: number;
    completionRatePct: number;
    /** Share of the month elapsed (what "on pace" would be today); older APIs omit it. */
    expectedPacePct?: number;
    velocity: string;
    plans: {
      _id: string;
      code: string;
      title: string;
      kind: string;
      status: string;
      planned: number;
      done: number;
      createdByName?: string;
    }[];
  };
  kpis: {
    planned: number;
    completed: number;
    inProgress: number;
    atRisk: number;
    blocked: number;
    pendingApproval: number;
    overdue: number;
    /** The month the cards count (IST), as sent by the API. */
    month?: string;
  };
  priorities: {
    _id: string;
    title: string;
    workType: string;
    deadline: string;
    status: string;
    priority: string;
    isOverdue?: boolean;
    profileId?: { _id: string; name: string };
    ownerId?: { _id: string; name: string; role: string; jobRole?: string };
  }[];
  creativeStats: {
    totalDeliverables: number;
    byWorkType: Record<string, number>;
    byDepartment: {
      departmentId: string;
      name: string;
      code: string;
      total: number;
      inProgress: number;
      completed: number;
    }[];
    weeklyTrend: {
      weekLabel: string;
      completed: number;
    }[];
  };
  workload: {
    totalMembers: number;
    /** Workload bands from step counts. */
    bands?: { available: number; busy: number; over: number };
  };
  issues: {
    activeBlockersCount: number;
    longBlockedCount: number;
    activeFlagsCount: number;
    escalatedFlagsCount: number;
    blockersList: {
      _id: string;
      workItemId: string;
      deliverableTitle: string;
      reason: string;
      notes: string;
      dependencyOwnerName?: string;
      blockedAt: string;
      durationHours: number;
    }[];
    revisionFlags?: {
      _id: string;
      workItemId: string;
      project?: string;
      stepType?: string;
      deliverableTitle: string;
      ownerName: string | null;
      revisionsCount: number;
      rootCause?: string;
      isEscalated?: boolean;
      flaggedAt: string;
    }[];
  };
  waitingApproval: {
    plansCount: number;
    stagesCount: number;
    totalPending: number;
    plans: {
      _id: string;
      code: string;
      title: string;
      submittedAt: string;
      createdByName: string;
    }[];
    stages: {
      _id: string;
      title: string;
      workType: string;
      currentStageKey?: string;
      ownerName: string;
      deadline?: string;
    }[];
  };
  recentActivity: {
    _id: string;
    action: string;
    fromStatus?: string;
    toStatus?: string;
    timestamp: string;
    actorId?: { name: string; email: string; role: string };
    metadata?: Record<string, any>;
  }[];
}

export const TeamDashboardPage: React.FC = () => {
  const { user } = useAuth();
  const access = useAccess();
  const navigate = useNavigate();
  const { queryParams, filters } = useGlobalFilter();

  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Requirement: executive (worker) is redirected to My Work
  useEffect(() => {
    if (access.isOwnScope) {
      navigate('/my-work', { replace: true });
    }
  }, [user, navigate]);

  const fetchDashboard = async () => {
    setIsLoading(true);
    try {
      const queryString = new URLSearchParams(queryParams).toString();
      const url = `/api/dashboard/overview${queryString ? `?${queryString}` : ''}`;
      const res = await apiFetch<{ data?: DashboardData } | DashboardData>(url);
      const dashboardData = (res as any).data || res;
      setData(dashboardData);
    } catch (err) {
      console.error('Failed to load dashboard overview', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (user && !access.isOwnScope) {
      fetchDashboard();
    }
  }, [queryParams, user]);

  const getRoleDisplayName = (role?: string) => ROLE_LABELS[role as UserRole] || 'Member';

  // Plan statuses reuse the shared status tones (no colours here).
  const planTone = (status: string): StatusTone => {
    switch (status) {
      case 'Approved':
        return 'approved';
      case 'Submitted':
      case 'Approved with pending rows':
        return 'waiting';
      case 'Changes requested':
        return 'changes';
      default:
        return 'not-started';
    }
  };

  // Shared text styles for this screen
  const sectionTitle = 'text-base font-semibold text-ui-text';
  const fieldLabel = 'text-[13px] font-medium text-ui-muted';
  const textLink =
    'inline-flex items-center gap-1 min-h-[44px] -my-3 text-[13px] font-semibold text-ui-text hover:underline underline-offset-4 rounded-full';
  const row = 'rounded-2xl bg-white/60 hover:bg-white transition-colors';

  /**
   * A KPI card's link: the Tracker with that card's status and the dashboard's month, department,
   * owner and step-status filters, so the list it opens has exactly the card's number of rows.
   */
  const trackerLink = (key: DashboardKpiKey) => {
    const sp = new URLSearchParams({ tab: 'tracker' });
    // Dashboard filters left at "all" are not passed on.
    const put = (k: string, v?: string) => v && v !== 'all' && sp.set(k, v);
    put('month', data?.kpis.month || filters.month);
    sp.set('status', DASHBOARD_KPI_STATUSES[key]); // the Tracker's own "all" (Planned) is a real status
    put('department', filters.departmentId);
    put('owner', filters.ownerId);
    put('stageStatus', filters.status);
    return `/calendar?${sp.toString()}`;
  };

  // KPI strip: icon carries the only colour (blue = in progress, coral = blocked/overdue, ink = neutral)
  const kpis = data
    ? [
        { key: 'planned', label: 'Planned', value: data.kpis.planned, link: 'All rows', Icon: Layers, tone: 'text-ui-ink' },
        { key: 'completed', label: 'Completed', value: data.kpis.completed, link: 'Posted', Icon: CheckCircle2, tone: 'text-ui-ink' },
        { key: 'inProgress', label: 'In progress', value: data.kpis.inProgress, link: 'On track', Icon: Clock, tone: 'text-ui-blue' },
        { key: 'atRisk', label: 'At risk', value: data.kpis.atRisk, link: 'Due within 3 days', Icon: AlertOctagon, tone: 'text-ui-ink' },
        { key: 'blocked', label: 'Blocked', value: data.kpis.blocked, link: 'Blocked steps', Icon: ShieldAlert, tone: 'text-ui-coral' },
        { key: 'pendingApproval', label: 'Pending appr.', value: data.kpis.pendingApproval, link: 'Waiting for approval', Icon: FileCheck, tone: 'text-ui-ink' },
        { key: 'overdue', label: 'Overdue', value: data.kpis.overdue, link: 'Past deadline', Icon: AlertTriangle, tone: 'text-ui-coral' },
      ].map((k) => ({ ...k, to: trackerLink(k.key as DashboardKpiKey) }))
    : [];

  const canCreateDeliverable = access.can('calendar.plan');

  // "2026-11" → "November 2026"
  const monthLabel = (ym?: string) => {
    const [y, m] = String(ym || '').split('-').map(Number);
    if (!y || !m) return ym || '';
    return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  };

  // On pace when the share published is at least the share of the month gone by.
  const pace = (() => {
    if (!data) return null;
    const m = data.monthPlanStatus;
    const expected = m.expectedPacePct ?? 0;
    if (m.plannedPieces === 0) return { label: 'No plan yet', tone: 'not-started' as StatusTone, expected };
    if (m.completionRatePct >= expected) return { label: 'On pace', tone: 'approved' as StatusTone, expected };
    return { label: `Behind by ${expected - m.completionRatePct} pts`, tone: 'changes' as StatusTone, expected };
  })();

  return (
    <div className="space-y-8 pb-16">
      {/* Page title on the canvas */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className={`role-badge ${roleClass(user?.role)} px-2.5 py-0.5 text-xs font-semibold`}>
              {getRoleDisplayName(user?.role)}
            </span>
            <span className="text-[13px] text-ui-muted">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
            </span>
          </div>
          <h1 className="text-[28px] sm:text-[32px] leading-tight font-extrabold tracking-[-0.02em] text-ui-ink">
            Welcome back, {user?.name || 'Marketer'}
          </h1>
          <p className="mt-1.5 text-[15px] leading-relaxed text-ui-muted max-w-[70ch]">
            Your live view of calendar plans, production pace, workload, blockers and sign-offs.
          </p>
        </div>

        <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
          {canCreateDeliverable && (
            // Opens the "Add individual work" form on Calendar → Plans, where a single deliverable is created.
            <button
              onClick={() => navigate('/calendar?tab=plans&new=individual')}
              className="ui-btn ui-btn-primary h-11 flex-1 sm:flex-none px-3 sm:px-5"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
              <span>New Deliverable</span>
            </button>
          )}

          <button onClick={() => navigate('/calendar')} className="ui-btn ui-btn-secondary bg-transparent h-11 flex-1 sm:flex-none px-3 sm:px-5">
            <Calendar className="w-4 h-4" aria-hidden="true" />
            <span>Calendar &amp; Plans</span>
          </button>
        </div>
      </div>

      {/* Overview panel: filters, month plan status and KPIs */}
      <section className="glass-panel rounded-ui-panel p-5 sm:p-8 space-y-6">
        <GlobalFilterBar />

        {isLoading ? (
          <div className="glass-card">
            <DataLoader label="Loading dashboard overview…" />
          </div>
        ) : !data ? (
          <div className="glass-card p-12 text-center text-[13px] text-ui-muted">
            The dashboard couldn&apos;t load. Refresh the page to try again.
          </div>
        ) : (
          <>
            {/* Month plan status */}
            <div className="glass-card p-5 sm:p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-5 border-b border-ui-line">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-11 h-11 shrink-0 rounded-full bg-ui-ink text-white flex items-center justify-center">
                    <Calendar className="w-5 h-5" aria-hidden="true" />
                  </div>
                  <div className="min-w-0">
                    <span className={fieldLabel}>Month plan status · {monthLabel(data.monthPlanStatus.selectedMonth)}</span>
                    <h2 className="text-lg font-bold text-ui-ink flex flex-wrap items-center gap-2">
                      Active monthly plan
                      <span
                        className={`status-chip ${statusClass(planTone(data.monthPlanStatus.activePlanStatus))} text-xs px-2.5 py-0.5 font-semibold`}
                      >
                        {data.monthPlanStatus.activePlanStatus}
                      </span>
                    </h2>
                  </div>
                </div>

                <button onClick={() => navigate('/calendar?tab=plans')} className={`${textLink} self-start md:self-auto`}>
                  <span>View all plans ({data.monthPlanStatus.totalPlans})</span>
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-0 md:divide-x md:divide-ui-line pt-5">
                {/* Planned vs published */}
                <div className="space-y-2 md:pr-6">
                  <div className="flex items-center justify-between gap-2">
                    <span className={fieldLabel}>Planned vs published</span>
                    <span className="text-[13px] font-semibold text-ui-ink tabular-nums">
                      {data.monthPlanStatus.donePieces} / {data.monthPlanStatus.plannedPieces} pieces
                    </span>
                  </div>
                  <div
                    className="w-full bg-ui-line rounded-full h-2 overflow-hidden"
                    role="progressbar"
                    aria-label="Share of planned pieces published"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.min(100, data.monthPlanStatus.completionRatePct)}
                  >
                    <div
                      className="h-full bg-ui-blue rounded-full transition-[width]"
                      style={{ width: `${Math.min(100, data.monthPlanStatus.completionRatePct)}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between text-xs text-ui-muted tabular-nums">
                    <span>{data.monthPlanStatus.completionRatePct}% completed</span>
                    <span>{Math.max(0, data.monthPlanStatus.plannedPieces - data.monthPlanStatus.donePieces)} remaining</span>
                  </div>
                </div>

                {/* Publishing pace */}
                <div className="space-y-1.5 md:px-6">
                  <div className="flex items-center justify-between gap-2">
                    <span className={fieldLabel}>Publishing pace</span>
                    {pace && (
                      <span className={`status-chip ${statusClass(pace.tone)} text-[11px] px-2 py-0.5 font-semibold`}>{pace.label}</span>
                    )}
                  </div>
                  <div className="text-base font-semibold text-ui-ink tabular-nums">
                    {data.monthPlanStatus.donePieces} done of {data.monthPlanStatus.plannedPieces} planned
                  </div>
                  <p className="text-xs text-ui-muted">
                    {data.monthPlanStatus.completionRatePct}% done vs {pace?.expected ?? 0}% of the month passed.
                  </p>
                </div>

                {/* Plans in this period */}
                <div className="space-y-1.5 md:pl-6">
                  <span className={`${fieldLabel} block`}>Active plans in period</span>
                  {data.monthPlanStatus.plans.length === 0 ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <span className="text-[13px] text-ui-muted">No calendar plans for this month yet.</span>
                      {canCreateDeliverable && (
                        <button onClick={() => navigate('/calendar?tab=plans')} className={textLink}>
                          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>Create a plan</span>
                        </button>
                      )}
                    </div>
                  ) : (
                    <ul className="space-y-1.5 max-h-28 overflow-y-auto">
                      {data.monthPlanStatus.plans.map((p) => (
                        <li key={p._id}>
                          <button
                            type="button"
                            onClick={() => navigate('/calendar?tab=plans')}
                            className={`w-full flex items-center justify-between text-left text-[13px] px-3 py-2 ${row}`}
                          >
                            <span className="font-semibold text-ui-text truncate mr-2">{p.title}</span>
                            <span className={`status-chip ${statusClass(planTone(p.status))} text-[11px] px-2 py-0.5 font-semibold shrink-0`}>
                              {p.status}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>

            {/* KPI strip: one card, hairline dividers. The 7th stat spans the leftover cells. */}
            <div className="glass-card overflow-hidden">
              <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-px bg-ui-line">
                {kpis.map(({ label, value, link, to, Icon, tone }, i) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => navigate(to)}
                    className={`group text-left p-5 bg-ui-card hover:bg-ui-card-hover transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ui-ink ${
                      i === kpis.length - 1 ? 'col-span-2 sm:col-span-2 xl:col-span-1' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={fieldLabel}>{label}</span>
                      <span className={`flex h-7 w-7 items-center justify-center rounded-full bg-white/80 transition-colors group-hover:bg-white ${tone}`}>
                        <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                      </span>
                    </div>
                    <div className="mt-1 text-[28px] leading-9 font-semibold text-ui-ink tabular-nums">{value}</div>
                    <span className="mt-1 inline-flex items-center gap-0.5 text-xs font-medium text-ui-muted group-hover:text-ui-ink group-hover:underline underline-offset-4">
                      <span>{link}</span>
                      <ArrowUpRight className="w-3 h-3 transition-transform group-hover:-translate-y-px group-hover:translate-x-px" aria-hidden="true" />
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </section>

      {!isLoading && data && (
        <div className="space-y-8">
          {/* Waiting for approval (Creative Manager / Admin sign-off queue) */}
          {access.can('review.decide') && (
            <section className="glass-panel rounded-ui-panel p-5 sm:p-8 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <FileCheck className="w-5 h-5 text-ui-ink shrink-0" />
                  <div>
                    <h2 className={sectionTitle}>Waiting for Creative Manager approval</h2>
                    <span className="text-[13px] text-ui-muted">
                      {data.waitingApproval.totalPending} pending items requiring your sign-off
                    </span>
                  </div>
                </div>
                <button onClick={() => navigate('/feedback')} className="ui-btn ui-btn-primary h-11 self-start sm:self-auto">
                  <span>Open Approvals Console</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Submitted Calendar Plans */}
                <div className="glass-card p-5 space-y-3">
                  <div className="flex items-center justify-between gap-2 text-[13px] font-semibold text-ui-text">
                    <span>Submitted Plans ({data.waitingApproval.plans.length})</span>
                    <button onClick={() => navigate('/calendar?tab=plans')} className={textLink}>
                      Review Plans
                    </button>
                  </div>
                  {data.waitingApproval.plans.length === 0 ? (
                    <span className="text-[13px] text-ui-muted italic">No plans waiting for approval.</span>
                  ) : (
                    <div className="space-y-1.5">
                      {data.waitingApproval.plans.map((p) => (
                        <div
                          key={p._id}
                          onClick={() => navigate('/calendar?tab=plans')}
                          className={`flex items-center justify-between gap-2 text-[13px] p-3 cursor-pointer ${row}`}
                        >
                          <div className="min-w-0">
                            <span className="font-semibold text-ui-text block truncate">{p.title}</span>
                            <span className="text-xs text-ui-muted">By {p.createdByName}</span>
                          </div>
                          <span className="status-chip status-waiting text-[11px] font-semibold px-2 py-0.5 shrink-0">
                            Submitted
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Stages in Feedback */}
                <div className="glass-card p-5 space-y-3">
                  <div className="flex items-center justify-between gap-2 text-[13px] font-semibold text-ui-text">
                    <span>Deliverable Review Stages ({data.waitingApproval.stages.length})</span>
                    <button onClick={() => navigate('/feedback')} className={textLink}>
                      Review Stages
                    </button>
                  </div>
                  {data.waitingApproval.stages.length === 0 ? (
                    <span className="text-[13px] text-ui-muted italic">No deliverable review stages in feedback.</span>
                  ) : (
                    <div className="space-y-1.5">
                      {data.waitingApproval.stages.map((s) => (
                        <div
                          key={s._id}
                          onClick={() => navigate('/feedback')}
                          className={`flex items-center justify-between gap-2 text-[13px] p-3 cursor-pointer ${row}`}
                        >
                          <div className="min-w-0">
                            <span className="font-semibold text-ui-text block truncate">{s.title}</span>
                            <span className="text-xs text-ui-muted">
                              {s.workType} &bull; {s.ownerName}
                            </span>
                          </div>
                          <span className="status-chip status-changes text-[11px] font-semibold px-2 py-0.5 shrink-0">
                            Feedback
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Today's priorities + production stats */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="glass-panel rounded-ui-panel p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <Clock className="w-4 h-4 text-ui-ink" />
                  <h2 className={sectionTitle}>Today's priorities</h2>
                </div>
                <button onClick={() => navigate('/todo')} className={textLink}>
                  <span>Todo List</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2">
                {data.priorities.length === 0 ? (
                  <div className="glass-card text-center py-8 text-[13px] text-ui-muted">
                    No urgent tasks due today. All deadlines are clear!
                  </div>
                ) : (
                  data.priorities.map((item) => (
                    <button
                      type="button"
                      key={item._id}
                      onClick={() => navigate(`/work/${item._id}`)}
                      className={`w-full text-left p-3 rounded-2xl transition-colors cursor-pointer flex items-center justify-between gap-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-ink focus-visible:ring-offset-2 ${
                        item.isOverdue
                          ? 'bg-ui-coral-soft/80 hover:bg-ui-coral-soft'
                          : item.status === 'Blocked'
                          ? 'bg-ui-coral-soft/40 hover:bg-ui-coral-soft/60'
                          : 'bg-white/60 hover:bg-white'
                      }`}
                    >
                      <span className="block min-w-0">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="text-[13px] font-semibold text-ui-text truncate">{item.title}</span>
                          <span className="text-[11px] px-2 py-0.5 rounded-full font-medium bg-white text-ui-muted shrink-0">
                            {item.workType}
                          </span>
                        </span>
                        <span className="block text-xs text-ui-muted mt-0.5 truncate">{item.ownerId?.name || 'Unassigned'}</span>
                      </span>

                      <span className="block shrink-0 text-right">
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full block mb-1 status-tint ${statusClass(
                            item.isOverdue ? 'blocked' : statusTone(displayStatus(item as any))
                          )}`}
                        >
                          {item.isOverdue ? overdueLabel(item.deadline) : getStepStatusLabel(displayStatus(item as any))}
                        </span>
                        <span className="text-[11px] text-ui-muted tabular-nums">
                          {item.deadline ? new Date(item.deadline).toLocaleDateString() : 'No date'}
                        </span>
                      </span>
                    </button>
                  ))
                )}
              </div>
            </section>

            <section className="glass-panel rounded-ui-panel p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <TrendingUp className="w-4 h-4 text-ui-ink" />
                  <h2 className={sectionTitle}>Production stats &amp; trend</h2>
                </div>
                <button onClick={() => navigate('/calendar?tab=tracker')} className={textLink}>
                  <span>Content Tracker</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="glass-card p-5 space-y-5">
                {/* Work type matrix */}
                <div>
                  <span className={`${fieldLabel} block mb-2`}>Output by deliverable type:</span>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-[13px]">
                    {Object.entries(data.creativeStats.byWorkType).map(([type, count]) => (
                      <div key={type} className="px-3 py-2.5 rounded-xl bg-white/70 flex items-center justify-between">
                        <span className="font-medium text-ui-text truncate">{type}</span>
                        <strong className="text-ui-ink font-semibold ml-1 tabular-nums">{count}</strong>
                      </div>
                    ))}
                  </div>
                </div>

                {/* 4-week completion trend */}
                <div className="pt-4 border-t border-ui-line">
                  <span className={`${fieldLabel} block mb-2`}>4-week completion trend:</span>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    {data.creativeStats.weeklyTrend.map((t) => (
                      <div key={t.weekLabel} className="p-2 rounded-xl bg-white/70">
                        <span className="text-[11px] text-ui-muted font-medium block">{t.weekLabel}</span>
                        <strong className="text-base font-semibold text-ui-ink tabular-nums">{t.completed}</strong>
                        <span className="text-[11px] text-ui-muted block">published</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Departmental throughput */}
                <div className="pt-4 border-t border-ui-line space-y-2.5">
                  <span className={`${fieldLabel} block`}>Departmental throughput:</span>
                  {data.creativeStats.byDepartment.map((dept) => (
                    <div key={dept.departmentId} className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-ui-text">{dept.name}</span>
                        <span className="text-ui-muted tabular-nums">
                          {dept.completed}/{dept.total} (
                          {dept.total > 0 ? Math.round((dept.completed / dept.total) * 100) : 0}%)
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-ui-line rounded-full overflow-hidden">
                        <div
                          className="h-full bg-ui-blue rounded-full"
                          style={{
                            width: `${dept.total > 0 ? (dept.completed / dept.total) * 100 : 0}%`,
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </div>

          {/* Team workload: band summary from step counts; each chip opens the Workload page filtered. */}
          <section className="glass-panel rounded-ui-panel p-5 sm:p-6 space-y-4" data-testid="dashboard-workload">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <Users className="w-4 h-4 text-ui-ink shrink-0" />
                <div>
                  <h2 className={sectionTitle}>Team workload</h2>
                  <span className="text-xs text-ui-muted">Steps due this week against each person's limit</span>
                </div>
              </div>
              <button onClick={() => navigate('/workload')} className={`${textLink} shrink-0`}>
                <span>Open Workload</span>
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              {([
                ['Available', 'band-healthy', data.workload.bands?.available ?? 0],
                ['Busy', 'band-high', data.workload.bands?.busy ?? 0],
                ['Over', 'band-overloaded', data.workload.bands?.over ?? 0],
              ] as const).map(([label, cls, count]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => navigate(`/workload?band=${label}`)}
                  className={`p-3 rounded-2xl band-tint ${cls} min-h-[44px]`}
                  aria-label={`${label}: ${count} people`}
                >
                  <span className="text-xs font-medium block">{label}</span>
                  <strong className="text-2xl font-semibold tabular-nums">{count}</strong>
                  <span className="text-[11px] block mt-0.5">people</span>
                </button>
              ))}
            </div>
          </section>

          {/* Issues & blockers + recent activity */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="glass-panel rounded-ui-panel p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <ShieldAlert className="w-4 h-4 text-ui-coral" />
                  <h2 className={sectionTitle}>Issues &amp; blockers</h2>
                </div>
                <button onClick={() => navigate('/issues')} className={textLink}>
                  <span>Issues Console</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-2 text-[13px]">
                <div className="flex items-center justify-between p-4 rounded-2xl status-tint status-changes">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    <span className="font-semibold">Active Unresolved Blockers</span>
                  </div>
                  <strong className="text-base font-semibold tabular-nums">{data.issues.activeBlockersCount}</strong>
                </div>

                {data.issues.blockersList.length === 0 ? (
                  <div className="glass-card text-center py-6 text-[13px] text-ui-muted">
                    No active dependency blockers currently reported.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {data.issues.blockersList.map((blocker) => (
                      <div
                        key={blocker._id}
                        onClick={() => navigate('/issues')}
                        className={`p-3 cursor-pointer space-y-1 ${row}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-ui-text">{blocker.deliverableTitle}</span>
                          <span className="status-chip status-blocked text-[11px] font-semibold px-2 py-0.5 shrink-0">
                            {blocker.durationHours}h Blocked
                          </span>
                        </div>
                        <p className="text-xs text-ui-text">Reason: {blocker.reason}</p>
                        <span className="text-xs text-ui-muted block">
                          Dependency Owner: {blocker.dependencyOwnerName || 'Unassigned'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                {/* Phase 7 close-out: revision flags by project and step (never by person). */}
                <div className="pt-2" data-testid="dashboard-revision-flags">
                  <h3 className="text-[13px] font-semibold text-ui-text mb-2">
                    Revision flags (round 4 or later){' '}
                    <span className="text-ui-muted font-normal">({(data.issues.revisionFlags || []).length})</span>
                  </h3>
                  {(data.issues.revisionFlags || []).length === 0 ? (
                    <div className="glass-card text-center py-4 text-[13px] text-ui-muted">No steps flagged.</div>
                  ) : (
                    <ul className="space-y-2">
                      {(data.issues.revisionFlags || []).map((flag) => (
                        <li key={flag._id}>
                          <button
                            type="button"
                            onClick={() => navigate(flag.workItemId ? `/work/${flag.workItemId}` : '/feedback')}
                            className={`p-3 w-full text-left space-y-1 ${row}`}
                            data-testid="dashboard-flag-row"
                          >
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-ui-text min-w-0 truncate">
                                {flag.project || flag.deliverableTitle} · {flag.stepType || 'Step'}
                              </span>
                              <span className={`status-chip ${flag.rootCause ? 'status-approved' : 'status-changes'} text-[11px] font-semibold px-2 py-0.5 shrink-0`}>
                                {flag.rootCause || 'Unclassified'}
                              </span>
                            </span>
                            <span className="text-xs text-ui-muted block">
                              {flag.revisionsCount} change requests{flag.ownerName ? ` · ${flag.ownerName}` : ''}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </section>

            <section className="glass-panel rounded-ui-panel p-5 sm:p-6 space-y-4">
              <div className="flex items-center justify-between gap-2 min-h-[44px]">
                <div className="flex items-center gap-2.5">
                  <Activity className="w-4 h-4 text-ui-ink" />
                  <h2 className={sectionTitle}>Recent activity feed</h2>
                </div>
                <span className="text-xs font-medium text-ui-muted">Audit feed</span>
              </div>

              <div className="space-y-2">
                {data.recentActivity.length === 0 ? (
                  <div className="glass-card text-center py-8 text-[13px] text-ui-muted">
                    No recent audit activity recorded.
                  </div>
                ) : (
                  data.recentActivity.map((event) => (
                    <div key={event._id} className="p-3 rounded-2xl bg-white/60 flex items-start gap-3 text-[13px]">
                      <div className="w-1.5 h-1.5 rounded-full bg-ui-muted mt-2 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-ui-text truncate">
                            {event.actorId?.name || 'System Automation'}
                          </span>
                          <span className="text-[11px] text-ui-muted shrink-0 tabular-nums">
                            {new Date(event.timestamp).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </span>
                        </div>
                        <p className="text-xs text-ui-muted mt-0.5">
                          {event.action.replace('_', ' ').replace('.', ' ')}
                          {event.fromStatus && event.toStatus && ` (${event.fromStatus} -> ${event.toStatus})`}
                        </p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>
        </div>
      )}
    </div>
  );
};
export default TeamDashboardPage;
