import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const apiFetch = vi.fn();
vi.mock('../../../lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('../../../hooks/useSocket', () => ({ useSocket: () => ({ on: () => () => {}, isConnected: true }) }));

import { ActivityFeed, dayLabel } from '../ActivityFeed';

const now = new Date();
const item = (over: Record<string, unknown>) => ({
  _id: String(Math.random()),
  at: now.toISOString(),
  action: 'auth.signed_in',
  category: 'sign_ins',
  verb: 'signed in',
  actor: { _id: 'u1', name: 'Riya', role: 'executive' },
  target: null,
  ...over,
});

describe('Recent activity feed', () => {
  beforeEach(() => apiFetch.mockReset());

  it('shows events as sentences under a day heading, and filters by type', async () => {
    apiFetch.mockResolvedValue({
      data: {
        items: [
          item({ device: 'Safari on iPhone' }),
          item({ action: 'submission.approved', category: 'work', verb: 'approved a submission', target: { label: 'Diwali reel', link: '/work/1' }, fromStatus: 'in review', toStatus: 'approved' }),
        ],
        nextBefore: null,
      },
    });
    render(
      <MemoryRouter>
        <ActivityFeed />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Today')).toBeTruthy();
    expect(screen.getByText(/Safari on iPhone/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Diwali reel' }).getAttribute('href')).toBe('/work/1');
    expect(screen.getByText('approved')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Sign-ins' }));
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith(expect.stringContaining('category=sign_ins')));
  });

  it('limits the feed to one person and loads older pages', async () => {
    apiFetch.mockResolvedValueOnce({ data: { items: [item({})], nextBefore: '2026-01-01T00:00:00.000Z' } });
    apiFetch.mockResolvedValueOnce({ data: { items: [item({ _id: 'old', verb: 'changed their photo' })], nextBefore: null } });
    const onClear = vi.fn();
    render(
      <MemoryRouter>
        <ActivityFeed actor={{ _id: 'u1', name: 'Riya' }} onClearActor={onClear} />
      </MemoryRouter>,
    );
    await screen.findAllByText('Riya');
    expect(apiFetch.mock.calls[0][0]).toContain('actorId=u1');
    fireEvent.click(screen.getByRole('button', { name: 'Show older activity' }));
    expect(await screen.findByText(/changed their photo/)).toBeTruthy();
    expect(apiFetch.mock.calls[1][0]).toContain('before=');
    fireEvent.click(screen.getByRole('button', { name: /Show everyone/ }));
    expect(onClear).toHaveBeenCalled();
  });

  it('labels days', () => {
    const ref = new Date(2026, 10, 28, 12);
    expect(dayLabel(new Date(2026, 10, 28, 1).toISOString(), ref)).toBe('Today');
    expect(dayLabel(new Date(2026, 10, 27, 23).toISOString(), ref)).toBe('Yesterday');
  });
});
