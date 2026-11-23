import '@testing-library/jest-dom';
import { describe, it, expect, vi } from 'vitest';
import { ROLE_KEYS, ROLE_LABELS, READ_ONLY_VIEWER_ROLES, getAvailableActions } from '@mmp/shared';
import { handleServerDisconnect } from '../hooks/useSocket';
import { roleClass } from '../lib/statusTone';
import { QUICK_LOGIN_GROUPS } from '../components/DevQuickLogin';
import fs from 'fs';
import path from 'path';

const css = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');

describe('Phase 12b roles in the web app', () => {
  it('after the server closes the socket (e.g. a role change), the user is reloaded, then the socket reconnects', async () => {
    const calls: string[] = [];
    const refreshUser = vi.fn(async () => {
      calls.push('refresh');
    });
    const reconnect = vi.fn(() => calls.push('reconnect'));
    expect(await handleServerDisconnect('io server disconnect', { refreshUser, reconnect })).toBe(true);
    expect(calls).toEqual(['refresh', 'reconnect']);
  });

  it('a network drop is left to Socket.IO: no reload', async () => {
    const refreshUser = vi.fn(async () => {});
    const reconnect = vi.fn();
    expect(await handleServerDisconnect('transport close', { refreshUser, reconnect })).toBe(false);
    expect(refreshUser).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });

  it('still reconnects if reloading the user fails', async () => {
    const reconnect = vi.fn();
    await expect(
      handleServerDisconnect('io server disconnect', { refreshUser: async () => Promise.reject(new Error('offline')), reconnect })
    ).rejects.toThrow('offline');
    expect(reconnect).toHaveBeenCalled();
  });

  it('every role has its own badge tone and label', () => {
    for (const role of ROLE_KEYS) {
      const cls = roleClass(role);
      expect(cls).toBe(`role-${role.replace(/_/g, '-')}`);
      expect(css).toContain(`.${cls}`);
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
    expect(roleClass('team_member')).toBe('role-executive');
  });

  it('quick sign-in lists the 8 roles in order', () => {
    expect(QUICK_LOGIN_GROUPS.map((g) => g.title)).toEqual(['Admin', 'Marketing Head', 'Production Head', 'Creative Manager', 'Marketing Growth Manager', 'SM Manager', 'Executive', 'Viewer']);
  });

  it('the read-only heads get no action on any step, even one waiting for review', () => {
    for (const role of READ_ONLY_VIEWER_ROLES) {
      for (const status of ['Not Started', 'In Progress', 'Pending', 'Feedback', 'Blocked', 'Approved']) {
        const { actions } = getAvailableActions({ _id: 'viewer-1', role }, { ownerId: 'someone', status, stageKey: 'Edit', isLocked: false });
        expect(actions, `${role} ${status}`).toEqual([]);
      }
    }
  });

  it('both leads and admin get approve and request revision on a step waiting for review; never on their own', () => {
    for (const role of ['creative_lead', 'growth_lead', 'admin']) {
      expect(getAvailableActions({ _id: 'r1', role }, { ownerId: 'w1', status: 'Pending', stageKey: 'Edit' }).actions).toEqual(expect.arrayContaining(['approve', 'request_revision']));
      expect(getAvailableActions({ _id: 'r1', role }, { ownerId: 'r1', status: 'Pending', stageKey: 'Edit' }).actions).not.toContain('approve');
    }
  });
});
