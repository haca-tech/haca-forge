#!/usr/bin/env node
/**
 * Adds named seed users (from seedUsers.js) that are not in the local database yet, without
 * touching anything else (unlike reset-and-seed.js, which empties the database).
 *
 *   node apps/api/scripts/seed-missing-users.js --only=PRODUCTIONHEAD,GROWTHLEAD            # dry run
 *   node apps/api/scripts/seed-missing-users.js --only=PRODUCTIONHEAD,GROWTHLEAD --confirm  # writes
 *
 * For each key: skipped when SEED_PASSWORD_<KEY> is not set (8+ characters) or when a user with
 * that email already exists (never updated). A created user is active, gets the seed name, role,
 * job role and department, and joins the Team Chat channel if it exists. Refuses in production.
 * Prints names, emails and roles only: never passwords.
 */
import bcrypt from 'bcryptjs';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const confirm = process.argv.includes('--confirm');
const keys = (arg('only') || '').split(',').map((k) => k.trim().toUpperCase()).filter(Boolean);

if (env.NODE_ENV === 'production') throw new Error('Refusing: NODE_ENV is production.');
if (!keys.length) throw new Error('Name the users: --only=KEY1,KEY2 (keys from seedUsers.js, e.g. PRODUCTIONHEAD,GROWTHLEAD).');

const { SEED_USERS, seedPasswordVar } = await import('../src/modules/people/seedUsers.js');
const unknown = keys.filter((k) => !SEED_USERS.some((u) => u.key === k));
if (unknown.length) throw new Error(`Unknown seed keys: ${unknown.join(', ')}`);

await connectDB();
try {
  const { Person } = await import('../src/modules/people/model.js');
  const { Department } = await import('../src/modules/departments/model.js');
  const { Channel } = await import('../src/modules/chat/channel.model.js');
  const { ChannelMember } = await import('../src/modules/chat/channelMember.model.js');
  const departments = await Department.find().select('_id code').lean();
  const team = await Channel.findOne({ type: 'team', systemSlug: 'team-chat' }).select('_id').lean();

  console.log(`${confirm ? 'Writing' : 'Dry run (add --confirm to write)'}: ${keys.join(', ')}`);
  for (const u of SEED_USERS.filter((x) => keys.includes(x.key))) {
    const pw = process.env[seedPasswordVar(u)];
    if (!pw || String(pw).length < 8) { console.log(`  ${u.key}: skipped, ${seedPasswordVar(u)} is not set`); continue; }
    if (await Person.exists({ email: u.email })) { console.log(`  ${u.key}: skipped, ${u.email} already exists (not changed)`); continue; }
    if (!confirm) { console.log(`  ${u.key}: would create ${u.name} <${u.email}> as ${u.role}`); continue; }
    const person = await Person.create({
      name: u.name,
      email: u.email,
      phone: u.phone,
      passwordHash: await bcrypt.hash(String(pw), 10),
      role: u.role,
      jobRole: u.jobRole,
      departmentId: u.departmentCode ? departments.find((d) => d.code === u.departmentCode)?._id || null : null,
      workPreferences: u.workPreferences,
      weeklyCapacityHours: u.capacity,
      status: 'active',
      mustSetPassword: false,
    });
    if (team) await ChannelMember.updateOne({ channelId: team._id, userId: person._id }, { $setOnInsert: { channelId: team._id, userId: person._id, role: 'member', joinedAt: new Date() } }, { upsert: true });
    console.log(`  ${u.key}: created ${u.name} <${u.email}> as ${u.role}${team ? ', joined Team Chat' : ''}`);
  }
} finally {
  await disconnectDB();
}
