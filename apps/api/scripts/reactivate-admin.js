#!/usr/bin/env node
/**
 * Recovery when nobody can sign in as an admin (Phase E). Gives an existing account the admin
 * role and Active status, recorded in the Access & Approvals History.
 *
 *   node apps/api/scripts/reactivate-admin.js --email=you@example.com            # dry run
 *   node apps/api/scripts/reactivate-admin.js --email=you@example.com --confirm  # writes
 *
 * Local databases only (localhost / 127.0.0.1 / ::1), never with NODE_ENV=production. To use it
 * on a hosted database, run the API locally against a restored copy, or ask the database owner.
 * It does not touch passwords: use the normal "Forgot password" flow after.
 */
import { env } from '../src/config/env.js';
import { isLocalMongoUri } from '../src/modules/accessConfig/recovery.js';

const confirm = process.argv.includes('--confirm');
const email = process.argv.find((a) => a.startsWith('--email='))?.slice('--email='.length) || '';
const refuse = (message) => {
  console.error(`Refusing: ${message}`);
  process.exit(2);
};

if (env.NODE_ENV === 'production') refuse('NODE_ENV is production.');
if (!isLocalMongoUri(env.MONGODB_URI)) refuse('MONGODB_URI is not a local database (localhost, 127.0.0.1 or ::1).');
if (!email) refuse('give the account with --email=<address>.');

const mongoose = (await import('mongoose')).default;
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const { connectDB, disconnectDB } = await import('../src/config/db.js');
const { planAdminRecovery, applyAdminRecovery } = await import('../src/modules/accessConfig/recovery.js');

await connectDB();
try {
  const { person, changes, activeAdmins } = await planAdminRecovery(email);
  console.log(`${confirm ? 'WRITE' : 'DRY RUN (add --confirm to write)'}: database "${mongoose.connection.db.databaseName}", ${activeAdmins} active admin(s) now`);
  if (!person) {
    console.log(`  No account with the email ${email}. Nothing changed.`);
    process.exitCode = 1;
  } else if (!Object.keys(changes).length) {
    console.log(`  ${person.name} is already an active admin. Nothing to do.`);
  } else {
    console.log(`  ${person.name}: ${Object.entries(changes).map(([k, v]) => `${k} ${person[k]} -> ${v}`).join(', ')}`);
    if (confirm) {
      await applyAdminRecovery(email);
      console.log('  Done. Recorded in Access & Approvals > History.');
    }
  }
} finally {
  await disconnectDB();
}
