#!/usr/bin/env node
/**
 * Removes leftover test users from the TEST database (marketing_portal_test), with their
 * sessions and chat memberships. Every user in that database was created by a test run; a test
 * that crashed or did not clean up leaves them behind, and they then change what later tests see
 * (extra admins, extra SM Managers).
 *
 *   node apps/api/scripts/purge-test-users.js            # dry run: counts only
 *   node apps/api/scripts/purge-test-users.js --confirm  # deletes, and prints how many
 *
 * Refuses anything but marketing_portal_test on a local host (localhost, 127.0.0.1, ::1), never
 * mongodb+srv://, and never with NODE_ENV=production. The database comes from
 * MONGODB_URI_TEST, else mongodb://127.0.0.1:27017/marketing_portal_test (never MONGODB_URI, which
 * is the app's own database).
 */
import mongoose from 'mongoose';

export const TEST_DB = 'marketing_portal_test';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** Throws unless the URI is the local test database. Returns its database name. */
export function assertTestDatabase(uri, nodeEnv = process.env.NODE_ENV) {
  if (nodeEnv === 'production') throw new Error('Refused: NODE_ENV=production.');
  if (!uri || /^mongodb\+srv:\/\//i.test(uri)) throw new Error('Refused: only a local mongodb:// URI is allowed.');
  const m = uri.match(/^mongodb:\/\/(?:[^@/]*@)?([^/?]+)\/([^?]*)/i);
  if (!m) throw new Error('Refused: the URI must name a database.');
  const hosts = m[1].split(',').map((h) => h.replace(/:\d+$/, '').toLowerCase());
  if (!hosts.every((h) => LOCAL_HOSTS.has(h))) throw new Error(`Refused: ${hosts.join(', ')} is not a local host.`);
  const db = decodeURIComponent(m[2]);
  if (db !== TEST_DB) throw new Error(`Refused: database "${db}" is not ${TEST_DB}.`);
  return db;
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const uri = process.env.MONGODB_URI_TEST || `mongodb://127.0.0.1:27017/${TEST_DB}`;
  assertTestDatabase(uri);
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (db.databaseName !== TEST_DB) throw new Error(`Refused: connected to ${db.databaseName}.`);
  const users = db.collection('users');
  const ids = (await users.find({}, { projection: { _id: 1 } }).toArray()).map((u) => u._id);
  const byDomain = await users
    .aggregate([{ $project: { d: { $arrayElemAt: [{ $split: [{ $ifNull: ['$email', '@(none)'] }, '@'] }, 1] } } }, { $group: { _id: '$d', n: { $sum: 1 } } }, { $sort: { n: -1 } }])
    .toArray();
  console.log(`${TEST_DB}: ${ids.length} leftover test user(s)`);
  for (const r of byDomain) console.log(`  ${String(r.n).padStart(5)}  @${r._id}`);
  if (!confirm) {
    console.log('Dry run: nothing deleted. Add --confirm to delete them.');
  } else if (ids.length) {
    // Raw collection writes: test clean-up, like the tests' own deleteMany.
    const sessions = await db.collection('sessions').deleteMany({ userId: { $in: ids } });
    const members = await db.collection('channelmembers').deleteMany({ userId: { $in: ids } });
    const removed = await users.deleteMany({ _id: { $in: ids } });
    console.log(`Removed ${removed.deletedCount} test user(s), ${sessions.deletedCount} session(s), ${members.deletedCount} chat membership(s).`);
  } else {
    console.log('Removed 0 test users: nothing to do.');
  }
  await mongoose.disconnect();
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/').replace(/^\/+/, '')}`).href) {
  main().catch(async (err) => {
    console.error(err.message);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });
}
