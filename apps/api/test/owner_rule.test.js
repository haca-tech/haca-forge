// Review follow-up, issue 2: one owner rule for every path that sets or changes a step's owner:
// the person is active, passes stepEligibility for the step, and for a Post step is a poster on the
// step's calendar. Refused with 400 OWNER_NOT_ELIGIBLE and a clear reason; dropdowns offer only
// eligible people.
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
import { Notification } from '../src/modules/notifications/model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { AssignmentOverride } from '../src/modules/assignment/model.js';
import { seedReferenceData } from '../src/modules/referenceData/service.js';
import { generateStagesForApprovedRow } from '../src/modules/calendar/plan.service.js';
import { ownerProblem } from '../src/modules/workItems/ownerRule.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'OWNRULE';
const DOMAIN = '@owner-rule-test.com';
const EMAIL = /@owner-rule-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();

describe('Issue 2: one owner rule on every owner-change path', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));

  async function step(calendar, stageKey, owner = null, extra = {}) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece ${calendar} ${stageKey}`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 6 * 864e5), status: 'In Progress', calendar });
    const s = await WorkItem.create({ title: `${TAG} ${calendar} ${stageKey}`, workType: 'Reel', stageKey, stageOrder: stageKey === 'Post' ? 4 : 3, status: 'Not Started', calendar, ownerId: owner ? P[owner]._id : null, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), ...extra });
    return { piece, step: s };
  }
  const expectRefused = (res, pattern) => {
    expect([res.status, res.body.error?.code]).toEqual([400, 'OWNER_NOT_ELIGIBLE']);
    expect(res.body.error.message).toMatch(pattern);
  };

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ topic: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const plans = (await CalendarPlan.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const planPieces = (await ContentPiece.find({ planId: { $in: plans } }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: [...pieces, ...planPieces] } }).select('_id').lean()).map((s) => s._id);
    await AssignmentOverride.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ _id: { $in: [...pieces, ...planPieces] } });
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
    await person('sm', 'sm_manager');
    await person('smSales', 'sm_manager', { calendarScope: ['sales'] });
    await person('editor', 'executive', { jobRole: 'Video Editor' });
    await person('designer', 'executive', { jobRole: 'Graphic Designer' });
    await person('away', 'executive', { jobRole: 'Video Editor', status: 'suspended' });
  }, 60000);
  afterAll(cleanup, 60000);
  beforeEach(async () => {
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
  });

  it('the rule itself: active, eligible for the step, a poster on the step\'s calendar for Post', async () => {
    const fresh = async (k) => Person.findById(P[k]._id).lean();
    expect(await ownerProblem(await fresh('away'), { stageKey: 'Edit', calendar: 'sm' })).toMatch(/is suspended/);
    expect(await ownerProblem(await fresh('designer'), { stageKey: 'Edit', calendar: 'sm' })).toMatch(/cannot own Edit steps/);
    expect(await ownerProblem(await fresh('smSales'), { stageKey: 'Post', calendar: 'sm' })).toMatch(/not a poster on SM Calendar/);
    expect(await ownerProblem(await fresh('smSales'), { stageKey: 'Post', calendar: 'sales' })).toBeNull();
    expect(await ownerProblem(await fresh('admin'), { stageKey: 'Post', calendar: 'sm' })).toMatch(/not a poster/);
    expect(await ownerProblem(await fresh('editor'), { stageKey: 'Edit', calendar: 'ads' })).toBeNull();
    expect(await ownerProblem(null, { stageKey: 'Edit' })).toMatch(/does not exist/);
  });

  it('assignment override (POST /api/assignment/override)', async () => {
    const { step: edit } = await step('sm', 'Edit', 'editor');
    const override = (chosen) => request(app).post('/api/assignment/override').set(as('cl')).send({ workItemId: String(edit._id), recommendedPersonId: String(P.editor._id), chosenPersonId: String(P[chosen]._id), reason: 'Owner rule check' });
    expectRefused(await override('away'), /is suspended/);
    expectRefused(await override('designer'), /cannot own Edit steps/);
    const { step: post } = await step('sm', 'Post', 'sm');
    const postOverride = await request(app).post('/api/assignment/override').set(as('cl')).send({ workItemId: String(post._id), recommendedPersonId: String(P.sm._id), chosenPersonId: String(P.smSales._id), reason: 'Owner rule check' });
    expectRefused(postOverride, /not a poster on SM Calendar/);
    expect(String((await WorkItem.findById(post._id).lean()).ownerId)).toBe(String(P.sm._id));
    expect(await AssignmentOverride.countDocuments({ workItemId: { $in: [edit._id, post._id] } })).toBe(0);
    const ok = await request(app).post('/api/assignment/override').set(as('cl')).send({ workItemId: String(edit._id), recommendedPersonId: String(P.designer._id), chosenPersonId: String(P.editor._id), reason: 'Owner rule check' });
    expect(ok.status).toBeLessThan(300);
  });

  it('Tracker assign (POST /api/content-pieces/assign): all or nothing', async () => {
    const { step: edit } = await step('sm', 'Edit');
    const { step: post } = await step('sm', 'Post');
    const res = await request(app).post('/api/content-pieces/assign').set(as('sm')).send({ assignments: [
      { workItemId: String(edit._id), assigneeId: String(P.editor._id) },
      { workItemId: String(post._id), assigneeId: String(P.smSales._id) },
    ] });
    expectRefused(res, /not a poster on SM Calendar/);
    expect((await WorkItem.findById(edit._id).lean()).ownerId ?? null).toBeNull(); // nothing saved
    const ok = await request(app).post('/api/content-pieces/assign').set(as('sm')).send({ assignments: [
      { workItemId: String(edit._id), assigneeId: String(P.editor._id) },
      { workItemId: String(post._id), assigneeId: String(P.sm._id) },
    ] });
    expect(ok.status).toBeLessThan(300);
    expect(String((await WorkItem.findById(post._id).lean()).ownerId)).toBe(String(P.sm._id));
  });

  it('reassign one stage (PATCH /api/content-pieces/:id/reassign)', async () => {
    const { piece, step: post } = await step('ads', 'Post', 'sm');
    const bad = await request(app).patch(`/api/content-pieces/${piece._id}/reassign`).set(as('sm')).send({ stageKey: 'Post', newOwnerId: String(P.smSales._id), overrideReason: 'check' });
    expectRefused(bad, /not a poster on Ads Calendar/);
    expect(String((await WorkItem.findById(post._id).lean()).ownerId)).toBe(String(P.sm._id));
    const { piece: p2 } = await step('ads', 'Edit', 'editor');
    expectRefused(await request(app).patch(`/api/content-pieces/${p2._id}/reassign`).set(as('sm')).send({ stageKey: 'Edit', newOwnerId: String(P.away._id), overrideReason: 'check' }), /is suspended/);
  });

  it('Work Detail owner change (PATCH /api/work/:id with ownerId); clearing is allowed', async () => {
    const { step: edit } = await step('sm', 'Edit', 'editor');
    expectRefused(await request(app).patch(`/api/work/${edit._id}`).set(as('sm')).send({ ownerId: String(P.designer._id) }), /cannot own Edit steps/);
    expectRefused(await request(app).patch(`/api/work/${edit._id}`).set(as('sm')).send({ ownerId: String(oid()) }), /does not exist/);
    expect((await request(app).patch(`/api/work/${edit._id}`).set(as('sm')).send({ ownerId: null })).status).toBe(200);
    expect((await request(app).patch(`/api/work/${edit._id}`).set(as('sm')).send({ ownerId: String(P.editor._id) })).status).toBe(200);
  });

  it('plan grid: a hand-picked Post owner must be a poster on the calendar; the dropdown offers only them', async () => {
    const month = '2037-08';
    const save = (posting) => request(app).post('/api/calendar-plans/grid/rows').set(as('sm')).send({ calendar: 'sm', month, rows: [{ clientKey: 'r', cells: { postingDate: `${month}-12`, topic: `${TAG} grid row`, type: 'Static Post', brief: 'Owner rule.', postingOwnerId: String(P[posting]._id) } }] });
    const bad = await save('smSales');
    const result = bad.body.data?.results?.[0] || {};
    expect(JSON.stringify(result.cellErrors || bad.body.error || {})).toMatch(/not a poster on SM Calendar/);
    expect(result.cellErrors?.postingOwner).toHaveLength(1); // one message, not one per check
    expect(result.status).not.toBe('saved');
    const ok = await save('sm');
    expect(ok.status).toBe(201);
    // The owner dropdown: Post offered only to this calendar's posters.
    const grid = await request(app).get('/api/calendar-plans/grid').query({ calendar: 'sm', month }).set(as('sm'));
    const prefsOf = (k) => grid.body.data.people.find((p) => p._id === String(P[k]._id))?.workPreferences || [];
    expect(prefsOf('sm')).toContain('Post');
    expect(prefsOf('smSales')).not.toContain('Post');
    const salesGrid = await request(app).get('/api/calendar-plans/grid').query({ calendar: 'sales', month }).set(as('sm'));
    expect(salesGrid.body.data.people.find((p) => p._id === String(P.smSales._id))?.workPreferences || []).toContain('Post');
  });

  it('step generation drops a planned owner who can no longer own the step', async () => {
    const plan = await CalendarPlan.create({ code: `${TAG}-gen-${Date.now()}`, title: `${TAG} gen plan`, calendar: 'sm', periodStart: new Date('2037-09-01'), periodEnd: new Date('2037-09-30'), createdById: P.sm._id });
    const row = await ContentPiece.create({ planId: plan._id, topic: `${TAG} gen row`, contentType: 'Static Post', type: 'Static Post', pipeline: 'design', postingDate: new Date('2037-09-20'), status: 'Not Started', calendar: 'sm', rowStatus: 'approved', brief: 'Brief.',
      stagePlan: [{ stageKey: 'Post', ownerId: P.smSales._id, ownerSource: 'manual', dueDate: new Date('2037-09-20') }, { stageKey: 'Design', ownerId: P.designer._id, ownerSource: 'manual', dueDate: new Date('2037-09-15') }] });
    await generateStagesForApprovedRow(row, null);
    const steps = await WorkItem.find({ contentPieceId: row._id }).lean();
    const by = Object.fromEntries(steps.map((s) => [s.stageKey, s.ownerId ? String(s.ownerId) : null]));
    expect(by.Post).toBeNull(); // smSales is not a poster on SM
    expect(by.Design).toBe(String(P.designer._id));
  });

  it('Tracker dropdown: each step offers only eligible owners; recommendations never pick a non-poster for Post', async () => {
    const { piece } = await step('sm', 'Post');
    await WorkItem.create({ title: `${TAG} sm Edit 2`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'Not Started', calendar: 'sm', ownerId: null, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 2 * 864e5) });
    const res = await request(app).post('/api/content-pieces/recommend-owners').set(as('sm')).send({ pieceId: String(piece._id) });
    expect(res.status).toBe(200);
    const recs = res.body.data;
    const ids = (stageKey) => (recs.find((r) => r.stageKey === stageKey)?.eligibleOwners || []).map((p) => p._id);
    expect(ids('Post')).toContain(String(P.sm._id));
    expect(ids('Post')).not.toContain(String(P.smSales._id));
    expect(ids('Edit')).toContain(String(P.editor._id));
    for (const k of ['designer', 'away', 'admin', 'cl']) expect(ids('Edit')).not.toContain(String(P[k]._id));
    const postRec = recs.find((r) => r.stageKey === 'Post')?.recommendedPerson;
    if (postRec) expect(String(postRec._id)).not.toBe(String(P.smSales._id));
  });
});
