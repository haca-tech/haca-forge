import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { FeedbackPage, timeAgo } from '../FeedbackPage';
import * as authContext from '../../../context/AuthContext';
import * as apiModule from '../../../lib/api';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => mockNavigate }));
vi.mock('../../../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiFetch: vi.fn() }));

const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;
const useAuth = authContext.useAuth as unknown as ReturnType<typeof vi.fn>;
const as = (role: string) => useAuth.mockReturnValue({ user: { _id: `${role}-1`, role, name: role }, hasPermission: () => true });
const H = 3600000;
const ago = (h: number) => new Date(Date.now() - h * H).toISOString();

const item = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
  workItemId: id, title, stageKey: 'Edit', type: 'Reel', calendar: 'sm', owner: { _id: 'o1', name: 'Check editor' },
  status: 'Feedback', reviewState: 'awaiting_review', statusLabel: 'Waiting for review', version: 1, submittedAt: ago(3), decidedAt: null,
  revisions: 0, revisionsLabel: 'No revisions', timeLabels: [], flag: null, ...extra,
});
const LEAD_TABS = [
  { key: 'waiting', label: 'Waiting for review', count: 2 },
  { key: 'changes', label: 'Changes requested', count: 1 },
  { key: 'pauses', label: 'Pause requests', count: 1 },
  { key: 'plans', label: 'Plan approvals', count: 1 },
  { key: 'flagged', label: 'Flagged (round 4)', count: 1 },
  { key: 'history', label: 'History', count: 1 },
];
const step = (mainAction: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  step: { _id: 'w1', title: 'Open day reel – Edit', stageKey: 'Edit', type: 'Reel', calendar: 'sm', owner: { _id: 'o1', name: 'Check editor' }, status: 'Feedback', reviewState: 'awaiting_review', statusLabel: 'Waiting for review', version: 2, dueDate: ago(-48), revisions: 1, revisionsLabel: '1 revision', ...extra },
  mainAction,
  events: [
    { kind: 'earlier_note', at: ago(90), by: 'Old Lead', message: 'From the old Feedback page', round: 1 },
    { kind: 'submitted', at: ago(80), by: 'Check editor', version: 1, note: 'First cut', links: [{ url: 'https://example.invalid/v1', kind: 'link' }] },
    { kind: 'changes_requested', at: ago(70), by: 'Check creativelead', version: 1, message: 'Shorten the intro', rootCause: 'Brief unclear' },
    { kind: 'rework_started', at: ago(60), by: 'Check editor' },
    { kind: 'pause_requested', at: ago(55), by: 'Check editor', reason: 'urgent_task', note: 'Admissions reel' },
    { kind: 'pause_approved', at: ago(54), by: 'Check creativelead' },
    { kind: 'submitted', at: ago(30), by: 'Check editor', version: 2, note: 'Shorter intro' },
    { kind: 'approved', at: ago(20), by: 'Check creativelead', version: 2, rating: 5, message: 'Lovely pacing' },
  ],
});
const mockHub = (hub: Record<string, unknown>, timeline?: Record<string, unknown>) =>
  apiFetch.mockImplementation(async (url: string) => {
    if (url.startsWith('/api/review-hub/steps/')) return { data: timeline };
    if (url.startsWith('/api/review-hub')) return { data: hub };
    return { data: [] };
  });
const open = (path = '/feedback') => render(<MemoryRouter initialEntries={[path]}><FeedbackPage /></MemoryRouter>);

beforeEach(() => vi.clearAllMocks());

describe('Review Hub', () => {
  it('shows the lead tabs with counts and no old Feedback forms', async () => {
    as('creative_lead');
    mockHub({ viewer: 'lead', tab: 'waiting', tabs: LEAD_TABS, items: [item('w1', 'Open day reel – Edit', { submittedAt: ago(26) }), item('w2', 'Hostel tour post – Design')] }, step({ kind: 'open_review_studio', href: '/feedback/review-studio?submissionId=s2' }));
    open('/feedback?step=w1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Review Hub' })).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
    expect(tabs).toEqual(['Waiting for review (2)', 'Changes requested (1)', 'Pause requests (1)', 'Plan approvals (1)', 'Flagged (round 4) (1)', 'History (1)']);
    expect(screen.getByText(/submitted 26h ago/)).toBeInTheDocument();
    await screen.findByRole('list', { name: 'Review timeline' });
    expect(screen.queryByText(/Submit Thread Update/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Request a revision \(new round\)/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Respond to Latest Reviewer Feedback/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Two-Entry/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    // Nothing is written by looking.
    expect(apiFetch.mock.calls.every(([, o]: any[]) => !o?.method || o.method === 'GET')).toBe(true);
  });

  it('search and calendar filter go to the URL and the request', async () => {
    as('creative_lead');
    mockHub({ viewer: 'lead', tab: 'waiting', tabs: LEAD_TABS, items: [] });
    open('/feedback?calendar=ads&q=editor');
    await screen.findByText('Nothing here.');
    expect(apiFetch).toHaveBeenCalledWith('/api/review-hub?q=editor&calendar=ads');
    expect(screen.getByLabelText('Search')).toHaveValue('editor');
    expect(screen.getByLabelText('Calendar')).toHaveValue('ads');
  });

  it('renders the timeline oldest first with ratings, root causes and earlier notes', async () => {
    as('creative_lead');
    mockHub({ viewer: 'lead', tab: 'history', tabs: LEAD_TABS, items: [] }, step({ kind: 'open_work_detail', href: '/work/w1' }));
    open('/feedback?tab=history&step=w1');
    const list = await screen.findByRole('list', { name: 'Review timeline' });
    const kinds = Array.from(list.querySelectorAll(':scope > li')).map((li) => li.getAttribute('data-kind'));
    expect(kinds).toEqual(['earlier_note', 'submitted', 'changes_requested', 'rework_started', 'pause_requested', 'pause_approved', 'submitted', 'approved']);
    expect(within(list).getByText(/Earlier note by Old Lead/)).toBeInTheDocument();
    expect(within(list).getByText('Root cause: Brief unclear')).toBeInTheDocument();
    expect(within(list).getByLabelText('Rated 5 out of 5')).toBeInTheDocument();
    expect(within(list).getByText('Lovely pacing')).toBeInTheDocument();
    expect(screen.getByTestId('hub-revisions')).toHaveTextContent('1 revision');
  });

  it.each([
    ['open_review_studio', { kind: 'open_review_studio', href: '/feedback/review-studio?submissionId=s2' }, /Open in Review Studio/],
    ['classify', { kind: 'classify', flagId: 'f1' }, /Classify root cause/],
    ['start_rework', { kind: 'start_rework' }, /Start rework/],
    ['resubmit', { kind: 'resubmit' }, /Resubmit link/],
    ['open_work_detail', { kind: 'open_work_detail', href: '/work/w1' }, /Open Work Detail/],
  ])('shows exactly one main action: %s', async (_k, action, name) => {
    as('creative_lead');
    mockHub({ viewer: 'lead', tab: 'waiting', tabs: LEAD_TABS, items: [] }, step(action));
    open('/feedback?step=w1');
    const box = await screen.findByTestId('hub-main-action');
    expect(box.children).toHaveLength(1);
    expect(within(box).getByText(name)).toBeInTheDocument();
  });

  it('Open in Review Studio deep-links the version; Start rework moves the step to In Progress', async () => {
    as('creative_lead');
    mockHub({ viewer: 'lead', tab: 'waiting', tabs: LEAD_TABS, items: [] }, step({ kind: 'open_review_studio', href: '/feedback/review-studio?submissionId=s2' }));
    open('/feedback?step=w1');
    fireEvent.click(await screen.findByRole('button', { name: /Open in Review Studio/ }));
    expect(mockNavigate).toHaveBeenCalledWith('/feedback/review-studio?submissionId=s2');

    as('executive');
    mockHub({ viewer: 'worker', tab: 'needs_action', tabs: [], items: [] }, step({ kind: 'start_rework' }, { reviewState: 'changes_requested' }));
    open('/feedback?step=w1');
    fireEvent.click(await screen.findByRole('button', { name: /Start rework/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/work/w1/transition', { method: 'POST', body: JSON.stringify({ toStatus: 'In Progress' }) }));
  });

  it('a worker gets their three tabs and no Review Studio button', async () => {
    as('executive');
    mockHub({ viewer: 'worker', tab: 'needs_action', tabs: [{ key: 'needs_action', label: 'Needs my action', count: 1 }, { key: 'waiting', label: 'Waiting for review', count: 0 }, { key: 'history', label: 'History', count: 2 }], items: [item('w1', 'Alumni story reel – Edit', { reviewState: 'changes_requested', decidedAt: ago(20), revisions: 1, revisionsLabel: '1 revision' })] });
    open();
    expect((await screen.findAllByRole('tab')).map((t) => t.textContent)).toEqual(['Needs my action (1)', 'Waiting for review (0)', 'History (2)']);
    expect(screen.getByText(/sent back 20h ago · 1 revision/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Open Review Studio/ })).not.toBeInTheDocument();
  });

  it('read-only heads see no Review Studio button', async () => {
    as('creative_head');
    mockHub({ viewer: 'viewer', tab: 'waiting', tabs: LEAD_TABS, items: [] }, step({ kind: 'open_work_detail', href: '/work/w1' }));
    open('/feedback?step=w1');
    const box = await screen.findByTestId('hub-main-action');
    expect(within(box).getByText(/Open Work Detail/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review Studio/ })).not.toBeInTheDocument();
    expect(screen.getByText('Every review round, read-only.')).toBeInTheDocument();
  });

  it('timeAgo wording', () => {
    const now = Date.now();
    expect(timeAgo(new Date(now - 10000).toISOString(), now)).toBe('just now');
    expect(timeAgo(new Date(now - 5 * 60000).toISOString(), now)).toBe('5m ago');
    expect(timeAgo(new Date(now - 3 * H).toISOString(), now)).toBe('3h ago');
    expect(timeAgo(new Date(now - 72 * H).toISOString(), now)).toBe('3d ago');
  });
});
