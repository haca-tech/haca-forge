// Live Status (admin): who has the portal open, from the Socket.IO connections.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { presenceConnected, presenceUpdated, presenceDisconnected, presenceList, resetPresence, cleanPage } from '../src/lib/presence.js';

const EMAIL = /@presence-test\.local$/;
const sock = (id, userId) => ({ id, user: { userId: String(userId) } });
const tokenFor = (p) => jwt.sign({ userId: String(p._id), role: p.role, email: p.email }, env.JWT_SECRET, { expiresIn: '1h' });

describe('Live presence', () => {
  let admin, worker;
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/marketing_portal_test');
    await Person.deleteMany({ email: EMAIL });
    admin = await Person.create({ name: 'PR Admin', email: 'admin@presence-test.local', role: 'admin', status: 'active' });
    worker = await Person.create({ name: 'PR Worker', email: 'worker@presence-test.local', role: 'executive', jobRole: 'Writer', status: 'active' });
  });
  afterAll(() => Person.deleteMany({ email: EMAIL }));
  beforeEach(() => resetPresence());

  const entry = async (p) => (await presenceList()).find((x) => x._id === String(p._id));

  it('tracks tabs: active, away when every tab is hidden, offline with last seen', async () => {
    presenceConnected(sock('a', worker._id));
    presenceUpdated(sock('a', worker._id), { state: 'active', page: '/calendar/123?x=1' });
    expect(await entry(worker)).toMatchObject({ online: true, state: 'active', page: '/calendar', tabs: 1 });

    presenceConnected(sock('b', worker._id));
    presenceUpdated(sock('a', worker._id), { state: 'away' });
    expect((await entry(worker)).state).toBe('active'); // tab b is still visible
    presenceUpdated(sock('b', worker._id), { state: 'away' });
    expect((await entry(worker)).state).toBe('away');

    presenceDisconnected(sock('a', worker._id));
    expect((await entry(worker)).online).toBe(true);
    presenceDisconnected(sock('b', worker._id));
    await new Promise((r) => setTimeout(r, 50));
    const off = await entry(worker);
    expect(off).toMatchObject({ online: false, state: 'offline' });
    expect(off.lastSeenAt).toBeTruthy();
  });

  it('only admins (user.manage) can read it, and it never includes contact details', async () => {
    expect((await request(app).get('/api/team/presence')).status).toBe(401);
    expect((await request(app).get('/api/team/presence').set('Authorization', `Bearer ${tokenFor(worker)}`)).status).toBe(403);
    presenceConnected(sock('c', worker._id));
    const res = await request(app).get('/api/team/presence').set('Authorization', `Bearer ${tokenFor(admin)}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const row = res.body.data.find((x) => x._id === String(worker._id));
    expect(row).toMatchObject({ online: true, state: 'active' });
    expect(row.email).toBeUndefined();
    expect(res.body.data[0].online).toBe(true); // online people first
  });

  it('keeps only the page section', () => {
    expect(cleanPage('/team/abc123')).toBe('/team');
    expect(cleanPage('/')).toBe('/');
    expect(cleanPage('https://evil.example')).toBeNull();
    expect(cleanPage('/<script>')).toBe('/script');
  });
});
