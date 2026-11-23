#!/usr/bin/env node
/**
 * Phase B seed: one WorkflowConfig per calendar from today's rules (Ads → Marketing Growth Manager, other
 * calendars → Creative Manager; posters → SM Manager; fallback → admin). Changes nothing else.
 *
 *   node apps/api/scripts/seed-workflow-config.js                      # dry run (writes nothing)
 *   node apps/api/scripts/seed-workflow-config.js --confirm            # backs up, then writes
 *   node apps/api/scripts/seed-workflow-config.js --confirm --backup-dir=<dir>
 *
 * Local databases only (localhost / 127.0.0.1 / ::1), never with NODE_ENV=production. Before
 * writing, the workflowconfigs collection is saved as JSON to apps/api/backups/ (git-ignored).
 * Existing configs are kept as they are: running it twice changes nothing.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { env } from '../src/config/env.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const confirm = process.argv.includes('--confirm');
const backupDir = process.argv.find((a) => a.startsWith('--backup-dir='))?.slice('--backup-dir='.length) || path.resolve(HERE, '../backups');

/** Host(s) of a MongoDB URI; refuses SRV and anything that is not this machine. */
export function isLocalMongoUri(uri) {
  const m = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)/.exec(String(uri || ''));
  if (!m) return false; // mongodb+srv:// and anything unparsable
  const hosts = m[1].split(',').map((h) => h.replace(/^\[|\](:\d+)?$/g, '').replace(/:\d+$/, '').toLowerCase());
  return hosts.length > 0 && hosts.every((h) => ['localhost', '127.0.0.1', '::1'].includes(h));
}

function refuse(message) {
  console.error(`Refusing: ${message}`);
  process.exit(2);
}

if (env.NODE_ENV === 'production') refuse('NODE_ENV is production.');
if (!isLocalMongoUri(env.MONGODB_URI)) refuse('MONGODB_URI is not a local database (localhost, 127.0.0.1 or ::1).');

// A dry run writes nothing at all: no automatic collection or index creation when models load.
const mongoose = (await import('mongoose')).default;
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const { connectDB, disconnectDB } = await import('../src/config/db.js');
const { WorkflowConfig } = await import('../src/modules/accessConfig/workflowConfig.model.js');
const { planWorkflowSeed, applyWorkflowSeed, describeSeedRow } = await import('../src/modules/accessConfig/seed.js');

await connectDB();
try {
  const dbName = mongoose.connection.db.databaseName;
  const plan = await planWorkflowSeed();
  console.log(`${confirm ? 'WRITE' : 'DRY RUN (add --confirm to write)'}: database "${dbName}"`);
  for (const p of plan) console.log(`  ${describeSeedRow(p)}`);
  const toCreate = plan.filter((p) => p.action === 'create').length;
  console.log(`  ${toCreate} to create, ${plan.length - toCreate} kept. Nothing else is changed.`);

  if (confirm && toCreate > 0) {
    fs.mkdirSync(backupDir, { recursive: true });
    const file = path.join(backupDir, `workflowconfigs-${dbName}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(file, JSON.stringify(await WorkflowConfig.find({}).lean(), null, 2));
    console.log(`  Backup of workflowconfigs: ${file}`);
    // Writing: the unique index on calendar is created first (idempotent).
    await WorkflowConfig.createCollection().catch(() => {});
    await WorkflowConfig.syncIndexes();
    const created = await applyWorkflowSeed(plan);
    console.log(`  Created: ${created.join(', ') || 'none'}`);
  } else if (confirm) {
    console.log('  Nothing to do.');
  }
} finally {
  await disconnectDB();
}
