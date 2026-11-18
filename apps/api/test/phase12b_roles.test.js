import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { io as ioClient } from 'socket.io-client';
import {
  APPROVER_ROLES,
  READ_ONLY_VIEWER_ROLES,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  REQUESTABLE_ROLES,
  effectiveStepsFor,
  eligibleStepsFor,
  isApprover,
  isReadOnlyViewer,
  isWorker,
} from '@mmp/shared';
import { app, server, io } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { Submission, Rating } from '../src/modules/submissions/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { registerSocketIO } from '../src/modules/notifications/service.js';
import { buildAutofillContext, autofillRowPlan } from '../src/modules/calendar/autofill.service.js';
import * as migration from '../scripts/migrate-roles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tokenFor = (u) => jwt.sign({ userId: String(u._id), role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });

describe('Phase 12b: the 7-role model', () => {
  const salt = `p12b-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const P = {};
  const sockets = [];
  let port;

  const make = (key, role, extra = {}) =>
    Person.create({
      name: `P12b ${key}`,
      email: `${key}.${salt}@p12b.test`,
      phone: '+15550003333',
      role,
      status: 'active',
      ...extra,
    }).then((p) => (P[key] = p));
  const as = (who) => {
    const t = `Bearer ${tokenFor(P[who])}`;
    return {
      get: (url) => request(app).get(url).set('Authorization', t),
      post: (url, body) => request(app).post(url).set('Authorization', t).send(body),
      patch: (url, body) => request(app).patch(url).set('Authorization', t).send(body),
    };
  };
  const step = (owner, extra = {}) =>
    WorkItem.create({
      title: `P12b step ${salt}`,
      workType: 'Reel',
      stageKey: 'Edit',
      stageOrder: 1,
      status: 'Feedback',
      isLocked: false,
      reviewRequired: true,
      ownerId: P[owner]._id,
      departmentId: new mongoose.Types.ObjectId(),
      deadline: new Date(Date.now() + 5 * 86400000),
      startedAt: new Date(Date.now() - 3600000),
      rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 3600000), submittedAt: new Date(), intervals: [] }],
      ...extra,
    });
  const version = (w, status = 'submitted') =>
    Submission.create({ workItemId: w._id, stageKey: w.stageKey, version: 1, kind: 'link', status, submittedById: w.ownerId, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/p12b' });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(env.MONGODB_URI);
    await make('admin', 'admin');
    await make('creativeHead', 'creative_head');
    await make('productionHead', 'production_head');
    await make('creativeLead', 'creative_lead');
    await make('growthLead', 'growth_lead');
    await make('sm', 'sm_manager', { jobRole: 'Social Media Manager' });
    await make('writer', 'executive', { jobRole: 'Writer', workPreferences: ['Script'] });
    await make('cine', 'executive', { jobRole: 'Cinematographer', workPreferences: ['Shoot'] });
    await make('designer', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Design'] });
    await make('editor', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'] });
    await make('allRounder', 'executive', { jobRole: 'All Rounder', workPreferences: ['Shoot', 'Edit'] });
    await make('unassigned', 'executive', { jobRole: '' });
    await make('mover', 'executive', { jobRole: 'Writer' });
    registerSocketIO(io);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await new Promise((resolve) => server.close(() => resolve()));
    const ids = Object.values(P).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(salt) }).select('_id').lean()).map((w) => w._id);
    const subs = (await Submission.find({ workItemId: { $in: steps } }).select('_id').lean()).map((s) => s._id);
    await ActivityEvent.deleteMany({ entityId: { $in: [...steps, ...subs, ...ids, ...steps.map(String), ...subs.map(String)] } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await Notification.deleteMany({ recipient: { $in: ids } });
    await mongoose.connection.db.collection('users').deleteMany({ email: new RegExp(salt) });
  });

  describe('The shared model', () => {
    it('has exactly the 7 roles, with the decided permissions', () => {
      expect([...ROLE_KEYS].sort()).toEqual(['admin', 'creative_head', 'creative_lead', 'executive', 'growth_lead', 'production_head', 'sm_manager']);
      expect(ROLE_PERMISSIONS.creative_lead).toEqual(ROLE_PERMISSIONS.growth_lead);
      expect(ROLE_PERMISSIONS.creative_head).toEqual(ROLE_PERMISSIONS.production_head);
      for (const key of ['report.configure', 'automation.manage', 'user.manage', 'user.approve']) {
        expect(ROLE_KEYS.filter((r) => ROLE_PERMISSIONS[r].includes(key))).toEqual(['admin']);
      }
      for (const write of ['work.update.own', 'work.create', 'calendar.plan', 'calendar.approve', 'feedback.give', 'chat.use', 'assignment.override']) {
        for (const viewer of READ_ONLY_VIEWER_ROLES) expect(ROLE_PERMISSIONS[viewer]).not.toContain(write);
      }
      for (const key of ['calendar.approve', 'feedback.give', 'revision.classify']) {
        expect(ROLE_KEYS.filter((r) => ROLE_PERMISSIONS[r].includes(key)).sort()).toEqual(['admin', 'creative_lead', 'growth_lead']);
      }
      expect(ROLE_PERMISSIONS.executive.sort()).toEqual(['chat.use', 'feedback.respond', 'work.request', 'work.update.own']);
      expect([...REQUESTABLE_ROLES]).toEqual(['executive', 'sm_manager']);
    });

    it('the helpers name each group', () => {
      expect(ROLE_KEYS.filter(isApprover)).toEqual([...APPROVER_ROLES]);
      expect(ROLE_KEYS.filter(isReadOnlyViewer)).toEqual([...READ_ONLY_VIEWER_ROLES]);
      expect(ROLE_KEYS.filter(isWorker)).toEqual(['executive']);
      expect(isApprover('team_member') || isWorker('team_member') || isReadOnlyViewer('team_member')).toBe(false);
    });

    it('step eligibility follows the job role; preferences only narrow it; Post is SM Managers only', () => {
      const ALL = ['Script', 'Content', 'Shoot', 'Design', 'Edit', 'Post'];
      const e = (jobRole, workPreferences = ALL, role = 'executive') => effectiveStepsFor({ role, jobRole, workPreferences });
      expect(eligibleStepsFor({ role: 'executive', jobRole: 'Writer' }).sort()).toEqual(['Content', 'Script']);
      expect(e('Writer').sort()).toEqual(['Content', 'Script']);
      expect(e('Cinematographer')).toEqual(['Shoot']);
      expect(e('Graphic Designer')).toEqual(['Design']);
      expect(e('Video Editor')).toEqual(['Edit']);
      expect(e('All Rounder').sort()).toEqual(['Content', 'Design', 'Edit', 'Script', 'Shoot']);
      expect(e('All Rounder', ['Shoot', 'Post'])).toEqual(['Shoot']);
      // As before Phase 12b, no preferences means not suggested.
      expect(e('All Rounder', [])).toEqual([]);
      expect(e('')).toEqual([]);
      expect(e('Videographer')).toEqual([]);
      expect(e('', [], 'sm_manager')).toEqual(['Post']);
      for (const r of ['admin', 'creative_head', 'production_head', 'creative_lead', 'growth_lead']) expect(eligibleStepsFor({ role: r, jobRole: 'Writer' })).toEqual([]);
      for (const j of ['Writer', 'Cinematographer', 'Graphic Designer', 'Video Editor', 'All Rounder']) expect(e(j)).not.toContain('Post');
    });
  });

  describe('The permission matrix, on every route group', () => {
    const ALL = ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm', 'writer'];
    const READS = [
      ['dashboard', '/api/dashboard', ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm']],
      ['people', '/api/people', ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm']],
      ['team directory', '/api/team', ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm']],
      ['reports', '/api/reports/overview', ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm']],
      ['review queue', '/api/submissions/review-queue', ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm']],
      ['tracker', '/api/content-pieces', ['admin', 'creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'sm']],
      ['my work', '/api/my-work', ['admin', 'creativeLead', 'growthLead', 'sm', 'writer']],
      ['chat', '/api/chat/channels', ALL],
      ['access requests', '/api/admin/access-requests', ['admin']],
    ];
    for (const [name, url, allowed] of READS) {
      it(`GET ${name}: ${allowed.length === ALL.length ? 'everyone' : allowed.join(', ')}`, { timeout: 60000 }, async () => {
        for (const who of ALL) {
          const res = await as(who).get(url);
          if (allowed.includes(who)) expect(res.status, `${who} ${url}`).toBe(200);
          else expect([403, 404], `${who} ${url}`).toContain(res.status);
        }
      });
    }

    it('a worker gets the 404 for someone else\'s profile, as team_member did', async () => {
      expect((await as('writer').get(`/api/team/${P.editor._id}`)).status).toBe(404);
      expect((await as('writer').get(`/api/team/${P.writer._id}`)).status).toBe(200);
    });

    it('creating work: admin and SM Manager only', async () => {
      const body = { title: `P12b new ${salt}`, workType: 'Reel', deadline: new Date(Date.now() + 86400000).toISOString() };
      for (const who of ['creativeHead', 'productionHead', 'creativeLead', 'growthLead', 'writer']) {
        expect([403, 404], who).toContain((await as(who).post('/api/work-items', body)).status);
      }
    });
  });

  describe('creative_head and production_head are read-only', () => {
    for (const who of ['creativeHead', 'productionHead']) {
      it(`${who}: every write is 403, reads work, own account still writable`, async () => {
        const w = await step('writer');
        for (const [method, url, body] of [
          ['post', '/api/work-items', {}],
          ['patch', `/api/work-items/${w._id}`, { title: 'x' }],
          ['post', `/api/work/${w._id}/transition`, { toStatus: 'In Progress' }],
          ['post', '/api/blockers', {}],
          ['post', '/api/calendar-plans', {}],
          ['patch', `/api/team/${P.writer._id}`, { weeklyCapacityHours: 10 }],
          ['post', '/api/chat/channels', { name: 'x' }],
          ['post', `/api/submissions/${new mongoose.Types.ObjectId()}/approve`, { score: 5 }],
        ]) {
          const res = await as(who)[method](url, body);
          expect(res.status, `${method} ${url}`).toBe(403);
          expect(res.body.error.code, `${method} ${url}`).toBe('READ_ONLY_ROLE');
        }
        expect((await as(who).get(`/api/work/${w._id}`)).status).toBe(200);
        expect((await as(who).post('/api/auth/logout', {})).status).toBeLessThan(400);
      });
    }

    it('they see contact details', async () => {
      for (const who of ['creativeHead', 'productionHead']) {
        const res = await as(who).get(`/api/people/${P.writer._id}/profile`);
        expect(res.status).toBe(200);
        expect(JSON.stringify(res.body)).toContain(P.writer.email);
        const list = await as(who).get('/api/people');
        expect(JSON.stringify(list.body)).toContain(P.writer.email);
      }
      // A worker does not see someone else's.
      const worker = await as('writer').get(`/api/people/${P.editor._id}/profile`);
      expect(JSON.stringify(worker.body)).not.toContain(P.editor.email);
    });

    it('they see review text (revision notes and rating feedback) but cannot decide', async () => {
      const w = await step('editor');
      const v = await version(w);
      expect((await as('creativeLead').post(`/api/submissions/${v._id}/request-revision`, { comment: 'Trim the intro please' })).status).toBe(200);
      for (const who of ['creativeHead', 'productionHead']) {
        const res = await as(who).get(`/api/work/${w._id}`);
        expect(res.body.data.latestFeedback.text).toBe('Trim the intro please');
        const sub = await as(who).get(`/api/submissions/${v._id}`);
        expect(sub.status).toBe(200);
        expect((sub.body.data.comments || []).map((c) => c.text)).toContain('Trim the intro please');
      }
    });

    it('their My Work route goes to the dashboard (no steps to own)', async () => {
      expect([403, 404]).toContain((await as('creativeHead').get('/api/my-work')).status);
    });
  });

  describe('Reviewing: both leads and admin, never on their own work', () => {
    for (const lead of ['creativeLead', 'growthLead']) {
      it(`${lead} approves others' work and cannot approve or send back their own`, async () => {
        const own = await step(lead);
        const ownV = await version(own);
        const a = await as(lead).post(`/api/submissions/${ownV._id}/approve`, { score: 5 });
        expect(a.status).toBe(403);
        expect(a.body.error.code).toBe('FORBIDDEN_SELF_APPROVAL');
        const r = await as(lead).post(`/api/submissions/${ownV._id}/request-revision`, { comment: 'self' });
        expect(r.status).toBe(403);
        const other = await step('editor');
        const otherV = await version(other);
        expect((await as(lead).post(`/api/submissions/${otherV._id}/approve`, { score: 4 })).status).toBe(200);
      });
    }

    it('admin reviews as a backup; the SM Manager and workers cannot', async () => {
      for (const who of ['sm', 'writer']) {
        const w = await step('editor');
        const v = await version(w);
        expect([403, 404], who).toContain((await as(who).post(`/api/submissions/${v._id}/approve`, { score: 4 })).status);
      }
      const w = await step('editor');
      const v = await version(w);
      expect((await as('admin').post(`/api/submissions/${v._id}/approve`, { score: 4 })).status).toBe(200);
    });
  });

  describe('Operational fields and eligibility', () => {
    it('both leads edit a worker\'s operational fields; preferences outside the job role are refused', async () => {
      for (const lead of ['creativeLead', 'growthLead']) {
        const bad = await as(lead).patch(`/api/team/${P.writer._id}`, { workPreferences: ['Script', 'Post'] });
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('PREFERENCE_NOT_ELIGIBLE');
        const ok = await as(lead).patch(`/api/team/${P.writer._id}`, { workPreferences: ['Content'], weeklyCapacityHours: 35 });
        expect(ok.status).toBe(200);
        expect((await Person.findById(P.writer._id).lean()).workPreferences).toEqual(['Content']);
      }
      // A job role change drops the preferences the new job role does not allow.
      expect((await as('admin').patch(`/api/team/${P.allRounder._id}`, { jobRole: 'Video Editor' })).status).toBe(200);
      expect((await Person.findById(P.allRounder._id).lean()).workPreferences).toEqual(['Edit']);
      // Leads cannot touch leadership accounts or roles.
      expect((await as('creativeLead').patch(`/api/team/${P.growthLead._id}`, { weeklyCapacityHours: 10 })).status).toBe(403);
      expect((await as('creativeLead').patch(`/api/team/${P.editor._id}`, { role: 'sm_manager' })).status).toBe(403);
    });

    it('autofill suggests each step only to eligible people; Post only to SM Managers', async () => {
      // The test above changed the writer's preferences; give them both writing steps again.
      await Person.updateOne({ _id: P.writer._id }, { $set: { workPreferences: ['Script', 'Content'] } });
      const ctx = await buildAutofillContext();
      const mine = { candidates: ctx.candidates.filter((c) => String(c.member.email).includes(salt)) };
      const byEmail = new Map(mine.candidates.map((c) => [c.member.email.split('.')[0], c]));
      expect(byEmail.has('creativeLead') || byEmail.has('creativeHead') || byEmail.has('admin')).toBe(false);
      expect(byEmail.get('sm').workPreferences).toEqual(['Post']);
      expect(byEmail.get('cine').workPreferences).toEqual(['Shoot']);
      expect(byEmail.get('unassigned').workPreferences).toEqual([]);
      for (const c of mine.candidates) {
        if (c.member.role === 'executive') expect(c.workPreferences).not.toContain('Post');
      }
      const plan = await autofillRowPlan({ type: 'Reel', postingDate: new Date(Date.now() + 20 * 86400000), needsScript: true, needsShoot: true, context: mine });
      const owner = (k) => mine.candidates.find((c) => String(c.member._id) === plan.stages.find((s) => s.stageKey === k)?.ownerId)?.member;
      expect(owner('Post')?.role).toBe('sm_manager');
      expect(['Cinematographer', 'All Rounder']).toContain(owner('Shoot')?.jobRole);
      expect(['Writer', 'All Rounder']).toContain(owner('Script')?.jobRole);
      expect(['Video Editor', 'All Rounder']).toContain(owner('Edit')?.jobRole);
      expect(plan.suggestedPostingOwner?._id).toBe(String(P.sm._id));
    });
  });

  describe('Old keys and account grants', () => {
    it('team_member is no longer a role: refused on save, on sign-in and on every request', async () => {
      expect((await as('admin').patch(`/api/team/${P.editor._id}`, { role: 'team_member' })).status).toBe(400);
      const passwordHash = await bcrypt.hash('Old-role-pass-9', 10);
      const { insertedId } = await mongoose.connection.db.collection('users').insertOne({ name: 'P12b old', email: `old.${salt}@p12b.test`, role: 'team_member', status: 'active', passwordHash, createdAt: new Date() });
      const old = { _id: insertedId, role: 'team_member' };
      const res = await request(app).get('/api/my-work').set('Authorization', `Bearer ${tokenFor(old)}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('ROLE_MIGRATION_PENDING');
      const login = await request(app).post('/api/auth/login').send({ email: `old.${salt}@p12b.test`, password: 'Old-role-pass-9' });
      expect(login.status).toBe(403);
      expect(login.body.error.code).toBe('ROLE_MIGRATION_PENDING');
    });

    it('public requests: executive or sm_manager only', async () => {
      const res = await request(app).post('/api/auth/request-access').send({ name: 'P12b request', email: `req.${salt}@p12b.test`, phone: '9000000099', jobRole: 'Writer', requestedRole: 'creative_lead', reason: 'I would like to lead the creative team please.' });
      expect(res.status).toBe(400);
    });
  });

  describe('A role change refreshes the session', () => {
    const connect = (user) =>
      new Promise((resolve) => {
        const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { cookie: `accessToken=${tokenFor(user)}` } });
        socket.on('connect', () => {
          sockets.push(socket);
          resolve(socket);
        });
        socket.on('connect_error', () => resolve(null));
      });

    it('disconnects the sockets; the reconnect joins the new role room; /auth/me returns the new role', async () => {
      const socket = await connect(P.mover);
      expect(socket).toBeTruthy();
      expect((await io.in('role:executive').fetchSockets()).some((s) => s.user?.userId === String(P.mover._id))).toBe(true);
      const gone = new Promise((resolve) => socket.once('disconnect', resolve));
      expect((await as('admin').patch(`/api/team/${P.mover._id}`, { role: 'sm_manager', workPreferences: [] })).status).toBe(200);
      expect(await gone).toBe('io server disconnect');

      const again = await connect(P.mover);
      expect(again).toBeTruthy();
      const inRoom = async (room) => (await io.in(room).fetchSockets()).some((s) => s.user?.userId === String(P.mover._id));
      expect(await inRoom('role:sm_manager')).toBe(true);
      expect(await inRoom('role:executive')).toBe(false);
      const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${tokenFor(P.mover)}`);
      expect(me.body.user?.role || me.body.data?.user?.role).toBe('sm_manager');
      expect(me.body.permissions || me.body.data?.permissions).toEqual(ROLE_PERMISSIONS.sm_manager);
    });

    it('live review comments go to the two lead rooms and admin, not to the read-only heads', async () => {
      const lead = await connect(P.growthLead);
      const head = await connect(P.creativeHead);
      const w = await step('editor', { status: 'Pending' });
      const v = await version(w);
      const got = (socket) => new Promise((resolve) => {
        const t = setTimeout(() => resolve(false), 1500);
        socket.once('comment:new', () => {
          clearTimeout(t);
          resolve(true);
        });
      });
      const leadGot = got(lead);
      const headGot = got(head);
      expect((await as('creativeLead').post(`/api/submissions/${v._id}/comments`, { text: 'Live note' })).status).toBe(201);
      expect(await leadGot).toBe(true);
      expect(await headGot).toBe(false);
    });
  });

  describe('The migration script', () => {
    const scratchName = `marketing_portal_test_migr_${Date.now()}`;
    let db;
    const ids = {};

    beforeAll(async () => {
      db = mongoose.connection.useDb(scratchName, { useCache: false }).db;
      const oid = () => new mongoose.Types.ObjectId();
      const users = [
        ['admin', 'admin', '', []],
        ['execLeader', 'executive', '', []],
        ['approver', 'creative_head', 'Creative Manager (TL)', []],
        ['sm', 'sm_manager', 'Social Media Manager', []],
        ['writer', 'team_member', 'Writer', ['Content', 'Script']],
        ['designer', 'team_member', 'Designer', ['Design']],
        ['shooter', 'team_member', 'Videographer', ['Shoot']],
        ['poster', 'team_member', 'Social Specialist', ['Post']],
        ['allround', 'team_member', 'Social Specialist', ['Script', 'Shoot', 'Post']],
      ];
      for (const [k, role, jobRole, workPreferences] of users) {
        ids[k] = oid();
        await db.collection('users').insertOne({ _id: ids[k], name: `Migr ${k}`, role, jobRole, workPreferences, status: 'active' });
      }
      ids.piece = oid();
      await db.collection('contentpieces').insertOne({ _id: ids.piece, postingOwnerId: ids.poster, stagePlan: [{ stageKey: 'Edit', ownerId: ids.writer }, { stageKey: 'Post', ownerId: ids.poster }] });
      ids.openPost = oid();
      ids.postedPost = oid();
      await db.collection('workitems').insertMany([
        { _id: ids.openPost, stageKey: 'Post', status: 'Not Started', ownerId: ids.poster, contentPieceId: ids.piece },
        { _id: ids.postedPost, stageKey: 'Post', status: 'Published', ownerId: ids.poster },
      ]);
      await db.collection('sessions').insertOne({ userId: ids.writer, revokedAt: null });
    });

    afterAll(async () => {
      await db.dropDatabase();
    });

    it('refuses production, non-local hosts, and confirmed runs on test databases', () => {
      const ok = { confirm: false };
      expect(() => migration.assertSafe({ uri: 'mongodb://10.0.0.5:27017/marketing_portal', flags: ok, nodeEnv: 'development' })).toThrow(/not local/);
      expect(() => migration.assertSafe({ uri: 'mongodb+srv://cluster.example.net/marketing_portal', flags: ok, nodeEnv: 'development' })).toThrow(/not local/);
      expect(() => migration.assertSafe({ uri: 'mongodb://127.0.0.1:27017/marketing_portal', flags: ok, nodeEnv: 'production' })).toThrow(/production/);
      expect(() => migration.assertSafe({ uri: 'mongodb://127.0.0.1:27017/marketing_portal_test', flags: { confirm: true, dbName: 'marketing_portal_test' }, nodeEnv: 'test' })).toThrow(/test or disposable/);
      expect(() => migration.assertSafe({ uri: 'mongodb://127.0.0.1:27017/marketing_portal_test', flags: ok, nodeEnv: 'development' })).toThrow(/test or disposable/);
      expect(() => migration.assertSafe({ uri: 'mongodb://127.0.0.1:27017/marketing_portal', flags: { confirm: true, dbName: 'other' }, nodeEnv: 'development' })).toThrow(/--db-name/);
      expect(migration.assertSafe({ uri: 'mongodb://127.0.0.1:27017/marketing_portal', flags: ok, nodeEnv: 'development' })).toBe('marketing_portal');
      expect(migration.parseArgs([]).confirm).toBe(false);
      expect(migration.parseArgs([]).backupRoot).toBe('D:\\haca-backups');
    });

    it('the dry run maps every role and job role correctly and writes nothing', async () => {
      const snapshot = async () => JSON.stringify(await Promise.all(['users', 'workitems', 'contentpieces', 'sessions', 'accessrequests', 'migrations'].map((c) => db.collection(c).find({}).sort({ _id: 1 }).toArray())));
      const before = await snapshot();
      const plan = await migration.buildPlan(db);
      expect(await snapshot()).toBe(before);
      expect(plan.problems).toEqual([]);
      const to = Object.fromEntries(plan.changes.map((c) => [String(c.id), c]));
      expect(to[String(ids.execLeader)]).toMatchObject({ fromRole: 'executive', toRole: 'creative_head' });
      expect(to[String(ids.approver)]).toMatchObject({ fromRole: 'creative_head', toRole: 'creative_lead', toJob: 'Creative Manager (TL)' });
      expect(to[String(ids.writer)]).toMatchObject({ fromRole: 'team_member', toRole: 'executive', toJob: 'Writer', toPrefs: ['Content', 'Script'] });
      expect(to[String(ids.designer)]).toMatchObject({ toRole: 'executive', toJob: 'Graphic Designer', toPrefs: ['Design'] });
      expect(to[String(ids.shooter)]).toMatchObject({ toRole: 'executive', toJob: 'Cinematographer', toPrefs: ['Shoot'] });
      expect(to[String(ids.poster)]).toMatchObject({ toRole: 'executive', toJob: '', toPrefs: [] });
      expect(to[String(ids.allround)]).toMatchObject({ toRole: 'executive', toJob: 'All Rounder', toPrefs: ['Script', 'Shoot'] });
      expect(to[String(ids.admin)]).toBeUndefined();
      expect(plan.postMoves.map((w) => String(w._id))).toEqual([String(ids.openPost)]);
      expect(plan.postedCount).toBe(1);
      expect(plan.counts.rolesAfter).toEqual({ admin: 1, creative_head: 1, creative_lead: 1, sm_manager: 1, executive: 5 });
      const text = migration.formatPlan(plan, { dbName: scratchName, mode: 'DRY RUN' });
      expect(text).toContain('Users to change: 7');
      expect(text).toContain('No problems found.');
    });

    it('stops when there is not exactly one active SM Manager', async () => {
      const extra = new mongoose.Types.ObjectId();
      await db.collection('users').insertOne({ _id: extra, name: 'Migr sm2', role: 'sm_manager', status: 'active' });
      const plan = await migration.buildPlan(db);
      expect(plan.problems.join(' ')).toMatch(/exactly one active SM Manager/);
      await db.collection('users').deleteOne({ _id: extra });
    });

    it('applied once (as --confirm would after the backup), it cannot run twice', async () => {
      const done = await migration.applyPlan(db, await migration.buildPlan(db));
      expect(done.users).toBe(7);
      expect(done.postSteps).toBe(1);
      expect(done.sessionsRevoked).toBe(1);
      const u = async (k) => db.collection('users').findOne({ _id: ids[k] });
      expect((await u('execLeader')).role).toBe('creative_head');
      expect((await u('approver')).role).toBe('creative_lead');
      expect((await u('writer')).role).toBe('executive');
      expect((await db.collection('workitems').findOne({ _id: ids.openPost })).ownerId).toEqual(ids.sm);
      expect((await db.collection('workitems').findOne({ _id: ids.postedPost })).ownerId).toEqual(ids.poster);
      const piece = await db.collection('contentpieces').findOne({ _id: ids.piece });
      expect(piece.postingOwnerId).toEqual(ids.sm);
      expect(piece.stagePlan.find((s) => s.stageKey === 'Post').ownerId).toEqual(ids.sm);
      expect(piece.stagePlan.find((s) => s.stageKey === 'Edit').ownerId).toEqual(ids.writer);
      expect((await db.collection('sessions').findOne({ userId: ids.writer })).revokedAt).toBeTruthy();
      const again = await migration.buildPlan(db);
      expect(again.problems.join(' ')).toMatch(/Already migrated/);
    });
  });

  describe('Guard: the reused keys never keep their old meaning in app code', () => {
    const roots = ['../src', '../../web/src', '../../../scripts', '../../../packages/shared/src'].map((p) => path.resolve(__dirname, p));
    // The shared role model defines the keys; the seed users and the migration name them on purpose.
    const allowed = new Set(['seedUsers.js', 'index.ts']);
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(full);
        } else if (/\.(js|ts|tsx)$/.test(e.name) && !/\.test\./.test(e.name) && !allowed.has(e.name)) files.push(full);
      }
    };
    roots.forEach(walk);

    it('no team_member anywhere, and creative_head / executive only through the shared helpers', () => {
      const offenders = [];
      for (const file of files) {
        const text = fs.readFileSync(file, 'utf8');
        text.split('\n').forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '').trim();
          if (code.startsWith('*') || code.startsWith('/*')) return;
          if (/\bteam_member\b/.test(code)) offenders.push(`${path.basename(file)}:${i + 1} team_member`);
          if (/['"`](creative_head|executive)['"`]|\b(creative_head|executive)\s*:|role:(creative_head|executive)\b/.test(code)) {
            offenders.push(`${path.basename(file)}:${i + 1} ${code.slice(0, 80)}`);
          }
        });
      }
      expect(offenders).toEqual([]);
    });
  });
});
