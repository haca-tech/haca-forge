// Review follow-up, commit 3 (low items): who is told when access changes, admins as the final
// fallback in the health check, versioned restore, one write per person change, own rows in the
// plan grid, and a stable default poster.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { Submission } from '../src/modules/submissions/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { setSocketServer } from '../src/lib/socketHub.js';
import { seedReferenceData } from '../src/modules/referenceData/service.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'FUPLOW';
const DOMAIN = '@followup-low-test.com';
const EMAIL = /@followup-low-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();

function fakeIo() {
  const emits = [];
  return {
    emits,
    to(rooms) {
      const list = [].concat(rooms);
      return { emit: (event, payload) => emits.push({ rooms: list, event, payload }) };
    },
    in() {
      return { disconnectSockets: () => {}, socketsLeave: () => {} };
    },
  };
}

describe('Review follow-up: low items', () => {
  const P = {};
  let io;
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  const told = (k) => io.emits.filter((e) => e.event === 'access:changed' && e.rooms.includes(`user:${P[k]._id}`)).length;
  const setCalendar = async (calendar, slots) => {
    await WorkflowConfig.deleteOne({ calendar });
    await WorkflowConfig.create({ calendar, reviewers: { roles: ['creative_lead'], userIds: [] }, planApprovers: { roles: ['creative_lead'], userIds: [] }, posters: { roles: ['sm_manager'], userIds: [] }, fallbackApprovers: { roles: ['admin'], userIds: [] }, ...slots });
    resolver.clearAccessCache();
  };
  async function waitingReview(calendar) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} ${calendar}`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar });
    const s = await WorkItem.create({ title: `${TAG} ${calendar} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'Pending', calendar, ownerId: P.editor._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true });
    await Submission.create({ workItemId: s._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.editor._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/fup' });
    return s;
  }

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const plans = (await CalendarPlan.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ $or: [{ topic: new RegExp(`^${TAG}`) }, { planId: { $in: plans } }] }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: pieces } }).select('_id').lean()).map((s) => s._id);
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ _id: { $in: pieces } });
    await CalendarPlan.deleteMany({ _id: { $in: plans } });
    await Notification.deleteMany({ recipient: { $in: people } });
    await AccessChange.deleteMany({ $or: [{ entityId: { $in: people.map(String) } }, { entityType: 'workflow_config' }] });
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await seedReferenceData();
    await person('admin', 'admin');
    await person('admin2', 'admin');
    await person('cl', 'creative_lead');
    await person('gl', 'growth_lead');
    await person('gl2', 'growth_lead');
    await person('smB', 'sm_manager', { name: `${TAG} B poster` });
    await person('smA', 'sm_manager', { name: `${TAG} A poster` }); // created second, sorts first
    await person('editor', 'executive', { jobRole: 'Video Editor' });
  }, 60000);
  afterAll(cleanup, 60000);
  beforeEach(async () => {
    io = fakeIo();
    setSocketServer(io);
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    for (const k of Object.keys(P)) await Person.collection.updateOne({ _id: P[k]._id }, { $set: { status: 'active', role: P[k].role } });
    await Notification.deleteMany({ type: 'access_rerouted' });
  });

  describe('3. who is told when responsibility moves', () => {
    it('a person change: the fallback who starts acting gets access:changed and one notice about the waiting work', async () => {
      await setCalendar('other', { reviewers: { roles: [], userIds: [String(P.gl2._id)] }, fallbackApprovers: { roles: [], userIds: [String(P.cl._id)] } });
      await waitingReview('other');
      const res = await request(app).patch(`/api/access-admin/people/${P.gl2._id}`).set(as('admin')).send({ status: 'suspended', reason: 'On leave' });
      expect(res.status).toBe(200);
      expect(told('cl')).toBeGreaterThanOrEqual(1); // was: only gl2 was told
      const notes = await Notification.find({ recipient: P.cl._id, type: 'access_rerouted' }).lean();
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toBe('You now decide on Other: 1 waiting review moved to you.');
      expect(told('gl')).toBe(0); // nothing changed for them
    });

    it('when the fallback list has nobody either, the admins are told and notified', async () => {
      await setCalendar('other', { reviewers: { roles: [], userIds: [String(P.gl2._id)] }, fallbackApprovers: { roles: [], userIds: [] } });
      await waitingReview('other');
      const res = await request(app).patch(`/api/access-admin/people/${P.gl2._id}`).set(as('admin')).send({ status: 'suspended', reason: 'On leave' });
      expect(res.status).toBe(200);
      for (const k of ['admin', 'admin2']) {
        expect(told(k), k).toBeGreaterThanOrEqual(1);
        expect(await Notification.countDocuments({ recipient: P[k]._id, type: 'access_rerouted' }), k).toBe(1);
      }
    });

    it('a calendar save: everyone whose calendars changed is told (including people who lose them)', async () => {
      await waitingReview('ads');
      const v = (await request(app).get('/api/access-admin/calendars').set(as('admin'))).body.data.calendars.find((c) => c.calendar === 'ads').version;
      const res = await request(app).put('/api/access-admin/calendars/ads').set(as('admin')).send({ version: v, reason: 'Ads to the lead', changes: { reviewers: { roles: [], userIds: [String(P.cl._id)] } } });
      expect(res.status).toBe(200);
      expect(told('cl')).toBeGreaterThanOrEqual(1);
      expect(told('gl')).toBeGreaterThanOrEqual(1); // lost Ads
      expect(await Notification.countDocuments({ recipient: P.cl._id, type: 'access_rerouted' })).toBe(1);
      expect(await Notification.countDocuments({ recipient: P.gl._id, type: 'access_rerouted' })).toBe(0);
    });
  });

  it('4. the health check counts active admins as the final fallback', async () => {
    const preview = (changes) => request(app).post('/api/access-admin/calendars/other/preview').set(as('admin')).send({ changes });
    const emptyFallback = await preview({ fallbackApprovers: { roles: [], userIds: [] } });
    expect(emptyFallback.body.data.health.ok).toBe(true);
    expect(emptyFallback.body.data.health.warnings.map((w) => w.message)).toContain('Nobody active in the fallback: every active admin covers it.');
    const noReviewers = await preview({ reviewers: { roles: [], userIds: [] }, fallbackApprovers: { roles: [], userIds: [] } });
    expect(noReviewers.body.data.health.ok).toBe(true);
    // Posters still have no fallback.
    expect((await preview({ posters: { roles: [], userIds: [] } })).body.data.health.ok).toBe(false);
    // And a person change that only the admins would cover is no longer refused.
    await setCalendar('other', { reviewers: { roles: [], userIds: [String(P.gl2._id)] }, fallbackApprovers: { roles: [], userIds: [String(P.gl._id)] } });
    expect((await request(app).post(`/api/access-admin/people/${P.gl._id}/preview`).set(as('admin')).send({ status: 'suspended' })).body.data.blocked).toBeNull();
  });

  it('5. restore carries the preview\'s version: 409 when the calendar changed since', async () => {
    const put = async (changes, reason) => {
      const v = (await request(app).get('/api/access-admin/calendars').set(as('admin'))).body.data.calendars.find((c) => c.calendar === 'sales').version;
      return request(app).put('/api/access-admin/calendars/sales').set(as('admin')).send({ version: v, reason, changes });
    };
    expect((await put({ reviewers: { roles: [], userIds: [String(P.cl._id)] } }, 'first change')).status).toBe(200);
    const entry = (await request(app).get('/api/access-admin/history').query({ calendar: 'sales' }).set(as('admin'))).body.data[0];
    const pre = await request(app).post(`/api/access-admin/history/${entry._id}/restore`).set(as('admin')).send({ preview: true });
    expect(pre.body.data.version).toBe(1);
    // Someone saves the calendar between the preview and the confirm.
    expect((await put({ posters: { roles: [], userIds: [String(P.smA._id)] } }, 'second change')).status).toBe(200);
    const stale = await request(app).post(`/api/access-admin/history/${entry._id}/restore`).set(as('admin')).send({ reason: 'Undo', version: pre.body.data.version });
    expect([stale.status, stale.body.error.code]).toEqual([409, 'SETTINGS_CHANGED']);
    const fresh = await request(app).post(`/api/access-admin/history/${entry._id}/restore`).set(as('admin')).send({ preview: true });
    expect((await request(app).post(`/api/access-admin/history/${entry._id}/restore`).set(as('admin')).send({ reason: 'Undo', version: fresh.body.data.version })).status).toBe(200);
  });

  describe('6. one write per person change', () => {
    it('a role change that clears a calendar limit, plus other fields, is saved in one write', async () => {
      const lead = await Person.create({ name: `${TAG} limited lead`, email: `limited${DOMAIN}`, role: 'creative_lead', status: 'active', calendarScope: ['ads'] });
      const spy = vi.spyOn(Person.prototype, 'save');
      try {
        const res = await request(app).patch(`/api/team/${lead._id}`).set(as('admin')).send({ role: 'executive', reason: 'Back to production', jobRole: 'Video Editor', workPreferences: ['Edit'] });
        expect(res.status).toBe(200);
        const writes = spy.mock.contexts.filter((doc) => String(doc?._id) === String(lead._id));
        expect(writes).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
      const after = await Person.findById(lead._id).lean();
      expect(after).toMatchObject({ role: 'executive', jobRole: 'Video Editor' });
      expect(after.calendarScope?.length || 0).toBe(0);
      expect(after.workPreferences).toEqual(['Edit']);
    });

    it('a refused role change saves none of the other fields either', async () => {
      const worker = await Person.create({ name: `${TAG} worker`, email: `worker${DOMAIN}`, role: 'executive', status: 'active', jobRole: 'Video Editor' });
      const res = await request(app).patch(`/api/team/${worker._id}`).set(as('admin')).send({ role: 'sm_manager', jobRole: 'Writer' }); // no reason
      expect(res.status).toBe(400);
      expect((await Person.findById(worker._id).lean())).toMatchObject({ role: 'executive', jobRole: 'Video Editor' });
    });

    it('a suspension and the forced sign-out are one write', async () => {
      const worker = await Person.create({ name: `${TAG} leaver`, email: `leaver${DOMAIN}`, role: 'executive', status: 'active', jobRole: 'Video Editor', refreshTokenHash: 'x' });
      const spy = vi.spyOn(Person.prototype, 'save');
      try {
        expect((await request(app).post(`/api/people/${worker._id}/suspend`).set(as('admin')).send({ reason: 'Left' })).status).toBe(200);
        expect(spy.mock.contexts.filter((doc) => String(doc?._id) === String(worker._id))).toHaveLength(1);
      } finally {
        spy.mockRestore();
      }
      const after = await Person.findById(worker._id).select('+refreshTokenHash').lean();
      expect(after.status).toBe('suspended');
      expect(after.refreshTokenHash ?? null).toBeNull();
    });
  });

  it('7. the plan grid marks the rows the viewer added or submitted', async () => {
    const month = '2037-10';
    const saved = await request(app).post('/api/calendar-plans/grid/rows').set(as('admin')).send({ calendar: 'sm', month, rows: [{ clientKey: 'a', cells: { postingDate: `${month}-10`, topic: `${TAG} admin row`, type: 'Static Post', brief: 'Added by the admin.', postingOwnerId: String(P.smA._id) } }] });
    expect(saved.status).toBe(201);
    await CalendarPlan.updateOne({ _id: saved.body.data.plan._id }, { $set: { title: `${TAG} grid plan` } });
    const grid = (k) => request(app).get('/api/calendar-plans/grid').query({ calendar: 'sm', month }).set(as(k));
    expect((await grid('admin')).body.data.rows.map((r) => r.ownRow)).toEqual([true]);
    expect((await grid('cl')).body.data.rows.map((r) => r.ownRow)).toEqual([false]);
  });

  it('M1: the default poster is chosen by name, then id (not insertion order)', async () => {
    await setCalendar('sales', { posters: { roles: [], userIds: [String(P.smB._id), String(P.smA._id)] } });
    const { people, defaultPoster } = await resolver.postersFor({ calendar: 'sales' });
    expect(people.map((p) => p.name)).toEqual([`${TAG} A poster`, `${TAG} B poster`]);
    expect(String(defaultPoster._id)).toBe(String(P.smA._id));
  });
});
