import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toEmbed } from '@mmp/shared';
import { PublishedPage, type PublishedItem } from '../PublishedPage';
import { EMBED_LOAD_TIMEOUT_MS, EmbedFrame } from '../EmbedFrame';
import { StepSubmitDialog } from '../../../components/StepSubmitDialog';
import { Layout } from '../../../components/Layout';

// Published page: cards with embeds or link cards, filters in the URL, the larger view, the
// fallback when an embed does not load, the posting dialog's preview line, and the sidebar item.

const calls: string[] = [];
let response: { items: PublishedItem[]; total: number; page: number; pages: number };
let mockUser: any = { _id: 'u1', role: 'creative_lead', name: 'Lead' };

vi.mock('../../../context/AuthContext', () => ({ useAuth: () => ({ user: mockUser, logout: vi.fn(), hasPermission: () => true }) }));
vi.mock('../../../lib/api', () => ({
  ApiError: class extends Error {},
  apiFetch: vi.fn(async (url: string, opts: any = {}) => {
    calls.push(opts.method && opts.method !== 'GET' ? `${opts.method} ${url} ${opts.body}` : url);
    if (url.startsWith('/api/published')) return { data: response };
    return { data: [] };
  }),
}));

const item = (over: Partial<PublishedItem>): PublishedItem => ({
  id: 'p1',
  title: 'Campus reel',
  type: 'Reel',
  workflow: 'full',
  workflowLabel: 'Reel · Full',
  calendar: 'sm',
  postedAt: '2034-03-16T05:00:00.000Z',
  liveUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/',
  embed: toEmbed('https://www.instagram.com/reel/C8xYz12AbCd/'),
  credits: [
    { step: 'Edit', name: 'Ravi Editor' },
    { step: 'Post', name: 'Sam Manager' },
  ],
  ...over,
});

let observed: { cb: IntersectionObserverCallback; el: Element }[] = [];
class FakeIO {
  cb: IntersectionObserverCallback;
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
  }
  observe(el: Element) {
    observed.push({ cb: this.cb, el });
  }
  disconnect() {}
  unobserve() {}
  takeRecords() {
    return [];
  }
}
const scrollIntoView = () =>
  act(() => {
    for (const o of observed) o.cb([{ isIntersecting: true, target: o.el } as IntersectionObserverEntry], {} as IntersectionObserver);
  });

let location = '';
const LocationProbe = () => {
  location = useLocation().search;
  return null;
};
const show = (url = '/published?month=2034-03') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/published" element={<><PublishedPage /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>
  );

beforeEach(() => {
  calls.length = 0;
  observed = [];
  mockUser = { _id: 'u1', role: 'creative_lead', name: 'Lead' };
  (globalThis as any).IntersectionObserver = FakeIO;
  response = {
    items: [
      item({}),
      item({ id: 'p2', title: 'Offer short', calendar: 'ads', type: 'Reel', workflowLabel: 'Reel · Edit only', liveUrl: 'https://youtube.com/shorts/dQw4w9WgXcQ', embed: toEmbed('https://youtube.com/shorts/dQw4w9WgXcQ') }),
      item({ id: 'p3', title: 'Partner page', type: 'Static Post', workflowLabel: 'Static Post · With content', liveUrl: 'https://example.org/haca/post-1', embed: toEmbed('https://example.org/haca/post-1'), credits: [] }),
    ],
    total: 3,
    page: 1,
    pages: 1,
  };
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).IntersectionObserver;
});

describe('Cards', () => {
  it('shows embeds only once scrolled into view, sandboxed and titled; other links as link cards', async () => {
    show();
    await screen.findByText('Campus reel');
    expect(screen.getByTestId('published-count')).toHaveTextContent('3 posts · March 2034');
    expect(document.querySelectorAll('iframe')).toHaveLength(0); // lazy
    scrollIntoView();
    const frames = Array.from(document.querySelectorAll('iframe'));
    expect(frames.map((f) => f.getAttribute('src'))).toEqual([
      'https://www.instagram.com/reel/C8xYz12AbCd/embed',
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    ]);
    expect(frames[0]).toHaveAttribute('title', 'Instagram reel: Campus reel');
    expect(frames[0].getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    expect(frames[1].getAttribute('sandbox')).toContain('allow-presentation');
    expect(frames[0].parentElement).toHaveStyle({ aspectRatio: '9 / 16' });
    // The unknown site is a link card that opens in a new tab.
    const card = screen.getByTestId('link-card');
    expect(card).toHaveTextContent('example.org');
    expect(within(card).getByRole('link', { name: /Open original/ })).toHaveAttribute('href', 'https://example.org/haca/post-1');
    expect(within(card).getByRole('link', { name: /Open original/ })).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('chips, posted date and credits; nothing counted or sorted by person', async () => {
    show();
    await screen.findByText('Campus reel');
    expect(screen.getAllByText('Reel · Full').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SM Calendar').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Posted 16 Mar/).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('list', { name: 'Credits' })[0]).toHaveTextContent('Edit: Ravi Editor');
    expect(screen.getAllByRole('list', { name: 'Credits' })[0]).toHaveTextContent('Posted by: Sam Manager');
  });

  it('never frames a URL toEmbed did not produce', () => {
    render(<EmbedFrame embed={{ kind: 'youtube', embedUrl: 'https://evil.com/embed/dQw4w9WgXcQ', aspect: '16:9', label: 'YouTube video' }} liveUrl="https://evil.com/x" title="X" eager />);
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByTestId('link-card')).toBeInTheDocument();
  });

  it('a javascript: live link gets no clickable href', () => {
    render(<EmbedFrame embed={{ kind: 'link', label: 'Link' }} liveUrl="javascript:alert(1)" title="X" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByText('No link to open.')).toBeInTheDocument();
  });
});

describe('Fallback when an embed does not load', () => {
  it('shows the link card after the time limit; a loaded embed stays', () => {
    vi.useFakeTimers();
    const embed = toEmbed('https://www.instagram.com/p/C8xYz12AbCd/');
    const { unmount } = render(<EmbedFrame embed={embed} liveUrl="https://www.instagram.com/p/C8xYz12AbCd/" title="Private post" eager />);
    expect(document.querySelector('iframe')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(EMBED_LOAD_TIMEOUT_MS + 10);
    });
    expect(document.querySelector('iframe')).toBeNull();
    expect(screen.getByTestId('link-card')).toHaveTextContent('The post could not be shown here.');
    unmount();

    render(<EmbedFrame embed={embed} liveUrl="https://www.instagram.com/p/C8xYz12AbCd/" title="Public post" eager />);
    fireEvent.load(document.querySelector('iframe')!);
    act(() => {
      vi.advanceTimersByTime(EMBED_LOAD_TIMEOUT_MS + 10);
    });
    expect(document.querySelector('iframe')).not.toBeNull();
  });
});

describe('Larger view', () => {
  it('opens with the embed and "Open original" in a new tab', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Open larger view: Campus reel' }));
    const dlg = await screen.findByRole('dialog', { name: 'Campus reel' });
    expect(within(dlg).getByTitle('Instagram reel: Campus reel')).toHaveAttribute('src', 'https://www.instagram.com/reel/C8xYz12AbCd/embed');
    const open = within(dlg).getByRole('link', { name: /Open original/ });
    expect(open).toHaveAttribute('href', 'https://www.instagram.com/reel/C8xYz12AbCd/');
    expect(open).toHaveAttribute('target', '_blank');
    fireEvent.click(within(dlg).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('the title opens it too', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Offer short' }));
    expect(await screen.findByRole('dialog', { name: 'Offer short' })).toBeInTheDocument();
  });
});

describe('Filters live in the URL', () => {
  it('reads them from the URL into the API query', async () => {
    show('/published?month=2034-03&calendar=ads&type=Reel&workflow=edit_only&q=offer&page=2');
    await screen.findByText('Campus reel');
    expect(calls.find((c) => c.startsWith('/api/published'))).toBe('/api/published?month=2034-03&calendar=ads&type=Reel&workflow=edit_only&q=offer&page=2');
    expect(screen.getByLabelText('Calendar')).toHaveValue('ads');
    expect(screen.getByLabelText('Workflow')).toHaveValue('edit_only');
    expect(screen.getByLabelText('Search')).toHaveValue('offer');
  });

  it('writes changes back to the URL (page resets), and "All" months drops the month', async () => {
    show('/published?month=2034-03&page=2');
    await screen.findByText('Campus reel');
    fireEvent.change(screen.getByLabelText('Calendar'), { target: { value: 'ads' } });
    await waitFor(() => expect(location).toBe('?month=2034-03&calendar=ads'));
    fireEvent.change(screen.getByLabelText('Type'), { target: { value: 'Reel' } });
    await waitFor(() => expect(location).toBe('?month=2034-03&calendar=ads&type=Reel'));
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(location).toBe('?month=all&calendar=ads&type=Reel'));
    await waitFor(() => expect(calls.at(-1)).toBe('/api/published?calendar=ads&type=Reel&page=1'));
  });

  it('search is written after a short pause', async () => {
    show();
    await screen.findByText('Campus reel');
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'campus' } });
    await waitFor(() => expect(location).toContain('q=campus'));
  });

  it('empty state for the month', async () => {
    response = { items: [], total: 0, page: 1, pages: 1 };
    show();
    expect(await screen.findByText('Nothing published yet for this month')).toBeInTheDocument();
    expect(screen.getByTestId('published-count')).toHaveTextContent('0 posts');
  });
});

describe('Posting dialog: homepage refused, preview line', () => {
  const dialog = () =>
    render(<StepSubmitDialog step={{ _id: 'w1', title: 'Post', stageKey: 'Post' }} onClose={vi.fn()} onDone={vi.fn()} />);

  it('says whether the link will embed once it is valid', () => {
    dialog();
    const input = screen.getByLabelText('Live post link');
    fireEvent.change(input, { target: { value: 'https://www.instagram.com/reel/C8xYz12AbCd/' } });
    expect(screen.getByTestId('embed-preview')).toHaveTextContent('Instagram reel detected');
    fireEvent.change(input, { target: { value: 'https://youtube.com/shorts/dQw4w9WgXcQ' } });
    expect(screen.getByTestId('embed-preview')).toHaveTextContent('YouTube Short detected');
    fireEvent.change(input, { target: { value: 'https://example.org/haca/post-1' } });
    expect(screen.getByTestId('embed-preview')).toHaveTextContent('Will show as a link');
    fireEvent.change(input, { target: { value: 'not a link' } });
    expect(screen.queryByTestId('embed-preview')).not.toBeInTheDocument();
  });

  it('refuses a site homepage with the message, and sends nothing', async () => {
    dialog();
    fireEvent.change(screen.getByLabelText('Live post link'), { target: { value: 'https://www.instagram.com/' } });
    expect(screen.queryByTestId('embed-preview')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as posted' }));
    expect(await screen.findByText('Paste the link to the post itself, not the site homepage.')).toBeInTheDocument();
    expect(calls.some((c) => c.startsWith('POST'))).toBe(false);
  });
});

describe('Sidebar item "Published", right after Creative Calendar', () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const role of ['admin', 'creative_head', 'production_head', 'creative_lead', 'growth_lead', 'sm_manager', 'executive']) {
    it(role, () => {
      mockUser = { _id: 'u1', role, name: 'User' };
      render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/published']}>
            <Layout>
              <div>content</div>
            </Layout>
          </MemoryRouter>
        </QueryClientProvider>
      );
      const links = screen.getAllByRole('link', { name: /Published/ });
      expect(links.some((l) => l.getAttribute('href') === '/published')).toBe(true);
      // Order in the link list: Creative Calendar, then Published.
      const hrefs = screen.getAllByRole('link').map((l) => l.getAttribute('href'));
      const cal = hrefs.indexOf('/calendar');
      expect(hrefs[cal + 1]).toBe('/published');
    });
  }
});
