import { describe, it, expect } from 'vitest';
import { statusLine, timeAgo, pageLabel, type PresencePerson } from '../LiveStatusPage';

const NOW = Date.parse('2026-11-28T12:00:00Z');
const base: PresencePerson = { _id: '1', name: 'A', role: 'executive', online: false, state: 'offline', tabs: 0 };

describe('Live Status text', () => {
  it('says what the person is doing, or when they were last here', () => {
    expect(statusLine({ ...base, online: true, state: 'active', page: '/calendar' }, NOW)).toBe('Active · Creative Calendar');
    expect(statusLine({ ...base, online: true, state: 'away', lastActiveAt: '2026-11-28T11:50:00Z' }, NOW)).toBe('Away · portal open in the background, last active 10 min ago');
    expect(statusLine({ ...base, lastSeenAt: '2026-11-28T09:00:00Z' }, NOW)).toBe('Last seen 3 h ago');
    expect(statusLine({ ...base, lastLoginAt: '2026-11-27T10:00:00Z' }, NOW)).toBe('Last signed in yesterday');
    expect(statusLine(base, NOW)).toBe('Has not signed in yet');
  });
  it('formats times and pages', () => {
    expect(timeAgo('2026-11-28T11:59:40Z', NOW)).toBe('just now');
    expect(timeAgo('2026-11-25T12:00:00Z', NOW)).toBe('3 days ago');
    expect(pageLabel('/feedback')).toBe('Review Hub');
    expect(pageLabel('/my-work')).toBe('My Work');
  });
});
