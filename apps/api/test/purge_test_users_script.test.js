// The leftover-test-user purge script only ever touches the local test database.
import { describe, it, expect } from 'vitest';
import { assertTestDatabase, TEST_DB } from '../scripts/purge-test-users.js';

describe('scripts/purge-test-users.js refuses anything but the local test database', () => {
  it('accepts the local marketing_portal_test only', () => {
    expect(assertTestDatabase('mongodb://127.0.0.1:27017/marketing_portal_test', 'test')).toBe(TEST_DB);
    expect(assertTestDatabase('mongodb://localhost/marketing_portal_test?retryWrites=true', 'development')).toBe(TEST_DB);
  });
  it.each([
    ['the app database', 'mongodb://127.0.0.1:27017/marketing_portal', 'test', /is not marketing_portal_test/],
    ['another test database', 'mongodb://127.0.0.1:27017/marketing_portal_matrix', 'test', /is not marketing_portal_test/],
    ['a hosted cluster', 'mongodb+srv://u:p@cluster0.example.net/marketing_portal_test', 'test', /local mongodb/],
    ['a remote host', 'mongodb://db.example.net:27017/marketing_portal_test', 'test', /not a local host/],
    ['no database', 'mongodb://127.0.0.1:27017/', 'test', /is not marketing_portal_test|must name a database/],
    ['production', 'mongodb://127.0.0.1:27017/marketing_portal_test', 'production', /production/],
  ])('refuses %s', (_name, uri, nodeEnv, message) => {
    expect(() => assertTestDatabase(uri, nodeEnv)).toThrow(message);
  });
});
