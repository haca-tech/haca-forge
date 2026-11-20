import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TeamWorkloadPage } from './TeamWorkloadPage';
import * as authContext from '../../context/AuthContext';
import * as apiModule from '../../lib/api';

vi.mock('../../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));

const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;
const useAuth = authContext.useAuth as unknown as ReturnType<typeof vi.fn>;

const row = (id: string, name: string, jobRole: string, inProgress: number, dueThisWeek: number, band: 'Available' | 'Busy' | 'Over', extra: Record<string, unknown> = {}) => ({
  _id: id, name, role: 'executive', jobRole, avatarUrl: null, inProgress, dueThisWeek, limit: 4, band, nextDue: '2026-11-21', ...extra,
});
const LIST = {
  bands: { available: 2, busy: 1, over: 1 },
  people: [
    row('a', 'Asha Writer', 'Writer', 1, 1, 'Available'),
    row('c', 'Chitra Designer', 'Graphic Designer', 3, 3, 'Busy'),
    row('d', 'Dev Designer', 'Graphic Designer', 0, 0, 'Available', { nextDue: null }),
    row('e', 'Esha Editor', 'Video Editor', 2, 5, 'Over'),
  ],
  jobRoles: ['Graphic Designer', 'Video Editor', 'Writer'],
  canEditLimit: true,
  // Older fields (deprecated) must not show up on screen even if sent.
  departments: [{ name: 'General', avgWorkloadPct: 26, members: [] }],
  summary: { overallAvgWorkload: 26, totalCapacityHours: 280 },
};
const STEPS = {
  person: { _id: 'e', name: 'Esha Editor', jobRole: 'Video Editor' },
  workload: { inProgress: 2, dueThisWeek: 5, limit: 4, band: 'Over', nextDue: '2026-11-20' },
  steps: [
    { _id: 's1', title: 'Open day reel – Edit', stageKey: 'Edit', status: 'In Progress', paused: false, latestVersionStatus: null, dueDate: '2026-11-20T06:30:00.000Z', project: { name: 'Open day reel', code: 'P-1' } },
    { _id: 's2', title: 'Alumni reel – Edit', stageKey: 'Edit', status: 'Feedback', paused: false, latestVersionStatus: 'changes_requested', dueDate: '2026-11-22T06:30:00.000Z', project: { name: 'Alumni reel', code: 'P-2' } },
  ],
};

const mockApi = (list = LIST) =>
  apiFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === '/api/workload') return { data: list };
    if (url === '/api/workload/e/steps') return { data: STEPS };
    if (url.endsWith('/limit') && opts?.method === 'PUT') return { data: { ...STEPS.workload, limit: 6 } };
    return { data: {} };
  });
const open = (path = '/workload') => render(<MemoryRouter initialEntries={[path]}><TeamWorkloadPage /></MemoryRouter>);
const names = () => screen.getAllByTestId('wl-row').map((r) => within(r).getByRole('button', { name: /open steps/ }).getAttribute('aria-label'));

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { _id: 'l1', role: 'creative_lead', name: 'Lead' }, hasPermission: () => true });
});

describe('Team Workload (step counts)', () => {
  it('shows counts, next due and band per person, sorted by name, with no hours or percentages', async () => {
    mockApi();
    const { container } = open();
    await screen.findByText('Esha Editor');
    expect(names()).toEqual(['Asha Writer: open steps', 'Chitra Designer: open steps', 'Dev Designer: open steps', 'Esha Editor: open steps']);
    const esha = screen.getAllByTestId('wl-row')[3];
    expect(within(esha).getByTestId('wl-counts')).toHaveTextContent('2 in progress · 5 due this week');
    expect(within(esha).getByText('Over')).toBeInTheDocument();
    expect(within(esha).getByText(/Next due 21 Nov/)).toBeInTheDocument();
    expect(within(screen.getAllByTestId('wl-row')[2]).getByText('Nothing due')).toBeInTheDocument();
    // DOM test: no "h" (hours) and no "%" anywhere on the workload screen.
    const text = container.textContent || '';
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/\d+\s?h\b/);
    expect(text).not.toMatch(/hours|capacity|utili[sz]ation/i);
  });

  it('the summary chips count each band and filter the list (in the URL)', async () => {
    mockApi();
    open();
    await screen.findByText('Esha Editor');
    expect(screen.getByTestId('wl-chip-Available')).toHaveTextContent('Available 2');
    expect(screen.getByTestId('wl-chip-Busy')).toHaveTextContent('Busy 1');
    expect(screen.getByTestId('wl-chip-Over')).toHaveTextContent('Over 1');
    fireEvent.click(screen.getByTestId('wl-chip-Available'));
    await waitFor(() => expect(screen.getAllByTestId('wl-row')).toHaveLength(2));
    expect(screen.getByLabelText('Band')).toHaveValue('Available');
    fireEvent.click(screen.getByTestId('wl-chip-Available'));
    await waitFor(() => expect(screen.getAllByTestId('wl-row')).toHaveLength(4));
  });

  it('job role, band and search filters come from the URL', async () => {
    mockApi();
    open('/workload?jobRole=Graphic%20Designer&q=chi');
    await screen.findByText('Chitra Designer');
    expect(screen.getAllByTestId('wl-row')).toHaveLength(1);
    expect(screen.getByLabelText('Job role')).toHaveValue('Graphic Designer');
    expect(screen.getByLabelText('Search')).toHaveValue('chi');
    // Chips count what the role and search leave in view.
    expect(screen.getByTestId('wl-chip-Busy')).toHaveTextContent('Busy 1');
    expect(screen.getByTestId('wl-chip-Available')).toHaveTextContent('Available 0');
  });

  it('clicking a row opens the side panel with open steps linking to Work Detail', async () => {
    mockApi();
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Esha Editor: open steps' }));
    const panel = await screen.findByRole('dialog', { name: 'Esha Editor' });
    const links = await within(panel).findAllByRole('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/work/s1', '/work/s2']);
    expect(within(panel).getByText('Open day reel')).toBeInTheDocument();
    expect(within(panel).getByText('Changes requested')).toBeInTheDocument();
    expect(within(panel).getByText('Due 20 Nov')).toBeInTheDocument();
    expect(within(panel).getByText(/2 in progress · 5 due this week · limit 4/)).toBeInTheDocument();
  });

  it('admin and leads get a pencil to change a limit', async () => {
    mockApi();
    open();
    fireEvent.click(await screen.findByRole('button', { name: "Change Esha Editor's limit" }));
    const dialog = screen.getByRole('dialog', { name: /Active-step limit: Esha Editor/ });
    fireEvent.change(within(dialog).getByLabelText('Limit'), { target: { value: '6' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workload/e/limit', { method: 'PUT', body: JSON.stringify({ limit: 6 }) }));
  });

  it('no pencil when the viewer cannot change limits (e.g. the read-only heads)', async () => {
    useAuth.mockReturnValue({ user: { _id: 'h1', role: 'creative_head', name: 'Head' }, hasPermission: () => false });
    mockApi({ ...LIST, canEditLimit: false });
    open();
    await screen.findByText('Esha Editor');
    expect(screen.queryByRole('button', { name: /limit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Suggest an owner/ })).not.toBeInTheDocument();
  });
});
