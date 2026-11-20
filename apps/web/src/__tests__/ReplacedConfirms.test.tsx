import '@testing-library/jest-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act, within, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { MediaItemType } from '@mmp/shared';
import { ClipCard } from '../pages/work/workspaces/ClipCard';
import { VersionHistoryModal } from '../pages/work/writing-studio/VersionHistoryModal';
import { MediaCardPlayer } from '../pages/chat/MediaCardPlayer';
import { AvatarCropModal } from '../components/AvatarCropModal';
import { SettingsPage } from '../pages/SettingsPage';
import { WorkDetailPage } from '../pages/work/WorkDetailPage';
import { resetUiFeedback } from '../lib/uiFeedback';
import * as authContext from '../context/AuthContext';
import * as apiModule from '../lib/api';

/**
 * Every confirm that replaced a browser confirm: Cancel does nothing, Confirm does the action.
 * (The dialogs mount their own host here, as they would outside the app shell.)
 */
vi.mock('../context/AuthContext', async (orig) => ({ ...(await orig<typeof import('../context/AuthContext')>()), useAuth: vi.fn() }));
vi.mock('../lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../hooks/useSocket', () => ({ useSocket: () => ({ on: () => () => {}, emit: vi.fn() }) }));
const apiFetch = apiModule.apiFetch as unknown as ReturnType<typeof vi.fn>;
const useAuth = authContext.useAuth as unknown as ReturnType<typeof vi.fn>;
const calls = (part: string, method?: string) => apiFetch.mock.calls.filter(([u, o]: any[]) => String(u).includes(part) && (!method || o?.method === method));

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ data: {} });
  useAuth.mockReturnValue({ user: { _id: 'admin-1', id: 'admin-1', role: 'admin', name: 'Admin' }, hasPermission: () => true });
});
afterEach(() => act(() => resetUiFeedback()));

// Scoped to the confirm dialog: the button that opened it may carry the same name.
const cancel = async () => fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
const confirmWith = async (label: string) => fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: label }));
const noDialog = () => waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());

const clip = { _id: 'clip-1', stageItemId: 's1', kind: 'video', url: 'https://x.test/a.mp4', title: 'Hero B-Roll', tags: [], order: 1, version: 1, status: 'uploaded', createdAt: '', updatedAt: '' } as unknown as MediaItemType;

describe('Replaced confirms: Cancel keeps things, Confirm acts', () => {
  it('Delete clip (Shoot workspace)', async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ClipCard clip={clip} canEdit onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete clip Hero B-Roll' }));
    expect(await screen.findByRole('alertdialog', { name: 'Delete clip "Hero B-Roll"?' })).toBeInTheDocument();
    await cancel();
    await noDialog();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete clip Hero B-Roll' }));
    await confirmWith('Delete clip');
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('Restore version (Writing Studio), opened over the Version history modal', async () => {
    const onRestore = vi.fn();
    const onClose = vi.fn();
    render(<VersionHistoryModal isOpen onClose={onClose} versions={[{ _id: 'v2', version: 2, submittedAt: new Date().toISOString(), document: { htmlSnapshot: '<p>x</p>' } }]} onRestoreVersion={onRestore} />);
    fireEvent.click(screen.getByRole('button', { name: /Restore this version/ }));
    await screen.findByRole('alertdialog', { name: 'Restore version 2?' });
    // Esc closes only the confirm, not the Version history modal under it.
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await noDialog();
    expect(onClose).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Restore this version/ }));
    await confirmWith('Restore version');
    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Unshare asset (chat)', async () => {
    const card = { grantId: 'g1', assetId: 'a1', assetType: 'clip', title: 'Founder interview', url: 'https://x.test/a.mp4', sharedBy: { _id: 'admin-1', name: 'Admin' } };
    render(<authContext.AuthContext.Provider value={{ user: { _id: 'admin-1', role: 'admin' } } as any}><MediaCardPlayer card={card as any} /></authContext.AuthContext.Provider>);
    fireEvent.click(screen.getByTestId('unshare-btn'));
    await screen.findByRole('alertdialog', { name: 'Unshare "Founder interview"?' });
    await cancel();
    await noDialog();
    expect(calls('/revoke')).toHaveLength(0);
    fireEvent.click(screen.getByTestId('unshare-btn'));
    await confirmWith('Unshare');
    await waitFor(() => expect(calls('/api/chat/share/g1/revoke', 'POST')).toHaveLength(1));
  });

  it('Remove profile photo', async () => {
    const onAvatarUpdated = vi.fn();
    render(<AvatarCropModal isOpen onClose={vi.fn()} currentAvatarUrl="https://x.test/me.jpg" onAvatarUpdated={onAvatarUpdated} />);
    fireEvent.click(screen.getByRole('button', { name: /Remove current photo/ }));
    await screen.findByRole('alertdialog', { name: 'Remove your profile photo?' });
    await cancel();
    await noDialog();
    expect(calls('/api/me/avatar', 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Remove current photo/ }));
    await confirmWith('Remove photo');
    await waitFor(() => expect(calls('/api/me/avatar', 'DELETE')).toHaveLength(1));
    expect(onAvatarUpdated).toHaveBeenCalledWith(null);
  });

  it('Sign out a device, and sign out all other devices (Settings)', async () => {
    const sessions = [
      { id: 'cur', deviceLabel: 'This laptop', createdAt: '', lastUsedAt: '', isCurrent: true },
      { id: 'old', deviceLabel: 'Old phone', createdAt: '', lastUsedAt: '', isCurrent: false },
    ];
    apiFetch.mockImplementation(async (url: string) => (url === '/api/me/sessions' ? { data: sessions } : url === '/api/me/sessions/old' ? { success: true } : { data: {} }));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: 'Sign Out' }));
    expect(await screen.findByRole('alertdialog', { name: 'Sign out this device?' })).toHaveTextContent('That device will have to sign in again.');
    await cancel();
    await noDialog();
    expect(calls('/api/me/sessions/old', 'DELETE')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Sign Out' }));
    await confirmWith('Sign out device');
    await waitFor(() => expect(calls('/api/me/sessions/old', 'DELETE')).toHaveLength(1));

    // Fresh page: signing out the other device removed it, and with it this button.
    cleanup();
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: /Sign out all other devices/ }));
    await screen.findByRole('alertdialog', { name: 'Sign out all other devices?' });
    await cancel();
    await noDialog();
    expect(calls('/revoke-others')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Sign out all other devices/ }));
    await confirmWith('Sign out others');
    await waitFor(() => expect(calls('/api/me/sessions/revoke-others', 'POST')).toHaveLength(1));
  });

  describe('Work Detail', () => {
    const item = (extra: any) => ({
      _id: 'w1', title: 'Spring reel: Edit', workType: 'Reel', deadline: new Date().toISOString(), status: 'Not Started', revisions: 0, reviewRequired: true,
      stageKey: 'Edit', contentPieceId: 'cp1', ownerId: { _id: 'owner-1', name: 'Owner', role: 'executive' }, ...extra,
    });
    const show = (data: any) => {
      apiFetch.mockImplementation(async (url: string) => (url === '/api/work/w1' ? { data } : { data: [] }));
      render(
        <MemoryRouter initialEntries={['/work/w1']}>
          <Routes><Route path="/work/:id" element={<WorkDetailPage />} /></Routes>
        </MemoryRouter>
      );
    };

    it('Skip step (admin / SM Manager)', async () => {
      show(item({}));
      fireEvent.click(await screen.findByRole('button', { name: 'Skip step' }));
      expect(await screen.findByRole('alertdialog', { name: 'Skip the Edit step?' })).toHaveTextContent('"Spring reel: Edit" will be marked as not needed.');
      await cancel();
      await noDialog();
      expect(calls('/skip')).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Skip step' }));
      await confirmWith('Skip step');
      await waitFor(() => expect(calls('/api/content-pieces/cp1/stages/w1/skip', 'PATCH')).toHaveLength(1));
    });

    it('Reopen step asks for an optional reason (was a browser prompt)', async () => {
      useAuth.mockReturnValue({ user: { _id: 'lead-1', id: 'lead-1', role: 'creative_lead', name: 'Lead' }, hasPermission: () => true });
      show(item({ status: 'Approved', canReopen: true }));
      fireEvent.click(await screen.findByTestId('reopen-step'));
      await screen.findByRole('dialog', { name: 'Reopen "Spring reel: Edit"?' });
      fireEvent.click(within(screen.getByRole('dialog', { name: /Reopen/ })).getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /Reopen/ })).not.toBeInTheDocument());
      expect(calls('/transition', 'POST')).toHaveLength(0);

      fireEvent.click(screen.getByTestId('reopen-step'));
      fireEvent.change(await screen.findByLabelText('Reason (optional)'), { target: { value: 'Wrong logo' } });
      fireEvent.click(within(screen.getByRole('dialog', { name: /Reopen/ })).getByRole('button', { name: 'Reopen step' }));
      await waitFor(() => expect(calls('/transition', 'POST')).toHaveLength(1));
      expect(JSON.parse(calls('/transition', 'POST')[0][1].body)).toMatchObject({ toStatus: 'In Progress', comment: 'Wrong logo' });
    });
  });
});
