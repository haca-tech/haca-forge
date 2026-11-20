#!/usr/bin/env node
/**
 * Writes VITE_QUICK_LOGINS in apps/web/.env.local (git-ignored) for the dev-only Quick sign in
 * and Switch account. Local development only: the web app reads it only in the dev server.
 *
 *   node apps/api/scripts/write-quick-logins.js            # names, roles, job roles from the local database
 *   node apps/api/scripts/write-quick-logins.js --no-db    # from the seed definitions (seedUsers.js)
 *
 * Accounts: the admin (ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD) and the seed users whose
 * SEED_PASSWORD_<KEY> is set in apps/api/.env (Production Head and Growth Lead are optional:
 * only when their passwords exist). With the database, each account's CURRENT name, role and
 * job role are used; missing or suspended accounts, and accounts whose password no longer matches
 * the seed password, are left out. The database is only read.
 *
 * Format: base64 of JSON `{ v: 2, accounts: [{ label, jobRole, email, password, role }] }`.
 * Prints names, roles and job roles only: never passwords (nor the encoded value).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_ENV = path.resolve(HERE, '../.env');
const WEB_ENV_LOCAL = path.resolve(HERE, '../../web/.env.local');
const useDb = !process.argv.includes('--no-db');

dotenv.config({ path: API_ENV });
const { SEED_USERS, seedPasswordVar } = await import('../src/modules/people/seedUsers.js');

const password = (key) => {
  const v = process.env[key];
  return v && String(v).length >= 8 ? String(v) : null;
};

// Candidates: admin first, then every seed user (required and optional) with a password.
const candidates = [];
const adminEmail = (process.env.ADMIN_SEED_EMAIL || '').trim().toLowerCase();
if (adminEmail && password('ADMIN_SEED_PASSWORD')) {
  candidates.push({ key: 'ADMIN', email: adminEmail, name: 'Admin', role: 'admin', jobRole: '', password: password('ADMIN_SEED_PASSWORD') });
} else {
  console.log('Admin: skipped (ADMIN_SEED_EMAIL or ADMIN_SEED_PASSWORD missing)');
}
const missing = [];
for (const u of SEED_USERS) {
  const pw = password(seedPasswordVar(u));
  if (!pw) {
    missing.push(`${seedPasswordVar(u)}${u.optional ? ' (optional)' : ''}`);
    continue;
  }
  candidates.push({ key: u.key, email: u.email.toLowerCase(), name: u.name, role: u.role, jobRole: u.jobRole || '', password: pw });
}

// Current name, role and job role from the local database (read only).
let accounts = candidates;
const notes = [];
if (useDb) {
  const { connectDB, disconnectDB } = await import('../src/config/db.js');
  const { Person } = await import('../src/modules/people/model.js');
  await connectDB();
  try {
    const people = await Person.find({ email: { $in: candidates.map((c) => c.email) } })
      .select('+passwordHash email name preferredName role jobRole status')
      .lean();
    const byEmail = new Map(people.map((p) => [String(p.email).toLowerCase(), p]));
    accounts = [];
    for (const c of candidates) {
      const p = byEmail.get(c.email);
      if (!p) { notes.push(`${c.name} (${c.key}): not in the database, left out`); continue; }
      if (p.status === 'suspended') { notes.push(`${p.name} (${c.key}): suspended, left out`); continue; }
      // The password was changed since seeding: the button would fail, so leave it out.
      if (!(await bcrypt.compare(c.password, p.passwordHash || ''))) { notes.push(`${p.name} (${c.key}): password changed since seeding, left out`); continue; }
      accounts.push({ ...c, name: p.name || c.name, role: p.role || c.role, jobRole: p.jobRole || '' });
    }
    // Other active test accounts (@demo.haca.local) that one of the seed passwords opens, e.g. an
    // account kept from before the Phase 12b role change (checked against its hash, read only).
    const included = new Set(accounts.map((a) => a.email));
    const seedSecrets = [...new Set(Object.keys(process.env).filter((k) => /^SEED_PASSWORD_[A-Z0-9_]+$/.test(k)).map((k) => password(k)).filter(Boolean))];
    const others = await Person.find({ email: /@demo\.haca\.local$/i, status: { $ne: 'suspended' } })
      .select('+passwordHash email name role jobRole status')
      .lean();
    for (const p of others) {
      const email = String(p.email).toLowerCase();
      if (included.has(email)) continue;
      let pw = null;
      for (const s of seedSecrets) if (await bcrypt.compare(s, p.passwordHash || '')) { pw = s; break; }
      if (!pw) continue;
      accounts.push({ key: 'EXTRA', email, name: p.name, role: p.role, jobRole: p.jobRole || '', password: pw });
      notes.push(`${p.name} (${p.role}): extra test account, opened by a seed password`);
    }
  } finally {
    await disconnectDB();
  }
}

const value = Buffer.from(
  JSON.stringify({ v: 2, accounts: accounts.map((a) => ({ label: a.name, jobRole: a.jobRole, email: a.email, password: a.password, role: a.role })) }),
  'utf8'
).toString('base64');

// Replace (or add) only the VITE_QUICK_LOGINS line; other lines stay as they are.
const before = fs.existsSync(WEB_ENV_LOCAL) ? fs.readFileSync(WEB_ENV_LOCAL, 'utf8') : '';
const line = `VITE_QUICK_LOGINS=${value}`;
const after = /^VITE_QUICK_LOGINS=.*$/m.test(before)
  ? before.replace(/^VITE_QUICK_LOGINS=.*$/m, line)
  : `${before}${before && !before.endsWith('\n') ? '\n' : ''}# Local development only. Quick sign in accounts, as base64 JSON. Ignored by git.\n${line}\n`;
fs.writeFileSync(WEB_ENV_LOCAL, after);

console.log(`Wrote VITE_QUICK_LOGINS to apps/web/.env.local: ${accounts.length} accounts (${useDb ? 'current names and roles from the database' : 'seed definitions'})`);
for (const a of accounts) console.log(`  ${a.role.padEnd(16)} ${a.name}${a.jobRole ? ` · ${a.jobRole}` : ''}`);
for (const n of notes) console.log(`  note: ${n}`);
if (missing.length) console.log(`Missing seed passwords (not included): ${missing.join(', ')}`);
console.log('Restart the web dev server to pick it up.');
