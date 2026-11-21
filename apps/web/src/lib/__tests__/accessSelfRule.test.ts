import { describe, it, expect } from 'vitest';
import { accessFromUser, makeAccess } from '../accessCore';

// Phase E fix: screens use the shared self-forbidden list (reviews, revision flags, own plans).
describe('can() never offers a decision on your own work', () => {
  const admin = { _id: 'a1', role: 'admin', status: 'active' };
  const access = makeAccess(accessFromUser(admin), admin);
  it.each(['review.decide', 'revision.classify', 'calendar.approve'])('%s on your own item is false, on someone else\'s true', (perm) => {
    expect(access.can(perm, { calendar: 'sm', ownerId: 'a1' })).toBe(false);
    expect(access.can(perm, { calendar: 'sm', ownerId: 'someone' })).toBe(true);
  });
  it('posting your own Post step is not a self-decision', () => {
    expect(access.can('publish.post', { calendar: 'sm', ownerId: 'a1' })).toBe(true);
  });
});
