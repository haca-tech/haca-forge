/**
 * apps/api/scripts/setup-fresh-database-core.js
 *
 * Core logic for preparing an empty database for the app.
 * Reusable without shebang line so it can be imported safely by ESM tests and tools.
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../src');
export const REFUSED_DATABASES = ['marketing_portal_test'];

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = { confirm: false, allowRemote: false, dbName: null };
  for (const arg of argv) {
    if (arg === '--confirm') flags.confirm = true;
    else if (arg === '--allow-remote') flags.allowRemote = true;
    else if (arg.startsWith('--db-name=')) flags.dbName = arg.slice('--db-name='.length);
    else throw new Error(`Unknown option: ${arg}`);
  }
  return flags;
}

/** The hosts of a MongoDB URI (credentials never included). */
export function hostsOf(uri) {
  const m = /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/i.exec(String(uri || ''));
  if (!m) return [];
  return m[1].split(',').map((h) => (h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '')).toLowerCase());
}
export const isLocalUri = (uri) =>
  !/^mongodb\+srv:/i.test(String(uri || '')) && hostsOf(uri).length > 0 && hostsOf(uri).every((h) => ['localhost', '127.0.0.1', '::1'].includes(h));
export const dbNameOf = (uri) => decodeURIComponent((/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/i.exec(String(uri || '')) || [])[1] || '');

/** Throws on anything unsafe. Returns { dbName, host, remote }. */
export function checkTarget({ uri, flags }) {
  if (!/^mongodb(\+srv)?:\/\//i.test(String(uri || ''))) throw new Error('Refusing: MONGODB_URI is not a MongoDB URI.');
  const dbName = dbNameOf(uri);
  if (!dbName) throw new Error('Refusing: MONGODB_URI names no database (add it after the host: ...mongodb.net/<database>?...).');
  if (REFUSED_DATABASES.includes(dbName)) throw new Error(`Refusing: "${dbName}" is the test database.`);
  const remote = !isLocalUri(uri);
  const host = hostsOf(uri).join(',');
  if (remote && !flags.allowRemote) throw new Error(`Refusing: "${host}" is a remote host. Add --allow-remote --db-name=${dbName} if this is the database to set up.`);
  if ((remote || flags.confirm) && flags.dbName !== dbName) {
    throw new Error(`Refusing: --db-name must equal the database in MONGODB_URI ("${dbName}").`);
  }
  return { dbName, host, remote };
}

/** Every model file under src/modules (so every collection and index the app uses is known). */
function modelFiles(dir = path.join(SRC, 'modules')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return modelFiles(p);
    return /(^model|\.model)\.js$/.test(e.name) ? [p] : [];
  });
}

export async function run({ argv = process.argv.slice(2), log = console.log } = {}) {
  const flags = parseArgs(argv);
  // A dry run writes nothing at all: no automatic collection or index creation when models load.
  const mongoose = (await import('mongoose')).default;
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const { env } = await import('../src/config/env.js');
  const uri = env.MONGODB_URI;
  const { dbName, host, remote } = checkTarget({ uri, flags });

  const adminEmail = (env.ADMIN_SEED_EMAIL || '').toLowerCase().trim();
  if (!adminEmail) throw new Error('Refusing: ADMIN_SEED_EMAIL is not set.');

  for (const file of modelFiles()) await import(pathToFileURL(file).href);
  const { Person } = await import('../src/modules/people/model.js');
  const { CalendarPlan } = await import('../src/modules/calendar/plan.model.js');
  const { WorkItem } = await import('../src/modules/workItems/model.js');
  const { Department } = await import('../src/modules/departments/model.js');
  const { AutomationRule } = await import('../src/modules/automation/model.js');
  const { WorkflowConfig } = await import('../src/modules/accessConfig/workflowConfig.model.js');
  const { Channel } = await import('../src/modules/chat/channel.model.js');
  const { ChannelMember } = await import('../src/modules/chat/channelMember.model.js');
  const { DEPARTMENTS } = await import('@mmp/shared');
  const { DEFAULT_AUTOMATION_RULES } = await import('../src/modules/automation/runner.js');
  const { planWorkflowSeed, describeSeedRow } = await import('../src/modules/accessConfig/seed.js');

  log(`${flags.confirm ? 'SET UP' : `DRY RUN (nothing is written; add --confirm --db-name=${dbName}${remote ? ' --allow-remote' : ''})`}`);
  log(`  Host:     ${host}${remote ? ' (remote)' : ' (local)'}`);
  log(`  Database: ${dbName}`);

  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 15000 });
  try {
    const db = mongoose.connection.db;
    if (db.databaseName !== dbName) throw new Error(`Refusing: connected to "${db.databaseName}", expected "${dbName}".`);

    // Empty, or already set up by this script (only the configured admin; no plans or work).
    const users = await Person.find({}).select('email role').limit(5).lean();
    const plans = await CalendarPlan.countDocuments({});
    const steps = await WorkItem.countDocuments({});
    const onlyAdmin = users.length === 1 && users[0].email === adminEmail && users[0].role === 'admin';
    if (plans || steps || (users.length && !onlyAdmin)) {
      throw new Error(`Refusing: "${dbName}" is not empty (${await Person.countDocuments({})} users, ${plans} plans, ${steps} work items). This script only sets up an empty database.`);
    }
    const admin = onlyAdmin ? users[0] : null;
    if (!admin && !env.ADMIN_SEED_PASSWORD) throw new Error('Refusing: ADMIN_SEED_PASSWORD is not set (needed to create the admin).');

    const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));
    const models = Object.values(mongoose.models).sort((a, b) => a.collection.collectionName.localeCompare(b.collection.collectionName));
    const missingCollections = models.map((m) => m.collection.collectionName).filter((n) => !existing.has(n));
    const deptHave = new Set((await Department.find({}).select('code name').lean()).flatMap((d) => [d.code, d.name]));
    const deptToCreate = DEPARTMENTS.filter((d) => !deptHave.has(d.code) && !deptHave.has(d.name));
    const rulesHave = new Set((await AutomationRule.find({}).select('ruleKey').lean()).map((r) => r.ruleKey));
    const rulesToCreate = DEFAULT_AUTOMATION_RULES.filter((r) => !rulesHave.has(r.ruleKey));
    const workflowPlan = await planWorkflowSeed();
    const teamChat = await Channel.findOne({ type: 'team', systemSlug: 'team-chat' }).select('_id').lean();

    log(admin ? `  Admin:    ${admin.email} (already there; not changed)` : `  Admin:    CREATE ${adminEmail}`);
    log(`  Collections: ${missingCollections.length} to create, ${models.length - missingCollections.length} already there; indexes for all ${models.length}`);
    log(`  Departments: ${deptToCreate.length} to create (${deptToCreate.map((d) => d.name).join(', ') || 'none'})`);
    log(`  Automation rules: ${rulesToCreate.length} to create (${rulesToCreate.map((r) => r.ruleKey).join(', ') || 'none'})`);
    log('  Calendar approval settings:');
    for (const p of workflowPlan) log(`    ${describeSeedRow(p)}`);
    log(`  Team Chat: ${teamChat ? 'already there' : 'CREATE'} (the admin is its only member)`);

    if (!flags.confirm) return { mode: 'dry-run', dbName, host, remote };

    log(`\nWriting to ${host} / ${dbName} ...`);
    // 1. Collections and indexes (createIndexes only adds missing ones; nothing is dropped).
    for (const m of models) {
      if (!existing.has(m.collection.collectionName)) await m.createCollection();
      await m.createIndexes();
    }
    // 2. Departments, 3. the admin, 4. reminder rules, 5. calendar approval settings.
    const { seedReferenceData } = await import('../src/modules/referenceData/service.js');
    await seedReferenceData();
    if (!admin) {
      const bcrypt = (await import('bcryptjs')).default;
      const tech = await Department.findOne({ code: 'tech' }).select('_id').lean();
      await Person.create({
        name: 'System Administrator',
        email: adminEmail,
        passwordHash: await bcrypt.hash(env.ADMIN_SEED_PASSWORD, 10),
        role: 'admin',
        departmentId: tech?._id || null,
        weeklyCapacityHours: 40,
        status: 'active',
        mustSetPassword: false,
      });
    }
    const { ensureAutomationRules } = await import('../src/modules/automation/runner.js');
    await ensureAutomationRules();
    const { applyWorkflowSeed } = await import('../src/modules/accessConfig/seed.js');
    await applyWorkflowSeed(workflowPlan);
    // 6. Team Chat: every active user who can chat is a member, which here is the admin only.
    const { ensureTeamChatChannel } = await import('../src/modules/chat/service.js');
    await ensureTeamChatChannel();

    const counts = {};
    for (const name of (await db.listCollections().toArray()).map((c) => c.name).sort()) {
      counts[name] = await db.collection(name).countDocuments({});
    }
    log('Done. Records:');
    for (const [name, n] of Object.entries(counts)) if (n) log(`  ${name.padEnd(24)} ${n}`);
    log(`  (${Object.values(counts).filter((n) => !n).length} other collections created empty)`);
    log(`Members of Team Chat: ${await ChannelMember.countDocuments({})}; calendar settings: ${await WorkflowConfig.countDocuments({})}`);
    return { mode: 'setup', dbName, host, remote, counts };
  } finally {
    await mongoose.disconnect();
  }
}
