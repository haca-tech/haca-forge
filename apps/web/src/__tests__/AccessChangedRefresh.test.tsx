import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '../context/AuthContext';
import { Layout } from '../components/Layout';
import { accessFromUser } from '../lib/accessCore';
import { emitAccessChanged, wireAccessEvents } from '../lib/accessEvents';
import * as apiModule from '../lib/api';

/**
 * Phase C4: an admin changes someone's role while that person is signed in. The server sends
 * `access:changed` to their sockets; the app reloads /auth/me and the menu follows, with no
 * sign-out. (Sockets are not opened in tests: the socket wiring is checked on its own.)
 */
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), apiFetch: vi.fn() }));
const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;

let role = 'executive';
const me = () => {
  const user = { _id: 'u-taylor', id: 'u-taylor', name: 'Taylor Lee', email: 'taylor@example.invalid', role, status: 'active' };
  return { user, role, permissions: [], access: accessFromUser(user) };
};

beforeEach(() => {
  vi.clearAllMocks();
  role = 'executive';
  apiFetch.mockImplementation(async (url: string) => {
    if (url === '/auth/me') return me();
    if (String(url).includes('/api/chat/channels')) return { channels: [] };
    return { data: [] };
  });
});

const renderApp = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/my-work']}>
        <AuthProvider>
          <Layout>
            <div>Page</div>
          </Layout>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );

describe('Access changes apply without signing out', () => {
  it('a role change updates the signed-in user\'s menu on access:changed', async () => {
    renderApp();
    await screen.findByText('Page');
    // An executive: My Work, no Team Workload / Reports in the menu.
    await waitFor(() => expect(screen.getAllByRole('link', { name: /my work/i }).length).toBeGreaterThan(0));
    expect(screen.queryAllByRole('link', { name: /team workload/i })).toHaveLength(0);
    expect(screen.queryAllByRole('link', { name: /reports/i })).toHaveLength(0);

    // The admin makes them an SM Manager; the server tells their tabs.
    role = 'sm_manager';
    await act(async () => emitAccessChanged('access:changed'));

    await waitFor(() => expect(screen.getAllByRole('link', { name: /team workload/i }).length).toBeGreaterThan(0));
    expect(screen.getAllByRole('link', { name: /reports/i }).length).toBeGreaterThan(0);
    // Still signed in: /auth/me was reloaded, nobody signed out.
    expect(apiFetch.mock.calls.filter(([u]: any[]) => u === '/auth/me').length).toBeGreaterThanOrEqual(2);
    expect(apiFetch.mock.calls.some(([u]: any[]) => u === '/auth/logout')).toBe(false);
    expect(screen.getByText('Page')).toBeInTheDocument();
  });

  it("a suspended user's open tab signs out on access:changed (Phase E fixed rule)", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/my-work']}>
          <AuthProvider>
            <Routes>
              <Route path="/my-work" element={<ProtectedRoute><div>Page</div></ProtectedRoute>} />
              <Route path="/login" element={<div>Sign in page</div>} />
            </Routes>
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    await screen.findByText('Page');
    // The admin suspends them: the server sends access:changed, then /auth/me answers 403.
    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/auth/me') throw new apiModule.ApiError('Your account has been suspended.', 'ACCOUNT_SUSPENDED', 403);
      return { data: [] };
    });
    await act(async () => emitAccessChanged('access:changed'));
    expect(await screen.findByText('Sign in page')).toBeInTheDocument();
    expect(screen.queryByText('Page')).toBeNull();
  });

  it('the socket wiring forwards access:changed and reconnects (not the first connect)', () => {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const seen: string[] = [];
    const socket = { on: (event: string, fn: (...a: any[]) => void) => { handlers[event] = fn; } };
    wireAccessEvents(socket);
    const off = (() => {
      const listener = (r: string) => seen.push(r);
      // subscribe through the same bus AuthContext uses
      return import('../lib/accessEvents').then((m) => m.onAccessChanged(listener));
    })();
    return off.then((unsubscribe) => {
      handlers.connect(); // first connect: no refresh
      handlers['access:changed']();
      handlers.connect(); // a reconnect: refresh
      unsubscribe();
      expect(seen).toEqual(['access:changed', 'reconnect']);
    });
  });
});
