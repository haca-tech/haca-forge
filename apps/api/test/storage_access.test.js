// Bunny storage through the API (driver swapped to a mock Bunny server; no real Bunny call):
// uploads land in Bunny and come back as signed URLs; a fresh URL is given only after the access
// rules (worker 404 on others' files, Viewer rules, chat membership, revoked shares); deleting a
// clip, a chat message or a replaced / removed profile photo deletes the Bunny file.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { storageKeyOf } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { MediaItem } from '../src/modules/media/model.js';
import { Channel } from '../src/modules/chat/channel.model.js';
import { ChannelMember } from '../src/modules/chat/channelMember.model.js';
import { ChatMessage } from '../src/modules/chat/chatMessage.model.js';
import { setStorageDriver, putFile } from '../src/lib/storage/index.js';
import { createBunnyDriver } from '../src/lib/storage/bunnyDriver.js';
import { setWorkspacesLockedForTests } from '../src/lib/workspaceLock.js';
import { startMockBunny } from './helpers/mockBunny.js';

const TAG = 'STORAGEACC';
const DOMAIN = '@storage-access-test.com';
const EMAIL = /@storage-access-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();

describe('Bunny storage through the API', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) => (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  let bunny;
  let previousDriver;
  let step;
  let clip;
  let channel;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-acc-'));
  const stored = async (key, body = 'data', type = 'video/mp4') => {
    const p = path.join(tmp, path.basename(key));
    fs.writeFileSync(p, body);
    await putFile(key, p, { contentType: type });
    return key;
  };
  const refresh = (k, url) => request(app).post('/api/files/refresh').set(as(k)).send({ url });

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ topic: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: pieces } }).select('_id').lean()).map((s) => s._id);
    await MediaItem.deleteMany({ stageItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ _id: { $in: pieces } });
    const channels = (await Channel.find({ name: new RegExp(`^${TAG}`) }).select('_id').lean()).map((c) => c._id);
    await ChatMessage.deleteMany({ channelId: { $in: channels } });
    await ChannelMember.deleteMany({ $or: [{ channelId: { $in: channels } }, { userId: { $in: people } }] });
    await Channel.deleteMany({ _id: { $in: channels } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    bunny = await startMockBunny();
    setWorkspacesLockedForTests(false);
    previousDriver = setStorageDriver(createBunnyDriver({ storageZone: bunny.zone, storageHost: bunny.storageHost, storageKey: bunny.accessKey, cdnUrl: bunny.cdnUrl, tokenKey: bunny.tokenKey }));
    await person('owner', 'executive', { jobRole: 'Video Editor' });
    await person('mate', 'executive', { jobRole: 'Video Editor' }); // works on another piece
    await person('viewer', 'viewer');
    await person('cl', 'creative_lead');
    await person('admin', 'admin');
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'sm' });
    step = await WorkItem.create({ title: `${TAG} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'In Progress', calendar: 'sm', ownerId: P.owner._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5) });
    const clipKey = await stored('uploads/2026/11/clip-one.mp4', '0123456789');
    clip = await MediaItem.create({ stageItemId: step._id, contentPieceId: piece._id, uploadedById: P.owner._id, title: `${TAG} clip`, url: clipKey, status: 'uploaded' });
    channel = await Channel.create({ type: 'group', name: `${TAG} group`, createdById: P.cl._id });
    for (const k of ['owner', 'cl']) await ChannelMember.create({ channelId: channel._id, userId: P[k]._id, role: k === 'cl' ? 'owner' : 'member' });
  }, 60000);

  afterAll(async () => {
    setWorkspacesLockedForTests(null);
    setStorageDriver(previousDriver);
    await cleanup();
    await bunny.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }, 60000);

  it('an upload is stored in Bunny under a new key and comes back as a signed URL', async () => {
    const res = await request(app).post('/api/uploads/file').set(as('owner')).attach('file', Buffer.from('fake mp4 bytes'), { filename: 'cut.mp4', contentType: 'video/mp4' });
    expect(res.status).toBe(201);
    const key = storageKeyOf(res.body.data.url);
    expect(key).toMatch(/^uploads\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.mp4$/);
    expect(res.body.data.url).toMatch(new RegExp(`^${bunny.cdnUrl}/uploads/.+\\?token=HS256-[^&]+&expires=\\d+$`));
    expect(bunny.files.get(key)).toMatchObject({ contentType: 'video/mp4' });
    const served = await fetch(res.body.data.url);
    expect([served.status, served.headers.get('content-type')]).toEqual([200, 'video/mp4']);
    // The record stores the key, even when the signed URL is sent back.
    const created = await request(app).post(`/api/work/${step._id}/clips`).set(as('owner')).send({ url: res.body.data.url, title: `${TAG} second`, kind: 'clip' });
    if (created.status < 300) expect((await MediaItem.findById(created.body.data._id).lean()).url).toBe(key);
  });

  it('records come back with signed URLs only to people who may see them', async () => {
    const own = await request(app).get(`/api/work/${step._id}/clips`).set(as('owner'));
    expect(own.status).toBe(200);
    const list = own.body.data || own.body;
    const url = (Array.isArray(list) ? list : list.clips || []).find((c) => String(c._id) === String(clip._id))?.url;
    expect(storageKeyOf(url)).toBe('uploads/2026/11/clip-one.mp4');
    expect(url).toContain('token=HS256-');
    expect((await fetch(url, { headers: { Range: 'bytes=2-5' } })).status).toBe(206);
    // A worker on another piece never gets the record, so never a URL.
    expect((await request(app).get(`/api/work/${step._id}/clips`).set(as('mate'))).status).toBe(404);
  });

  it('a fresh URL needs the access rules first: worker 404 on others\' files, Viewer rules, chat membership', async () => {
    const key = 'uploads/2026/11/clip-one.mp4';
    const ok = await refresh('owner', key);
    expect(ok.status).toBe(200);
    expect(storageKeyOf(ok.body.data.url)).toBe(key);
    expect(ok.body.data.url).toContain('token=');
    const mate = await refresh('mate', key);
    expect([mate.status, mate.body.error?.code]).toEqual([404, 'NOT_FOUND']);
    expect((await refresh('viewer', key)).status).toBe(200); // the Viewer sees every step's outputs
    expect((await refresh('owner', 'uploads/2026/11/no-such-file.mp4')).status).toBe(404);
    expect((await refresh('owner', 'https://drive.google.com/file/d/abc')).status).toBe(404);

    // A chat attachment: channel members only; the Viewer has no chat at all.
    const chatKey = await stored(`uploads/chat/${channel._id}/0f8fad5b-d9cb-469f-a165-70867728950e/notes.pdf`, '%PDF-1.4', 'application/pdf');
    await ChatMessage.create({ channelId: channel._id, authorId: P.cl._id, content: 'file', attachments: [{ fileName: 'notes.pdf', fileSize: 8, mimeType: 'application/pdf', storageUrl: chatKey }] });
    expect((await refresh('cl', chatKey)).status).toBe(200);
    expect((await refresh('owner', chatKey)).status).toBe(200);
    expect((await refresh('mate', chatKey)).status).toBe(404);
    expect((await refresh('viewer', chatKey)).status).toBe(404);
    expect((await refresh('admin', chatKey)).status).toBe(404); // not a member of this group
    // Bunny serves a PDF as a download (Edge Rule in docs/STORAGE.md; the mock does the same).
    const pdf = await fetch((await refresh('cl', chatKey)).body.data.url);
    expect([pdf.headers.get('content-type'), pdf.headers.get('content-disposition')]).toEqual(['application/pdf', 'attachment; filename="notes.pdf"']);
  });

  it('a revoked share card loses its URLs and cannot be refreshed', async () => {
    const shared = await stored('uploads/2026/11/shared-cut.mp4');
    const msg = await ChatMessage.create({
      channelId: channel._id, authorId: P.owner._id, content: '', kind: 'media_share',
      sharedMedia: { grantId: oid(), assetId: String(oid()), assetType: 'clip', contentPieceId: oid(), contentPieceTitle: 'x', stageKey: 'Edit', title: 'x', previewUrl: shared, downloadUrl: shared, isRevoked: true },
    });
    const list = await request(app).get(`/api/chat/channels/${channel._id}/messages`).set(as('cl'));
    expect(list.status).toBe(200);
    const card = JSON.stringify(list.body).includes(String(msg._id)) ? (list.body.messages || list.body.data || []).find?.((m) => String(m._id) === String(msg._id))?.sharedMedia : null;
    if (card) expect([card.previewUrl, card.downloadUrl]).toEqual(['', '']);
    expect(JSON.stringify(list.body)).not.toContain('shared-cut.mp4');
    expect((await refresh('cl', shared)).status).toBe(404);
  });

  it('deleting a clip, a chat message or a replaced / removed photo deletes the Bunny file', async () => {
    // Clip
    const k1 = await stored('uploads/2026/11/to-delete.mp4');
    const c = await MediaItem.create({ stageItemId: step._id, contentPieceId: step.contentPieceId, uploadedById: P.owner._id, title: `${TAG} del`, url: k1, status: 'uploaded' });
    const del = await request(app).delete(`/api/clips/${c._id}`).set(as('owner'));
    expect(del.status).toBeLessThan(300);
    expect(bunny.files.has(k1)).toBe(false);

    // Chat message with an attachment
    const k2 = await stored(`uploads/chat/${channel._id}/1b4e28ba-2fa1-41d2-883f-0016d3cca427/photo.png`, 'png', 'image/png');
    const sent = await request(app).post(`/api/chat/channels/${channel._id}/messages`).set(as('owner')).send({ content: 'pic', attachments: [{ storageUrl: k2 }] });
    expect(sent.status, JSON.stringify(sent.body)).toBeLessThan(300);
    const msgId = sent.body.message?._id || sent.body.data?._id || sent.body._id;
    expect((await ChatMessage.findById(msgId).lean()).attachments[0].storageUrl).toBe(k2);
    expect((await request(app).delete(`/api/chat/channels/${channel._id}/messages/${msgId}`).set(as('owner'))).status).toBeLessThan(300);
    expect(bunny.files.has(k2)).toBe(false);

    // Profile photo: replaced, then removed
    const up = (name) => request(app).post('/api/me/avatar').set(as('owner')).attach('file', Buffer.from('png'), { filename: name, contentType: 'image/png' });
    const first = await up('a.png');
    expect(first.status).toBe(200);
    const k3 = storageKeyOf(first.body.data.avatarUrl);
    expect(k3).toMatch(/^uploads\/avatars\/avatar-[0-9a-f-]{36}\.png$/);
    expect(bunny.files.has(k3)).toBe(true);
    const second = await up('b.png');
    const k4 = storageKeyOf(second.body.data.avatarUrl);
    expect(bunny.files.has(k3)).toBe(false);
    expect(bunny.files.has(k4)).toBe(true);
    // Profile photos: any signed-in user gets a fresh URL; it lasts 7 days.
    const photo = await refresh('mate', k4);
    expect(photo.status).toBe(200);
    const expires = Number(new URL(photo.body.data.url).searchParams.get('expires'));
    expect(expires * 1000 - Date.now()).toBeGreaterThan(6 * 864e5);
    expect((await request(app).delete('/api/me/avatar').set(as('owner'))).status).toBe(200);
    expect(bunny.files.has(k4)).toBe(false);
  });

  it('work files and chat files expire after 10 minutes', async () => {
    const res = await refresh('owner', 'uploads/2026/11/clip-one.mp4');
    const expires = Number(new URL(res.body.data.url).searchParams.get('expires'));
    const left = expires * 1000 - Date.now();
    expect(left).toBeGreaterThan(9 * 60e3);
    expect(left).toBeLessThanOrEqual(10 * 60e3 + 1000);
  });
});
