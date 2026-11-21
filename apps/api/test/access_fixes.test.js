// Phase C5 fixes (documented changes):
// 1. Classifying a revision flag on your own step is blocked (403 SELF_DECISION), like every
//    other decision. Someone else's step on the same calendar still works.
// 2. Overdue escalation goes to every active SM Manager of the step's department, or every
//    active SM Manager when the department has none (was: the first one only). Once per due date.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { RevisionFlag } from '../src/modules/feedback/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { executeAutomationRule } from '../src/modules/automation/runner.js';
import * as resolver from '../src/lib/accessResolver.js';

const EMAIL = /@access-fixes-test\.com$/;
const TAG = 'AFIXES';
const DAY = 86400000;

describe('Phase C5 fixes', () => {
  const P = {};
  const dept = new mongoose.Types.ObjectId();
  const emptyDept = new mongoose.Types.ObjectId();
  const token = (u) => jwt.sign({ userId: String(u._id), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@access-fixes-test.com`, role, status: 'active', ...extra }));
  const step = (owner, extra = {}) =>
    WorkItem.create({
      title: `${TAG} ${Math.round(Math.random() * 1e9)}`,
      workType: 'Reel',
      stageKey: 'Edit',
      stageOrder: 3,
      status: 'In Progress',
      calendar: 'sm',
      ownerId: owner._id,
      departmentId: dept,
      deadline: new Date(Date.now() + 3 * DAY),
      reviewRequired: true,
      ...extra,
    });
  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    await RevisionFlag.deleteMany({ workItemId: { $in: steps } });
    await Notification.deleteMany({ $or: [{ recipient: { $in: ids } }, { 'metadata.workItemId': { $in: steps } }] });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await Person.deleteMany({ email: EMAIL });
    resolver.clearAccessCache();
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    await person('admin', 'admin');
    await person('lead', 'creative_lead');
    await person('worker', 'executive', { jobRole: 'Video Editor' });
    await person('sm1', 'sm_manager', { departmentId: dept });
    await person('sm2', 'sm_manager', { departmentId: dept });
  }, 60000);
  afterAll(cleanup, 60000);

  describe('1. No classifying a flag on your own step', () => {
    const flagOn = async (w) =>
      RevisionFlag.create({ workItemId: w._id, ownerId: w.ownerId, revisionsCount: 4, baselineAvg: 1, isFlagged: true, flaggedAt: new Date(), rootCause: null });
    const classify = (who, flag) =>
      request(app).post(`/api/revisions/flags/${flag._id}/classify`).set('Authorization', `Bearer ${token(who)}`).send({ rootCause: 'Brief unclear' });

    it('the admin who owns the step gets 403 SELF_DECISION; nothing is saved', async () => {
      const own = await step(P.admin);
      const flag = await flagOn(own);
      const res = await classify(P.admin, flag);
      expect(res.status).toBe(403);
      expect(res.body.error?.code).toBe('SELF_DECISION');
      expect((await RevisionFlag.findById(flag._id).lean()).rootCause).toBeNull();
    });

    it('the lead can still classify someone else\'s step on their calendar', async () => {
      const flag = await flagOn(await step(P.worker));
      const res = await classify(P.lead, flag);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect((await RevisionFlag.findById(flag._id).lean()).rootCause).toBeTruthy();
    });
  });

  describe('2. Overdue escalation reaches every SM Manager of the department', () => {
    const notes = (w) => Notification.find({ 'metadata.workItemId': w._id, 'metadata.type': 'overdue_manager' }).lean();
    let inDept;
    let noSm;

    beforeAll(async () => {
      const overdue = { deadline: new Date(Date.now() - 2 * DAY), dueDate: new Date(Date.now() - 2 * DAY), unlockedAt: new Date(Date.now() - 5 * DAY) };
      inDept = await step(P.worker, overdue);
      noSm = await step(P.worker, { ...overdue, departmentId: emptyDept });
      await executeAutomationRule('overdue_escalation', null, { force: true });
    });

    it('both SM Managers of the step\'s department are told (was: the first one only)', async () => {
      expect((await notes(inDept)).map((n) => String(n.recipient)).sort()).toEqual([String(P.sm1._id), String(P.sm2._id)].sort());
    });

    it('a department without an SM Manager: every active SM Manager is told', async () => {
      const everySm = (await Person.find({ role: 'sm_manager', status: 'active' }).select('_id').lean()).map((p) => String(p._id)).sort();
      expect((await notes(noSm)).map((n) => String(n.recipient)).sort()).toEqual(everySm);
    });

    it('still once per person per due date', async () => {
      await executeAutomationRule('overdue_escalation', null, { force: true });
      expect(await notes(inDept)).toHaveLength(2);
    });
  });
});
