import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PLAN_GRID_DISPLAY_COLUMNS, DELIVERABLE_TYPE_KEYS, PLAN_GRID_COLUMNS, canDecide } from '@mmp/shared';
import { PlanGrid } from '../PlanGrid';
import { PlansApprovalTab } from '../../../feedback/PlansApprovalTab';
import type { GridData, GridRow } from '../types';

// Phase 13: plan rows sent back with a message and suggested values; whole-plan Request changes;
// the SM Manager's "current → suggested" view and Apply suggestion; plans listed per calendar lead.

const calls: { url: string; method: string; body: any }[] = [];
let gridResponse: GridData;
let role = 'creative_lead';
let historyResponse: any[] = [];
let approvalPlans: any[] = [];

vi.mock('../../../../context/AuthContext', () => ({ useAuth: () => ({ user: { _id: 'u1', role, name: 'User' }, hasPermission: () => true }) }));
vi.mock('../../../../lib/api', async () => {
  class ApiError extends Error {
    code: string;
    constructor(message: string, code = 'X') {
      super(message);
      this.code = code;
    }
  }
  return {
    ApiError,
    apiFetch: vi.fn(async (url: string, opts: any = {}) => {
      const method = opts.method || 'GET';
      const body = opts.body ? JSON.parse(opts.body) : undefined;
      calls.push({ url, method, body });
      if (url.startsWith('/api/calendar-plans/grid?')) return { data: gridResponse };
      if (url.endsWith('/history')) return { data: historyResponse };
      if (url === '/api/calendar-plans') return { data: approvalPlans };
      const detail = /^\/api\/calendar-plans\/([^/?]+)$/.exec(url);
      if (detail && method === 'GET') return { data: approvalPlans.find((x) => x._id === detail[1]) || {} };
      if (url.endsWith('/autofill')) return { data: { stages: [] } };
      return { data: {} };
    }),
  };
});

const base: GridRow = {
  rowId: 'r1', rowStatus: 'submitted', editable: true, postingDate: '2031-11-16', topic: 'Founder reel', type: 'Reel',
  scriptStatus: '', scriptDoneDate: '', scriptOwner: '', shootStatus: '', shootDoneDate: '', shootOwner: '',
  editStatus: '', editDoneDate: '', editOwner: '', approvalStatus: '', approvalDate: '', publishedDate: '',
  postingOwner: '', turnaroundDays: null, remarks: '', brief: 'Brief', publishTime: '18:00', contentLink: '',
  reviewFeedback: '', changeRequest: null, workflow: 'full',
  stepDeadlines: { Script: '2031-11-08', Shoot: '2031-11-11', Edit: '2031-11-14', Post: '2031-11-16' },
  ownerSources: {}, ownerIds: {}, contentOwner: '', designOwner: '', contentStatus: 'N/A', designStatus: 'N/A',
  needsScript: true, needsShoot: true, programOrEvent: '', referenceLink: '', priority: 'Normal', sourceVideoLink: '', pipeline: 'reel_a',
  stages: ['Script', 'Shoot', 'Edit', 'Post'],
};
const approved: GridRow = { ...base, rowId: 'r9', topic: 'Old approved', rowStatus: 'approved', editable: false };
const sentBack: GridRow = {
  ...base,
  rowStatus: 'changes_requested',
  reviewFeedback: 'Post it after the lab opening.',
  changeRequest: { message: 'Post it after the lab opening.', suggestions: { postingDate: '2031-11-18', workflow: 'shoot_edit' }, requestedAt: '2031-11-01T10:00:00.000Z' },
};

const plan = { _id: 'plan1', code: 'PLAN-2031-11-001', title: 'SM November 2031', status: 'Submitted', rowCount: 2, periodStart: '', periodEnd: '', periodIssue: null };
const grid = (over: Partial<GridData> = {}): GridData => ({
  calendar: 'sm', month: '2031-11', columns: PLAN_GRID_COLUMNS, displayColumns: PLAN_GRID_DISPLAY_COLUMNS, types: [...DELIVERABLE_TYPE_KEYS],
  plans: [plan], selectionRequired: false, plan,
  rows: [base, approved],
  permissions: { canEdit: false, canReview: true, readOnly: false },
  people: [],
  ...over,
});
const show = async (over: Partial<GridData> = {}) => {
  gridResponse = grid(over);
  render(<PlanGrid initialCalendar="sm" initialMonth="2031-11" onClose={vi.fn()} />);
  await screen.findByText(/PLAN-2031-11-001 ·/);
};
const reviewCalls = () => calls.filter((c) => c.url === '/api/calendar-plans/plan1/review');

beforeEach(() => {
  calls.length = 0;
  role = 'creative_lead';
  historyResponse = [];
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});
afterEach(() => {
  // @ts-expect-error reset between tests
  delete window.matchMedia;
});

describe('The lead sends a row back with suggested values', () => {
  it('a row the lead added or submitted: the panel offers no send-back (another approver decides it)', async () => {
    await show({ rows: [{ ...base, ownRow: true }, approved] });
    expect(screen.queryByRole('button', { name: 'Review row: Founder reel' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Row details: Founder reel|Edit row: Founder reel|View row: Founder reel/ }));
    const panel = await screen.findByRole('dialog', { name: 'Founder reel' });
    expect(within(panel).queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument();
  });

  it('sends the message and only the values that change', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Review row: Founder reel' }));
    const panel = await screen.findByRole('dialog', { name: 'Founder reel' });
    fireEvent.change(within(panel).getByLabelText('What needs to change'), { target: { value: 'Move it and skip the script.' } });
    fireEvent.click(within(panel).getByText('Suggest new values'));
    fireEvent.change(within(panel).getByLabelText('Posting date', { selector: '#suggest-date' }), { target: { value: '2031-11-18' } });
    fireEvent.change(within(panel).getByLabelText('Workflow', { selector: '#suggest-workflow' }), { target: { value: 'shoot_edit' } });
    // Same topic as now: not sent.
    fireEvent.change(within(panel).getByLabelText('Topic', { selector: '#suggest-topic' }), { target: { value: 'Founder reel' } });
    expect(within(panel).getByText('Now: 16 Nov 2031')).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(reviewCalls()[0].body).toEqual({
      action: 'request_changes',
      changes: [{ rowId: 'r1', comment: 'Move it and skip the script.', suggestions: { postingDate: '2031-11-18', workflow: 'shoot_edit' } }],
    });
  });

  it('the suggested date is limited to the plan month', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Review row: Founder reel' }));
    const panel = await screen.findByRole('dialog', { name: 'Founder reel' });
    const date = within(panel).getByLabelText('Posting date', { selector: '#suggest-date' });
    expect(date).toHaveAttribute('min', '2031-11-01');
    expect(date).toHaveAttribute('max', '2031-11-30');
  });
});

describe('Whole-plan Request changes', () => {
  it('needs a message, then sends request_changes_all; approved rows are said to stay approved', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes on plan' }));
    const dlg = await screen.findByRole('dialog', { name: 'Request changes on the plan' });
    expect(dlg).toHaveTextContent('All 1 submitted row goes back');
    expect(dlg).toHaveTextContent('Approved rows stay approved.');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Send back' }));
    expect(within(dlg).getByText('Write what should change before sending the plan back.')).toBeInTheDocument();
    expect(reviewCalls()).toHaveLength(0);
    fireEvent.change(within(dlg).getByLabelText('What should change'), { target: { value: 'Use the new offer price.' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Send back' }));
    await waitFor(() => expect(reviewCalls()).toHaveLength(1));
    expect(reviewCalls()[0].body).toEqual({ action: 'request_changes_all', message: 'Use the new offer price.' });
  });

  it('is disabled when no row is waiting', async () => {
    await show({ rows: [approved] });
    expect(screen.getByRole('button', { name: 'Request changes on plan' })).toBeDisabled();
  });
});

describe('The SM Manager sees the request and applies the suggestion', () => {
  beforeEach(() => {
    role = 'sm_manager';
  });

  it('shows "current → suggested", applies it, and the row can then be resubmitted', async () => {
    historyResponse = [
      { action: 'changes_requested', at: '2031-11-01T10:00:00.000Z', by: { name: 'Lead', role: 'creative_lead' }, message: 'Post it after the lab opening.', suggestions: sentBack.changeRequest!.suggestions, applied: null, before: { postingDate: '2031-11-16', workflow: 'full' }, withPlan: false },
    ];
    await show({ rows: [sentBack], permissions: { canEdit: true, canReview: false, readOnly: false } });
    fireEvent.click(screen.getByRole('button', { name: /Edit row: Founder reel|Row details: Founder reel/ }));
    const panel = await screen.findByRole('dialog', { name: 'Founder reel' });
    const banner = within(panel).getByRole('region', { name: 'Changes requested' });
    expect(banner).toHaveTextContent('Post it after the lab opening.');
    expect(banner).toHaveTextContent('Posting date: 16 Nov 2031 → 18 Nov 2031');
    expect(banner).toHaveTextContent('Workflow: Full → Shoot + Edit');
    // The old plain feedback box is replaced by the request.
    expect(within(panel).queryByRole('region', { name: 'Review feedback' })).not.toBeInTheDocument();
    // History lists the request.
    const history = await within(panel).findByRole('region', { name: 'Row history' });
    expect(history).toHaveTextContent('Changes requested');
    expect(within(panel).getByRole('button', { name: 'Resubmit row' })).toBeInTheDocument();

    fireEvent.click(within(banner).getByRole('button', { name: 'Apply suggestion' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/calendar-plans/plan1/rows/r1/apply-suggestion' && c.method === 'POST')).toBe(true));
  });

  it('a lead does not get Apply suggestion', async () => {
    role = 'creative_lead';
    await show({ rows: [sentBack], permissions: { canEdit: false, canReview: true, readOnly: false } });
    fireEvent.click(screen.getByLabelText(/Only rows waiting for review/));
    fireEvent.click(screen.getByRole('button', { name: 'Row details: Founder reel' }));
    const panel = await screen.findByRole('dialog', { name: 'Founder reel' });
    expect(within(panel).getByRole('region', { name: 'Changes requested' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Apply suggestion' })).not.toBeInTheDocument();
  });
});

describe('The other lead sees the grid read-only', () => {
  it('Marketing Growth Manager on an SM plan: no review controls, and the note says who reviews it', async () => {
    role = 'growth_lead';
    // The note names the calendar's configured plan approvers (from the API), not a role.
    await show({ permissions: { canEdit: false, canReview: false, readOnly: true }, planApprovers: ['Check Lead'] });
    expect(screen.getByText("Read-only view: Check Lead approves this calendar's plans.")).toBeInTheDocument();
    for (const name of [/Request changes on plan/, /Approve whole plan/, /Approve selected/]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });
});

describe('Plans waiting for approval are listed per calendar lead', () => {
  const p = (id: string, calendar: string) => ({
    _id: id, code: `PLAN-${id}`, title: `${calendar} plan`, kind: 'individual', calendar,
    periodStart: '2031-11-01T00:00:00.000Z', periodEnd: '2031-11-30T23:59:59.999Z', status: 'Submitted',
    createdAt: '2031-10-01T00:00:00.000Z', rowCount: 1, submittedRowCount: 1, approvedRowCount: 0, rows: [],
  });
  const showList = async () => {
    approvalPlans = [p('sm1', 'sm'), p('ads1', 'ads')];
    render(<MemoryRouter><PlansApprovalTab /></MemoryRouter>);
  };

  it('Marketing Growth Manager sees Ads plans only; Creative Manager sees the rest; admin sees all', async () => {
    role = 'growth_lead';
    await showList();
    expect(await screen.findByText('ads plan')).toBeInTheDocument();
    expect(screen.queryByText('sm plan')).not.toBeInTheDocument();
  });

  it('Creative Manager', async () => {
    role = 'creative_lead';
    await showList();
    expect(await screen.findByText('sm plan')).toBeInTheDocument();
    expect(screen.queryByText('ads plan')).not.toBeInTheDocument();
  });

  it('admin', async () => {
    role = 'admin';
    await showList();
    expect(await screen.findByText('sm plan')).toBeInTheDocument();
    expect(screen.getByText('ads plan')).toBeInTheDocument();
  });
});

describe('The shared rule the pages use', () => {
  it('decides per calendar and never on own work', () => {
    expect(canDecide('growth_lead', 'ads')).toBe(true);
    expect(canDecide('growth_lead', 'sm')).toBe(false);
    expect(canDecide('creative_lead', 'ads')).toBe(false);
    expect(canDecide('admin', 'ads')).toBe(true);
    expect(canDecide({ _id: 'u1', role: 'creative_lead' }, 'sm', { ownerId: 'u1' })).toBe(false);
  });
});
