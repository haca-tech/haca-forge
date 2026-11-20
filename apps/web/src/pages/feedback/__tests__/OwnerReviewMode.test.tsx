import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ReviewStudioPage } from '../review-studio/ReviewStudioPage';
import * as authContext from '../../../context/AuthContext';
import * as apiModule from '../../../lib/api';

vi.mock('../../../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => ({ on: () => () => {}, emit: vi.fn() }) }));

const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;
const useAuth = authContext.useAuth as unknown as ReturnType<typeof vi.fn>;
const signIn = (role: string, _id: string, name = role) => useAuth.mockReturnValue({ user: { _id, id: _id, role, name }, hasPermission: () => true });
const ago = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

const comments = [
  { _id: 'c1', text: 'Trim the intro here', authorId: { _id: 'lead-1', name: 'Check Lead', role: 'creative_lead' }, anchor: { type: 'time', seconds: 3 }, resolved: false, parentId: null, createdAt: ago(5) },
  { _id: 'c2', text: 'Trimmed to 2 seconds', authorId: { _id: 'owner-1', name: 'Esha Editor', role: 'executive' }, anchor: null, resolved: false, parentId: 'c1', createdAt: ago(4) },
  { _id: 'c3', text: 'Colour looks great', authorId: { _id: 'lead-1', name: 'Check Lead', role: 'creative_lead' }, anchor: null, resolved: true, parentId: null, createdAt: ago(3) },
];
const version = (status = 'changes_requested') => ({
  id: 's1', _id: 's1', version: 1, kind: 'video', status, calendar: 'sm', files: [{ url: '/uploads/v.mp4' }],
  workItemId: { _id: 'w1', title: 'Open day reel – Edit', stageKey: 'Edit', calendar: 'sm', ownerId: { _id: 'owner-1', name: 'Esha Editor' } },
  comments,
});
const timeline = (reviewState: string | null, status: string, mainAction: string, extra: any[] = []) => ({
  step: { _id: 'w1', title: 'Open day reel – Edit', stageKey: 'Edit', status, reviewState, version: 1 },
  mainAction: { kind: mainAction },
  events: [
    { kind: 'submitted', at: ago(30), by: 'Esha Editor', version: 1 },
    { kind: 'changes_requested', at: ago(20), by: 'Check Lead', version: 1, message: 'Shorten the intro and fix the colour.', rootCause: 'Execution quality' },
    ...extra,
  ],
});

const mock = (sub: any, tl: any) =>
  apiFetch.mockImplementation(async (url: string, opts?: any) => {
    if (url === '/api/submissions/review-queue') return [sub];
    if (url.startsWith('/api/submissions?workItemId=w1')) return [sub];
    if (url === '/api/submissions/s1/comments' && opts?.method === 'POST') return { data: { _id: 'c9', parentId: JSON.parse(opts.body).parentId, createdAt: new Date().toISOString() } };
    if (url.includes('/api/submissions/s1')) return sub;
    if (url === '/api/review-hub/steps/w1/timeline') return { data: tl };
    if (url === '/api/work/w1/transition') return { data: {} };
    return [];
  });
const openAs = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/work/:id/review" element={<ReviewStudioPage />} />
        <Route path="/feedback/review-studio" element={<ReviewStudioPage />} />
      </Routes>
    </MemoryRouter>,
  );
const threads = () => screen.getAllByTestId('review-thread');

beforeEach(() => vi.clearAllMocks());

describe('Review Studio: "my review" for the step owner', () => {
  it('shows the status, every comment with its replies and resolved state, and the decision message; no decision controls', async () => {
    signIn('executive', 'owner-1', 'Esha Editor');
    mock(version(), timeline('changes_requested', 'Feedback', 'start_rework'));
    openAs('/work/w1/review');
    expect(await screen.findByTestId('owner-review-status')).toHaveTextContent('Changes requested');
    expect(screen.getByTestId('owner-review-header')).toHaveTextContent(/sent back 20h ago/);
    expect(threads()).toHaveLength(2);
    expect(within(threads()[0]).getByText('Trim the intro here')).toBeInTheDocument();
    expect(within(threads()[0]).getByTestId('review-reply')).toHaveTextContent('Trimmed to 2 seconds');
    expect(within(threads()[0]).getByTestId('review-reply')).toHaveTextContent('Owner');
    expect(within(threads()[1]).getByText('Resolved')).toBeInTheDocument();
    // Decision message above the next action.
    expect(screen.getByTestId('owner-decision')).toHaveTextContent('Changes requested by Check Lead (version 1)');
    expect(screen.getByTestId('owner-decision')).toHaveTextContent('Shorten the intro and fix the colour.');
    // No decision bar, no new comments or pins, no resolve.
    expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /request revision/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /post comment/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as resolved/i })).not.toBeInTheDocument();
    // The owner's own view has no "New reply" badge.
    expect(screen.queryByTestId('new-reply-badge')).not.toBeInTheDocument();
  });

  it('filters resolved and unresolved comments', async () => {
    signIn('executive', 'owner-1');
    mock(version(), timeline('changes_requested', 'Feedback', 'start_rework'));
    openAs('/work/w1/review');
    await screen.findByTestId('owner-review-status');
    fireEvent.click(screen.getByRole('button', { name: 'Resolved (1)' }));
    expect(threads()).toHaveLength(1);
    expect(within(threads()[0]).getByText('Colour looks great')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unresolved (1)' }));
    expect(within(threads()[0]).getByText('Trim the intro here')).toBeInTheDocument();
  });

  it('replies are threaded under the comment (text only)', async () => {
    signIn('executive', 'owner-1');
    mock(version(), timeline('changes_requested', 'Feedback', 'start_rework'));
    openAs('/work/w1/review');
    await screen.findByTestId('owner-review-status');
    fireEvent.change(screen.getByLabelText('Reply to comment 1'), { target: { value: 'Will do' } });
    fireEvent.click(within(threads()[0]).getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/submissions/s1/comments', expect.objectContaining({ method: 'POST' })));
    const call = apiFetch.mock.calls.find(([u, o]: any[]) => u === '/api/submissions/s1/comments' && o?.method === 'POST')!;
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ text: 'Will do', content: 'Will do', parentId: 'c1' });
    expect(await within(threads()[0]).findByText('Will do')).toBeInTheDocument();
  });

  it('Start rework uses the existing flow', async () => {
    signIn('executive', 'owner-1');
    mock(version(), timeline('changes_requested', 'Feedback', 'start_rework'));
    openAs('/work/w1/review');
    fireEvent.click(await screen.findByRole('button', { name: /Start rework/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/work/w1/transition', { method: 'POST', body: JSON.stringify({ toStatus: 'In Progress' }) }));
  });

  it('Resubmit link opens the existing submit dialog during rework', async () => {
    signIn('executive', 'owner-1');
    mock(version(), timeline('rework_in_progress', 'In Progress', 'resubmit', [{ kind: 'rework_started', at: ago(2), by: 'Esha Editor' }]));
    openAs('/work/w1/review');
    expect(await screen.findByTestId('owner-review-status')).toHaveTextContent('Rework in progress');
    fireEvent.click(screen.getByRole('button', { name: /Resubmit link/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('after approval: "Approved ★4" and the rating message', async () => {
    signIn('executive', 'owner-1');
    mock(version('approved'), timeline(null, 'Approved', 'open_work_detail', [
      { kind: 'submitted', at: ago(10), by: 'Esha Editor', version: 2 },
      { kind: 'approved', at: ago(1), by: 'Check Lead', version: 2, rating: 4, message: 'Much better pacing.' },
    ]));
    openAs('/work/w1/review');
    expect(await screen.findByTestId('owner-review-status')).toHaveTextContent('Approved ★4');
    expect(screen.getByTestId('owner-decision')).toHaveTextContent('Approved by Check Lead (version 2)');
    expect(screen.getByTestId('owner-decision')).toHaveTextContent('Much better pacing.');
    expect(screen.queryByRole('button', { name: /Start rework|Resubmit link/ })).not.toBeInTheDocument();
  });
});

describe('Review Studio: the revision request in "my review"', () => {
  // request-revision saves its note as a first comment (same text, at the decision time).
  const sentBackAt = ago(20);
  const withRequest = () => ({
    ...version(),
    comments: [
      ...comments,
      { _id: 'c4', text: 'Shorten the intro and fix the colour.', authorId: { _id: 'lead-1', name: 'Check Lead', role: 'creative_lead' }, anchor: null, resolved: false, parentId: null, createdAt: sentBackAt },
    ],
  });
  const tl = () => {
    const t = timeline('changes_requested', 'Feedback', 'start_rework');
    t.events[1].at = sentBackAt;
    return t;
  };

  it('labels the comment "Revision request" and links to it instead of repeating the text', async () => {
    signIn('executive', 'owner-1');
    mock(withRequest(), tl());
    openAs('/work/w1/review');
    const link = await screen.findByTestId('see-revision-request');
    expect(link).toHaveTextContent('See revision request');
    expect(link).toHaveAttribute('href', '#comment-c4');
    // The decision line stays; its text is not repeated.
    expect(screen.getByTestId('owner-decision')).toHaveTextContent('Changes requested by Check Lead (version 1)');
    expect(screen.getByTestId('owner-decision')).not.toHaveTextContent('Shorten the intro and fix the colour.');
    // Only that comment is labelled.
    const labelled = screen.getAllByTestId('revision-request-label');
    expect(labelled).toHaveLength(1);
    const thread = labelled[0].closest('[data-testid="review-thread"]')!;
    expect(thread).toHaveAttribute('id', 'comment-c4');
    expect(within(thread as HTMLElement).getByText('Shorten the intro and fix the colour.')).toBeInTheDocument();
    // The link selects that comment.
    fireEvent.click(link);
    await waitFor(() => expect(within(thread as HTMLElement).getAllByRole('button')[0]).toHaveAttribute('aria-pressed', 'true'));
  });

  it('a plain comment with the same text but written at another time is not taken for it', async () => {
    signIn('executive', 'owner-1');
    const sub = withRequest();
    sub.comments[sub.comments.length - 1] = { ...sub.comments[sub.comments.length - 1], createdAt: ago(2) };
    mock(sub, tl());
    openAs('/work/w1/review');
    await screen.findByTestId('owner-decision');
    expect(screen.queryByTestId('revision-request-label')).not.toBeInTheDocument();
    expect(screen.queryByTestId('see-revision-request')).not.toBeInTheDocument();
    expect(screen.getByTestId('owner-decision')).toHaveTextContent('Shorten the intro and fix the colour.');
  });

  it('uses the kind field first: a tagged comment is labelled and linked even when its text differs', async () => {
    signIn('executive', 'owner-1');
    const sub = withRequest();
    // Newer comment: tagged, written a minute after the decision, text not identical to the event.
    sub.comments[sub.comments.length - 1] = {
      ...sub.comments[sub.comments.length - 1],
      _id: 'c5',
      text: 'Shorten the intro and fix the colour. (see notes)',
      kind: 'revision_request',
      createdAt: new Date(new Date(sentBackAt).getTime() + 60 * 1000).toISOString(),
    } as any;
    mock(sub, tl());
    openAs('/work/w1/review');
    const link = await screen.findByTestId('see-revision-request');
    expect(link).toHaveAttribute('href', '#comment-c5');
    const labelled = screen.getAllByTestId('revision-request-label');
    expect(labelled).toHaveLength(1);
    expect(labelled[0].closest('[data-testid="review-thread"]')).toHaveAttribute('id', 'comment-c5');
  });

  it('a tagged comment is labelled even with no matching decision; an untagged same-text comment is not then used', async () => {
    signIn('executive', 'owner-1');
    const sub = withRequest();
    sub.comments = [
      ...sub.comments,
      { _id: 'c6', text: 'An earlier revision note', authorId: { _id: 'lead-1', name: 'Check Lead', role: 'creative_lead' }, anchor: null, resolved: true, parentId: null, kind: 'revision_request', createdAt: ago(200) } as any,
      // Tagged and near the decision: it wins over the untagged same-text comment (c4).
      { _id: 'c7', text: 'Shorten the intro and fix the colour.', authorId: { _id: 'lead-1', name: 'Check Lead', role: 'creative_lead' }, anchor: null, resolved: false, parentId: null, kind: 'revision_request', createdAt: sentBackAt } as any,
    ];
    mock(sub, tl());
    openAs('/work/w1/review');
    expect(await screen.findByTestId('see-revision-request')).toHaveAttribute('href', '#comment-c7');
    const ids = screen.getAllByTestId('revision-request-label').map((l) => l.closest('[data-testid="review-thread"]')!.getAttribute('id'));
    expect(ids.sort()).toEqual(['comment-c6', 'comment-c7']);
  });

  it('the lead view has no "Revision request" label (owner view only)', async () => {
    signIn('creative_lead', 'lead-1', 'Check Lead');
    mock({ ...withRequest(), status: 'submitted' }, tl());
    openAs('/feedback/review-studio');
    await waitFor(() => expect(threads()).toHaveLength(3));
    expect(screen.queryByTestId('revision-request-label')).not.toBeInTheDocument();
  });
});

describe('Review Studio: the lead sees owner replies', () => {
  it('owner replies show with the owner\'s name, and an open comment with a new owner reply has a "New reply" badge', async () => {
    signIn('creative_lead', 'lead-1', 'Check Lead');
    mock({ ...version('submitted') }, null);
    openAs('/feedback/review-studio');
    await waitFor(() => expect(threads()).toHaveLength(2));
    expect(within(threads()[0]).getByTestId('review-reply')).toHaveTextContent('Esha Editor');
    expect(within(threads()[0]).getByTestId('review-reply')).toHaveTextContent('Owner');
    expect(within(threads()[0]).getByTestId('new-reply-badge')).toBeInTheDocument();
    // Resolved threads never show the badge.
    expect(within(threads()[1]).queryByTestId('new-reply-badge')).not.toBeInTheDocument();
    // Lead controls unchanged: decide, comment, resolve, and reply.
    expect(screen.getByRole('button', { name: /^approve/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /post comment/i })).toBeInTheDocument();
    expect(within(threads()[0]).getByRole('button', { name: /mark as resolved/i })).toBeInTheDocument();
    expect(within(threads()[0]).getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.queryByTestId('owner-review-bar')).not.toBeInTheDocument();
  });

  it('read-only heads view only: comments and replies, no reply box, no resolve, no decisions', async () => {
    signIn('creative_head', 'head-1');
    mock({ ...version('submitted') }, null);
    openAs('/feedback/review-studio');
    await waitFor(() => expect(threads()).toHaveLength(2));
    expect(within(threads()[0]).getByTestId('review-reply')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark as resolved/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^approve/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /post comment/i })).not.toBeInTheDocument();
  });
});
