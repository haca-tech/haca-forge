// Phase B seed migration (scripts/seed-workflow-config.js), run as a real CLI against the test
// database: the dry run writes nothing (not even a collection), non-local databases are refused
// before connecting, --confirm backs up and creates one config per calendar, and a second run
// changes nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import { CALENDAR_KEYS } from '@mmp/shared';
import { connectDB } from '../src/config/db.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';

const SCRIPT = path.resolve(__dirname, '../scripts/seed-workflow-config.js');
const TEST_URI = process.env.MONGODB_URI; // marketing_portal_test (vitest.config.js)
const run = (args = [], env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: TEST_URI, ...env }, encoding: 'utf8', timeout: 60000 });
const hasCollection = async () => (await mongoose.connection.db.listCollections({ name: 'workflowconfigs' }).toArray()).length > 0;

describe('Seed migration: WorkflowConfig per calendar', () => {
  let backupDir;
  beforeAll(async () => {
    expect(TEST_URI).toMatch(/127\.0\.0\.1.*marketing_portal_test$/);
    await connectDB();
    // This test process loads the model too: let its own index build finish, then drop the
    // collection, so only the script could create it again.
    await WorkflowConfig.init();
    if (await hasCollection()) await mongoose.connection.db.collection('workflowconfigs').drop();
    backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfseed-'));
  }, 60000);
  afterAll(async () => {
    await WorkflowConfig.deleteMany({});
    fs.rmSync(backupDir, { recursive: true, force: true });
  });

  it('the dry run lists 5 configs to create and writes nothing, not even the collection', async () => {
    const res = run();
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('DRY RUN');
    expect(res.stdout).toContain('5 to create, 0 kept');
    expect(res.stdout).toMatch(/ads\s+CREATE reviewers=role:growth_lead; planApprovers=role:growth_lead; posters=role:sm_manager; fallback=role:admin/);
    expect(res.stdout).toMatch(/sm\s+CREATE reviewers=role:creative_lead/);
    expect(await hasCollection()).toBe(false);
  });

  it('refuses a database that is not local, before connecting', () => {
    for (const uri of ['mongodb+srv://cluster0.example.mongodb.net/marketing_portal', 'mongodb://10.0.0.5:27017/marketing_portal', 'mongodb://db.example.com:27017/x', 'mongodb://127.0.0.1:27017,10.0.0.6:27017/x']) {
      const res = run(['--confirm'], { MONGODB_URI: uri });
      expect(res.status, uri).toBe(2);
      expect(res.stderr, uri).toContain('not a local database');
      expect(res.stdout).not.toContain('WRITE');
    }
    const prod = run(['--confirm'], { NODE_ENV: 'production' });
    expect(prod.status).toBe(2);
    expect(prod.stderr).toContain('production');
  });

  it('--confirm backs up first and creates one config per calendar from today\'s rules', async () => {
    const res = run(['--confirm', `--backup-dir=${backupDir}`]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('Backup of workflowconfigs');
    expect(fs.readdirSync(backupDir).filter((f) => f.startsWith('workflowconfigs-marketing_portal_test-'))).toHaveLength(1);
    const docs = await WorkflowConfig.find({}).lean();
    expect(docs.map((d) => d.calendar).sort()).toEqual([...CALENDAR_KEYS].sort());
    for (const d of docs) {
      const lead = d.calendar === 'ads' ? 'growth_lead' : 'creative_lead';
      expect(d.reviewers.roles).toEqual([lead]);
      expect(d.planApprovers.roles).toEqual([lead]);
      expect(d.posters.roles).toEqual(['sm_manager']);
      expect(d.fallbackApprovers.roles).toEqual(['admin']);
      expect(d.version).toBe(1);
    }
  });

  it('running it twice changes nothing', async () => {
    const before = await WorkflowConfig.find({}).sort({ calendar: 1 }).lean();
    const res = run(['--confirm', `--backup-dir=${backupDir}`]);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toContain('0 to create, 5 kept');
    expect(res.stdout).toContain('Nothing to do');
    const after = await WorkflowConfig.find({}).sort({ calendar: 1 }).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(fs.readdirSync(backupDir)).toHaveLength(1); // no second backup: nothing was written
  });
});
