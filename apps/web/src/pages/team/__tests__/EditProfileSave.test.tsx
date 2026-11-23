// Edit Profile → Save: a WhatsApp number shown with spaces ("+91 9072190088") is sent without
// them, and a validation error shows the field's own message, not "Invalid input parameters".

import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { WorkerProfilePage } from '../WorkerProfilePage';
import * as authContext from '../../../context/AuthContext';
import * as apiModule from '../../../lib/api';

vi.mock('../../../context/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('../../../lib/api', () => ({ apiFetch: vi.fn() }));

const profile = {
  _id: 'user-1',
  name: 'MUBASHIR',
  role: 'executive',
  jobRole: 'Writer',
  status: 'active',
  email: 'mubashir@harisandcoacademy.com',
  phone: '+91 9072190088',
  whatsappNumber: '+91 9072190088',
  phoneVerified: true,
  languages: [],
  skills: [],
  workPreferences: [],
  kpis: {},
};

function renderOwnProfile(patch: (body: any) => Promise<unknown>) {
  (authContext.useAuth as any).mockReturnValue({ user: { _id: 'user-1', role: 'executive', name: 'MUBASHIR' } });
  (apiModule.apiFetch as any).mockImplementation((url: string, opts?: any) => {
    if (url === '/api/me/profile' && opts?.method === 'PATCH') return patch(JSON.parse(opts.body));
    if (url.includes('/overview')) return Promise.resolve({ success: true, data: { rightNow: [], nextUp: [], loadTrend: [] } });
    return Promise.resolve({ success: true, data: profile });
  });
  render(
    <MemoryRouter initialEntries={['/profile']}>
      <Routes>
        <Route path="/profile" element={<WorkerProfilePage />} />
      </Routes>
    </MemoryRouter>
  );
}

async function openAndSave() {
  fireEvent.click(await screen.findByRole('button', { name: /Edit Profile/i }));
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Save Profile Changes/i }));
  });
}

describe('Edit Profile → Save', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sends the WhatsApp number without spaces, and leaves an unchanged phone out', async () => {
    const sent: any[] = [];
    renderOwnProfile((body) => {
      sent.push(body);
      return Promise.resolve({ success: true, data: profile });
    });
    await openAndSave();
    expect(sent).toHaveLength(1);
    expect(sent[0].whatsappNumber).toBe('+919072190088');
    expect(sent[0]).not.toHaveProperty('phone');
  });

  it('a new mobile number is entered directly: no verification badge, no Send code, saved as typed (cleaned)', async () => {
    const sent: any[] = [];
    renderOwnProfile((body) => {
      sent.push(body);
      return Promise.resolve({ success: true, data: profile });
    });
    fireEvent.click(await screen.findByRole('button', { name: /Edit Profile/i }));
    // The first +919876543210 field is the mobile number (the second is WhatsApp).
    fireEvent.change(screen.getAllByPlaceholderText('+919876543210')[0], { target: { value: '+91 98765 43210' } });
    expect(screen.queryByText('Verification Required')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Send code/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/6-digit code/i)).not.toBeInTheDocument();
    const save = screen.getByRole('button', { name: /Save Profile Changes/i });
    expect(save).toBeEnabled();
    await act(async () => {
      fireEvent.click(save);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].phone).toBe('+919876543210');
    expect(sent[0]).not.toHaveProperty('phoneVerificationToken');
  });

  it('a validation error shows the field message', async () => {
    renderOwnProfile(() =>
      Promise.reject(
        Object.assign(new Error('Invalid input parameters or request body'), {
          code: 'VALIDATION_ERROR',
          status: 400,
          details: [{ field: 'about', message: 'About must not exceed 200 characters' }],
        })
      )
    );
    await openAndSave();
    expect(await screen.findByText('About must not exceed 200 characters')).toBeInTheDocument();
    expect(screen.queryByText('Invalid input parameters or request body')).not.toBeInTheDocument();
  });
});
