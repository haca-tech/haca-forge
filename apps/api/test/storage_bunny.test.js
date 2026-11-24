// Bunny storage: the token signer (known vector), the driver against a mock Bunny server (upload,
// delete, listing, errors, streaming), signed URL expiry and range requests, the settings check,
// and the local driver unchanged. No real Bunny call is made.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';
import { bunnyToken, signBunnyUrl, verifyBunnyToken } from '../src/lib/storage/bunnyToken.js';
import { createBunnyDriver } from '../src/lib/storage/bunnyDriver.js';
import { createLocalDriver } from '../src/lib/storage/localDriver.js';
import { missingStorageSettings, BUNNY_SETTINGS } from '../src/config/env.js';
import { storageKeyOf } from '@mmp/shared';
import { startMockBunny } from './helpers/mockBunny.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-test-'));
const writeTmp = (name, bytes) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, bytes);
  return p;
};

describe('Bunny token authentication (Advanced, HMAC-SHA256)', () => {
  // Bunny's documentation gives the formula but no numeric example, so this vector was computed
  // once from the documented formula and is fixed here:
  //   token = "HS256-" + Base64URL(HMAC-SHA256(security_key, signature_path + expires))
  const KEY = '229248f0-f007-4bf9-ba1f-bbf1b4ad9d40';
  const PATH = '/uploads/2026/11/0f8fad5b-d9cb-469f-a165-70867728950e.mp4';
  const EXPIRES = 1798761600;
  const TOKEN = 'HS256-vJy6FGVuuvpai3K83kYgXAh5o0hBYpXhCSvnAtgyRxk';

  it('matches the known vector and the documented formula computed independently', () => {
    expect(bunnyToken(KEY, PATH, EXPIRES)).toBe(TOKEN);
    const independent = crypto.createHmac('sha256', KEY).update(`${PATH}${EXPIRES}`).digest('base64');
    expect(TOKEN).toBe(`HS256-${independent.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`);
    expect(TOKEN).not.toMatch(/[+/=]/);
  });

  it('builds the query-string URL: <cdn><path>?token=...&expires=...', () => {
    expect(signBunnyUrl({ cdnUrl: 'https://haca-files.b-cdn.net/', tokenKey: KEY, key: PATH.slice(1), expires: EXPIRES })).toBe(
      `https://haca-files.b-cdn.net${PATH}?token=${TOKEN}&expires=${EXPIRES}`
    );
  });

  it('is refused after expiry, for another path, or with another key', () => {
    const now = (EXPIRES - 60) * 1000;
    expect(verifyBunnyToken({ tokenKey: KEY, path: PATH, token: TOKEN, expires: EXPIRES, now })).toBe(true);
    expect(verifyBunnyToken({ tokenKey: KEY, path: PATH, token: TOKEN, expires: EXPIRES, now: (EXPIRES + 1) * 1000 })).toBe(false);
    expect(verifyBunnyToken({ tokenKey: KEY, path: '/uploads/other.mp4', token: TOKEN, expires: EXPIRES, now })).toBe(false);
    expect(verifyBunnyToken({ tokenKey: 'another-key', path: PATH, token: TOKEN, expires: EXPIRES, now })).toBe(false);
    expect(verifyBunnyToken({ tokenKey: KEY, path: PATH, token: TOKEN, expires: EXPIRES + 1, now })).toBe(false); // expires changed
  });
});

describe('Bunny driver against a mock Bunny server', () => {
  let bunny;
  let driver;
  beforeAll(async () => {
    bunny = await startMockBunny();
    driver = createBunnyDriver({ storageZone: bunny.zone, storageHost: bunny.storageHost, storageKey: bunny.accessKey, cdnUrl: bunny.cdnUrl, tokenKey: bunny.tokenKey });
  });
  afterAll(async () => {
    await bunny.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('uploads with PUT /<zone>/<key>, the AccessKey, the type and the length, streamed from disk', async () => {
    const big = crypto.randomBytes(3 * 1024 * 1024); // 3 MB: arrives in many chunks
    const file = writeTmp('big.mp4', big);
    await driver.put('uploads/2026/11/big.mp4', file, { contentType: 'video/mp4' });
    const put = bunny.log.find((l) => l.method === 'PUT' && l.key === 'uploads/2026/11/big.mp4');
    expect(put).toMatchObject({ contentType: 'video/mp4', contentLength: String(big.length) });
    const stored = bunny.files.get('uploads/2026/11/big.mp4');
    expect(stored.body.equals(big)).toBe(true);
    expect(stored.chunks).toBeGreaterThan(1); // streamed, not one buffered body
    expect(await driver.stat('uploads/2026/11/big.mp4')).toEqual({ size: big.length });
    expect(await driver.stat('uploads/2026/11/none.mp4')).toBeNull();
    expect(await driver.stat('uploads/1999/01/none.mp4')).toBeNull();
  });

  it('a signed URL opens the file, supports range requests (seeking), and stops working after expiry', async () => {
    const bytes = Buffer.from('0123456789abcdefghij');
    await driver.put('uploads/2026/11/seek.mp4', writeTmp('seek.mp4', bytes), { contentType: 'video/mp4' });
    const url = driver.url('uploads/2026/11/seek.mp4', { ttlSeconds: 600 });
    expect(storageKeyOf(url)).toBe('uploads/2026/11/seek.mp4');
    const full = await fetch(url);
    expect([full.status, full.headers.get('content-type'), await full.text()]).toEqual([200, 'video/mp4', bytes.toString()]);
    const part = await fetch(url, { headers: { Range: 'bytes=10-14' } });
    expect([part.status, part.headers.get('content-range'), await part.text()]).toEqual([206, 'bytes 10-14/20', 'abcde']);
    const expired = driver.url('uploads/2026/11/seek.mp4', { ttlSeconds: -1 });
    expect((await fetch(expired)).status).toBe(403);
    expect((await fetch(url.replace(/token=[^&]+/, 'token=HS256-forged'))).status).toBe(403);
    expect((await fetch(url.split('?')[0])).status).toBe(403);
  });

  it('deletes with DELETE; a file already gone is fine', async () => {
    await driver.put('uploads/2026/11/gone.png', writeTmp('gone.png', 'x'), { contentType: 'image/png' });
    await driver.remove('uploads/2026/11/gone.png');
    expect(bunny.files.has('uploads/2026/11/gone.png')).toBe(false);
    await expect(driver.remove('uploads/2026/11/gone.png')).resolves.toBeUndefined();
  });

  it('errors are clear and never carry the keys', async () => {
    bunny.failNext('PUT', 500);
    const err = await driver.put('uploads/2026/11/fail.pdf', writeTmp('fail.pdf', '%PDF'), { contentType: 'application/pdf' }).catch((e) => e);
    expect([err.statusCode, err.code, err.message]).toEqual([502, 'STORAGE_ERROR', 'File storage refused the upload (HTTP 500).']);
    bunny.failNext('DELETE', 400);
    expect((await driver.remove('uploads/2026/11/big.mp4').catch((e) => e)).code).toBe('STORAGE_ERROR');
    const wrongKey = createBunnyDriver({ storageZone: bunny.zone, storageHost: bunny.storageHost, storageKey: 'wrong', cdnUrl: bunny.cdnUrl, tokenKey: bunny.tokenKey });
    const denied = await wrongKey.put('uploads/2026/11/x.png', writeTmp('x.png', 'x')).catch((e) => e);
    expect(denied.code).toBe('STORAGE_ERROR');
    for (const e of [err, denied]) {
      const text = `${e.message} ${JSON.stringify(e.details)}`;
      expect(text).not.toContain(bunny.accessKey);
      expect(text).not.toContain(bunny.tokenKey);
    }
  });
});

describe('Storage settings', () => {
  it('STORAGE_DRIVER=bunny needs every Bunny setting; local needs none', () => {
    expect(BUNNY_SETTINGS).toEqual(['BUNNY_STORAGE_ZONE', 'BUNNY_STORAGE_HOST', 'BUNNY_STORAGE_KEY', 'BUNNY_CDN_URL', 'BUNNY_TOKEN_KEY']);
    expect(missingStorageSettings({ STORAGE_DRIVER: 'local' })).toEqual([]);
    expect(missingStorageSettings({ STORAGE_DRIVER: 'bunny', BUNNY_STORAGE_ZONE: 'z', BUNNY_STORAGE_KEY: ' ' })).toEqual(['BUNNY_STORAGE_HOST', 'BUNNY_STORAGE_KEY', 'BUNNY_CDN_URL', 'BUNNY_TOKEN_KEY']);
  });

  it('the API refuses to start with a Bunny setting missing, naming it but never printing values', () => {
    const res = spawnSync(process.execPath, ['-e', "import('./src/config/env.js')"], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, STORAGE_DRIVER: 'bunny', BUNNY_STORAGE_ZONE: 'zone-x', BUNNY_STORAGE_HOST: 'storage.bunnycdn.com', BUNNY_STORAGE_KEY: 'secret-storage-key-123', BUNNY_CDN_URL: '', BUNNY_TOKEN_KEY: '' },
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('BUNNY_CDN_URL');
    expect(res.stderr).toContain('BUNNY_TOKEN_KEY');
    expect(res.stderr).not.toContain('secret-storage-key-123');
    expect(res.stderr).not.toContain('zone-x');
  });
});

describe('Local driver (unchanged behaviour)', () => {
  it('moves the file into the uploads folder, serves it at /uploads/..., never outside the folder', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-root-'));
    const local = createLocalDriver({ root });
    const src = path.join(os.tmpdir(), `local-${Date.now()}.png`);
    fs.writeFileSync(src, 'png');
    await local.put('uploads/2026/11/a.png', src);
    expect(fs.existsSync(path.join(root, '2026', '11', 'a.png'))).toBe(true);
    expect(fs.existsSync(src)).toBe(false);
    expect(await local.stat('uploads/2026/11/a.png')).toEqual({ size: 3 });
    expect(local.url('uploads/2026/11/a.png')).toBe('/uploads/2026/11/a.png');
    await local.remove('uploads/2026/11/a.png');
    expect(await local.stat('uploads/2026/11/a.png')).toBeNull();
    await expect(local.put('uploads/../../evil.png', src)).rejects.toThrow(/outside the uploads folder/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe('No legacy storage references anywhere in the repo', () => {
  it('has zero references across tracked files', () => {
    const root = path.resolve(__dirname, '../../..');
    const target = ['cloud', 'inary'].join('');
    const res = spawnSync('git', ['grep', '-i', target, '--', ':(exclude)*storage_bunny.test.js'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(res.status).toBe(1);
    expect(res.stdout.trim()).toBe('');
  });
});

