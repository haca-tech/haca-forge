// scripts/migrate-uploads-to-bunny.js against a mock Bunny server and a disposable local database
// (never marketing_portal, marketing_portal_test or a real Bunny account): the dry run writes
// nothing; --confirm uploads every file and rewrites "/uploads/..." values to keys; a second run
// changes nothing; local files are kept; remote databases need the flags.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import mongoose from 'mongoose';
import { checkTarget, parseArgs } from '../scripts/migrate-uploads-to-bunny-core.js';
import { startMockBunny } from './helpers/mockBunny.js';

const SCRIPT = path.resolve(__dirname, '../scripts/migrate-uploads-to-bunny.js');
const DB = `marketing_portal_migratecheck_${process.pid}`;
const URI = `mongodb://127.0.0.1:27017/${DB}`;
const CID = '0123456789abcdef01234567';
const UUID = '0f8fad5b-d9cb-469f-a165-70867728950e';

describe('migrate-uploads-to-bunny', () => {
  let bunny;
  let conn;
  let db;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-uploads-'));
  const write = (rel, body) => {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  // Async: the mock Bunny server runs in this process and must keep answering while the script runs.
  const run = (args = []) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [SCRIPT, `--uploads-dir=${dir}`, ...args], {
        cwd: path.resolve(__dirname, '..'),
        // Every storage setting is given here, so apps/api/.env can never point this at a real account.
        env: { ...process.env, NODE_ENV: 'development', MONGODB_URI: URI, STORAGE_DRIVER: 'local', BUNNY_STORAGE_ZONE: bunny.zone, BUNNY_STORAGE_HOST: bunny.storageHost, BUNNY_STORAGE_KEY: bunny.accessKey, BUNNY_CDN_URL: bunny.cdnUrl, BUNNY_TOKEN_KEY: bunny.tokenKey },
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('close', (code) => resolve({ code, out }));
    });
  const dump = async () => {
    const out = {};
    for (const name of ['users', 'mediaitems', 'submissions', 'workitems', 'chatmessages']) out[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
    return JSON.parse(JSON.stringify(out));
  };

  beforeAll(async () => {
    bunny = await startMockBunny();
    conn = await mongoose.createConnection(URI).asPromise();
    db = conn.db;
    await db.dropDatabase();
    write('legacy-cut.mp4', 'video-bytes');
    write('avatar-1b4e28ba-2fa1-41d2-883f-0016d3cca427.png', 'png');
    write(`chat/${CID}/${UUID}/notes.pdf`, '%PDF-1.4');
    write('2026/11/already-key.mp4', 'new');
    write('.gitkeep', '');
    await db.collection('users').insertOne({ email: 'm@example.invalid', role: 'executive', avatarUrl: '/uploads/avatar-1b4e28ba-2fa1-41d2-883f-0016d3cca427.png', avatarStorageId: 'avatar-1b4e28ba-2fa1-41d2-883f-0016d3cca427.png' });
    await db.collection('mediaitems').insertOne({ url: '/uploads/legacy-cut.mp4', thumbnailUrl: '' });
    await db.collection('submissions').insertOne({ files: [{ url: '/uploads/legacy-cut.mp4' }, { url: 'https://drive.google.com/file/d/abc' }], fileUrl: '/uploads/legacy-cut.mp4', linkUrl: '' });
    await db.collection('workitems').insertOne({ title: 'w', deliverableUrl: '/uploads/legacy-cut.mp4' });
    await db.collection('chatmessages').insertOne({ content: 'x', attachments: [{ fileName: 'notes.pdf', storageUrl: `/uploads/chat/${CID}/${UUID}/notes.pdf` }] });
  }, 60000);

  afterAll(async () => {
    await db.dropDatabase();
    await conn.close();
    await bunny.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it('refuses a remote database without --allow-remote and a matching --db-name, and the test database', () => {
    const srv = 'mongodb+srv://u:p@cluster0.example.mongodb.net/haca_prod?retryWrites=true';
    expect(() => checkTarget({ uri: srv, flags: parseArgs([]) })).toThrow(/remote database/);
    expect(() => checkTarget({ uri: srv, flags: parseArgs(['--allow-remote']) })).toThrow(/--db-name must equal/);
    expect(checkTarget({ uri: srv, flags: parseArgs(['--allow-remote', '--db-name=haca_prod']) }).remote).toBe(true);
    expect(() => checkTarget({ uri: 'mongodb://127.0.0.1:27017/marketing_portal_test', flags: parseArgs([]) })).toThrow(/test database/);
    expect(() => checkTarget({ uri: URI, flags: parseArgs(['--confirm']) })).toThrow(/--db-name must equal/);
  });

  it('a dry run writes nothing (no upload, no record change)', async () => {
    const before = await dump();
    const res = await run();
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('DRY RUN');
    expect(res.out).toContain('Files to upload: 4 of 4');
    expect(res.out).toContain('Records to update: 5');
    expect(bunny.log.filter((l) => l.method === 'PUT' || l.method === 'DELETE')).toEqual([]);
    expect(bunny.files.size).toBe(0);
    expect(await dump()).toEqual(before);
    expect(res.out).not.toContain(bunny.accessKey);
  }, 120000);

  it('--confirm uploads every file under its key and rewrites stored paths to keys; local files stay', async () => {
    const res = await run(['--confirm', `--db-name=${DB}`]);
    expect(res.code, res.out).toBe(0);
    expect([...bunny.files.keys()].sort()).toEqual([
      'uploads/2026/11/already-key.mp4',
      'uploads/avatar-1b4e28ba-2fa1-41d2-883f-0016d3cca427.png',
      `uploads/chat/${CID}/${UUID}/notes.pdf`,
      'uploads/legacy-cut.mp4',
    ]);
    expect(bunny.files.get('uploads/legacy-cut.mp4').contentType).toBe('video/mp4');
    expect(bunny.files.get(`uploads/chat/${CID}/${UUID}/notes.pdf`).contentType).toBe('application/pdf');
    const after = await dump();
    expect(after.users[0]).toMatchObject({ avatarUrl: 'uploads/avatar-1b4e28ba-2fa1-41d2-883f-0016d3cca427.png', avatarStorageId: 'uploads/avatar-1b4e28ba-2fa1-41d2-883f-0016d3cca427.png' });
    expect(after.mediaitems[0].url).toBe('uploads/legacy-cut.mp4');
    expect(after.submissions[0].files.map((f) => f.url)).toEqual(['uploads/legacy-cut.mp4', 'https://drive.google.com/file/d/abc']);
    expect(after.submissions[0].fileUrl).toBe('uploads/legacy-cut.mp4');
    expect(after.workitems[0].deliverableUrl).toBe('uploads/legacy-cut.mp4');
    expect(after.chatmessages[0].attachments[0].storageUrl).toBe(`uploads/chat/${CID}/${UUID}/notes.pdf`);
    expect(fs.existsSync(path.join(dir, 'legacy-cut.mp4'))).toBe(true); // never deletes local files
  }, 120000);

  it('a second run changes nothing', async () => {
    const before = await dump();
    const puts = bunny.log.filter((l) => l.method === 'PUT').length;
    const res = await run(['--confirm', `--db-name=${DB}`]);
    expect(res.code, res.out).toBe(0);
    expect(res.out).toContain('Files to upload: 0 of 4 (4 already in Bunny');
    expect(res.out).toContain('Records to update: 0');
    expect(bunny.log.filter((l) => l.method === 'PUT').length).toBe(puts);
    expect(await dump()).toEqual(before);
  }, 120000);
});
