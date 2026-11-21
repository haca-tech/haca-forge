#!/usr/bin/env node
/**
 * Finds approved plan rows that have no generated steps (for example a review that failed between
 * approving the row and creating its steps) and, with --confirm, generates them. Plan pages also
 * repair their own rows when they are opened; this script fixes every plan at once.
 *
 *   node apps/api/scripts/repair-missing-stages.js            # dry run: lists them, writes nothing
 *   node apps/api/scripts/repair-missing-stages.js --confirm  # generates the missing steps
 *
 * Uses MONGODB_URI. The dry run only reads (no index or collection is created).
 */
import { env } from '../src/config/env.js';

const confirm = process.argv.includes('--confirm');
const mongoose = (await import('mongoose')).default;
mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
const { connectDB, disconnectDB } = await import('../src/config/db.js');
const { repairMissingStages } = await import('../src/modules/calendar/plan.service.js');

await connectDB();
try {
  const db = mongoose.connection.db.databaseName;
  const result = await repairMissingStages({ dryRun: !confirm });
  console.log(`${confirm ? 'WRITE' : 'DRY RUN (add --confirm to generate the steps)'}: database "${db}" (${env.NODE_ENV})`);
  console.log(`  Approved rows without steps: ${result.found}`);
  for (const r of result.rows) console.log(`  - ${r.topic} (row ${r.rowId}, plan ${r.planId}, ${r.calendar})`);
  if (confirm) console.log(`  Steps generated for ${result.repaired} row(s).`);
} finally {
  await disconnectDB();
}
process.exit(0);
