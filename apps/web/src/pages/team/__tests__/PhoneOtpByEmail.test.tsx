// Phone verification by email OTP on the profile's Edit Profile dialog: the code goes to the
// registered email, the dialog says where (masked), and Resend waits for the server's cooldown.

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
  name: 'Mohammed Rafi',
  role: 'executive',
  jobRole: 'Writer',
  status: 'active',
  email: 'mohammed@harisandcoacademy.com',
  phone: '9000000011',
  phoneVerified: true,
  languages: [],
  skills: [],
  workPreferences: [],
  kpis: {},
};

function renderOwnProfile(sendResult: () => Promise<unknown>) {
  (authContext.useAuth as any).mockReturnValue({ user: { _id: 'user-1', role: 'executive', name: 'Mohammed Rafi' } });
  (apiModule.apiFetch as any).mockImplementation((url: string) => {
    if (url.includes('/phone-otp/send')) return sendResult();
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

async function enterNewNumberAndSend() {
  fireEvent.click(await screen.findByRole('button', { name: /Edit Profile/i }));
  // The first +919876543210 field is the mobile number (the second is WhatsApp).
  fireEvent.change(screen.getAllByPlaceholderText('+919876543210')[0], { target: { value: '+919876543210' } });
  expect(screen.getByText(/verify it with a 6-digit code sent to your registered email/i)).toBeInTheDocument();
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
  });
}

describe('Phone verification by email OTP (profile)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('says the code went to the masked registered email and counts down to Resend', async () => {
    renderOwnProfile(() =>
      Promise.resolve({
        success: true,
        channel: 'email',
        sentTo: 'm•••@harisandcoacademy.com',
        message: 'We sent a 6-digit code to m•••@harisandcoacademy.com',
        resendAfterSeconds: 60,
      })
    );
    await enterNewNumberAndSend();

    expect(await screen.findByText('We sent a 6-digit code to m•••@harisandcoacademy.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resend in 60s' })).toBeDisabled();
    expect(screen.getByText('Enter the 6-digit code')).toBeInTheDocument();
    expect(apiModule.apiFetch).toHaveBeenCalledWith('/api/me/phone-otp/send', expect.objectContaining({ method: 'POST' }));
  });

  it('shows the friendly error when the email could not be sent', async () => {
    renderOwnProfile(() => Promise.reject(Object.assign(new Error("We couldn't send the email. Try again."), { code: 'EMAIL_SEND_FAILED', status: 503 })));
    await enterNewNumberAndSend();

    expect(await screen.findByText("We couldn't send the email. Try again.")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send code' })).toBeEnabled();
  });
});
