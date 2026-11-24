// scripts/setup-fresh-database.js: dry run writes nothing; refuses a non-empty database and a
// remote one without the flags; creates exactly the listed records on an empty database; a second
// run changes nothing. Runs the real script as a child process against disposable local databases
// (never marketing_portal or marketing_portal_test).
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import mongoose from 'mongoose';
import { CALENDAR_KEYS, DEPARTMENTS } from '@mmp/shared';
import { checkTarget, parseArgs, isLocalUri, dbNameOf } from '../scripts/setup-fresh-database-core.js';
import { DEFAULT_AUTOMATION_RULES } from '../src/modules/automation/runner.js';

const SCRIPT = path.resolve(__dirname, '../scripts/setup-fresh-database.js');
const DB = `marketing_portal_setupcheck_${process.pid}`;
const DB2 = `marketing_portal_setupcheck_nonempty_${process.pid}`;
const uriOf = (name) => `mongodb://127.0.0.1:27017/${name}`;
const ADMIN = 'setup-admin@example.invalid';

function runScript(name, args = []) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, NODE_ENV: 'development', MONGODB_URI: uriOf(name), ADMIN_SEED_EMAIL: ADMIN, ADMIN_SEED_PASSWORD: 'Setup-check-123' },
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: res.status, out: `${res.stdout}\n${res.stderr}` };
}

const conns = [];
async function open(name) {
  const c = await mongoose.createConnection(uriOf(name)).asPromise();
  conns.push(c);
  return c.db;
}
async function dump(db) {
  const out = {};
  for (const { name } of (await db.listCollections().toArray()).sort((a, b) => a.name.localeCompare(b.name))) {
    out[name] = {
      docs: await db.collection(name).find({}).sort({ _id: 1 }).toArray(),
      indexes: (await db.collection(name).indexes()).map((i) => i.name).sort(),
    };
  }
  return JSON.parse(JSON.stringify(out));
}

afterAll(async () => {
  for (const name of [DB, DB2]) {
    const db = await open(name);
    await db.dropDatabase();
  }
  for (const c of conns) await c.close();
}, 60000);

describe('setup-fresh-database: target checks', () => {
  it('refuses a remote host without --allow-remote and a matching --db-name, even for a dry run', () => {
    const srv = 'mongodb+srv://user:pw@cluster0.example.mongodb.net/haca_prod?retryWrites=true';
    expect(isLocalUri(srv)).toBe(false);
    expect(dbNameOf(srv)).toBe('haca_prod');
    expect(() => checkTarget({ uri: srv, flags: parseArgs([]) })).toThrow(/remote host/);
    expect(() => checkTarget({ uri: srv, flags: parseArgs(['--confirm', '--db-name=haca_prod']) })).toThrow(/remote host/);
    expect(() => checkTarget({ uri: srv, flags: parseArgs(['--allow-remote']) })).toThrow(/--db-name must equal/);
    expect(() => checkTarget({ uri: srv, flags: parseArgs(['--allow-remote', '--db-name=other']) })).toThrow(/--db-name must equal/);
    expect(checkTarget({ uri: srv, flags: parseArgs(['--allow-remote', '--db-name=haca_prod']) })).toEqual({ dbName: 'haca_prod', host: 'cluster0.example.mongodb.net', remote: true });
    // A plain mongodb:// URI to another machine is remote too; credentials never show in the host.
    expect(() => checkTarget({ uri: 'mongodb://u:p@10.0.0.5:27017/x', flags: parseArgs([]) })).toThrow(/"10\.0\.0\.5" is a remote host/);
  });

  it('refuses no database name, the test database, and --confirm without the matching name', () => {
    expect(() => checkTarget({ uri: 'mongodb+srv://c.example.mongodb.net/?retryWrites=true', flags: parseArgs(['--allow-remote']) })).toThrow(/names no database/);
    expect(() => checkTarget({ uri: uriOf('marketing_portal_test'), flags: parseArgs([]) })).toThrow(/test database/);
    expect(() => checkTarget({ uri: uriOf(DB), flags: parseArgs(['--confirm']) })).toThrow(/--db-name must equal/);
    expect(checkTarget({ uri: uriOf(DB), flags: parseArgs([]) }).remote).toBe(false);
    expect(() => parseArgs(['--force'])).toThrow(/Unknown option/);
  });
});

describe('setup-fresh-database: runs', () => {
  it('a dry run writes nothing (the database is not even created)', async () => {
    const res = runScript(DB);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('DRY RUN');
    expect(res.out).toContain(`Database: ${DB}`);
    expect(res.out).toContain('Host:     127.0.0.1 (local)');
    const db = await open(DB);
    expect(await db.listCollections().toArray()).toEqual([]);
  }, 120000);

  it('refuses a database that is not empty, and writes nothing to it', async () => {
    const db = await open(DB2);
    await db.collection('users').insertOne({ email: 'someone@example.invalid', role: 'executive', status: 'active' });
    const before = await dump(db);
    const res = runScript(DB2, ['--confirm', `--db-name=${DB2}`]);
    expect(res.code).toBe(1);
    expect(res.out).toMatch(/is not empty \(1 users, 0 plans, 0 work items\)/);
    expect(await dump(db)).toEqual(before);
    // Plans or work items alone also refuse it.
    await db.collection('users').deleteMany({});
    await db.collection('calendarplans').insertOne({ title: 'x' });
    expect(runScript(DB2, ['--confirm', `--db-name=${DB2}`]).out).toMatch(/0 users, 1 plans/);
  }, 120000);

  it('creates exactly the listed records on an empty database', async () => {
    const res = runScript(DB, ['--confirm', `--db-name=${DB}`]);
    expect(res.code, res.out).toBe(0);
    const db = await open(DB);
    const count = (name) => db.collection(name).countDocuments({});
    expect(await count('users')).toBe(1);
    const admin = await db.collection('users').findOne({});
    expect([admin.email, admin.role, admin.status, Boolean(admin.passwordHash)]).toEqual([ADMIN, 'admin', 'active', true]);
    expect(await count('departments')).toBe(DEPARTMENTS.length);
    expect(await count('automationrules')).toBe(DEFAULT_AUTOMATION_RULES.length);
    expect((await db.collection('workflowconfigs').find({}).toArray()).map((c) => c.calendar).sort()).toEqual([...CALENDAR_KEYS].sort());
    const channels = await db.collection('channels').find({}).toArray();
    expect(channels.map((c) => [c.type, c.systemSlug, c.name])).toEqual([['team', 'team-chat', 'Team Chat']]);
    const members = await db.collection('channelmembers').find({}).toArray();
    expect(members.map((m) => String(m.userId))).toEqual([String(admin._id)]);
    // Every other collection exists, empty, with its indexes.
    const listed = ['users', 'departments', 'automationrules', 'workflowconfigs', 'channels', 'channelmembers'];
    for (const { name } of await db.listCollections().toArray()) {
      if (!listed.includes(name)) expect(await count(name), name).toBe(0);
    }
    const names = (await db.listCollections().toArray()).map((c) => c.name);
    for (const n of ['workitems', 'contentpieces', 'calendarplans', 'submissions', 'notifications', 'sessions']) expect(names).toContain(n);
    expect((await db.collection('users').indexes()).some((i) => i.unique && i.key.email === 1)).toBe(true);
    expect((await db.collection('workflowconfigs').indexes()).some((i) => i.unique && i.key.calendar === 1)).toBe(true);
  }, 120000);

  it('running it a second time changes nothing', async () => {
    const db = await open(DB);
    const before = await dump(db);
    const dry = runScript(DB);
    expect(dry.code, dry.out).toBe(0);
    expect(dry.out).toContain('(already there; not changed)');
    expect(dry.out).toContain('Collections: 0 to create');
    const res = runScript(DB, ['--confirm', `--db-name=${DB}`]);
    expect(res.code, res.out).toBe(0);
    expect(await dump(db)).toEqual(before);
  }, 180000);
});
