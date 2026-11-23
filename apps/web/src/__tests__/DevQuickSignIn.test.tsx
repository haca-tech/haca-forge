import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { QuickLoginAccount } from '../components/DevQuickLogin';
import * as authContext from '../context/AuthContext';

/** One-click sign in on the login page, and Switch account in the profile menu (dev server). */
const ACCOUNTS: QuickLoginAccount[] = vi.hoisted(() => [
  { label: 'Test Admin', email: 'admin@demo.haca.local', password: 'pw-admin-1', role: 'admin', jobRole: '' },
  { label: 'Test Creative Manager', email: 'creativelead@demo.haca.local', password: 'pw-lead-1', role: 'creative_lead', jobRole: 'Creative Manager (TL)' },
  { label: 'Test Writer One', email: 'writer1@demo.haca.local', password: 'pw-writer-1', role: 'executive', jobRole: 'Writer' },
]);
vi.mock('../components/DevQuickLogin', async (orig) => ({
  ...(await orig<typeof import('../components/DevQuickLogin')>()),
  devQuickLogins: () => ACCOUNTS,
}));
vi.mock('../context/AuthContext', async (orig) => ({ ...(await orig<typeof import('../context/AuthContext')>()), useAuth: vi.fn() }));
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (orig) => ({ ...(await orig<typeof import('react-router-dom')>()), useNavigate: () => mockNavigate }));
vi.mock('../lib/api', async (orig) => ({ ...(await orig<typeof import('../lib/api')>()), apiFetch: vi.fn().mockResolvedValue({}) }));

import { LoginPage } from '../pages/LoginPage';
import { UserMenuDropdown } from '../components/UserMenuDropdown';

const useAuth = authContext.useAuth as unknown as ReturnType<typeof vi.fn>;
const login = vi.fn();
const logout = vi.fn();
const roleOf = (email: string) => ACCOUNTS.find((a) => a.email === email)!.role;

beforeEach(() => {
  vi.clearAllMocks();
  login.mockImplementation(async ({ email }: { email: string }) => ({ _id: email, email, role: roleOf(email) }));
  logout.mockResolvedValue(undefined);
});

describe('Login page: Quick sign in (dev only)', () => {
  beforeEach(() => useAuth.mockReturnValue({ user: null, login, logout, isAuthenticated: false, isLoading: false }));

  it('shows the section under the form, grouped by the 8 roles', () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    const section = screen.getByRole('region', { name: 'Quick sign in (dev only)' });
    expect(within(section).getAllByTestId('quick-login-group')).toHaveLength(8);
    expect(within(section).getByRole('button', { name: 'Test Writer One · Writer' })).toBeInTheDocument();
  });

  it('one click signs in as that account and opens its home page', async () => {
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'Test Writer One · Writer' }));
    await waitFor(() => expect(login).toHaveBeenCalledWith({ email: 'writer1@demo.haca.local', password: 'pw-writer-1' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/my-work'));

    fireEvent.click(screen.getByRole('button', { name: 'Test Creative Manager · Creative Manager (TL)' }));
    await waitFor(() => expect(login).toHaveBeenLastCalledWith({ email: 'creativelead@demo.haca.local', password: 'pw-lead-1' }));
    await waitFor(() => expect(mockNavigate).toHaveBeenLastCalledWith('/dashboard'));
  });
});

describe('Profile menu: Switch account (dev)', () => {
  const realLocation = window.location;
  const assign = vi.fn();
  beforeEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: { ...realLocation, assign } });
    useAuth.mockReturnValue({ user: { _id: 'admin', email: 'admin@demo.haca.local', name: 'Test Admin', role: 'admin' }, login, logout, isAuthenticated: true });
  });
  afterEach(() => Object.defineProperty(window, 'location', { configurable: true, value: realLocation }));

  it('opens the grouped list (current account marked) and switches: sign out, sign in, reload home', async () => {
    render(<MemoryRouter><UserMenuDropdown /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'User navigation menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch account (dev)' }));
    const dialog = screen.getByRole('dialog', { name: /Switch account/ });
    expect(within(dialog).getAllByTestId('quick-login-group')).toHaveLength(8);
    expect(within(dialog).getByRole('button', { name: 'Test Admin' })).toBeDisabled(); // signed in now

    fireEvent.click(within(dialog).getByRole('button', { name: 'Test Writer One · Writer' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/my-work'));
    expect(logout).toHaveBeenCalledTimes(1);
    expect(login).toHaveBeenCalledWith({ email: 'writer1@demo.haca.local', password: 'pw-writer-1' });
    expect(logout.mock.invocationCallOrder[0]).toBeLessThan(login.mock.invocationCallOrder[0]);
  });

  it('a failed sign-in keeps the dialog open with the error', async () => {
    login.mockRejectedValueOnce(new Error('Invalid email or password'));
    render(<MemoryRouter><UserMenuDropdown /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: 'User navigation menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Switch account (dev)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Test Creative Manager · Creative Manager (TL)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not sign in as Test Creative Manager: Invalid email or password');
    expect(assign).not.toHaveBeenCalled();
  });
});
