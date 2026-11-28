// Recent activity on the admin Live Status page.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { categoryOf, verbFor } from '../src/modules/activity/feed.js';

const EMAIL = /@feed-test\.local$/;
const tokenFor = (p) => jwt.sign({ userId: String(p._id), role: p.role, email: p.email }, env.JWT_SECRET, { expiresIn: '1h' });

describe('Activity feed', () => {
  let admin, worker;
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/marketing_portal_test');
    await Person.deleteMany({ email: EMAIL });
    admin = await Person.create({ name: 'Feed Admin', email: 'admin@feed-test.local', role: 'admin', status: 'active' });
    worker = await Person.create({ name: 'Feed Worker', email: 'worker@feed-test.local', role: 'executive', jobRole: 'Writer', status: 'active', passwordHash: await bcrypt.hash('Feed@Pass123', 10) });
  });
  afterAll(async () => {
    await ActivityEvent.deleteMany({ actorId: { $in: [admin._id, worker._id] } });
    await Person.deleteMany({ email: EMAIL });
  });

  const feed = (q = '') => request(app).get(`/api/team/activity-feed?actorId=${worker._id}${q}`).set('Authorization', `Bearer ${tokenFor(admin)}`);

  it('records sign-ins and failed sign-ins, and shows them as sentences', async () => {
    await request(app).post('/api/auth/login').set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari').send({ email: 'worker@feed-test.local', password: 'wrong' });
    await request(app).post('/api/auth/login').send({ email: 'worker@feed-test.local', password: 'Feed@Pass123' });
    await new Promise((r) => setTimeout(r, 100));
    const res = await feed('&category=sign_ins');
    expect(res.status).toBe(200);
    const actions = res.body.data.items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.signed_in', 'auth.sign_in_failed']));
    const first = res.body.data.items[0];
    expect(first.actor.name).toBe('Feed Worker');
    expect(first.target).toBeNull(); // about themselves
    expect(first).not.toHaveProperty('metadata');
  });

  it('pages back with nextBefore and only admins can read it', async () => {
    const base = Date.now() - 60_000;
    await ActivityEvent.insertMany(
      [0, 1, 2].map((i) => ({ entityType: 'person', entityId: worker._id, actorId: worker._id, action: 'profile.updated', metadata: { secret: 'x' }, timestamp: new Date(base - i * 1000) })),
    );
    const page1 = await feed('&category=people&limit=2');
    expect(page1.body.data.items).toHaveLength(2);
    expect(page1.body.data.nextBefore).toBeTruthy();
    const page2 = await feed(`&category=people&limit=2&before=${encodeURIComponent(page1.body.data.nextBefore)}`);
    expect(page2.body.data.items.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(page2.body)).not.toContain('secret');
    expect((await request(app).get('/api/team/activity-feed').set('Authorization', `Bearer ${tokenFor(worker)}`)).status).toBe(403);
  });

  it('words and groups actions', () => {
    expect(verbFor('submission.approved')).toBe('approved a submission');
    expect(verbFor('work_item.something_new')).toBe('something new');
    expect(categoryOf('calendar_plan.created')).toBe('plans');
    expect(categoryOf('auth.signed_in')).toBe('sign_ins');
  });
});
