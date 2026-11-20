import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MyWorkPage } from '../MyWorkPage';
import { WorkDetailPage } from '../WorkDetailPage';
import * as authContext from '../../../context/AuthContext';
import * as apiModule from '../../../lib/api';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => mockNavigate }));
vi.mock('../../../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => ({ on: () => () => {}, emit: vi.fn() }) }));

const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;
const useAuth = authContext.useAuth as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { _id: 'owner-1', id: 'owner-1', role: 'executive', name: 'Owner' }, hasPermission: () => true });
});

const myWork = (extra: Record<string, unknown>) => ({
  data: {
    overdue: [],
    today: [{ _id: 'w1', title: 'Edit step', workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', startedAt: new Date().toISOString(), deadline: '2031-11-05T00:00:00.000Z', priority: 'Normal', revisions: 0, isLocked: false, ownerId: 'owner-1', latestSubmissionStatus: null, ...extra }],
    thisWeek: [],
    upcoming: [],
    completed: [],
    stats: { activeCount: 1, overdueCount: 0, todayCount: 1, completedCount: 0, avgRevisions: 0 },
  },
});

describe('"View review" on My Work', () => {
  it('is not shown before a version exists', async () => {
    apiFetch.mockImplementation(async (url: string) => (url.includes('/my-work') ? myWork({}) : { data: {} }));
    render(<MemoryRouter><MyWorkPage /></MemoryRouter>);
    await screen.findByText('Edit step');
    expect(screen.queryByTestId('view-review')).not.toBeInTheDocument();
  });

  it('is shown once a version exists, and opens Review Studio for the step', async () => {
    apiFetch.mockImplementation(async (url: string) => (url.includes('/my-work') ? myWork({ status: 'Feedback', revisions: 1, latestSubmissionStatus: 'changes_requested' }) : { data: {} }));
    render(<MemoryRouter><MyWorkPage /></MemoryRouter>);
    fireEvent.click(await screen.findByTestId('view-review'));
    expect(mockNavigate).toHaveBeenCalledWith('/work/w1/review');
  });
});

describe('"View review" on Work Detail', () => {
  const step = (extra: Record<string, unknown>) => ({
    _id: 'w1', title: 'Edit step', workType: 'Reel', stageKey: 'Edit', status: 'In Progress', deadline: new Date(Date.now() + 86400000).toISOString(),
    revisions: 0, reviewRequired: true, ownerId: { _id: 'owner-1', name: 'Owner', role: 'executive' }, ...extra,
  });
  const show = (data: Record<string, unknown>) => {
    apiFetch.mockImplementation(async (url: string) => (url === '/api/work/w1' ? { data } : { data: [] }));
    render(
      <MemoryRouter initialEntries={['/work/w1']}>
        <Routes>
          <Route path="/work/:id" element={<WorkDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  };

  it('is not shown before a version exists', async () => {
    show(step({}));
    await screen.findAllByText('Edit step');
    expect(screen.queryByTestId('view-review')).not.toBeInTheDocument();
  });

  it('is shown to the owner once a version exists', async () => {
    show(step({ status: 'Feedback', latestSubmission: { _id: 's1', status: 'submitted', version: 1 } }));
    fireEvent.click(await screen.findByTestId('view-review'));
    expect(mockNavigate).toHaveBeenCalledWith('/work/w1/review');
  });
});
