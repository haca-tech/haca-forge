import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WORKFLOW_SLOTS } from '@mmp/shared';
import { AccessApprovalsPage } from './AccessApprovalsPage';
import { ProtectedRoute } from '../../components/ProtectedRoute';
import { Layout } from '../../components/Layout';

let mockUser: any = { _id: 'admin-1', id: 'admin-1', name: 'Ada Admin', role: 'admin', status: 'active' };
let granted: string[] = ['settings.access.manage'];
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockUser,
    isAuthenticated: true,
    isLoading: false,
    logout: vi.fn(),
    hasPermission: (p: string) => granted.includes(p),
  }),
}));

const apiFetch = vi.fn();
vi.mock('../../lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  ApiError: class ApiError extends Error {},
}));

const confirmDialog = vi.fn().mockResolvedValue(true);
vi.mock('../../lib/uiFeedback', () => ({
  confirmDialog: (...a: unknown[]) => confirmDialog(...a),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const PEOPLE = [
  { _id: 'admin-1', name: 'Ada Admin', email: 'ada@x.test', jobRole: '', role: 'admin', status: 'active', calendarScope: null, lastActive: null, calendarLimitApplies: false },
  { _id: 'lead-1', name: 'Amjith Lead', email: 'am@x.test', jobRole: 'Creative Manager', role: 'creative_lead', status: 'active', calendarScope: null, lastActive: new Date().toISOString(), calendarLimitApplies: true },
];
const audience = (roles: string[] = [], userIds: string[] = []) => ({ roles, userIds });
const healthy = { ok: true, errors: [], warnings: [], resolved: Object.fromEntries(WORKFLOW_SLOTS.map((s) => [s, [{ _id: 'x', name: 'X' }]])) };
const CALENDARS = {
  calendars: [
    {
      calendar: 'ads',
      name: 'Ads Calendar',
      version: 1,
      updatedAt: null,
      updatedBy: null,
      namedPeople: [],
      health: healthy,
      config: { reviewers: audience(['growth_lead']), planApprovers: audience(['growth_lead']), posters: audience(['sm_manager']), fallbackApprovers: audience(['admin']) },
    },
  ],
  options: Object.fromEntries(
    WORKFLOW_SLOTS.map((s) => [s, { permission: 'x', roles: ['growth_lead', 'creative_lead', 'admin'], people: [{ _id: 'lead-1', name: 'Amjith Lead', role: 'creative_lead', calendarScope: null }] }])
  ),
};

function routeApi(handlers: Record<string, (body?: any) => unknown>) {
  apiFetch.mockImplementation((url: string, opts?: { method?: string; body?: string }) => {
    const method = opts?.method || 'GET';
    const key = Object.keys(handlers).find((k) => {
      const [m, path] = k.split(' ');
      return m === method && url.split('?')[0] === path;
    });
    if (!key) return Promise.resolve({ data: [] });
    return Promise.resolve({ data: handlers[key](opts?.body ? JSON.parse(opts.body) : undefined) });
  });
}

const renderAt = (url: string) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/settings/access" element={<ProtectedRoute requiredPermission="settings.access.manage"><AccessApprovalsPage /></ProtectedRoute>} />
          <Route path="/unauthorized" element={<div>Unauthorized page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );

describe('Access & Approvals page', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    confirmDialog.mockClear();
    mockUser = { _id: 'admin-1', id: 'admin-1', name: 'Ada Admin', role: 'admin', status: 'active' };
    granted = ['settings.access.manage'];
  });

  it('non-admins are sent away and do not see it in the menu', async () => {
    granted = ['calendar.plan'];
    renderAt('/settings/access');
    expect(screen.getByText('Unauthorized page')).toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();

    mockUser = { _id: 'g', name: 'Gia', role: 'growth_lead', status: 'active' };
    apiFetch.mockResolvedValue({ data: [] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Layout><div /></Layout>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.queryByRole('link', { name: /access & approvals/i })).toBeNull();
  });

  it('the admin sees it in the menu', () => {
    apiFetch.mockResolvedValue({ data: [] });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={['/dashboard']}>
          <Layout><div /></Layout>
        </MemoryRouter>
      </QueryClientProvider>
    );
    expect(screen.getAllByRole('link', { name: /access & approvals/i })[0]).toHaveAttribute('href', '/settings/access');
  });

  it('People: filters live in the URL; the panel previews gains and losses and needs a reason', async () => {
    const previews: any[] = [];
    routeApi({
      'GET /access-admin/people': () => PEOPLE,
      'POST /access-admin/people/lead-1/preview': (b) => {
        previews.push(b);
        return { gains: ['Approve plans on Ads Calendar'], losses: ['Approve plans on SM Calendar'], blocked: null };
      },
      'PATCH /access-admin/people/lead-1': () => PEOPLE[1],
    });
    renderAt('/settings/access?role=creative_lead&person=lead-1');
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('role=creative_lead')));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getAllByRole('combobox')[0], { target: { value: 'growth_lead' } });
    expect(await within(dialog).findByText('Amjith will be able to:')).toBeInTheDocument();
    expect(within(dialog).getByText('Approve plans on Ads Calendar')).toBeInTheDocument();
    expect(within(dialog).getByText('Approve plans on SM Calendar')).toBeInTheDocument();
    const save = within(dialog).getByRole('button', { name: 'Save access' });
    expect(save).toBeDisabled();
    fireEvent.change(within(dialog).getByPlaceholderText('Why is this changing?'), { target: { value: 'Covers Ads' } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/access-admin/people/lead-1', expect.objectContaining({ method: 'PATCH', body: expect.stringContaining('"reason":"Covers Ads"') }))
    );
    expect(previews[0]).toMatchObject({ role: 'growth_lead' });
  });

  it('People: the calendar limit appears only for roles where it means something', async () => {
    routeApi({ 'GET /access-admin/people': () => PEOPLE, 'POST /access-admin/people/lead-1/preview': () => ({ gains: [], losses: [], blocked: null }) });
    renderAt('/settings/access?person=lead-1');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Calendar limit')).toBeInTheDocument();
    fireEvent.change(within(dialog).getAllByRole('combobox')[0], { target: { value: 'executive' } });
    expect(within(dialog).queryByText('Calendar limit')).toBeNull();
  });

  it('People: an admin cannot change their own role or status', async () => {
    routeApi({ 'GET /access-admin/people': () => PEOPLE });
    renderAt('/settings/access?person=admin-1');
    const dialog = await screen.findByRole('dialog');
    const [role, status] = within(dialog).getAllByRole('combobox');
    expect(role).toBeDisabled();
    expect(status).toBeDisabled();
    expect(within(dialog).getByText(/can't change your own role/)).toBeInTheDocument();
  });

  it('People: a blocked change (last admin) shows why and cannot be saved', async () => {
    routeApi({
      'GET /access-admin/people': () => PEOPLE,
      'POST /access-admin/people/lead-1/preview': () => ({ gains: [], losses: [], blocked: { code: 'LAST_ADMIN', message: 'This is the last active admin.' } }),
    });
    renderAt('/settings/access?person=lead-1');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getAllByRole('combobox')[0], { target: { value: 'growth_lead' } });
    fireEvent.change(within(dialog).getByPlaceholderText('Why is this changing?'), { target: { value: 'Testing' } });
    expect(await within(dialog).findByText('This is the last active admin.')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Save access' })).toBeDisabled();
  });

  it('Calendars: pickers offer the eligible people; a failing health check blocks the save; the preview names who gets it', async () => {
    let failing = true;
    routeApi({
      'GET /access-admin/calendars': () => CALENDARS,
      'POST /access-admin/calendars/ads/preview': () =>
        failing
          ? { health: { ...healthy, ok: false, errors: [{ slot: 'reviewers', message: 'Ads Calendar has no active reviewer, even with the fallback.' }] }, sentences: [], counts: {} }
          : { health: healthy, sentences: ['Changing Ads Calendar reviewers will re-route 1 waiting review and 1 pause request to Amjith Lead.'], counts: {} },
      'PUT /access-admin/calendars/ads': () => ({ sentences: [], notified: 1, movedPosts: 0 }),
    });
    renderAt('/settings/access?tab=calendars');
    expect(await screen.findByText('Ads Calendar')).toBeInTheDocument();
    expect(screen.getByText('Plans approved by')).toBeInTheDocument();
    expect(screen.getByText('Fallback')).toBeInTheDocument();
    // Remove the Marketing Growth Manager role from reviewers: nobody left → blocked.
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove Marketing Growth Manager (role)' })[1]);
    fireEvent.change(screen.getByPlaceholderText('Why is this changing?'), { target: { value: 'Leave' } });
    expect(await screen.findByText('Ads Calendar has no active reviewer, even with the fallback.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save settings' })).toBeDisabled();
    expect(screen.getByText('Saving is blocked until every check passes.')).toBeInTheDocument();

    // Add the named Creative Manager: healthy, the preview says what moves.
    failing = false;
    const picker = screen.getByRole('combobox', { name: 'Add to Work reviewed by on Ads Calendar' });
    expect(within(picker).getByRole('option', { name: /Amjith Lead/ })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: 'person:lead-1' } });
    expect(await screen.findByText(/re-route 1 waiting review and 1 pause request to Amjith Lead/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() =>
      expect(apiFetch).toHaveBeenCalledWith('/access-admin/calendars/ads', expect.objectContaining({ method: 'PUT', body: expect.stringContaining('"userIds":["lead-1"]') }))
    );
    expect(confirmDialog).toHaveBeenCalled();
  });

  it('History: shows before → after with reasons, and restores a calendar version after the preview', async () => {
    routeApi({
      'GET /access-admin/people': () => PEOPLE,
      'GET /access-admin/history': () => [
        { _id: 'h1', at: new Date().toISOString(), actor: 'Ada Admin', type: 'workflow_config', subject: 'Ads Calendar', entityId: 'ads', field: 'reviewers', before: audience(['growth_lead']), after: audience([], ['lead-1']), reason: 'Leave', version: 1, canRestore: true },
        { _id: 'h2', at: new Date().toISOString(), actor: 'Ada Admin', type: 'person', subject: 'Amjith Lead', entityId: 'lead-1', field: 'calendarScope', before: null, after: ['sm'], reason: 'SM only', version: null, canRestore: false },
      ],
      'POST /access-admin/history/h1/restore': (b) => (b?.preview ? { health: healthy, sentences: ['Changing Ads Calendar reviewers will re-route nothing waiting.'], counts: {} } : { ok: true }),
    });
    renderAt('/settings/access?tab=history&type=workflow_config');
    expect(await screen.findByText('Marketing Growth Manager (role)')).toBeInTheDocument();
    expect(await screen.findByText('Amjith Lead', { selector: 'span.font-medium' })).toBeInTheDocument();
    expect(screen.getByText('SM Calendar', { selector: 'span.font-medium' })).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('type=workflow_config'));
    expect(screen.getAllByRole('button', { name: /Restore this version/ })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Restore this version/ }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/access-admin/history/h1/restore', expect.objectContaining({ body: expect.stringContaining('"reason"') })));
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ confirmLabel: 'Restore this version' }));
  });

  it('Role guide: all eight roles (with the Viewer) with what they can do, by area', () => {
    renderAt('/settings/access?tab=guide');
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(8);
    expect(screen.getByText('Locked: everything')).toBeInTheDocument();
    expect(screen.getAllByText('Roles & access').length).toBeGreaterThan(0);
  });
});
