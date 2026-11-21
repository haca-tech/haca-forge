// Final access fix, commit 1 (H1–H3): nobody-can-act gaps.
// H1 a named non-admin fallback decides when the main reviewer is suspended; admins are the final fallback.
// H2 a calendar without an active poster who can own Post steps is blocked; a Post step with no
//    poster stays unowned and "needs an owner" reaches the posting roles and admins.
// H3 a named reviewer whose role changed is skipped (the fallback takes over), and a person change
//    that would break a calendar is blocked, naming the calendars and settings to fix.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { Submission, Rating } from '../src/modules/submissions/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { seedReferenceData } from '../src/modules/referenceData/service.js';
import { unlockNextStage } from '../src/modules/workItems/transition.service.js';
import { canDecideOn, decisionCalendarFilter } from '../src/modules/workItems/deciders.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'FIXH';
const DOMAIN = '@final-fix-h-test.com';
const EMAIL = /@final-fix-h-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();
const ids = (list) => [...new Set(list.map((p) => String(p._id || p)))].sort();

describe('Final fix H1–H3: somebody can always act', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  const fresh = async (k) => Person.findById(P[k]._id);
  const setStatus = (k, status) => Person.collection.updateOne({ _id: P[k]._id }, { $set: { status } });
  const config = async (calendar, slots) => {
    await WorkflowConfig.deleteOne({ calendar });
    await WorkflowConfig.create({
      calendar,
      reviewers: { roles: ['creative_lead'], userIds: [] },
      planApprovers: { roles: ['creative_lead'], userIds: [] },
      posters: { roles: ['sm_manager'], userIds: [] },
      fallbackApprovers: { roles: ['admin'], userIds: [] },
      ...slots,
    });
    resolver.clearAccessCache();
  };

  async function waiting(calendar) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} ${calendar}`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar });
    const step = await WorkItem.create({
      title: `${TAG} ${calendar} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'Pending', isLocked: false, calendar,
      ownerId: P.worker._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true,
      startedAt: new Date(Date.now() - 36e5), rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 36e5), intervals: [] }],
    });
    const sub = await Submission.create({ workItemId: step._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.worker._id, submittedAt: new Date(), linkUrl: `https://drive.google.com/file/d/${TAG}` });
    return { step, sub };
  }
  const approve = (k, subId) => request(app).post(`/api/submissions/${subId}/approve`).set(as(k)).send({ score: 4, feedback: 'Clean work.', tags: [] });

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG}`) });
    const plans = (await CalendarPlan.find({ createdById: { $in: people } }).select('_id').lean()).map((p) => p._id);
    await WorkItem.deleteMany({ calendarPlanId: { $in: plans } });
    await ContentPiece.deleteMany({ planId: { $in: plans } });
    await CalendarPlan.deleteMany({ _id: { $in: plans } });
    await Notification.deleteMany({ $or: [{ recipient: { $in: people } }, { 'metadata.workItemId': { $in: steps } }] });
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
    await person('cl', 'creative_lead');
    await person('gl', 'growth_lead');
    await person('gl2', 'growth_lead');
    await person('sm', 'sm_manager');
    await person('sm2', 'sm_manager');
    await person('worker', 'executive', { jobRole: 'Video Editor' });
  }, 60000);
  afterAll(cleanup, 60000);
  beforeEach(async () => {
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    for (const k of Object.keys(P)) await Person.collection.updateOne({ _id: P[k]._id }, { $set: { status: 'active', role: P[k].role } });
  });

  describe('H1: the fallback decides', () => {
    it('a named non-admin fallback decides when the main reviewer is suspended, and is notified', async () => {
      // Other calendar: reviewed by gl2 only; the fallback is the Creative Lead by name (no admin role).
      await config('other', { reviewers: { roles: [], userIds: [String(P.gl2._id)] }, fallbackApprovers: { roles: [], userIds: [String(P.cl._id)] } });
      const w = await waiting('other');
      expect(await canDecideOn(await fresh('cl'), 'other')).toBe(false); // gl2 is active: the main list decides

      await setStatus('gl2', 'suspended');
      const { primary, people } = await resolver.reviewersFor({ calendar: 'other' });
      expect(primary).toEqual([]);
      expect(ids(people)).toEqual(ids([P.cl]));
      expect(await canDecideOn(await fresh('cl'), 'other')).toBe(true);
      expect(await decisionCalendarFilter(await fresh('cl'))).toContain('other');
      // The fallback never decides on their own work.
      expect(await canDecideOn(await fresh('cl'), 'other', { ownerId: P.cl._id })).toBe(false);
      // A Creative Lead not in the fallback still cannot.
      expect(await canDecideOn(await fresh('gl'), 'other')).toBe(false);

      const me = await request(app).get('/api/auth/me').set(as('cl'));
      expect(me.body.access?.calendars?.['review.decide'] || me.body.data?.access?.calendars?.['review.decide']).toContain('other');
      expect((await approve('cl', w.sub._id)).status).toBe(200);

      // The notice for a new submission goes to the acting fallback.
      expect(ids(await resolver.recipientsFor('submission.ready', { calendar: 'other' }))).toEqual(ids([P.cl]));
    });

    it('plan approvals: the fallback approves when no plan approver is active', async () => {
      await config('sales', { planApprovers: { roles: [], userIds: [String(P.gl2._id)] }, fallbackApprovers: { roles: [], userIds: [String(P.cl._id)] } });
      await setStatus('gl2', 'suspended');
      expect(await canDecideOn(await fresh('cl'), 'sales', { permission: 'calendar.approve' })).toBe(true);
      expect(ids((await resolver.planApproversFor({ calendar: 'sales' })).people)).toEqual(ids([P.cl]));
    });

    it('admins are the final fallback: notified when the fallback list has nobody active, and always able to decide', async () => {
      await config('other', { reviewers: { roles: [], userIds: [String(P.gl2._id)] }, fallbackApprovers: { roles: [], userIds: [String(P.cl._id)] } });
      await setStatus('gl2', 'suspended');
      await setStatus('cl', 'suspended');
      const { people } = await resolver.reviewersFor({ calendar: 'other' });
      const admins = await Person.find({ role: 'admin', status: 'active' });
      expect(ids(people)).toEqual(ids(admins));
      const w = await waiting('other');
      expect((await approve('admin', w.sub._id)).status).toBe(200);
    });
  });

  describe('H3: people who can no longer act are skipped', () => {
    it('a named reviewer whose role changed is skipped, and the fallback takes over', async () => {
      await config('sales', { reviewers: { roles: [], userIds: [String(P.gl2._id)] } });
      const w = await waiting('sales');
      // The role changes outside the admin page (a direct write): the resolver must not keep them.
      await Person.collection.updateOne({ _id: P.gl2._id }, { $set: { role: 'sm_manager' } });
      const { primary, people } = await resolver.reviewersFor({ calendar: 'sales' });
      expect(primary).toEqual([]);
      expect(ids(people)).toEqual(ids(await Person.find({ role: 'admin', status: 'active' })));
      expect((await approve('gl2', w.sub._id)).status).toBe(403);
      expect((await approve('admin', w.sub._id)).status).toBe(200);
    });

    it('a person change that would break a calendar is blocked, naming the calendars and settings', async () => {
      // Sales posts only through sm2 (named). Suspending or demoting sm2 would leave it with no poster.
      await config('sales', { posters: { roles: [], userIds: [String(P.sm2._id)] } });
      const preview = await request(app).post(`/api/access-admin/people/${P.sm2._id}/preview`).set(as('admin')).send({ status: 'suspended' });
      expect(preview.body.data.blocked).toMatchObject({ code: 'BREAKS_CALENDARS' });
      expect(preview.body.data.blocked.message).toMatch(/Sales Calendar \(Posted by\)/);
      const save = await request(app).patch(`/api/access-admin/people/${P.sm2._id}`).set(as('admin')).send({ status: 'suspended', reason: 'Leaving' });
      expect([save.status, save.body.error.code]).toEqual([409, 'BREAKS_CALENDARS']);
      expect(save.body.error.details.calendars.map((c) => [c.calendar, c.slots])).toEqual([['sales', ['posters']]]);
      expect((await Person.findById(P.sm2._id).lean()).status).toBe('active');

      const demote = await request(app).patch(`/api/access-admin/people/${P.sm2._id}`).set(as('admin')).send({ role: 'executive', reason: 'Moving' });
      expect([demote.status, demote.body.error.code]).toEqual([409, 'BREAKS_CALENDARS']);
      // A limit that excludes Sales breaks it too.
      const limit = await request(app).patch(`/api/access-admin/people/${P.sm2._id}`).set(as('admin')).send({ calendarScope: ['sm'], reason: 'SM only' });
      expect([limit.status, limit.body.error.code]).toEqual([409, 'BREAKS_CALENDARS']);

      // A change that leaves cover (the reviewer gl2 on Sales, with the admin fallback) is allowed.
      await config('sales', { reviewers: { roles: [], userIds: [String(P.gl2._id)] } });
      const ok = await request(app).patch(`/api/access-admin/people/${P.gl2._id}`).set(as('admin')).send({ status: 'suspended', reason: 'Leave' });
      expect(ok.status).toBe(200);
    });
  });

  describe('H2: posters', () => {
    it('the health check blocks a calendar with no active poster who can own Post steps (admin does not count)', async () => {
      const prev = (changes) => request(app).post('/api/access-admin/calendars/sm/preview').set(as('admin')).send({ changes });
      await setStatus('sm2', 'suspended');
      const suspended = await prev({ posters: { roles: [], userIds: [String(P.sm2._id)] } });
      expect(suspended.body.data.health.ok).toBe(false);
      expect(suspended.body.data.health.errors.map((e) => e.slot)).toContain('posters');
      const adminOnly = await prev({ posters: { roles: ['admin'], userIds: [] } });
      expect(adminOnly.body.data.health.ok).toBe(false);
      const save = await request(app).put('/api/access-admin/calendars/sm').set(as('admin')).send({ reason: 'test', changes: { posters: { roles: [], userIds: [String(P.admin._id)] } } });
      expect([save.status, save.body.error.code]).toEqual([409, 'HEALTH_CHECK_FAILED']);
      // The picker never offers admin as a poster.
      const cal = await request(app).get('/api/access-admin/calendars').set(as('admin'));
      expect(cal.body.data.options.posters.roles).toEqual(['sm_manager']);
    });

    it('with no active poster, a new row is kept with its Post step unowned, and "needs an owner" reaches the posting roles and admins', async () => {
      // Stored directly (as an older or hand-edited config would be): Academics posts only through a suspended sm2.
      await config('academics_management', { posters: { roles: [], userIds: [String(P.sm2._id)] } });
      await setStatus('sm2', 'suspended');
      expect((await resolver.postersFor({ calendar: 'academics_management' })).defaultPoster).toBeNull();

      const saved = await request(app).post('/api/calendar-plans/grid/rows').set(as('sm')).send({
        calendar: 'academics_management', month: '2037-02',
        rows: [{ clientKey: 'r', cells: { postingDate: '2037-02-20', topic: `${TAG} unowned post`, type: 'Static Post', brief: 'No poster yet.' } }],
      });
      expect(saved.status).toBe(201);
      const row = await ContentPiece.findById(saved.body.data.results[0].rowId).lean();
      // Not the planner (was: "defaultPoster || user").
      expect(row.postingOwnerId ?? null).toBeNull();

      // A Post step without an owner unlocks: the posting roles and every admin are told.
      const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} post piece`, contentType: 'Static Post', pipeline: 'design', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'academics_management' });
      const design = await WorkItem.create({ title: `${TAG} Design`, workType: 'Static Post', stageKey: 'Design', stageOrder: 1, status: 'Approved', calendar: 'academics_management', ownerId: P.worker._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5) });
      const post = await WorkItem.create({ title: `${TAG} Post`, workType: 'Static Post', stageKey: 'Post', stageOrder: 2, status: 'Not Started', isLocked: true, calendar: 'academics_management', ownerId: null, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 2 * 864e5) });
      await unlockNextStage(design);
      expect((await WorkItem.findById(post._id).lean()).ownerId ?? null).toBeNull();
      const told = (await Notification.find({ type: 'needs_owner', message: new RegExp(`${TAG} Design`) }).select('recipient').lean()).map((n) => String(n.recipient));
      expect(told).toEqual(expect.arrayContaining([String(P.sm._id), String(P.admin._id)]));
      expect(told).not.toContain(String(P.sm2._id)); // suspended
      expect(told).not.toContain(String(P.worker._id));
    });
  });
});
