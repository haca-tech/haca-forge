// Review follow-up, issue 1: plan row decisions on several rows claim every row first, then do the
// follow-ups (steps, timestamps, notices) only for the rows they won; rows lost to a race are
// reported. Approved rows left without steps are repaired on plan load or by the script.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { seedReferenceData } from '../src/modules/referenceData/service.js';
import { planReviewHooks, repairMissingStages, reviewPlan } from '../src/modules/calendar/plan.service.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'BATCHROW';
const DOMAIN = '@batch-row-test.com';
const EMAIL = /@batch-row-test\.com$/;

describe('Issue 1: batch decisions on plan rows', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  let seq = 0;

  async function plan(n, { rowStatus = 'submitted' } = {}) {
    seq += 1;
    const p = await CalendarPlan.create({ code: `${TAG}-${seq}-${Date.now()}`, title: `${TAG} plan ${seq}`, calendar: 'sm', periodStart: new Date('2037-06-01'), periodEnd: new Date('2037-06-30'), createdById: P.sm._id });
    const rows = [];
    for (let i = 1; i <= n; i += 1) {
      rows.push(await ContentPiece.create({ planId: p._id, topic: `${TAG} row ${seq}.${i}`, contentType: 'Static Post', type: 'Static Post', pipeline: 'design', postingDate: new Date(`2037-06-${String(10 + i).padStart(2, '0')}`), status: 'Not Started', calendar: 'sm', rowStatus, createdById: P.sm._id, submittedById: P.sm._id, brief: 'Brief.' }));
    }
    return { plan: p, rows };
  }
  const stepsOf = (row) => WorkItem.find({ contentPieceId: row._id }).select('stageKey').lean();

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const plans = (await CalendarPlan.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ planId: { $in: plans } }).select('_id').lean()).map((p) => p._id);
    await WorkItem.deleteMany({ contentPieceId: { $in: pieces } });
    await ContentPiece.deleteMany({ _id: { $in: pieces } });
    await CalendarPlan.deleteMany({ _id: { $in: plans } });
    await Notification.deleteMany({ recipient: { $in: people } });
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
    await person('cl2', 'creative_lead');
    await person('sm', 'sm_manager');
  }, 60000);
  afterAll(cleanup, 60000);
  afterEach(() => {
    planReviewHooks.afterRead = null;
  });

  /** Between this request's read and its writes, the other lead decides row 2 (a real reviewPlan call). */
  const otherLeadDecidesRow2First = (planId, row2, body) => {
    let done = false;
    planReviewHooks.afterRead = async () => {
      if (done) return;
      done = true;
      planReviewHooks.afterRead = null;
      await reviewPlan(String(planId), body(String(row2._id)), await Person.findById(P.cl2._id));
    };
  };

  it('approve_selected on 3 rows, row 2 lost to a race: rows 1 and 3 get steps and the notice; the response says so', async () => {
    const { plan: p, rows } = await plan(3);
    otherLeadDecidesRow2First(p._id, rows[1], (id) => ({ action: 'approve_selected', approvedRowIds: [id] }));
    const res = await request(app).post(`/api/calendar-plans/${p._id}/review`).set(as('cl')).send({ action: 'approve_selected', approvedRowIds: rows.map((r) => String(r._id)) });
    expect(res.status).toBe(200);
    expect(res.body.data.decision.approved.sort()).toEqual([String(rows[0]._id), String(rows[2]._id)].sort());
    expect(res.body.data.decision.alreadyDecided.map((r) => r.rowId)).toEqual([String(rows[1]._id)]);
    expect(res.body.data.decision.summary).toBe('2 approved, 1 already decided');
    expect(res.body.message).toBe(`2 approved, 1 already decided. "${rows[1].topic}" was already decided by someone else.`);
    // Steps: rows 1 and 3 from this request; row 2 once, from the lead who won it.
    for (const r of rows) {
      const steps = await stepsOf(r);
      expect(steps.length, r.topic).toBeGreaterThan(0);
      expect(new Set(steps.map((s) => s.stageKey)).size, `${r.topic}: no duplicate steps`).toBe(steps.length);
    }
    // Notices to the planner: one per request, each naming only the rows that request won.
    const notes = await Notification.find({ recipient: P.sm._id, 'metadata.planId': p._id, type: 'plan_approved' }).lean();
    const named = notes.map((n) => n.metadata.rowIds.map(String).sort());
    expect(named).toEqual(expect.arrayContaining([[String(rows[1]._id)], [String(rows[0]._id), String(rows[2]._id)].sort()]));
    expect(notes).toHaveLength(2);
    // Every submitted row is decided now: the plan's approval timestamp is set.
    expect((await CalendarPlan.findById(p._id).lean()).approvedAt).toBeTruthy();
  });

  it('request_changes on 3 rows, row 2 lost to a race: rows 1 and 3 go back, row 2 stays approved', async () => {
    const { plan: p, rows } = await plan(3);
    otherLeadDecidesRow2First(p._id, rows[1], (id) => ({ action: 'approve_selected', approvedRowIds: [id] }));
    const res = await request(app).post(`/api/calendar-plans/${p._id}/review`).set(as('cl')).send({ action: 'request_changes', changes: rows.map((r) => ({ rowId: String(r._id), comment: 'Change the hook.' })) });
    expect(res.status).toBe(200);
    expect(res.body.data.decision.summary).toBe('2 sent back, 1 already decided');
    const after = await ContentPiece.find({ _id: { $in: rows.map((r) => r._id) } }).lean();
    const byId = Object.fromEntries(after.map((r) => [String(r._id), r.rowStatus]));
    expect([byId[rows[0]._id], byId[rows[1]._id], byId[rows[2]._id]]).toEqual(['changes_requested', 'approved', 'changes_requested']);
    expect((await stepsOf(rows[0])).length).toBe(0);
  });

  it('a request that wins no row at all is refused with 409 and writes nothing', async () => {
    const { plan: p, rows } = await plan(1);
    otherLeadDecidesRow2First(p._id, rows[0], (id) => ({ action: 'approve_selected', approvedRowIds: [id] }));
    const res = await request(app).post(`/api/calendar-plans/${p._id}/review`).set(as('cl')).send({ action: 'request_changes', changes: [{ rowId: String(rows[0]._id), comment: 'Again.' }] });
    expect([res.status, res.body.error.code]).toEqual([409, 'ROW_ALREADY_DECIDED']);
    expect((await ContentPiece.findById(rows[0]._id).lean()).rowStatus).toBe('approved');
  });

  it('the plan\'s approval timestamp is set when its last submitted row is decided', async () => {
    const { plan: p, rows } = await plan(2);
    await request(app).post(`/api/calendar-plans/${p._id}/review`).set(as('cl')).send({ action: 'approve_selected', approvedRowIds: [String(rows[0]._id)] });
    expect((await CalendarPlan.findById(p._id).lean()).approvedAt ?? null).toBeNull();
    await request(app).post(`/api/calendar-plans/${p._id}/review`).set(as('cl')).send({ action: 'approve_selected', approvedRowIds: [String(rows[1]._id)] });
    expect((await CalendarPlan.findById(p._id).lean()).approvedAt).toBeTruthy();
  });

  describe('repair: approved rows without steps', () => {
    it('the dry run lists them and writes nothing; opening the plan generates their steps', async () => {
      const { plan: p, rows } = await plan(2, { rowStatus: 'approved' }); // approved, steps never generated
      const dry = await repairMissingStages({ planId: p._id, dryRun: true });
      expect(dry).toMatchObject({ found: 2, repaired: 0 });
      expect(dry.rows.map((r) => r.rowId).sort()).toEqual(rows.map((r) => String(r._id)).sort());
      expect(await WorkItem.countDocuments({ contentPieceId: { $in: rows.map((r) => r._id) } })).toBe(0);

      expect((await request(app).get(`/api/calendar-plans/${p._id}`).set(as('sm'))).status).toBe(200);
      for (const r of rows) expect((await stepsOf(r)).length, r.topic).toBeGreaterThan(0);
      expect(await repairMissingStages({ planId: p._id, dryRun: true })).toMatchObject({ found: 0 });
    });

    it('two repairs at once generate each row\'s steps only once', async () => {
      const { rows } = await plan(1, { rowStatus: 'approved' });
      const [a, b] = await Promise.all([repairMissingStages({ planId: rows[0].planId }), repairMissingStages({ planId: rows[0].planId })]);
      expect(a.repaired + b.repaired).toBe(1);
      const steps = await stepsOf(rows[0]);
      expect(steps.length).toBeGreaterThan(0);
      expect(new Set(steps.map((s) => s.stageKey)).size).toBe(steps.length);
    });
  });
});
