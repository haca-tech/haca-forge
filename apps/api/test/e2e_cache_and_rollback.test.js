// Phase E4/E5: the resolver cache (cleared on save; 5 s TTL as the safety net when another API
// process changes a config), rollback by restoring an older calendar version, the app with no
// WorkflowConfig at all, and the admin recovery script's logic. Throwaway database
// marketing_portal_rollback, dropped before and after.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';

const DB = 'mongodb://127.0.0.1:27017/marketing_portal_rollback';
process.env.MONGODB_URI = DB;
const { app } = await import('../src/server.js');
const { env } = await import('../src/config/env.js');
const { Person } = await import('../src/modules/people/model.js');
const { WorkItem } = await import('../src/modules/workItems/model.js');
const { ContentPiece } = await import('../src/modules/calendar/contentPiece.model.js');
const { Submission } = await import('../src/modules/submissions/model.js');
const { Notification } = await import('../src/modules/notifications/model.js');
const { AccessChange } = await import('../src/modules/accessConfig/accessChange.model.js');
const { WorkflowConfig } = await import('../src/modules/accessConfig/workflowConfig.model.js');
const { seedReferenceData } = await import('../src/modules/referenceData/service.js');
const { isLocalMongoUri, planAdminRecovery, applyAdminRecovery } = await import('../src/modules/accessConfig/recovery.js');
const resolver = await import('../src/lib/accessResolver.js');

const oid = () => new mongoose.Types.ObjectId();
const tokenOf = (u) => jwt.sign({ userId: String(u._id), role: u.role, email: u.email }, env.JWT_SECRET, { expiresIn: '1h' });

describe('Phase E4/E5: cache and rollback', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${tokenOf(P[k])}` });
  const make = async (key, role, extra = {}) => (P[key] = await Person.create({ name: `RB ${key}`, email: `${key}@rollback.invalid`, role, status: 'active', ...extra }));
  async function waiting(calendar) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `RB ${calendar}`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar });
    const s = await WorkItem.create({ title: `RB ${calendar} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'Pending', calendar, ownerId: P.worker._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true });
    const v = await Submission.create({ workItemId: s._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.worker._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/rb' });
    return { step: s, sub: v };
  }
  const decides = async (key, cal) => resolver.can(await Person.findById(P[key]._id).lean(), 'review.decide', { calendar: cal });

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(DB);
    await mongoose.connection.db.dropDatabase();
    await seedReferenceData();
    resolver.clearAccessCache();
    await make('admin', 'admin');
    await make('cl', 'creative_lead');
    await make('gl', 'growth_lead');
    await make('sm', 'sm_manager');
    await make('worker', 'executive', { jobRole: 'Video Editor' });
  }, 120000);
  afterAll(async () => {
    vi.useRealTimers();
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 120000);

  describe('E4: the resolver cache', () => {
    it('a save in this process applies at once (the cache is cleared on change)', async () => {
      expect(await decides('cl', 'sales')).toBe(true);
      await request(app).put('/api/access-admin/calendars/sales').set(as('admin')).send({ reason: 'cache test', changes: { reviewers: { roles: ['growth_lead'], userIds: [] } } });
      expect(await decides('cl', 'sales')).toBe(false);
      expect(await decides('gl', 'sales')).toBe(true);
      await request(app).put('/api/access-admin/calendars/sales').set(as('admin')).send({ reason: 'cache test', changes: { reviewers: { roles: ['creative_lead'], userIds: [] } } });
    });

    it('a change made by another API process (raw write, no hook here) applies within 5 seconds', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const t0 = new Date('2030-01-01T00:00:00Z').getTime();
        vi.setSystemTime(t0);
        resolver.clearAccessCache();
        expect(await decides('cl', 'other')).toBe(true); // cached now
        // "Instance B" writes straight to the database: this process gets no change event.
        await WorkflowConfig.collection.updateOne(
          { calendar: 'other' },
          { $set: { calendar: 'other', reviewers: { roles: ['growth_lead'], userIds: [] }, planApprovers: { roles: ['creative_lead'], userIds: [] }, posters: { roles: ['sm_manager'], userIds: [] }, fallbackApprovers: { roles: ['admin'], userIds: [] }, version: 9 } },
          { upsert: true }
        );
        vi.setSystemTime(t0 + 4000);
        expect(await decides('cl', 'other')).toBe(true); // still the cached value
        vi.setSystemTime(t0 + 5001);
        expect(await decides('cl', 'other')).toBe(false); // the TTL re-read it
        expect(await decides('gl', 'other')).toBe(true);
      } finally {
        vi.useRealTimers();
        await WorkflowConfig.deleteOne({ calendar: 'other' });
        resolver.clearAccessCache();
      }
    });

    it('people (role, status, calendar limit) are never cached: each request reads them', async () => {
      await Person.collection.updateOne({ _id: P.cl._id }, { $set: { calendarScope: ['sm'] } }); // as another process would
      expect(await decides('cl', 'other')).toBe(false);
      await Person.collection.updateOne({ _id: P.cl._id }, { $unset: { calendarScope: '' } });
      expect(await decides('cl', 'other')).toBe(true);
    });
  });

  describe('E5: rollback', () => {
    it('restoring an older Ads version sends the waiting review back to the Marketing Growth Manager', async () => {
      const w = await waiting('ads');
      const save = await request(app).put('/api/access-admin/calendars/ads').set(as('admin')).send({ reason: 'Marketing Growth Manager away', changes: { reviewers: { roles: [], userIds: [String(P.cl._id)] } } });
      expect(save.status).toBe(200);
      expect(await decides('cl', 'ads')).toBe(true);
      expect(await decides('gl', 'ads')).toBe(false);
      const entry = await AccessChange.findOne({ entityType: 'workflow_config', entityId: 'ads' }).sort({ at: -1 }).lean();
      const restored = await request(app).post(`/api/access-admin/history/${entry._id}/restore`).set(as('admin')).send({ reason: 'Back to normal' });
      expect(restored.status).toBe(200);
      expect(restored.body.data.calendar.config.reviewers).toEqual({ roles: ['growth_lead'], userIds: [] });
      expect(await decides('gl', 'ads')).toBe(true);
      expect(await decides('cl', 'ads')).toBe(false);
      expect(await Notification.countDocuments({ recipient: P.gl._id, type: 'access_rerouted' })).toBe(1);
      expect((await request(app).post(`/api/submissions/${w.sub._id}/approve`).set(as('cl')).send({ score: 4, feedback: 'x', tags: [] })).status).toBe(403);
      expect((await request(app).post(`/api/submissions/${w.sub._id}/approve`).set(as('gl')).send({ score: 4, feedback: 'Good.', tags: [] })).status).toBe(200);
    });

    it('with every WorkflowConfig deleted, the app falls back to today\'s rules and keeps working', async () => {
      await WorkflowConfig.deleteMany({});
      resolver.clearAccessCache();
      expect(await WorkflowConfig.countDocuments()).toBe(0);
      // Decisions: Ads → Marketing Growth Manager, the others → Creative Manager; posters → SM Manager.
      for (const cal of ['sm', 'sales', 'academics_management', 'other']) {
        expect(await decides('cl', cal)).toBe(true);
        expect(await decides('gl', cal)).toBe(false);
      }
      expect(await decides('gl', 'ads')).toBe(true);
      const w = await waiting('sm');
      expect((await request(app).post(`/api/submissions/${w.sub._id}/approve`).set(as('cl')).send({ score: 5, feedback: 'Good.', tags: [] })).status).toBe(200);
      // The admin page still works: every calendar healthy at version 0, and a save creates the record.
      const cals = await request(app).get('/api/access-admin/calendars').set(as('admin'));
      expect(cals.body.data.calendars.map((c) => [c.calendar, c.version, c.health.ok])).toEqual([['sm', 0, true], ['sales', 0, true], ['ads', 0, true], ['academics_management', 0, true], ['other', 0, true]]);
      expect((await request(app).put('/api/access-admin/calendars/sm').set(as('admin')).send({ reason: 'first save', changes: { posters: { roles: [], userIds: [String(P.sm._id)] } } })).body.data.calendar.version).toBe(1);
    });

    it('admin recovery: local databases only; re-activates an account as an active admin, in the History', async () => {
      expect(isLocalMongoUri('mongodb://127.0.0.1:27017/x')).toBe(true);
      expect(isLocalMongoUri('mongodb://localhost/x')).toBe(true);
      expect(isLocalMongoUri('mongodb+srv://cluster0.example.mongodb.net/x')).toBe(false);
      expect(isLocalMongoUri('mongodb://db.example.com:27017/x')).toBe(false);
      expect(isLocalMongoUri('mongodb://127.0.0.1,db.example.com/x')).toBe(false);
      // Lock-out: the only admin is suspended by a raw write (the guard cannot see raw writes).
      await Person.collection.updateOne({ _id: P.admin._id }, { $set: { status: 'suspended' } });
      expect((await request(app).get('/api/access-admin/people').set(as('admin'))).status).toBe(403);
      const plan = await planAdminRecovery('admin@rollback.invalid');
      expect(plan).toMatchObject({ changes: { status: 'active' }, activeAdmins: 0 });
      expect(await Person.countDocuments({ status: 'active', role: 'admin' })).toBe(0); // dry run wrote nothing
      await applyAdminRecovery('admin@rollback.invalid');
      expect(await Person.findById(P.admin._id).lean()).toMatchObject({ role: 'admin', status: 'active' });
      expect((await request(app).get('/api/access-admin/people').set(as('admin'))).status).toBe(200);
      const hist = await AccessChange.findOne({ entityId: String(P.admin._id), field: 'status' }).lean();
      expect(hist).toMatchObject({ before: 'suspended', after: 'active', note: 'Recovery script (scripts/reactivate-admin.js)' });
      // Promoting another local account works the same way.
      await applyAdminRecovery('sm@rollback.invalid');
      expect((await Person.findById(P.sm._id).lean()).role).toBe('admin');
      await expect(applyAdminRecovery('nobody@rollback.invalid')).rejects.toThrow(/No account/);
    });
  });
});
