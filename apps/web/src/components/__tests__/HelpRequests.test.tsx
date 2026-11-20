import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AskForHelpDialog, HelpRequestsCard, type HelpData, type HelpOption, type HelpRequestView } from '../help/HelpRequests';
import * as apiModule from '../../lib/api';

vi.mock('../../lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../../lib/uiFeedback', async (orig) => ({
  ...(await orig<typeof import('../../lib/uiFeedback')>()),
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;
const posts = () => apiFetch.mock.calls.filter(([, o]: any[]) => o?.method === 'POST');

const OPTIONS: HelpOption[] = [
  { kind: 'lead', personId: 'lead-1', name: 'Lena Lead', label: 'Lena Lead (lead for this step)' },
  { kind: 'sm_manager', personId: 'sm-1', name: 'Sam SM', label: 'Sam SM (SM Manager)' },
  { kind: 'step_owner', personId: 'w-2', name: 'Wes Writer', label: 'Wes Writer (Script step)' },
];

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ data: {} });
});

describe('Ask for help dialog', () => {
  const open = (extra: Partial<React.ComponentProps<typeof AskForHelpDialog>> = {}) => {
    const onSent = vi.fn();
    const onClose = vi.fn();
    render(<AskForHelpDialog stepId="w1" stepTitle="Edit: Spring reel" options={OPTIONS} defaultHelperId="lead-1" onClose={onClose} onSent={onSent} {...extra} />);
    return { onSent, onClose, dialog: screen.getByRole('dialog', { name: 'Ask for help' }) };
  };

  it('defaults to the deciding lead and lists SM Manager and other step owners', () => {
    const { dialog } = open();
    const select = within(dialog).getByLabelText('Who should help') as HTMLSelectElement;
    expect(select.value).toBe('lead-1');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(OPTIONS.map((o) => o.label));
    expect(within(dialog).getAllByRole('radio').map((r) => r.closest('label')!.textContent)).toEqual(['Brief unclear', 'Need files or assets', 'Technical issue', 'Other']);
  });

  it('requires a topic and a message, caps the message at 1,000 characters, and takes https links only', async () => {
    const { dialog } = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText('Choose a topic.')).toBeInTheDocument();
    expect(within(dialog).getByText('Write what you need help with.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('Technical issue'));
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'x'.repeat(1001) } });
    fireEvent.change(within(dialog).getByLabelText('Link (optional)'), { target: { value: 'http://drive.google.com/x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText('Keep it under 1000 characters.')).toBeInTheDocument();
    expect(within(dialog).getByText('The link must start with https://')).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it('sends one request with the chosen person, topic, message and link', async () => {
    const { dialog, onSent } = open();
    fireEvent.change(within(dialog).getByLabelText('Who should help'), { target: { value: 'w-2' } });
    fireEvent.click(within(dialog).getByLabelText('Need files or assets'));
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: '  Where is the final script?  ' } });
    fireEvent.change(within(dialog).getByLabelText('Link (optional)'), { target: { value: 'https://drive.google.com/x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(posts()).toHaveLength(1);
    const [url, opts] = posts()[0];
    expect(url).toBe('/api/work/w1/help-requests');
    expect(JSON.parse(opts.body)).toEqual({ helperId: 'w-2', topic: 'need_files', message: 'Where is the final script?', link: 'https://drive.google.com/x' });
  });

  it('a failed send keeps the dialog open with the error', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Choose who should help from the list.'));
    const { dialog, onSent } = open();
    fireEvent.click(within(dialog).getByLabelText('Other'));
    fireEvent.change(within(dialog).getByLabelText('Message'), { target: { value: 'Help' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));
    expect(await within(dialog).findByText('Choose who should help from the list.')).toBeInTheDocument();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('Cancel and Esc close without sending', () => {
    const { dialog, onClose } = open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(posts()).toHaveLength(0);
  });
});

describe('Help requests card on Work Detail', () => {
  const req = (extra: Partial<HelpRequestView> = {}): HelpRequestView => ({
    _id: 'h1',
    topic: 'brief_unclear',
    topicLabel: 'Brief unclear',
    message: 'Which logo?',
    link: 'https://drive.google.com/x',
    status: 'open',
    asker: { _id: 'w1', name: 'Wanda Worker' },
    helper: { _id: 'lead-1', name: 'Lena Lead', kind: 'lead' },
    createdAt: '2026-11-20T08:00:00Z',
    replies: [{ _id: 'r1', author: { _id: 'lead-1', name: 'Lena Lead' }, text: 'The white one', at: '2026-11-20T09:00:00Z' }],
    resolvedBy: null,
    resolvedAt: null,
    canReply: true,
    canResolve: true,
    ...extra,
  });
  const data = (open: HelpRequestView[], resolved: HelpRequestView[] = []): HelpData => ({ open, resolved, openCount: open.length, canAsk: false, options: [], defaultHelperId: null });

  it('shows topic, message, link, who asked whom, the replies; reply and resolve call the API', async () => {
    const onChanged = vi.fn();
    render(<HelpRequestsCard stepId="w1" data={data([req()])} onChanged={onChanged} />);
    const card = screen.getByTestId('help-card');
    expect(card).toHaveTextContent('1 open');
    expect(card).toHaveTextContent('Brief unclear');
    expect(card).toHaveTextContent('Which logo?');
    expect(card).toHaveTextContent('Wanda Worker asked Lena Lead');
    expect(within(card).getByRole('link', { name: /drive\.google\.com/ })).toHaveAttribute('href', 'https://drive.google.com/x');
    expect(card).toHaveTextContent('The white one');

    fireEvent.change(within(card).getByLabelText('Reply'), { target: { value: 'Thanks!' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Reply' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0][0]).toBe('/api/work/w1/help-requests/h1/replies');
    expect(JSON.parse(posts()[0][1].body)).toEqual({ text: 'Thanks!' });

    fireEvent.click(within(card).getByRole('button', { name: 'Mark resolved' }));
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1][0]).toBe('/api/work/w1/help-requests/h1/resolve');
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it('a viewer who may not write (a read-only head) sees no reply box or resolve button', () => {
    render(<HelpRequestsCard stepId="w1" data={data([req({ canReply: false, canResolve: false })])} onChanged={vi.fn()} />);
    expect(screen.queryByLabelText('Reply')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark resolved' })).not.toBeInTheDocument();
  });

  it('resolved requests sit in History; nothing at all shows when there are none', () => {
    const { unmount } = render(
      <HelpRequestsCard stepId="w1" data={data([], [req({ status: 'resolved', canReply: false, canResolve: false, resolvedBy: { _id: 'lead-1', name: 'Lena Lead' }, resolvedAt: '2026-11-20T10:00:00Z' })])} onChanged={vi.fn()} />
    );
    expect(screen.getByText('No open help requests.')).toBeInTheDocument();
    const history = screen.getByText('History (1 resolved)').closest('details')!;
    expect(history).not.toHaveAttribute('open');
    expect(within(history).getByTestId('help-request-resolved')).toHaveTextContent('Resolved by Lena Lead');
    unmount();
    const { container } = render(<HelpRequestsCard stepId="w1" data={data([])} onChanged={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
