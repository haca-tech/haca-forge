/**
 * apps/api/scripts/migrate-roles.js (Phase 12b: Roles)
 *
 * Moves the LOCAL database from the 5-role model to the 7-role model. Never for production.
 *
 *   node scripts/migrate-roles.js                                     dry run (default): reports only
 *   node scripts/migrate-roles.js --confirm --db-name=marketing_portal  backs up, then migrates
 *   Options: --backup-root=<dir> (default D:\haca-backups), --mongodump=<path to mongodump.exe>
 *
 * Mapping (one pass from a snapshot, so nothing is mapped twice):
 *   roles      executive -> creative_head, creative_head -> creative_lead, team_member -> executive
 *   job roles  Videographer -> Cinematographer, Designer -> Graphic Designer,
 *              Social Specialist -> All Rounder when they also prefer Script, Content or Shoot,
 *              otherwise no job role ("to be assigned"). Other job roles are kept.
 *   preferences  a worker keeps only the steps their new job role allows (Post is never a
 *              worker's step).
 *   Post steps  open Post steps (not Published) move to the one active SM Manager, with their
 *              plan row's Post owner. Published ones are left as they are. Stops if there is
 *              not exactly one active SM Manager.
 *   access requests  requested and assigned roles map the same way.
 *   sessions   every changed user's sessions are revoked, so they sign in again with their new
 *              role (the API cannot reach running sockets from here, so it must be stopped).
 *
 * Safety: refuses NODE_ENV=production, any non-local host, and test or disposable databases
 * (a dry run is allowed on the test database under NODE_ENV=test, for the tests). --confirm
 * also needs --db-name to match MONGODB_URI, the API to be stopped, and a successful mongodump
 * to <backup-root>\<timestamp>\ before the first write. A database already migrated (a marker,
 * or any user on a new-only role) is refused, so it cannot run twice.
 */
import fs from 'fs';
import http from 'http';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import mongoose from 'mongoose';
import { hostOf, isLocalUri, dbNameOf, isProtectedDbName } from './reset-and-seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATION_ID = 'phase12b-roles';
export const DEFAULT_BACKUP_ROOT = 'D:\\haca-backups';
export const DEFAULT_MONGODUMP = 'C:\\Program Files\\MongoDB\\Tools\\100\\bin\\mongodump.exe';

export const OLD_ROLES = ['admin', 'creative_head', 'executive', 'sm_manager', 'team_member'];
export const NEW_ONLY_ROLES = ['production_head', 'creative_lead', 'growth_lead'];
export const ROLE_MAP = { admin: 'admin', executive: 'creative_head', creative_head: 'creative_lead', sm_manager: 'sm_manager', team_member: 'executive' };
export const JOB_ROLE_MAP = { Videographer: 'Cinematographer', Designer: 'Graphic Designer' };
const WORKER_ELIGIBILITY = {
  Writer: ['Script', 'Content'],
  Cinematographer: ['Shoot'],
  'Graphic Designer': ['Design'],
  'Video Editor': ['Edit'],
  'All Rounder': ['Script', 'Content', 'Shoot', 'Design', 'Edit'],
};

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = { confirm: false, dbName: null, backupRoot: DEFAULT_BACKUP_ROOT, mongodump: DEFAULT_MONGODUMP };
  for (const arg of argv) {
    if (arg === '--confirm') flags.confirm = true;
    else if (arg.startsWith('--db-name=')) flags.dbName = arg.slice('--db-name='.length);
    else if (arg.startsWith('--backup-root=')) flags.backupRoot = arg.slice('--backup-root='.length);
    else if (arg.startsWith('--mongodump=')) flags.mongodump = arg.slice('--mongodump='.length);
  }
  return flags;
}

/** Throws on anything unsafe. Returns the database name. */
export function assertSafe({ uri, flags, nodeEnv }) {
  if (nodeEnv === 'production') throw new Error('Refusing: NODE_ENV is production.');
  if (!isLocalUri(uri)) throw new Error(`Refusing: the database host "${hostOf(uri)}" is not local (localhost, 127.0.0.1 or ::1).`);
  const name = dbNameOf(uri);
  if (!name) throw new Error('Refusing: MONGODB_URI has no database name.');
  if (isProtectedDbName(name) && (flags.confirm || nodeEnv !== 'test')) {
    throw new Error(`Refusing: "${name}" is a test or disposable database.`);
  }
  if (flags.confirm && flags.dbName !== name) {
    throw new Error(`Refusing: --db-name must match the database in MONGODB_URI ("${name}").`);
  }
  return name;
}

/** The job role and preferences a person gets. */
export function mapPerson(person) {
  const fromRole = person.role;
  const toRole = ROLE_MAP[fromRole] || null;
  const fromJob = person.jobRole || '';
  const fromPrefs = Array.isArray(person.workPreferences) ? person.workPreferences : [];
  let toJob = JOB_ROLE_MAP[fromJob] || fromJob;
  let note = '';
  if (fromJob === 'Social Specialist') {
    const creates = fromPrefs.some((p) => ['Script', 'Content', 'Shoot'].includes(p));
    toJob = creates ? 'All Rounder' : '';
    note = creates ? 'Social Specialist with creation steps -> All Rounder' : 'Social Specialist (posting only) -> job role to be assigned';
  }
  let toPrefs = fromPrefs;
  if (toRole === 'executive') {
    const allowed = WORKER_ELIGIBILITY[toJob] || [];
    toPrefs = fromPrefs.filter((p) => allowed.includes(p));
  }
  return { fromRole, toRole, fromJob, toJob, fromPrefs, toPrefs, note };
}

const short = (id) => String(id).slice(-6);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Everything the migration would do. Reads only. */
export async function buildPlan(db) {
  const problems = [];
  const users = await db.collection('users').find({}).project({ name: 1, role: 1, jobRole: 1, workPreferences: 1, status: 1 }).toArray();
  const marker = await db.collection('migrations').findOne({ _id: MIGRATION_ID });
  if (marker) problems.push(`Already migrated on ${new Date(marker.appliedAt).toISOString()}.`);
  const newOnly = users.filter((u) => NEW_ONLY_ROLES.includes(u.role));
  if (newOnly.length) problems.push(`${newOnly.length} user(s) already on a Phase 12b-only role (${[...new Set(newOnly.map((u) => u.role))].join(', ')}): the database looks migrated.`);
  const unknown = users.filter((u) => !OLD_ROLES.includes(u.role) && !NEW_ONLY_ROLES.includes(u.role));
  if (unknown.length) problems.push(`${unknown.length} user(s) with an unknown role: ${[...new Set(unknown.map((u) => u.role))].join(', ')}.`);

  const people = users.map((u) => ({ id: u._id, name: u.name, status: u.status, ...mapPerson(u) }));
  const changes = people.filter((p) => p.toRole && (p.fromRole !== p.toRole || p.fromJob !== p.toJob || !same(p.fromPrefs, p.toPrefs)));

  const smManagers = users.filter((u) => u.role === 'sm_manager' && u.status === 'active');
  let smManager = null;
  if (smManagers.length !== 1) problems.push(`Expected exactly one active SM Manager to own the open Post steps; found ${smManagers.length}.`);
  else smManager = smManagers[0];

  const openPost = await db
    .collection('workitems')
    .find({ stageKey: 'Post', status: { $ne: 'Published' } })
    .project({ title: 1, status: 1, ownerId: 1, contentPieceId: 1 })
    .toArray();
  const postedCount = await db.collection('workitems').countDocuments({ stageKey: 'Post', status: 'Published' });
  const postMoves = openPost.filter((w) => !smManager || String(w.ownerId || '') !== String(smManager._id));

  const roleCount = (list, key) => list.reduce((m, x) => ((m[x[key] || '(none)'] = (m[x[key] || '(none)'] || 0) + 1), m), {});
  const after = people.map((p) => ({ role: p.toRole || p.fromRole, jobRole: p.toJob }));
  const accessRequests = await db.collection('accessrequests').countDocuments({
    $or: [{ requestedRole: { $in: ['team_member', 'executive', 'creative_head'] } }, { assignedRole: { $in: ['team_member', 'executive', 'creative_head'] } }],
  });

  return {
    problems,
    changes,
    smManager: smManager ? { id: smManager._id, name: smManager.name } : null,
    postMoves,
    postedCount,
    accessRequests,
    counts: {
      rolesBefore: roleCount(users, 'role'),
      rolesAfter: roleCount(after, 'role'),
      jobRolesBefore: roleCount(users.map((u) => ({ jobRole: u.jobRole || '' })), 'jobRole'),
      jobRolesAfter: roleCount(after, 'jobRole'),
    },
  };
}

export function formatPlan(plan, { dbName, mode }) {
  const lines = [];
  lines.push(`Phase 12b role migration: ${mode} on "${dbName}"`);
  lines.push('');
  lines.push(`Roles before:     ${JSON.stringify(plan.counts.rolesBefore)}`);
  lines.push(`Roles after:      ${JSON.stringify(plan.counts.rolesAfter)}`);
  lines.push(`Job roles before: ${JSON.stringify(plan.counts.jobRolesBefore)}`);
  lines.push(`Job roles after:  ${JSON.stringify(plan.counts.jobRolesAfter)}`);
  lines.push('');
  lines.push(`Users to change: ${plan.changes.length}`);
  for (const c of plan.changes) {
    const parts = [];
    if (c.fromRole !== c.toRole) parts.push(`role ${c.fromRole} -> ${c.toRole}`);
    if (c.fromJob !== c.toJob) parts.push(`job role ${JSON.stringify(c.fromJob)} -> ${JSON.stringify(c.toJob)}`);
    if (!same(c.fromPrefs, c.toPrefs)) parts.push(`preferences ${JSON.stringify(c.fromPrefs)} -> ${JSON.stringify(c.toPrefs)}`);
    lines.push(`  …${short(c.id)} ${c.name}: ${parts.join('; ')}${c.note ? `  (${c.note})` : ''}`);
  }
  lines.push('');
  lines.push(`Open Post steps to move to the SM Manager${plan.smManager ? ` (…${short(plan.smManager.id)} ${plan.smManager.name})` : ''}: ${plan.postMoves.length}`);
  const byOwner = plan.postMoves.reduce((m, w) => {
    const k = `…${short(w.ownerId || 'none')} / ${w.status}`;
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  for (const [k, n] of Object.entries(byOwner)) lines.push(`  from owner ${k}: ${n}`);
  lines.push(`Posted Post steps left unchanged: ${plan.postedCount}`);
  lines.push(`Access requests to remap: ${plan.accessRequests}`);
  lines.push(`Sessions to revoke: those of the ${plan.changes.filter((c) => c.fromRole !== c.toRole).length} user(s) whose role changes`);
  lines.push('');
  if (plan.problems.length) {
    lines.push('STOP. Problems:');
    for (const p of plan.problems) lines.push(`  - ${p}`);
  } else {
    lines.push('No problems found.');
  }
  return lines.join('\n');
}

/** True when something answers on the API's health route. */
export function apiIsRunning(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

export function backup({ uri, backupRoot, mongodump, now = new Date() }) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const out = path.join(backupRoot, stamp);
  if (!fs.existsSync(mongodump)) throw new Error(`Refusing: mongodump not found at "${mongodump}". Pass --mongodump=<path>.`);
  fs.mkdirSync(out, { recursive: true });
  const result = spawnSync(mongodump, [`--uri=${uri}`, `--out=${out}`], { encoding: 'utf8' });
  const usersDump = path.join(out, dbNameOf(uri), 'users.bson');
  if (result.status !== 0 || !fs.existsSync(usersDump)) {
    throw new Error(`Refusing: the backup failed (exit ${result.status}). ${String(result.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  }
  return out;
}

/** Applies the plan. Each write is guarded by the value it expects, so a changed record is left alone. */
export async function applyPlan(db, plan, { now = new Date() } = {}) {
  const done = { users: 0, postSteps: 0, pieces: 0, accessRequests: 0, sessionsRevoked: 0 };
  for (const c of plan.changes) {
    const res = await db.collection('users').updateOne(
      { _id: c.id, role: c.fromRole },
      { $set: { role: c.toRole, jobRole: c.toJob, workPreferences: c.toPrefs, updatedAt: now } }
    );
    done.users += res.modifiedCount;
    if (c.fromRole !== c.toRole) {
      const s = await db.collection('sessions').updateMany({ userId: c.id, revokedAt: null }, { $set: { revokedAt: now, revokedReason: 'role_changed' } });
      done.sessionsRevoked += s.modifiedCount;
    }
  }
  if (plan.smManager) {
    for (const w of plan.postMoves) {
      const res = await db.collection('workitems').updateOne(
        { _id: w._id, stageKey: 'Post', status: { $ne: 'Published' }, ownerId: w.ownerId ?? null },
        { $set: { ownerId: plan.smManager.id, updatedAt: now } }
      );
      done.postSteps += res.modifiedCount;
      if (res.modifiedCount && w.contentPieceId) {
        const p = await db.collection('contentpieces').updateOne(
          { _id: w.contentPieceId },
          { $set: { postingOwnerId: plan.smManager.id, 'stagePlan.$[post].ownerId': plan.smManager.id, updatedAt: now } },
          { arrayFilters: [{ 'post.stageKey': 'Post' }] }
        );
        done.pieces += p.modifiedCount;
      }
    }
  }
  for (const field of ['requestedRole', 'assignedRole']) {
    for (const [from, to] of [['executive', 'creative_head'], ['creative_head', 'creative_lead'], ['team_member', 'executive']]) {
      // Mark first, then map, so a value is never mapped twice.
      await db.collection('accessrequests').updateMany({ [field]: from, [`${field}Migrated`]: { $ne: MIGRATION_ID } }, { $set: { [`${field}Next`]: to } });
    }
    const pending = await db.collection('accessrequests').find({ [`${field}Next`]: { $exists: true } }).toArray();
    for (const r of pending) {
      await db.collection('accessrequests').updateOne({ _id: r._id }, { $set: { [field]: r[`${field}Next`], [`${field}Migrated`]: MIGRATION_ID }, $unset: { [`${field}Next`]: '' } });
      done.accessRequests += 1;
    }
  }
  await db.collection('migrations').insertOne({ _id: MIGRATION_ID, appliedAt: now, done });
  return done;
}

export async function run({ argv = process.argv.slice(2), log = console.log } = {}) {
  const { env } = await import('../src/config/env.js');
  const flags = parseArgs(argv);
  const uri = env.MONGODB_URI;
  const dbName = assertSafe({ uri, flags, nodeEnv: env.NODE_ENV });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    const db = mongoose.connection.db;
    const plan = await buildPlan(db);
    log(formatPlan(plan, { dbName, mode: flags.confirm ? 'CONFIRMED RUN' : 'DRY RUN (nothing written)' }));
    if (!flags.confirm) return { mode: 'dry-run', plan };
    if (plan.problems.length) throw new Error('Refusing: fix the problems above first.');
    if (await apiIsRunning(env.PORT)) throw new Error(`Refusing: the API is running on port ${env.PORT}. Stop it first, so no session or socket keeps an old role.`);
    const out = backup({ uri, backupRoot: flags.backupRoot, mongodump: flags.mongodump });
    log(`\nBackup written to ${out}`);
    const done = await applyPlan(db, plan);
    log(`Done: ${JSON.stringify(done)}`);
    return { mode: 'confirmed', plan, done, backup: out };
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  run().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
