// Final access fix, commit 2 (M1–M10): routing and races.
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
import { Submission, Rating } from '../src/modules/submissions/model.js';
import { MediaItem, MediaMessage } from '../src/modules/media/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { seedReferenceData } from '../src/modules/referenceData/service.js';
import { reviewClip, toggleMessageDone } from '../src/modules/media/service.js';
import { editRating } from '../src/modules/submissions/service.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'FIXM';
const DOMAIN = '@final-fix-m-test.com';
const EMAIL = /@final-fix-m-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();

describe('Final fix M1–M10: routing and races', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  const fresh = (k) => Person.findById(P[k]._id);
  let planSeq = 0;

  async function plan(calendar, createdBy, rows = []) {
    planSeq += 1;
    const p = await CalendarPlan.create({ code: `${TAG}-${planSeq}-${Date.now()}`, title: `${TAG} plan ${planSeq}`, calendar, periodStart: new Date('2037-03-01'), periodEnd: new Date('2037-03-31'), createdById: P[createdBy]._id });
    const made = [];
    for (const r of rows) {
      made.push(await ContentPiece.create({ planId: p._id, topic: `${TAG} ${r.topic || 'row'}`, contentType: 'Static Post', type: 'Static Post', pipeline: 'design', postingDate: new Date('2037-03-20'), status: 'Not Started', calendar, rowStatus: r.rowStatus || 'submitted', createdById: P[r.createdBy || createdBy]._id, submittedById: r.submittedBy ? P[r.submittedBy]._id : null, brief: 'Brief.' }));
    }
    return { plan: p, rows: made };
  }
  const review = (k, planId, body) => request(app).post(`/api/calendar-plans/${planId}/review`).set(as(k)).send(body);
  const setConfig = async (calendar, slots) => {
    await WorkflowConfig.deleteOne({ calendar });
    await WorkflowConfig.create({ calendar, reviewers: { roles: ['creative_lead'], userIds: [] }, planApprovers: { roles: ['creative_lead'], userIds: [] }, posters: { roles: ['sm_manager'], userIds: [] }, fallbackApprovers: { roles: ['admin'], userIds: [] }, ...slots });
    resolver.clearAccessCache();
  };
  async function step(calendar, owner, extra = {}) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece ${calendar}`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar });
    return WorkItem.create({ title: `${TAG} ${calendar} ${extra.stageKey || 'Edit'}`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', calendar, ownerId: P[owner]._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), ...extra });
  }

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    const clips = (await MediaItem.find({ stageItemId: { $in: steps } }).select('_id').lean()).map((c) => c._id);
    await MediaMessage.deleteMany({ mediaItemId: { $in: clips } });
    await MediaItem.deleteMany({ _id: { $in: clips } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    const plans = (await CalendarPlan.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    await WorkItem.deleteMany({ calendarPlanId: { $in: plans } });
    await ContentPiece.deleteMany({ $or: [{ planId: { $in: plans } }, { topic: new RegExp(`^${TAG}`) }] });
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
    await person('cl2', 'creative_lead');
    await person('gl', 'growth_lead');
    await person('smLimited', 'sm_manager', { calendarScope: ['sales'] });
    await person('sm', 'sm_manager');
    await person('worker', 'executive', { jobRole: 'Video Editor' });
    await person('worker2', 'executive', { jobRole: 'Video Editor' });
    await person('invited', 'executive', { status: 'invited', jobRole: 'Video Editor' });
    await person('away', 'executive', { status: 'suspended', jobRole: 'Video Editor' });
  }, 60000);
  afterAll(cleanup, 60000);
  beforeEach(async () => {
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
  });

  it('M1: the default poster respects calendar limits', async () => {
    // Only the two test SM Managers post on SM: the one limited to Sales is never picked there.
    await setConfig('sm', { posters: { roles: [], userIds: [String(P.smLimited._id), String(P.sm._id)] } });
    const { people, defaultPoster } = await resolver.postersFor({ calendar: 'sm' });
    expect(people.map((p) => String(p._id))).toEqual([String(P.sm._id)]);
    expect(String(defaultPoster._id)).toBe(String(P.sm._id));
    await setConfig('sales', { posters: { roles: [], userIds: [String(P.smLimited._id)] } });
    expect(String((await resolver.postersFor({ calendar: 'sales' })).defaultPoster._id)).toBe(String(P.smLimited._id));
  });

  it('M2: a row cannot move to another calendar than its plan (400); approval follows the plan', async () => {
    const { plan: p, rows } = await plan('sm', 'sm', [{ topic: 'm2', rowStatus: 'draft' }]);
    const res = await request(app).patch(`/api/calendar-plans/${p._id}/rows/${rows[0]._id}`).set(as('sm')).send({ calendar: 'ads' });
    expect([res.status, res.body.error?.code, res.body.error?.message]).toEqual([400, 'ROW_CALENDAR_CHANGE', 'Move the whole plan to change calendar']);
    expect((await ContentPiece.findById(rows[0]._id).lean()).calendar).toBe('sm');
    // The same calendar is fine.
    expect((await request(app).patch(`/api/calendar-plans/${p._id}/rows/${rows[0]._id}`).set(as('sm')).send({ calendar: 'sm', topic: `${TAG} m2 renamed` })).status).toBe(200);
  });

  describe('M3: only waiting rows are decided, once', () => {
    it('draft rows are never approved; approve_all with nothing waiting is 409', async () => {
      const { plan: p, rows } = await plan('sm', 'sm', [{ topic: 'draft', rowStatus: 'draft' }]);
      const all = await review('cl', p._id, { action: 'approve_all' });
      expect([all.status, all.body.error?.code]).toEqual([409, 'NOTHING_WAITING']);
      const sel = await review('cl', p._id, { action: 'approve_selected', approvedRowIds: [String(rows[0]._id)] });
      expect([sel.status, sel.body.error?.code]).toEqual([409, 'ROW_NOT_SUBMITTED']);
      expect((await ContentPiece.findById(rows[0]._id).lean()).rowStatus).toBe('draft');
    });

    it('two decisions on one row at the same time: one wins, the other gets 409', async () => {
      const { plan: p, rows } = await plan('sm', 'sm', [{ topic: 'race' }]);
      const rowId = String(rows[0]._id);
      const [a, b] = await Promise.all([
        review('cl', p._id, { action: 'approve_selected', approvedRowIds: [rowId] }),
        review('cl2', p._id, { action: 'request_changes', changes: [{ rowId, comment: 'Change the hook.' }] }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(['ROW_ALREADY_DECIDED', 'ROW_NOT_SUBMITTED']).toContain(loser.body.error.code);
      const row = await ContentPiece.findById(rowId).lean();
      expect(row.rowStatus).toBe(a.status === 200 ? 'approved' : 'changes_requested');
      // Steps exist only if the approval won, and only once.
      const stepsMade = await WorkItem.countDocuments({ contentPieceId: rowId });
      expect(stepsMade > 0).toBe(a.status === 200);
    });

    it('two approvals of one row at the same time: exactly one approves it and its steps are made once', async () => {
      const { plan: p, rows } = await plan('sm', 'sm', [{ topic: 'double' }]);
      const rowId = String(rows[0]._id);
      const res = await Promise.all([
        review('cl', p._id, { action: 'approve_selected', approvedRowIds: [rowId] }),
        review('cl2', p._id, { action: 'approve_selected', approvedRowIds: [rowId] }),
      ]);
      expect(res.map((r) => r.status).sort()).toEqual([200, 409]);
      const stages = await WorkItem.find({ contentPieceId: rowId }).select('stageKey').lean();
      expect(stages.length).toBe(new Set(stages.map((s) => s.stageKey)).size);
    });
  });

  it('M4: nobody decides on a plan they made, a row they added, or a row they submitted', async () => {
    // The SM Manager's plan; the admin added one row and submitted another.
    const { plan: p, rows } = await plan('sm', 'sm', [
      { topic: 'added by admin', createdBy: 'admin' },
      { topic: 'submitted by admin', submittedBy: 'admin' },
      { topic: 'plain' },
    ]);
    for (const r of rows.slice(0, 2)) {
      const res = await review('admin', p._id, { action: 'approve_selected', approvedRowIds: [String(r._id)] });
      expect([res.status, res.body.error?.code]).toEqual([403, 'SELF_DECISION']);
    }
    const all = await review('admin', p._id, { action: 'approve_all' });
    expect([all.status, all.body.error?.code]).toEqual([403, 'SELF_DECISION']);
    const sendBack = await review('admin', p._id, { action: 'request_changes_all', message: 'Again.' });
    expect([sendBack.status, sendBack.body.error?.code]).toEqual([403, 'SELF_DECISION']);
    // The plain row is fine for the admin; the others for another approver.
    expect((await review('admin', p._id, { action: 'approve_selected', approvedRowIds: [String(rows[2]._id)] })).status).toBe(200);
    expect((await review('admin2', p._id, { action: 'approve_selected', approvedRowIds: rows.slice(0, 2).map((r) => String(r._id)) })).status).toBe(200);
    // Plan creator: refused as before.
    const own = await plan('sm', 'admin', [{ topic: 'admin plan', createdBy: 'sm' }]);
    expect((await review('admin', own.plan._id, { action: 'approve_all' })).status).toBe(403);
  });

  it('M5: clip review and reopening clip feedback are never on your own step', async () => {
    const own = await step('sm', 'admin', { stageKey: 'Shoot' });
    const clip = await MediaItem.create({ stageItemId: own._id, url: 'https://drive.google.com/file/d/clip', title: `${TAG} clip`, type: 'video', uploadedById: P.admin._id });
    await expect(reviewClip(clip._id, { action: 'approve' }, await fresh('admin'))).rejects.toMatchObject({ statusCode: 403, code: 'SELF_DECISION' });
    const msg = await MediaMessage.create({ mediaItemId: clip._id, authorId: P.cl._id, type: 'text', text: 'Fix the light', doneAt: new Date() });
    await expect(toggleMessageDone(clip._id, msg._id, false, await fresh('admin'))).rejects.toMatchObject({ statusCode: 403 });
    // Another reviewer of the calendar can.
    await expect(toggleMessageDone(clip._id, msg._id, false, await fresh('cl'))).resolves.toBeTruthy();
  });

  it('M6: rating edits are refused on your own work and need review on that calendar now', async () => {
    const ownStep = await step('sm', 'admin');
    const ownRating = await Rating.create({ workItemId: ownStep._id, workerId: P.admin._id, raterId: P.admin2._id, score: 4, feedback: 'ok', stageKey: 'Edit', submissionId: oid() });
    await expect(editRating(ownRating._id, { score: 5, reason: 'mine' }, await fresh('admin'))).rejects.toMatchObject({ statusCode: 403, code: 'SELF_DECISION' });

    const adsStep = await step('ads', 'worker');
    const r = await Rating.create({ workItemId: adsStep._id, workerId: P.worker._id, raterId: P.gl._id, score: 3, feedback: 'ok', stageKey: 'Edit', submissionId: oid() });
    await expect(editRating(r._id, { score: 4, reason: 'Second look' }, await fresh('gl'))).resolves.toBeTruthy();
    // Ads reviews move to the Creative Manager: the Marketing Growth Manager can no longer change the rating.
    await setConfig('ads', { reviewers: { roles: ['creative_lead'], userIds: [] } });
    await expect(editRating(r._id, { score: 5, reason: 'Again' }, await fresh('gl'))).rejects.toMatchObject({ statusCode: 403, code: 'WRONG_CALENDAR' });
  });

  describe('M7: settings saves are versioned', () => {
    const put = (version, reason) =>
      request(app).put('/api/access-admin/calendars/other').set(as('admin')).send({ version, reason, changes: { reviewers: { roles: ['creative_lead'], userIds: [String(P.gl._id)] } } });

    it('a stale version is refused with "Settings changed — reload"', async () => {
      const first = await put(0, 'first');
      expect(first.status).toBe(200);
      expect(first.body.data.calendar.version).toBe(1);
      const stale = await request(app).put('/api/access-admin/calendars/other').set(as('admin2')).send({ version: 0, reason: 'stale', changes: { posters: { roles: ['sm_manager'], userIds: [String(P.sm._id)] } } });
      expect([stale.status, stale.body.error.code, stale.body.error.message]).toEqual([409, 'SETTINGS_CHANGED', 'Settings changed — reload']);
    });

    it('two saves at the same time: one wins, the other gets 409, history versions stay unique', async () => {
      await AccessChange.deleteMany({ entityType: 'workflow_config', entityId: 'other' }); // the stored config was reset
      const results = await Promise.all([
        request(app).put('/api/access-admin/calendars/other').set(as('admin')).send({ version: 0, reason: 'Save A', changes: { reviewers: { roles: ['creative_lead'], userIds: [String(P.gl._id)] } } }),
        request(app).put('/api/access-admin/calendars/other').set(as('admin2')).send({ version: 0, reason: 'Save B', changes: { posters: { roles: ['sm_manager'], userIds: [String(P.sm._id)] } } }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const next = await request(app).put('/api/access-admin/calendars/other').set(as('admin')).send({ version: 1, reason: 'Save C', changes: { planApprovers: { roles: ['creative_lead'], userIds: [String(P.gl._id)] } } });
      expect(next.body.data.calendar.version).toBe(2);
      const versions = (await AccessChange.find({ entityType: 'workflow_config', entityId: 'other' }).lean()).map((h) => [h.version, h.note]);
      const byVersion = new Map();
      for (const [v, note] of versions) byVersion.set(v, new Set([...(byVersion.get(v) || []), note]));
      expect([...byVersion.values()].every((notes) => notes.size === 1)).toBe(true); // one save per version
      expect([...byVersion.keys()].sort()).toEqual([1, 2]);
    });
  });

  it('M8: a read that started before a save cannot refill the cache with the old settings', async () => {
    await setConfig('other', { reviewers: { roles: ['creative_lead'], userIds: [] } });
    const real = WorkflowConfig.findOne.bind(WorkflowConfig);
    let release;
    const gate = new Promise((r) => (release = r));
    const spy = vi.spyOn(WorkflowConfig, 'findOne').mockImplementationOnce((...args) => {
      const q = real(...args);
      return { lean: async () => { const old = await q.lean(); await gate; return old; } };
    });
    try {
      const slow = resolver.getWorkflowConfig('other'); // reads the old settings, then waits
      await new Promise((r) => setTimeout(r, 50));
      // The save lands while that read is still in flight.
      await WorkflowConfig.updateOne({ calendar: 'other' }, { $set: { reviewers: { roles: ['growth_lead'], userIds: [] }, version: 2 } });
      resolver.clearAccessCache();
      release();
      expect((await slow).reviewers.roles).toEqual(['creative_lead']); // that caller saw the old value
      // ...but the cache was not filled with it: the next read gets the saved settings.
      expect((await resolver.getWorkflowConfig('other')).reviewers.roles).toEqual(['growth_lead']);
    } finally {
      spy.mockRestore();
    }
  });

  describe('M9: team routes', () => {
    it('role and status changes need user.manage, a reason, and the admin page guards; leads keep operational edits', async () => {
      // Guard: a worker is refused at the route.
      expect((await request(app).patch(`/api/team/${P.worker2._id}`).set(as('worker')).send({ jobRole: 'Designer' })).status).toBe(403);
      expect((await request(app).post(`/api/team/${P.worker2._id}/status`).set(as('cl')).send({ reason: 'x y z' })).status).toBe(403);
      // A lead still edits a worker's operational fields, but not the role.
      expect((await request(app).patch(`/api/team/${P.worker2._id}`).set(as('cl')).send({ activeStepLimit: 4 })).status).toBe(200);
      expect((await request(app).patch(`/api/team/${P.worker2._id}`).set(as('cl')).send({ role: 'sm_manager' })).status).toBe(403);
      // Admin: a reason is required; nothing else is saved without one.
      const noReason = await request(app).patch(`/api/team/${P.worker2._id}`).set(as('admin')).send({ role: 'sm_manager', jobRole: 'Designer' });
      expect([noReason.status, noReason.body.error.code]).toEqual([400, 'REASON_REQUIRED']);
      expect((await Person.findById(P.worker2._id).lean()).jobRole).toBe('Video Editor');
      // Self-demotion is refused.
      const self = await request(app).patch(`/api/team/${P.admin._id}`).set(as('admin')).send({ role: 'creative_lead', reason: 'try it' });
      expect([self.status, self.body.error.code]).toEqual([403, 'SELF_DEMOTE']);
      // With a reason it works and is in the History.
      expect((await request(app).patch(`/api/team/${P.worker2._id}`).set(as('admin')).send({ role: 'sm_manager', reason: 'Now posts' })).status).toBe(200);
      expect(await AccessChange.countDocuments({ entityId: String(P.worker2._id), field: 'role', note: 'Now posts' })).toBe(1);
      await Person.collection.updateOne({ _id: P.worker2._id }, { $set: { role: 'executive' } });
    });

    it('status: reason required, self-suspend refused, invited never becomes active, calendar health checked', async () => {
      expect((await request(app).post(`/api/team/${P.worker2._id}/status`).set(as('admin')).send({})).status).toBe(400);
      const self = await request(app).post(`/api/team/${P.admin._id}/status`).set(as('admin')).send({ reason: 'try it' });
      expect([self.status, self.body.error.code]).toEqual([403, 'SELF_SUSPEND']);
      const inv = await request(app).post(`/api/team/${P.invited._id}/status`).set(as('admin')).send({ reason: 'Withdraw invite' });
      expect(inv.status).toBe(200);
      expect((await Person.findById(P.invited._id).lean()).status).toBe('suspended');
      // Suspending the only poster of a calendar is refused.
      await setConfig('sales', { posters: { roles: [], userIds: [String(P.smLimited._id)] } });
      const breaks = await request(app).post(`/api/team/${P.smLimited._id}/status`).set(as('admin')).send({ reason: 'Leaving' });
      expect([breaks.status, breaks.body.error.code]).toEqual([409, 'BREAKS_CALENDARS']);
      expect((await Person.findById(P.smLimited._id).lean()).status).toBe('active');
    });
  });

  it('M10: reassigned steps go only to an active person who can own every one of them', async () => {
    const edit = await step('sm', 'worker');
    const post = await step('sales', 'sm', { stageKey: 'Post', stageOrder: 5, status: 'Not Started' });
    const move = (to, ids) => request(app).post(`/api/team/${P[ids.from]._id}/reassign`).set(as('admin')).send({ targetPersonId: String(P[to]._id), workItemIds: ids.steps.map((s) => String(s._id)) });
    let res = await move('away', { from: 'worker', steps: [edit] });
    expect([res.status, res.body.error.code]).toEqual([409, 'TARGET_NOT_ACTIVE']);
    res = await move('sm', { from: 'worker', steps: [edit] }); // an SM Manager cannot own an Edit step
    expect([res.status, res.body.error.code]).toEqual([409, 'TARGET_NOT_ELIGIBLE']);
    res = await move('worker2', { from: 'sm', steps: [post] }); // a worker cannot post
    expect([res.status, res.body.error.code]).toEqual([409, 'TARGET_NOT_ELIGIBLE']);
    await setConfig('sales', { posters: { roles: ['sm_manager'], userIds: [] } });
    const limited = await step('sm', 'sm', { stageKey: 'Post', stageOrder: 5, status: 'Not Started' });
    res = await move('smLimited', { from: 'sm', steps: [limited] }); // limited to Sales: not a poster on SM
    expect([res.status, res.body.error.code]).toEqual([409, 'TARGET_NOT_ELIGIBLE']);
    expect(String((await WorkItem.findById(limited._id).lean()).ownerId)).toBe(String(P.sm._id));
    res = await move('worker2', { from: 'worker', steps: [edit] });
    expect(res.status).toBe(200);
    expect(String((await WorkItem.findById(edit._id).lean()).ownerId)).toBe(String(P.worker2._id));
  });
});
