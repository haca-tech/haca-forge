// The Creative Manager seed user reads SEED_PASSWORD_CREATIVELEAD first, then the older
// SEED_PASSWORD_CREATIVEHEAD; every other user reads its own key. No database.
import { describe, it, expect } from 'vitest';
import { SEED_USERS, missingSeedPasswords, seedPasswordVar, seedUsersToCreate } from '../src/modules/people/seedUsers.js';

const lead = SEED_USERS.find((u) => u.email === 'creativelead@demo.haca.local');
const writer = SEED_USERS.find((u) => u.key === 'WRITER1');

describe('Seed password variables', () => {
  it('Creative Manager: CREATIVELEAD wins, CREATIVEHEAD is the fallback', () => {
    expect(seedPasswordVar(lead, { SEED_PASSWORD_CREATIVELEAD: 'lead-pass-1', SEED_PASSWORD_CREATIVEHEAD: 'head-pass-1' })).toBe('SEED_PASSWORD_CREATIVELEAD');
    expect(seedPasswordVar(lead, { SEED_PASSWORD_CREATIVEHEAD: 'head-pass-1' })).toBe('SEED_PASSWORD_CREATIVEHEAD');
    expect(seedPasswordVar(lead, {})).toBe('SEED_PASSWORD_CREATIVEHEAD');
    expect(seedPasswordVar(lead, { SEED_PASSWORD_CREATIVELEAD: 'short' })).toBe('SEED_PASSWORD_CREATIVEHEAD'); // under 8 characters: not set
  });

  it('other users read their own key', () => {
    expect(seedPasswordVar(writer, { SEED_PASSWORD_CREATIVELEAD: 'lead-pass-1' })).toBe('SEED_PASSWORD_WRITER1');
  });

  it('the Creative Manager counts as set with either variable', () => {
    const all = Object.fromEntries(SEED_USERS.filter((u) => u.key !== 'CREATIVEHEAD').map((u) => [`SEED_PASSWORD_${u.key}`, 'scratch-pass-1']));
    expect(missingSeedPasswords(all)).toEqual(['SEED_PASSWORD_CREATIVEHEAD']);
    expect(missingSeedPasswords({ ...all, SEED_PASSWORD_CREATIVELEAD: 'scratch-pass-2' })).toEqual([]);
    expect(seedUsersToCreate({ ...all, SEED_PASSWORD_CREATIVELEAD: 'scratch-pass-2' }).some((u) => u.email === lead.email)).toBe(true);
  });
});
