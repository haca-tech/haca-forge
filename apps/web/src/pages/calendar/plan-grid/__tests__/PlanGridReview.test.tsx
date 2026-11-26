import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { PLAN_GRID_DISPLAY_COLUMNS, DELIVERABLE_TYPE_KEYS, PLAN_GRID_COLUMNS } from '@mmp/shared';
import { PlanGrid } from '../PlanGrid';
import { composeMessage } from '../PlanGridReview';
import type { GridData, GridRow } from '../types';

// The reviewer's default screen: a review list (cards) instead of the editing grid.
const calls: { url: string; method: string; body: any }[] = [];
let gridResponse: GridData;

vi.mock('../../../../context/AuthContext', () => ({ useAuth: () => ({ user: { _id: 'u1', role: 'creative_lead', name: 'Lead' }, hasPermission: () => true }) }));
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
      return { data: {} };
    }),
  };
});

const row = (over: Partial<GridRow>): GridRow => ({
  rowId: 'r1', rowStatus: 'submitted', editable: true, postingDate: '2031-11-12', topic: 'Founder reel', type: 'Reel',
  scriptStatus: '', scriptDoneDate: '', scriptOwner: 'Asha Writer', shootStatus: '', shootDoneDate: '', shootOwner: '',
  editStatus: '', editDoneDate: '', editOwner: 'Ravi Editor', approvalStatus: '', approvalDate: '', publishedDate: '',
  postingOwner: '', turnaroundDays: null, remarks: '', brief: 'Founder story, 30 seconds.', publishTime: '18:00', contentLink: '',
  reviewFeedback: '', stepDeadlines: { Script: '2031-11-04', Edit: '2031-11-10' }, ownerSources: {}, ownerIds: { Script: 'p-writer', Edit: 'p-editor' },
  contentOwner: '', designOwner: '', contentStatus: 'N/A', designStatus: 'N/A', needsScript: true, needsShoot: false,
  programOrEvent: '', referenceLink: '', priority: 'Normal', sourceVideoLink: '', pipeline: 'reel_a', stages: ['Script', 'Edit'],
  planId: 'plan1', planKind: 'monthly', ...over,
});

const rows = [
  row({}),
  row({ rowId: 'r2', topic: 'Campus tour', postingDate: '2031-11-14' }),
  row({ rowId: 'r3', topic: 'One-off poster', planId: 'indiv1', planKind: 'individual', planCode: 'PLAN-2031-11-002' }),
  row({ rowId: 'r4', topic: 'Old approved', rowStatus: 'approved', editable: false }),
];

const show = async () => {
  gridResponse = {
    calendar: 'sm', month: '2031-11', columns: PLAN_GRID_COLUMNS, displayColumns: PLAN_GRID_DISPLAY_COLUMNS, types: [...DELIVERABLE_TYPE_KEYS],
    plans: [{ _id: 'plan1', code: 'PLAN-2031-11-001', title: 'SM November 2031', status: 'Submitted', rowCount: 3, periodStart: '', periodEnd: '', periodIssue: null }],
    selectionRequired: false,
    plan: { _id: 'plan1', code: 'PLAN-2031-11-001', title: 'SM November 2031', status: 'Submitted', rowCount: 3, periodStart: '', periodEnd: '', periodIssue: null },
    rows,
    permissions: { canEdit: false, canReview: true, readOnly: false },
    people: [],
  };
  render(<PlanGrid initialCalendar="sm" initialMonth="2031-11" onClose={vi.fn()} />);
  await screen.findByRole('list', { name: 'Rows to review' });
};
const reviews = () => calls.filter((c) => c.url.endsWith('/review'));

beforeEach(() => {
  const store: Record<string, string> = {};
  vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } });
  calls.length = 0;
  Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {} }) });
});

describe('Review list (reviewer default)', () => {
  it('shows waiting rows as cards with counts, not the editing grid', async () => {
    await show();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Waiting 3/ })).toHaveAttribute('aria-selected', 'true');
    const list = screen.getByRole('list', { name: 'Rows to review' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getByText('Individual')).toBeInTheDocument();
    expect(within(list).queryByText('Old approved')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /Approved 1/ }));
    expect(within(screen.getByRole('list', { name: 'Rows to review' })).getByText('Old approved')).toBeInTheDocument();
  });

  it('approves one row from its card', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Approve Founder reel' }));
    await waitFor(() => expect(reviews()).toHaveLength(1));
    expect(reviews()[0]).toMatchObject({ url: '/api/calendar-plans/plan1/review', body: { action: 'approve_selected', approvedRowIds: ['r1'] } });
  });

  it('sends one row back with a quick reason and a note', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Request changes on Campus tour' }));
    const send = screen.getByRole('button', { name: 'Send back' });
    expect(send).toBeDisabled(); // nothing to say yet
    fireEvent.click(screen.getByRole('button', { name: 'Change the posting date' }));
    fireEvent.change(screen.getByLabelText(/^Note/), { target: { value: 'Move it to the 20th' } });
    fireEvent.click(send);
    await waitFor(() => expect(reviews()).toHaveLength(1));
    expect(reviews()[0].body).toEqual({ action: 'request_changes', changes: [{ rowId: 'r2', comment: 'Change the posting date. Move it to the 20th.' }] });
  });

  it('decides several rows together, one request per plan (individual work goes to its own plan)', async () => {
    await show();
    fireEvent.click(screen.getByLabelText('Select all waiting (3)'));
    const bar = screen.getByRole('region', { name: 'Selected rows' });
    expect(within(bar).getByText('3 selected')).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole('button', { name: 'Request changes (3)' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'Make the topic clearer' }));
    fireEvent.click(within(bar).getByRole('button', { name: 'Send back (3)' }));
    await waitFor(() => expect(reviews()).toHaveLength(2));
    const byUrl = Object.fromEntries(reviews().map((c) => [c.url, c.body]));
    expect(byUrl['/api/calendar-plans/plan1/review'].changes.map((c: any) => c.rowId).sort()).toEqual(['r1', 'r2']);
    expect(byUrl['/api/calendar-plans/indiv1/review'].changes).toEqual([{ rowId: 'r3', comment: 'Make the topic clearer.' }]);
  });

  it('the Grid switch brings back the grid', async () => {
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'Grid' }));
    expect(await screen.findByRole('table')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve whole plan' })).toBeInTheDocument();
  });

  it('composes reasons and a note into one message', () => {
    expect(composeMessage(['Use a different type'], '')).toBe('Use a different type.');
    expect(composeMessage([], ' Shorter hook! ')).toBe('Shorter hook!');
    expect(composeMessage([], '')).toBe('');
  });
});
