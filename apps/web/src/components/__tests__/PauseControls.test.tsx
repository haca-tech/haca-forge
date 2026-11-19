import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { getAvailableActions, stepTimeLabels } from '@mmp/shared';
import { PausePanel, type PauseInfo } from '../pause/PauseControls';
import { PauseRequestsTab } from '../../pages/feedback/PauseRequestsTab';
import { TrackerRow } from '../../pages/calendar/tracker/TrackerRow';
import { matchesStatus, TRACKER_STATUSES, type TrackerPiece } from '../../pages/calendar/tracker/trackerModel';
import { TimeLabelChips } from '../TimeLabelChips';

// Pause work with lead approval: the owner's Request pause dialog and banners, the lead's
// decision buttons, read-only viewers, the Feedback "Pause requests" tab and the Tracker.

const calls: { url: string; method: string; body: any }[] = [];
let listResponse: any[] = [];
vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (url: string, opts: any = {}) => {
    const method = opts.method || 'GET';
    calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    if (url === '/api/my-work') return { data: { overdue: [], today: [{ _id: 'urgent1', title: 'Launch reel – Edit' }, { _id: 's1', title: 'This step' }], thisWeek: [], upcoming: [] } };
    if (url === '/api/work/pause-requests') return { data: listResponse };
    return { data: {} };
  }),
}));

const base: PauseInfo = { state: null, request: null, active: null, lastRejected: null, count: 0, totalMs: 0, canRequest: true, canCancel: false, canDecide: false, canResume: false };
const req = { _id: 'r1', reason: 'urgent_task' as const, reasonLabel: 'Urgent task', note: 'Launch video due today', urgentStep: { _id: 'urgent1', title: 'Launch reel – Edit' }, pauseUntil: '2034-03-12', requestedAt: '2034-03-10T05:00:00.000Z' };
const posts = () => calls.filter((c) => c.method === 'POST');

beforeEach(() => {
  calls.length = 0;
  listResponse = [];
});

describe('Owner: Request pause', () => {
  it('needs a note; sends reason, urgent step, note and pause-until; then refreshes', async () => {
    const onChanged = vi.fn();
    render(<PausePanel stepId="s1" stepTitle="This step" pause={base} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request pause' }));
    const dlg = await screen.findByRole('dialog', { name: 'Request pause' });
    expect(dlg).toHaveTextContent('Work time keeps counting until the pause is approved');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Send request' }));
    expect(within(dlg).getByText('Add a short note for the lead.')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
    // The urgent step comes from the worker's own open steps (not this one).
    const picker = await within(dlg).findByLabelText('The urgent step (optional)');
    expect(within(picker).queryByText('This step')).not.toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'urgent1' } });
    fireEvent.change(within(dlg).getByLabelText('Note for the lead'), { target: { value: 'Launch video due today' } });
    fireEvent.change(within(dlg).getByLabelText('Pause until (optional)'), { target: { value: '2034-03-12' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual({ url: '/api/work/s1/pause-request', method: 'POST', body: { reason: 'urgent_task', note: 'Launch video due today', urgentStepId: 'urgent1', pauseUntil: '2034-03-12' } });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('"Other" hides the urgent step picker', async () => {
    render(<PausePanel stepId="s1" stepTitle="This step" pause={base} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request pause' }));
    const dlg = await screen.findByRole('dialog', { name: 'Request pause' });
    fireEvent.click(within(dlg).getByLabelText('Other'));
    expect(within(dlg).queryByLabelText('The urgent step (optional)')).not.toBeInTheDocument();
  });

  it('"Pause requested" banner with Cancel; "Paused" banner with reason, until-date and Resume; stats', async () => {
    const { rerender } = render(<PausePanel stepId="s1" stepTitle="This step" pause={{ ...base, state: 'requested', request: req, canRequest: false, canCancel: true }} onChanged={vi.fn()} />);
    const pending = screen.getByRole('region', { name: 'Pause requested' });
    expect(pending).toHaveTextContent('Urgent task (Launch reel – Edit): Launch video due today');
    expect(pending).toHaveTextContent('Until 12 Mar');
    fireEvent.click(within(pending).getByRole('button', { name: 'Cancel request' }));
    await waitFor(() => expect(posts()[0].url).toBe('/api/work/s1/pause-request/cancel'));
    expect(screen.queryByRole('button', { name: 'Request pause' })).not.toBeInTheDocument();

    rerender(<PausePanel stepId="s1" stepTitle="This step" showStats pause={{ ...base, state: 'paused', active: req, canRequest: false, canResume: true, count: 2, totalMs: 3 * 3600000 }} onChanged={vi.fn()} />);
    const paused = screen.getByRole('region', { name: 'Paused' });
    expect(paused).toHaveTextContent('Work time is stopped. The due date has not changed.');
    expect(paused).toHaveTextContent('Until 12 Mar');
    expect(screen.getByTestId('pause-stats')).toHaveTextContent('Paused 2 times · 3h');
    fireEvent.click(within(paused).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(posts().at(-1)!.url).toBe('/api/work/s1/resume'));
  });

  it('a rejected request is mentioned with the lead message', () => {
    render(<PausePanel stepId="s1" stepTitle="This step" pause={{ ...base, lastRejected: { ...req, decisionMessage: 'Finish first' } }} onChanged={vi.fn()} />);
    expect(screen.getByTestId('pause-rejected')).toHaveTextContent('Last pause request not approved: Finish first');
  });
});

describe('Lead and read-only viewers', () => {
  it('the lead approves, or rejects with an optional message', async () => {
    render(<PausePanel stepId="s1" stepTitle="This step" pause={{ ...base, state: 'requested', request: req, canRequest: false, canDecide: true }} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Approve pause/ }));
    await waitFor(() => expect(posts()[0]).toEqual({ url: '/api/work/s1/pause-request/decide', method: 'POST', body: { decision: 'approve' } }));
    fireEvent.click(screen.getByRole('button', { name: /Reject/ }));
    const dlg = await screen.findByRole('dialog', { name: 'Reject pause request' });
    fireEvent.change(within(dlg).getByLabelText('Message to the worker (optional)'), { target: { value: 'Due today' } });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reject request' }));
    await waitFor(() => expect(posts()[1].body).toEqual({ decision: 'reject', message: 'Due today' }));
  });

  it('a read-only viewer sees the state but no actions', () => {
    render(<PausePanel stepId="s1" stepTitle="This step" pause={{ ...base, state: 'paused', active: req, canRequest: false }} onChanged={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Paused' })).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('Feedback "Pause requests": decide buttons only where allowed; reject asks for the optional message', async () => {
    listResponse = [
      { _id: 'a', workItem: { _id: 'w1', title: 'Campus reel – Edit', status: 'In Progress', calendar: 'sm' }, owner: { _id: 'o1', name: 'Ravi' }, reasonLabel: 'Urgent task', note: 'Launch', urgentStep: null, pauseUntil: null, requestedAt: '2034-03-10T05:00:00.000Z', canDecide: true },
      { _id: 'b', workItem: { _id: 'w2', title: 'Ads reel – Edit', status: 'Feedback', calendar: 'ads' }, owner: { _id: 'o2', name: 'Asha' }, reasonLabel: 'Other', note: 'Doctor', urgentStep: null, pauseUntil: '2034-03-12', requestedAt: '2034-03-10T06:00:00.000Z', canDecide: false },
    ];
    const onCount = vi.fn();
    render(<MemoryRouter><PauseRequestsTab onCount={onCount} /></MemoryRouter>);
    const list = await screen.findByRole('list', { name: 'Pause requests' });
    expect(onCount).toHaveBeenCalledWith(2);
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Approve pause: Campus reel – Edit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve pause: Ads reel – Edit' })).not.toBeInTheDocument();
    expect(screen.getByText('Step is Feedback')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reject pause: Campus reel – Edit' }));
    const dlg = await screen.findByRole('dialog', { name: 'Reject pause request' });
    fireEvent.click(within(dlg).getByRole('button', { name: 'Reject request' }));
    await waitFor(() => expect(posts()[0]).toEqual({ url: '/api/work/w1/pause-request/decide', method: 'POST', body: { decision: 'reject' } }));
  });
});

describe('Actions, labels and the Tracker', () => {
  it('a paused step offers no work actions to its owner', () => {
    const user = { _id: 'o1', role: 'executive' };
    const stage = { _id: 's1', ownerId: 'o1', status: 'In Progress', stageKey: 'Edit', startedAt: '2034-03-01' };
    expect(getAvailableActions(user, stage).actions).toEqual(expect.arrayContaining(['submit_for_approval']));
    const paused = getAvailableActions(user, { ...stage, pauseState: 'paused' });
    expect(paused.actions).not.toContain('submit_for_approval');
    expect(paused.actions).not.toContain('mark_blocked');
  });

  it('"Paused" shows next to Overdue (due dates do not change)', () => {
    const labels = stepTimeLabels({ status: 'In Progress', dueDate: '2034-03-01', pauseState: 'paused' }, { now: '2034-03-05T06:00:00Z' });
    render(<TimeLabelChips labels={labels} />);
    expect(screen.getByText('Overdue by 4 days')).toBeInTheDocument();
    expect(screen.getByText('Paused')).toHaveAttribute('data-kind', 'paused');
  });

  const piece = (stage: Record<string, unknown>): TrackerPiece =>
    ({
      _id: 'p1', topic: 'Campus reel', postingDate: '2034-03-20T00:00:00.000Z', contentType: 'Reel', pipeline: 'reel_a', needsScript: false, needsShoot: false, rowStatus: 'approved',
      hasNeedsOwner: false, hasWaitingApproval: false, hasBlocked: false, hasOverdue: false,
      stages: [{ _id: 's1', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', dueDate: '2034-03-18', isLocked: false, isSkipped: false, revisions: 0, ownerId: { _id: 'o1', name: 'Ravi Editor' }, timeLabels: [], ...stage }],
    }) as unknown as TrackerPiece;

  it('Tracker: "Paused" chip with the reason as its tooltip; Status filter has Paused and Pause requested', () => {
    expect(TRACKER_STATUSES.map((s) => s.label)).toEqual(expect.arrayContaining(['Paused', 'Pause requested']));
    const paused = piece({ pauseState: 'paused', pauseReason: 'Urgent task: Launch video', timeLabels: [{ kind: 'paused', text: 'Paused' }] });
    const requested = piece({ pauseState: 'requested', pauseReason: 'Other: Doctor' });
    expect(matchesStatus(paused, 'paused')).toBe(true);
    expect(matchesStatus(paused, 'pause_requested')).toBe(false);
    expect(matchesStatus(requested, 'pause_requested')).toBe(true);
    expect(matchesStatus(piece({}), 'paused')).toBe(false);
    const props = { canAssign: false, canManageSteps: false, onOpenTimeline: vi.fn(), onAssign: vi.fn(), onChangeDate: vi.fn(), onToggleSkip: vi.fn(), onOpenPerson: vi.fn() };
    const { unmount } = render(<ul><TrackerRow piece={paused} {...props} /></ul>);
    const chip = screen.getByTestId('tracker-pause-chip');
    expect(chip).toHaveTextContent('Paused');
    expect(chip).toHaveAttribute('title', 'Urgent task: Launch video');
    // Not shown twice (the time label is folded into the chip).
    expect(screen.getAllByText('Paused')).toHaveLength(1);
    unmount();
    render(<ul><TrackerRow piece={requested} {...props} /></ul>);
    expect(screen.getByTestId('tracker-pause-chip')).toHaveTextContent('Pause requested');
  });
});
