// Simple workload (step counts) through the API: limits, who sees what, name order, and the
// one owner rule in autofill, import and Recommended Owner.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { Department } from '../src/modules/departments/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { Submission, Rating } from '../src/modules/submissions/model.js';
import { PersonChangeAudit } from '../src/modules/team/audit.model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { recommendAssignee } from '../src/modules/assignment/service.js';
import { autofillRowPlan, buildAutofillContext } from '../src/modules/calendar/autofill.service.js';
import { validateImportRows } from '../src/modules/calendar/import.service.js';

const EMAIL = /@workload-test\.com$/;
const TAG = 'WLT';
const DAY = 86400000;
// "!" sorts before digits and letters, so these people win name tie-breaks in a shared test DB.
const NAME = (k) => `!${TAG} ${k}`;

describe('Simple workload API', () => {
  const P = {};
  const tokens = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (who) => ({
    get: (url, q) => request(app).get(url).query(q || {}).set('Authorization', `Bearer ${tokens[who]}`),
    put: (url, body) => request(app).put(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url, body) => request(app).patch(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });
  let dept;

  async function step(owner, { stageKey = 'Edit', status = 'Not Started', dueIn = 2, isLocked = false, extra = {} } = {}) {
    return WorkItem.create({
      title: `${TAG} ${owner} ${stageKey} ${Math.round(Math.random() * 1e9)}`,
      workType: 'Reel',
      stageKey,
      stageOrder: 1,
      status,
      isLocked,
      reviewRequired: true,
      calendar: 'sm',
      ownerId: P[owner]._id,
      departmentId: dept._id,
      deadline: new Date(Date.now() + dueIn * DAY),
      dueDate: new Date(Date.now() + dueIn * DAY),
      ...extra,
    });
  }
  const version = (w, v, status) => Submission.create({ workItemId: w._id, stageKey: w.stageKey, version: v, kind: 'link', status, submittedById: w.ownerId, submittedAt: new Date(), linkUrl: `https://drive.google.com/file/d/${TAG}-${v}` });

  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG} `) }).select('_id').lean()).map((w) => w._id);
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await PersonChangeAudit.deleteMany({ personId: { $in: ids } });
    await ActivityEvent.deleteMany({ entityId: { $in: ids } });
    await Person.deleteMany({ email: EMAIL });
    await Department.deleteMany({ code: 'wlt_dept' });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    dept = await Department.create({ name: `${TAG} Department`, code: 'wlt_dept' });
    for (const [key, role, extra] of [
      ['admin', 'admin'],
      ['creativeLead', 'creative_lead'],
      ['growthLead', 'growth_lead'],
      ['creativeHead', 'creative_head'],
      ['sm', 'sm_manager', { jobRole: 'Social Media Manager', departmentId: dept._id }],
      ['edA', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'], departmentId: dept._id }],
      ['edB', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'], departmentId: dept._id }],
      ['writer', 'executive', { jobRole: 'Writer', workPreferences: ['Script', 'Content'], departmentId: dept._id }],
    ]) {
      P[key] = await Person.create({ name: NAME(key), email: `${key.toLowerCase()}@workload-test.com`, role, status: 'active', ...(extra || {}) });
      tokens[key] = make(P[key]);
    }
  }, 60000);
  afterAll(cleanup, 60000);

  describe('active-step limit', () => {
    it.each(['admin', 'creativeLead', 'growthLead'])('%s can change a limit', async (who) => {
      const res = await as(who).put(`/api/workload/${P.writer._id}/limit`, { limit: 6 });
      expect(res.status).toBe(200);
      expect(res.body.data.limit).toBe(6);
      expect((await Person.findById(P.writer._id).lean()).activeStepLimit).toBe(6);
      await Person.updateOne({ _id: P.writer._id }, { $unset: { activeStepLimit: 1 } });
    });

    it.each(['sm', 'edA', 'creativeHead'])('%s cannot (403, unchanged)', async (who) => {
      const res = await as(who).put(`/api/workload/${P.writer._id}/limit`, { limit: 9 });
      expect(res.status).toBe(403);
      expect((await Person.findById(P.writer._id).lean()).activeStepLimit).toBeUndefined();
    });

    it('only whole numbers from 1 to 20; the change is audited', async () => {
      for (const bad of [0, 21, 2.5, 'x']) expect((await as('admin').put(`/api/workload/${P.writer._id}/limit`, { limit: bad })).status).toBe(400);
      expect((await as('creativeLead').put(`/api/workload/${P.writer._id}/limit`, { limit: 3 })).status).toBe(200);
      expect(await PersonChangeAudit.countDocuments({ personId: P.writer._id, field: 'activeStepLimit', newValue: 3 })).toBe(1);
      await Person.updateOne({ _id: P.writer._id }, { $unset: { activeStepLimit: 1 } });
    });

    it('the person edit (PATCH /api/team/:id) takes it from a lead, not from a worker', async () => {
      expect((await as('growthLead').patch(`/api/team/${P.writer._id}`, { activeStepLimit: 5 })).status).toBe(200);
      expect((await Person.findById(P.writer._id).lean()).activeStepLimit).toBe(5);
      expect((await as('edA').patch(`/api/team/${P.writer._id}`, { activeStepLimit: 9 })).status).toBe(403);
      expect((await as('admin').patch(`/api/team/${P.writer._id}`, { activeStepLimit: 50 })).status).toBe(400);
      await Person.updateOne({ _id: P.writer._id }, { $unset: { activeStepLimit: 1 } });
    });
  });

  describe('who sees what, and in what order', () => {
    it('a worker sees only their own workload', async () => {
      const res = await as('edA').get('/api/workload');
      expect(res.status).toBe(200);
      expect(res.body.data.people.map((p) => p._id)).toEqual([String(P.edA._id)]);
      expect(res.body.data.canEditLimit).toBe(false);
      expect((res.body.data.members || []).every((m) => String(m._id) === String(P.edA._id))).toBe(true);
      // Another person's steps: not found.
      expect((await as('edA').get(`/api/workload/${P.edB._id}/steps`)).status).toBe(404);
      expect((await as('edA').get(`/api/workload/${P.edA._id}/steps`)).status).toBe(200);
    });

    it('leads see everyone, sorted by name, never by load', async () => {
      await step('edB', { dueIn: 1 });
      await step('edB', { dueIn: 2 });
      await step('edB', { dueIn: 3 });
      const res = await as('creativeLead').get('/api/workload');
      expect(res.status).toBe(200);
      const names = res.body.data.people.map((p) => p.name);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
      expect(res.body.data.canEditLimit).toBe(true);
      const edB = res.body.data.people.find((p) => p._id === String(P.edB._id));
      expect(edB).toMatchObject({ dueThisWeek: 3, inProgress: 0, limit: 4, band: 'Busy' });
      expect(Object.keys(edB)).not.toEqual(expect.arrayContaining(['workloadPct', 'loadPct', 'allocatedHours']));
      // Filters: band, job role, name.
      const busy = await as('creativeLead').get('/api/workload', { band: 'Busy', q: TAG });
      expect(busy.body.data.people.map((p) => p._id)).toEqual([String(P.edB._id)]);
      const writers = await as('creativeLead').get('/api/workload', { jobRole: 'Writer', q: TAG });
      expect(writers.body.data.people.map((p) => p._id)).toEqual([String(P.writer._id)]);
      // The legacy department lists are by name too.
      for (const d of res.body.data.departments) {
        const n = d.members.map((m) => m.name);
        expect(n).toEqual([...n].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })));
      }
    });

    it('the directory ignores a sort by load', async () => {
      const byLoad = await as('admin').get('/api/team', { sortBy: 'load', sortDir: 'desc', search: TAG });
      const byName = await as('admin').get('/api/team', { sortBy: 'name', sortDir: 'desc', search: TAG });
      expect(byLoad.status).toBe(200);
      expect(byLoad.body.data.items.map((i) => i._id)).toEqual(byName.body.data.items.map((i) => i._id));
      expect(byLoad.body.data.items.find((i) => i._id === String(P.edB._id)).workload).toMatchObject({ dueThisWeek: 3, band: 'Busy' });
    });

    it('the side panel lists open, unlocked steps by due date; waiting for review is not counted', async () => {
      const waiting = await step('writer', { stageKey: 'Script', status: 'Feedback', dueIn: 1 });
      await version(waiting, 1, 'submitted');
      const sentBack = await step('writer', { stageKey: 'Content', status: 'Feedback', dueIn: 2, extra: { revisions: 1 } });
      await version(sentBack, 1, 'changes_requested');
      await step('writer', { stageKey: 'Content', status: 'Not Started', dueIn: 3, isLocked: true });
      const res = await as('creativeLead').get(`/api/workload/${P.writer._id}/steps`);
      expect(res.status).toBe(200);
      expect(res.body.data.workload).toMatchObject({ dueThisWeek: 1, band: 'Available' });
      expect(res.body.data.steps.map((s) => s._id)).toEqual([String(waiting._id), String(sentBack._id)]);
      expect(res.body.data.steps[1]).toMatchObject({ status: 'Feedback', latestVersionStatus: 'changes_requested' });
    });
  });

  describe('Recommended Owner', () => {
    it('team members come first, even when busier', async () => {
      // Department path: edA (worker, 0 due) vs sm (no steps): the worker still comes first.
      await step('edA', { dueIn: 1 });
      const rec = await recommendAssignee({ departmentId: String(dept._id) }, P.admin);
      expect(['executive']).toContain(rec.recommendedPerson.role);
      expect(rec.rationale).toMatch(/suitable skill/);
      expect(rec.rationale).not.toMatch(/%|\bh\b|hours/);
    });

    it('Post goes to an SM Manager only', async () => {
      const rec = await recommendAssignee({ stageKey: 'Post' }, P.admin);
      expect(rec.recommendedPerson.role).toBe('sm_manager');
      expect(rec.candidatePool.every((c) => c.person.role === 'sm_manager')).toBe(true);
    });

    it('when everyone is over the limit it still names someone, with the warning', async () => {
      const ctx = await buildAutofillContext();
      const ours = ctx.candidates.filter((c) => [String(P.edA._id), String(P.edB._id)].includes(c.id));
      for (const k of ['edA', 'edB']) await Person.updateOne({ _id: P[k]._id }, { $set: { activeStepLimit: 1 } });
      const plan = await autofillRowPlan({ type: 'Reel', postingDate: new Date(Date.now() + 4 * DAY), needsScript: false, needsShoot: false, context: { candidates: ours.map((c) => ({ ...c, activeStepLimit: 1 })) } });
      const edit = plan.stages.find((s) => s.stageKey === 'Edit');
      expect(edit.ownerId).toBeTruthy();
      expect(edit.overLimit).toBe(true);
      expect(edit.warning).toMatch(/^Over limit: !WLT has \d+ due this week\.$/);
      for (const k of ['edA', 'edB']) await Person.updateOne({ _id: P[k]._id }, { $unset: { activeStepLimit: 1 } });
    });

    it('revision counts and ratings change nothing', async () => {
      const before = await recommendAssignee({ stageKey: 'Edit', deadline: new Date(Date.now() + 2 * DAY) }, P.admin);
      const winner = Object.keys(P).find((k) => String(P[k]._id) === String(before.recommendedPerson._id));
      const done = await step(winner, { status: 'Approved', extra: { revisions: 7 } });
      await Rating.create({ submissionId: new mongoose.Types.ObjectId(), workItemId: done._id, stageKey: 'Edit', workerId: P[winner]._id, raterId: P.creativeLead._id, score: 1 });
      const after = await recommendAssignee({ stageKey: 'Edit', deadline: new Date(Date.now() + 2 * DAY) }, P.admin);
      expect(String(after.recommendedPerson._id)).toBe(String(before.recommendedPerson._id));
    });
  });

  describe('autofill', () => {
    it('spreads work across a run', async () => {
      const ctx = await buildAutofillContext();
      // Two fresh editors with nothing due in the run's window (far ahead).
      const ours = ctx.candidates.filter((c) => [String(P.edA._id), String(P.edB._id)].includes(c.id));
      const rows = [];
      const owners = [];
      for (let i = 0; i < 4; i++) {
        const plan = await autofillRowPlan({ type: 'Reel', postingDate: new Date(Date.now() + (60 + i) * DAY), needsScript: false, needsShoot: false, currentPlanRows: rows, context: { candidates: ours } });
        const edit = plan.stages.find((s) => s.stageKey === 'Edit');
        owners.push(edit.ownerId);
        expect(edit.reason).toMatch(/^Fewest due in the week to /);
        rows.push({ stagePlan: plan.stages });
      }
      expect(owners).toEqual([P.edA, P.edB, P.edA, P.edB].map((p) => String(p._id)));
    });

    it('autofill, import and Recommended Owner pick the same person for the same input', async () => {
      const postingDate = new Date(Date.now() + 5 * DAY);
      const plan = await autofillRowPlan({ type: 'Reel', postingDate, needsScript: false, needsShoot: false });
      const edit = plan.stages.find((s) => s.stageKey === 'Edit');
      const rec = await recommendAssignee({ stageKey: 'Edit', deadline: edit.dueDate }, P.admin);
      const imported = await validateImportRows([
        { topic: `${TAG} same person`, postingDate: postingDate.toISOString().slice(0, 10), contentType: 'Reel', needsScript: false, needsShoot: false, sourceVideoLink: 'https://drive.google.com/file/d/wlt-source', brief: 'x' },
      ]);
      const row = imported.rows[0];
      expect(row.errors).toEqual([]);
      const importEdit = row.stagePlan.find((s) => s.stageKey === 'Edit');
      expect(String(rec.recommendedPerson._id)).toBe(edit.ownerId);
      expect(importEdit.ownerId).toBe(edit.ownerId);
    });
  });
});
