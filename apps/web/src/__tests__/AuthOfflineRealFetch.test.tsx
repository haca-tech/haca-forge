import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../context/AuthContext';
import { ProtectedRoute } from '../components/ProtectedRoute';
import { accessFromUser } from '../lib/accessCore';
import { emitAccessChanged } from '../lib/accessEvents';

/**
 * L4 with the real apiFetch (lib/api is not mocked): only the browser's fetch is stubbed. Offline,
 * fetch rejects with TypeError("Failed to fetch"), exactly as browsers do; the signed-in tab must
 * keep its user and try again on the next refresh. A 401 (session over, refresh refused) still
 * signs the tab out.
 */
const user = { _id: 'u-ola', id: 'u-ola', name: 'Ola Offline', email: 'ola@example.invalid', role: 'executive', status: 'active' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let mode: 'online' | 'offline' | 'expired' = 'online';
const meCalls = () => (globalThis.fetch as any).mock.calls.filter(([u]: any[]) => String(u).endsWith('/auth/me')).length;

beforeEach(() => {
  mode = 'online';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      if (String(url).endsWith('/auth/me')) {
        return mode === 'expired'
          ? json(401, { error: { code: 'TOKEN_EXPIRED', message: 'Session has expired.' } })
          : json(200, { user, role: user.role, permissions: [], access: accessFromUser(user as any) });
      }
      if (String(url).endsWith('/auth/refresh')) return json(401, { error: { code: 'INVALID_TOKEN', message: 'No session.' } });
      return json(200, { data: [] });
    })
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const renderApp = () =>
  render(
    <MemoryRouter initialEntries={['/my-work']}>
      <AuthProvider>
        <Routes>
          <Route path="/my-work" element={<ProtectedRoute><div>Page</div></ProtectedRoute>} />
          <Route path="/login" element={<div>Sign in page</div>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );

describe('L4 with the real apiFetch: offline keeps the user, a 401 signs out', () => {
  it('fetch rejecting with "Failed to fetch" (offline) keeps the signed-in user; back online, the next refresh works', async () => {
    renderApp();
    expect(await screen.findByText('Page')).toBeInTheDocument();
    mode = 'offline';
    await act(async () => emitAccessChanged('access:changed'));
    expect(screen.getByText('Page')).toBeInTheDocument();
    expect(screen.queryByText('Sign in page')).toBeNull();
    mode = 'online';
    const before = meCalls();
    await act(async () => emitAccessChanged('reconnect'));
    await waitFor(() => expect(meCalls()).toBeGreaterThan(before));
    expect(screen.getByText('Page')).toBeInTheDocument();
  });

  it('a 401 the refresh cannot fix signs the tab out', async () => {
    renderApp();
    expect(await screen.findByText('Page')).toBeInTheDocument();
    mode = 'expired';
    await act(async () => emitAccessChanged('access:changed'));
    expect(await screen.findByText('Sign in page')).toBeInTheDocument();
  });
});
