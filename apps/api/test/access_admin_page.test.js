// Phase D: the Access & Approvals admin page API. Role changes (preview, history, access:changed,
// socket reset), calendar limits, the last-admin and self guards, picker eligibility, the health
// check, calendar re-routing with one notification per new person, restore, and admin-only access.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { PauseRequest } from '../src/modules/workItems/pauseRequest.model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { Submission } from '../src/modules/submissions/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { DISCONNECT_DELAY_MS } from '../src/modules/accessConfig/personAccess.service.js';
import { setSocketServer } from '../src/lib/socketHub.js';
import { registerSocketIO } from '../src/modules/notifications/service.js';
import { canDecideOn } from '../src/modules/workItems/deciders.js';
import { listFeedbackThreads } from '../src/modules/feedback/service.js';
import * as resolver from '../src/lib/accessResolver.js';

const DOMAIN = '@access-admin-test.com';
const EMAIL = /@access-admin-test\.com$/;
const TAG = 'AADMIN';
const BASE = '/api/access-admin';

function fakeIo() {
  const emits = [];
  const disconnected = [];
  return {
    emits,
    disconnected,
    to(rooms) {
      const list = [].concat(rooms);
      return { emit: (event, payload) => emits.push({ rooms: list, event, payload }) };
    },
    in(room) {
      return { disconnectSockets: () => disconnected.push(room), socketsLeave: () => {} };
    },
  };
}

const tokenFor = (u) => jwt.sign({ userId: String(u._id), role: u.role, email: u.email }, env.JWT_SECRET, { expiresIn: '1h' });

describe('Access & Approvals admin API (Phase D)', () => {
  const P = {};
  let io;
  const as = (key) => ({ Authorization: `Bearer ${tokenFor(P[key])}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  const fresh = async (key) => Person.findById(P[key]._id).lean();

  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    await PauseRequest.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG}`) });
    await Notification.deleteMany({ recipient: { $in: ids } });
    await AccessChange.deleteMany({ $or: [{ entityId: { $in: ids.map(String) } }, { entityType: 'workflow_config' }] });
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await person('admin', 'admin');
    await person('admin2', 'admin');
    await person('growth', 'growth_lead');
    await person('lead', 'creative_lead');
    await person('sm', 'sm_manager');
    await person('sm2', 'sm_manager');
    await person('worker', 'executive', { jobRole: 'Video Editor' });
    await person('gone', 'creative_lead', { status: 'suspended' });
  }, 60000);
  afterAll(async () => {
    setSocketServer(null);
    registerSocketIO(null);
    await cleanup();
  }, 60000);
  beforeEach(() => {
    io = fakeIo();
    setSocketServer(io);
    registerSocketIO(io);
  });

  describe('Only the admin can open it', () => {
    it('every other role gets 403 on every endpoint', async () => {
      for (const key of ['growth', 'lead', 'sm', 'worker']) {
        for (const [method, url] of [
          ['get', '/people'],
          ['get', '/calendars'],
          ['get', '/history'],
          ['get', '/role-guide'],
          ['patch', `/people/${P.worker._id}`],
          ['put', '/calendars/ads'],
        ]) {
          const res = await request(app)[method](BASE + url).set(as(key)).send({ reason: 'try' });
          expect(res.status, `${key} ${method} ${url}`).toBe(403);
        }
      }
      expect((await request(app).get(`${BASE}/people`)).status).toBe(401);
      expect((await request(app).get(`${BASE}/people`).set(as('admin'))).status).toBe(200);
    });
  });

  describe('People & roles', () => {
    it('lists people with search, role and status filters', async () => {
      const res = await request(app).get(`${BASE}/people`).query({ search: TAG, role: 'creative_lead' }).set(as('admin'));
      expect(res.body.data.map((p) => p.name).sort()).toEqual([`${TAG} gone`, `${TAG} lead`]);
      const suspended = await request(app).get(`${BASE}/people`).query({ search: TAG, status: 'suspended' }).set(as('admin'));
      expect(suspended.body.data.map((p) => p.name)).toEqual([`${TAG} gone`]);
      const lead = res.body.data.find((p) => p.name === `${TAG} lead`);
      expect(lead).toMatchObject({ role: 'creative_lead', calendarScope: null, calendarLimitApplies: true });
    });

    it('previews a role change in catalog labels, then saves it with history, access:changed and a socket reset', async () => {
      const preview = await request(app).post(`${BASE}/people/${P.worker._id}/preview`).set(as('admin')).send({ role: 'growth_lead' });
      expect(preview.status).toBe(200);
      expect(preview.body.data.gains).toEqual(expect.arrayContaining([expect.stringMatching(/ on Ads Calendar/)]));
      expect(preview.body.data.blocked).toBeNull();

      const noReason = await request(app).patch(`${BASE}/people/${P.worker._id}`).set(as('admin')).send({ role: 'growth_lead' });
      expect(noReason.status).toBe(400);
      expect(noReason.body.error.code).toBe('REASON_REQUIRED');

      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        const res = await request(app).patch(`${BASE}/people/${P.worker._id}`).set(as('admin')).send({ role: 'growth_lead', reason: 'Covers Ads now' });
        expect(res.status).toBe(200);
        expect((await fresh('worker')).role).toBe('growth_lead');
        const hist = await AccessChange.find({ entityId: String(P.worker._id) }).lean();
        expect(hist.map((h) => [h.field, h.before, h.after, h.note])).toEqual([['role', 'executive', 'growth_lead', 'Covers Ads now']]);
        expect(io.emits.filter((e) => e.event === 'access:changed').flatMap((e) => e.rooms)).toEqual([`user:${P.worker._id}`]);
        vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
        expect(io.disconnected).toEqual([`user:${P.worker._id}`]);
      } finally {
        vi.useRealTimers();
      }
      const history = await request(app).get(`${BASE}/history`).query({ person: String(P.worker._id) }).set(as('admin'));
      expect(history.body.data[0]).toMatchObject({ type: 'person', subject: `${TAG} worker`, field: 'role', before: 'executive', after: 'growth_lead', reason: 'Covers Ads now', actor: `${TAG} admin` });
      await request(app).patch(`${BASE}/people/${P.worker._id}`).set(as('admin')).send({ role: 'executive', reason: 'Back' });
    });

    it('a calendar limit narrows the lead\'s queue and decisions at once', async () => {
      const piece = await ContentPiece.create({ planId: new mongoose.Types.ObjectId(), topic: `${TAG} other piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(), status: 'In Progress', calendar: 'other' });
      const step = await WorkItem.create({ title: `${TAG} other Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'Pending', calendar: 'other', ownerId: P.worker._id, departmentId: new mongoose.Types.ObjectId(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5), reviewRequired: true });
      const inQueue = async () => (await listFeedbackThreads({}, await fresh('lead'))).some((t) => String(t.workItem?._id || t._id || t.workItemId) === String(step._id) || JSON.stringify(t).includes(String(step._id)));
      expect(await canDecideOn(await fresh('lead'), 'other')).toBe(true);
      expect(await inQueue()).toBe(true);

      const res = await request(app).patch(`${BASE}/people/${P.lead._id}`).set(as('admin')).send({ calendarScope: ['sm'], reason: 'SM only this month' });
      expect(res.status).toBe(200);
      expect(res.body.data.calendarScope).toEqual(['sm']);
      expect(await canDecideOn(await fresh('lead'), 'other')).toBe(false);
      expect(await inQueue()).toBe(false);
      expect(io.emits.some((e) => e.event === 'access:changed' && e.rooms.includes(`user:${P.lead._id}`))).toBe(true);

      await request(app).patch(`${BASE}/people/${P.lead._id}`).set(as('admin')).send({ calendarScope: null, reason: 'All again' });
      expect(await canDecideOn(await fresh('lead'), 'other')).toBe(true);
    });

    it('the calendar limit is ignored for roles where it means nothing', async () => {
      const res = await request(app).patch(`${BASE}/people/${P.worker._id}`).set(as('admin')).send({ calendarScope: ['ads'], reason: 'test' });
      expect(res.status).toBe(200);
      expect((await fresh('worker')).calendarScope ?? null).toBeNull();
    });

    it('an admin cannot demote or suspend themselves', async () => {
      const preview = await request(app).post(`${BASE}/people/${P.admin._id}/preview`).set(as('admin')).send({ role: 'growth_lead' });
      expect(preview.body.data.blocked).toMatchObject({ code: 'SELF_DEMOTE' });
      const demote = await request(app).patch(`${BASE}/people/${P.admin._id}`).set(as('admin')).send({ role: 'growth_lead', reason: 'test' });
      expect(demote.status).toBe(403);
      expect(demote.body.error.code).toBe('SELF_DEMOTE');
      const suspend = await request(app).patch(`${BASE}/people/${P.admin._id}`).set(as('admin')).send({ status: 'suspended', reason: 'test' });
      expect(suspend.status).toBe(403);
      expect(suspend.body.error.code).toBe('SELF_SUSPEND');
      expect((await fresh('admin')).role).toBe('admin');
    });

    it('the last active admin cannot be demoted or suspended', async () => {
      const { savePersonChange, previewPersonChange } = await import('../src/modules/accessConfig/accessAdmin.service.js');
      // While another admin is active, admin 1 may demote admin 2.
      const ok = await request(app).patch(`${BASE}/people/${P.admin2._id}`).set(as('admin')).send({ role: 'growth_lead', reason: 'Moving to Ads' });
      expect(ok.status).toBe(200);
      const others = await Person.collection.find({ role: 'admin', status: 'active', _id: { $ne: P.admin._id } }).project({ _id: 1 }).toArray();
      if (others.length) await Person.collection.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { status: 'suspended' } });
      try {
        // Through the page the acting admin is always active, so the last admin is themselves: SELF_DEMOTE.
        const self = await request(app).patch(`${BASE}/people/${P.admin._id}`).set(as('admin')).send({ role: 'growth_lead', reason: 'test' });
        expect(self.status).toBe(403);
        // Any other caller (system, script) hits LAST_ADMIN in the service and in the model.
        expect((await previewPersonChange(String(P.admin._id), { role: 'growth_lead' }, null)).blocked).toMatchObject({ code: 'LAST_ADMIN' });
        await expect(savePersonChange(String(P.admin._id), { role: 'growth_lead', reason: 'test' }, null)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
        await expect(savePersonChange(String(P.admin._id), { status: 'suspended', reason: 'test' }, null)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
        await expect(Person.updateOne({ _id: P.admin._id }, { $set: { role: 'growth_lead' } })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
        expect((await fresh('admin')).role).toBe('admin');
        expect((await fresh('admin')).status).toBe('active');
      } finally {
        if (others.length) await Person.collection.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { status: 'active' } });
        await Person.collection.updateOne({ _id: P.admin2._id }, { $set: { role: 'admin', status: 'active' } });
      }
    });
  });

  describe('Calendar approvals', () => {
    it('pickers offer only roles and active people holding the slot permission', async () => {
      const res = await request(app).get(`${BASE}/calendars`).set(as('admin'));
      expect(res.status).toBe(200);
      const { calendars, options } = res.body.data;
      expect(calendars.map((c) => c.calendar)).toEqual(['sm', 'sales', 'ads', 'academics_management', 'other']);
      expect(options.reviewers.permission).toBe('review.decide');
      expect(options.reviewers.roles).not.toContain('executive');
      expect(options.reviewers.roles).not.toContain('sm_manager');
      expect(options.posters.roles).toContain('sm_manager');
      const reviewerNames = options.reviewers.people.map((p) => p.name);
      expect(reviewerNames).toContain(`${TAG} lead`);
      expect(reviewerNames).not.toContain(`${TAG} gone`); // suspended
      expect(reviewerNames).not.toContain(`${TAG} worker`); // no permission
      expect(calendars.every((c) => c.health.ok)).toBe(true);
    });

    it('the health check blocks a save that leaves a calendar without a poster, and warns on a suspended person', async () => {
      const bad = await request(app).post(`${BASE}/calendars/ads/preview`).set(as('admin')).send({ changes: { posters: { roles: [], userIds: [] }, fallbackApprovers: { roles: [], userIds: [] } } });
      expect(bad.body.data.health.ok).toBe(false);
      const save = await request(app).put(`${BASE}/calendars/ads`).set(as('admin')).send({ reason: 'test', changes: { posters: { roles: [], userIds: [] }, fallbackApprovers: { roles: [], userIds: [] } } });
      expect(save.status).toBe(409);
      expect(save.body.error.code).toBe('HEALTH_CHECK_FAILED');
      const noPermission = await request(app).post(`${BASE}/calendars/ads/preview`).set(as('admin')).send({ changes: { reviewers: { roles: ['executive'], userIds: [] } } });
      expect(noPermission.body.data.health.ok).toBe(false);
      const warn = await request(app).post(`${BASE}/calendars/ads/preview`).set(as('admin')).send({ changes: { reviewers: { roles: ['growth_lead'], userIds: [String(P.gone._id)] } } });
      expect(warn.body.data.health.ok).toBe(true);
      expect(warn.body.data.health.warnings.map((w) => w.message)).toEqual(expect.arrayContaining([`${TAG} gone is suspended.`]));
      expect(await WorkflowConfig.countDocuments({ calendar: 'ads' })).toBe(0);
    });

    it('moving Ads reviews to a named Creative Manager re-routes waiting work, notifies once, and Marketing Growth Manager loses it', async () => {
      const piece = await ContentPiece.create({ planId: new mongoose.Types.ObjectId(), topic: `${TAG} ads piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(), status: 'In Progress', calendar: 'ads' });
      const row = await ContentPiece.create({ planId: new mongoose.Types.ObjectId(), topic: `${TAG} ads row`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(), status: 'Not Started', calendar: 'ads', rowStatus: 'submitted' });
      const step = await WorkItem.create({ title: `${TAG} ads Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'Pending', calendar: 'ads', ownerId: P.worker._id, departmentId: new mongoose.Types.ObjectId(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5), reviewRequired: true });
      await Submission.create({ workItemId: step._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.worker._id, submittedAt: new Date(), linkUrl: `https://drive.google.com/file/d/${TAG}` });
      const busy = await WorkItem.create({ title: `${TAG} ads Script`, workType: 'Reel', stageKey: 'Script', stageOrder: 1, status: 'In Progress', calendar: 'ads', ownerId: P.worker._id, departmentId: new mongoose.Types.ObjectId(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5) });
      await PauseRequest.create({ workItemId: busy._id, ownerId: P.worker._id, reason: 'other', note: 'Waiting on the client' });

      expect(await canDecideOn(await fresh('growth'), 'ads')).toBe(true);
      const changes = { reviewers: { roles: [], userIds: [String(P.lead._id)] } };
      const preview = await request(app).post(`${BASE}/calendars/ads/preview`).set(as('admin')).send({ changes });
      expect(preview.body.data.counts).toMatchObject({ waitingReviews: 1, pauseRequests: 1 });
      expect(preview.body.data.sentences[0]).toBe(`Changing Ads Calendar reviewers will re-route 1 waiting review and 1 pause request to ${TAG} lead.`);

      const save = await request(app).put(`${BASE}/calendars/ads`).set(as('admin')).send({ changes, reason: 'Marketing Growth Manager on leave' });
      expect(save.status).toBe(200);
      expect(save.body.data.calendar.version).toBe(1);
      // The work follows the resolver at once.
      expect(await canDecideOn(await fresh('lead'), 'ads')).toBe(true);
      expect(await canDecideOn(await fresh('growth'), 'ads')).toBe(false);
      expect(JSON.stringify(await listFeedbackThreads({}, await fresh('growth')))).not.toContain(String(step._id));
      // The in-progress step keeps its owner.
      expect(String((await WorkItem.findById(busy._id).lean()).ownerId)).toBe(String(P.worker._id));
      // One notification for the new reviewer about Ads (other notices may come from earlier limit changes).
      const notes = await Notification.find({ recipient: P.lead._id, type: 'access_rerouted', 'metadata.calendar': 'ads' }).lean();
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toMatch(/1 waiting review, 1 pause request/);
      expect(await Notification.countDocuments({ recipient: P.growth._id, type: 'access_rerouted' })).toBe(0);
      // History has the whole config for restore.
      const hist = await request(app).get(`${BASE}/history`).query({ calendar: 'ads' }).set(as('admin'));
      expect(hist.body.data[0]).toMatchObject({ type: 'workflow_config', subject: 'Ads Calendar', field: 'reviewers', reason: 'Marketing Growth Manager on leave', version: 1, canRestore: true });

      // Plan approvers: the submitted row re-routes too.
      const rows = await request(app).post(`${BASE}/calendars/ads/preview`).set(as('admin')).send({ changes: { planApprovers: { roles: [], userIds: [String(P.lead._id)] } } });
      expect(rows.body.data.counts.planRows).toBe(1);
      await ContentPiece.deleteOne({ _id: row._id });

      // Restore the previous Ads settings (preview, then save with the same checks).
      const restorePreview = await request(app).post(`${BASE}/history/${hist.body.data[0]._id}/restore`).set(as('admin')).send({ preview: true });
      expect(restorePreview.body.data.health.ok).toBe(true);
      const restored = await request(app).post(`${BASE}/history/${hist.body.data[0]._id}/restore`).set(as('admin')).send({ reason: 'Marketing Growth Manager is back' });
      expect(restored.status).toBe(200);
      expect(restored.body.data.calendar.version).toBe(2);
      expect(restored.body.data.calendar.config.reviewers).toEqual({ roles: ['growth_lead'], userIds: [] });
      expect(await canDecideOn(await fresh('growth'), 'ads')).toBe(true);
      expect(await canDecideOn(await fresh('lead'), 'ads')).toBe(false);
      expect(await Notification.countDocuments({ recipient: P.growth._id, type: 'access_rerouted' })).toBe(1);
    });

    it('open Post steps move only when their owner is no longer a poster', async () => {
      const piece = await ContentPiece.create({ planId: new mongoose.Types.ObjectId(), topic: `${TAG} post piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(), status: 'In Progress', calendar: 'sales' });
      const post = await WorkItem.create({ title: `${TAG} sales Post`, workType: 'Reel', stageKey: 'Post', stageOrder: 5, status: 'Not Started', calendar: 'sales', ownerId: P.sm._id, departmentId: new mongoose.Types.ObjectId(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5) });
      // Adding a named poster keeps the SM Manager a poster: nothing moves.
      const keep = await request(app).put(`${BASE}/calendars/sales`).set(as('admin')).send({ reason: 'add', changes: { posters: { roles: ['sm_manager'], userIds: [String(P.sm2._id)] } } });
      expect(keep.body.data.movedPosts).toBe(0);
      expect(String((await WorkItem.findById(post._id).lean()).ownerId)).toBe(String(P.sm._id));
      // An admin never counts as a poster (cannot own Post steps): blocked.
      const adminOnly = await request(app).put(`${BASE}/calendars/sales`).set(as('admin')).send({ reason: 'only admin2', changes: { posters: { roles: [], userIds: [String(P.admin2._id)] } } });
      expect([adminOnly.status, adminOnly.body.error.code]).toEqual([409, 'HEALTH_CHECK_FAILED']);
      // Only the named SM Manager posts now: the open Post step moves to them.
      const move = await request(app).put(`${BASE}/calendars/sales`).set(as('admin')).send({ reason: 'only sm2', changes: { posters: { roles: [], userIds: [String(P.sm2._id)] } } });
      expect(move.status).toBe(200);
      expect(move.body.data.movedPosts).toBe(1);
      expect(String((await WorkItem.findById(post._id).lean()).ownerId)).toBe(String(P.sm2._id));
      expect(await Notification.countDocuments({ recipient: P.sm2._id, type: 'access_rerouted' })).toBe(1);
    });
  });

  describe('Role guide', () => {
    it('lists the eight roles with what they can do, by area', async () => {
      const res = await request(app).get(`${BASE}/role-guide`).set(as('admin'));
      expect(res.body.data).toHaveLength(8);
      expect(res.body.data.find((r) => r.role === 'viewer')?.label).toBe('Viewer');
      const admin = res.body.data.find((r) => r.role === 'admin');
      expect(admin.locked).toBe(true);
      expect(admin.areas.flatMap((a) => a.items)).toContain('Roles & access');
    });
  });
});
