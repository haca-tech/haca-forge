import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CANONICAL_REVISION_ROOT_CAUSES } from '@mmp/shared';
import { DecisionBar } from '../review-studio/DecisionBar';
import { FeedbackPage } from '../FeedbackPage';
import { WorkDetailPage } from '../../work/WorkDetailPage';
import { IssuesBlockersPage } from '../../issues/IssuesBlockersPage';
import * as authContext from '../../../context/AuthContext';
import * as apiModule from '../../../lib/api';

vi.mock('../../../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiFetch: vi.fn() }));

const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;
const useAuth = authContext.useAuth as unknown as ReturnType<typeof vi.fn>;
const CANONICAL = [...CANONICAL_REVISION_ROOT_CAUSES];
const optionValues = (select: HTMLElement) => Array.from(select.querySelectorAll('option')).map((o) => o.value);
const now = new Date().toISOString();

const workItem = {
  _id: 'w1',
  title: 'Root cause test item',
  workType: 'Reel',
  deadline: now,
  status: 'Feedback',
  revisions: 4,
  reviewRequired: true,
  ownerId: { _id: 'owner-1', name: 'Sample Owner', email: 'o@example.invalid', role: 'executive' },
};

const hubFor = (rootCause: string | null) => (url: string) => {
  if (url.startsWith('/api/review-hub/steps/w1/timeline')) {
    return Promise.resolve({
      data: {
        step: { _id: 'w1', title: workItem.title, stageKey: 'Edit', type: 'Reel', calendar: 'sm', owner: { _id: 'owner-1', name: 'Sample Owner' }, status: 'In Progress', reviewState: null, statusLabel: 'In Progress', version: 4, dueDate: now, revisions: 3, revisionsLabel: '3 revisions' },
        mainAction: rootCause ? { kind: 'open_work_detail', href: '/work/w1' } : { kind: 'classify', flagId: 'f1' },
        events: [{ kind: 'flagged', at: now, revisions: 3 }, ...(rootCause ? [{ kind: 'classified', at: now, by: 'Earlier Lead', rootCause }] : [])],
      },
    });
  }
  if (url.startsWith('/api/review-hub')) return Promise.resolve({ data: { viewer: 'lead', tab: 'flagged', tabs: [{ key: 'flagged', label: 'Flagged (round 4)', count: rootCause ? 0 : 1 }], items: [] } });
  return Promise.resolve({ data: [] });
};
const renderHub = () => render(<MemoryRouter initialEntries={['/feedback?tab=flagged&step=w1']}><FeedbackPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { _id: 'head-1', role: 'creative_lead', name: 'Head' }, hasPermission: () => true });
});

describe('Revision root causes: only the 7 canonical values are offered', () => {
  it('Review Studio decision bar', () => {
    render(<DecisionBar hasComments commentCount={1} onApprove={vi.fn()} onRequestRevision={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /request revision/i }));
    expect(optionValues(screen.getByLabelText(/root cause/i))).toEqual(CANONICAL);
  });

  it('Work Detail Request Rework', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url === '/api/work/w1') {
        return Promise.resolve({ data: { ...workItem, status: 'Pending', stageKey: 'Content', latestSubmission: { _id: 's1', status: 'submitted', version: 1 } } });
      }
      return Promise.resolve({ data: [] });
    });
    render(
      <MemoryRouter initialEntries={['/work/w1']}>
        <Routes>
          <Route path="/work/:id" element={<WorkDetailPage />} />
        </Routes>
      </MemoryRouter>
    );
    fireEvent.click((await screen.findAllByRole('button', { name: 'Request Rework' }))[0]);
    const dialog = screen.getByRole('dialog', { name: 'Request Rework' });
    expect(optionValues(within(dialog).getByLabelText(/root cause/i))).toEqual(CANONICAL);
  });

  it('Review Hub Classify root cause', async () => {
    apiFetch.mockImplementation(hubFor(null));
    renderHub();
    fireEvent.click(await screen.findByRole('button', { name: /Classify root cause/ }));
    const dialog = screen.getByRole('dialog', { name: /Classify root cause/ });
    expect(optionValues(within(dialog).getByLabelText(/^root cause$/i))).toEqual(CANONICAL);
  });

  it('Issues & Blockers Classify Root Cause', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url === '/api/revisions/flags') return Promise.resolve({ data: [{ _id: 'f1', workItemId: workItem, ownerId: workItem.ownerId, revisionsCount: 4, baselineAvg: 1.5, isFlagged: true, flaggedAt: now, rootCause: null }] });
      return Promise.resolve({ data: [] });
    });
    render(<MemoryRouter><IssuesBlockersPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Revision Flags/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Classify Root Cause/ }));
    const select = screen.getAllByRole('combobox').find((el) => optionValues(el).includes('Brief unclear'))!;
    expect(optionValues(select)).toEqual(CANONICAL);
  });
});

describe('Legacy root causes stay readable', () => {
  it('Review Hub renders a flag saved with a legacy cause, without offering to change it', async () => {
    apiFetch.mockImplementation(hubFor('Script change'));
    renderHub();
    expect(await screen.findByText('Script change')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Classify root cause/ })).not.toBeInTheDocument();
    // Reading never writes: only GET requests were made.
    expect(apiFetch.mock.calls.every(([, opts]: any[]) => !opts || !opts.method || opts.method === 'GET')).toBe(true);
  });

  it('Issues & Blockers renders a flag saved with a legacy cause', async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url === '/api/revisions/flags') return Promise.resolve({ data: [{ _id: 'f2', workItemId: workItem, ownerId: workItem.ownerId, revisionsCount: 5, baselineAvg: 1.5, isFlagged: true, flaggedAt: now, rootCause: 'Visual defect', classifiedBy: { name: 'Earlier Lead' } }] });
      return Promise.resolve({ data: [] });
    });
    render(<MemoryRouter><IssuesBlockersPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Revision Flags/ }));
    expect(await screen.findByText('Visual defect')).toBeInTheDocument();
    expect(apiFetch.mock.calls.every(([, opts]: any[]) => !opts || !opts.method || opts.method === 'GET')).toBe(true);
  });
});
