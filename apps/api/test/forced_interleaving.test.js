// Review follow-up, commit 4: race tests that force the interleaving instead of hoping
// Promise.all overlaps. A test hook pauses the first request after its read; the second request
// runs to the end; then the first resumes and must lose. A check-then-write regression (writing
// without re-checking the state) would let the first one win, and these tests would fail.
// Also: review.read_all proven by a role that passes the route's access check but lacks it.
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
import { Submission, SubmissionComment, Rating } from '../src/modules/submissions/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { reviewDecisionHooks } from '../src/modules/submissions/reviewDecision.js';
import { planReviewHooks } from '../src/modules/calendar/plan.service.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'FORCED';
const DOMAIN = '@forced-race-test.com';
const EMAIL = /@forced-race-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();
const tick = () => new Promise((r) => setTimeout(r, 20));

/** A one-shot pause: the first call to `hook` waits until `release()`; `paused` resolves when it is waiting. */
function pauseOnce(filter = () => true) {
  let release;
  let markPaused;
  const gate = new Promise((r) => (release = r));
  const paused = new Promise((r) => (markPaused = r));
  let used = false;
  const hook = async (info) => {
    if (used || !filter(info)) return;
    used = true;
    markPaused();
    await gate;
  };
  return { hook, paused, release: () => release() };
}

describe('Forced interleaving: the request that read first and wrote last loses', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));

  async function waiting() {
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'sm' });
    const step = await WorkItem.create({ title: `${TAG} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'Pending', isLocked: false, calendar: 'sm', ownerId: P.editor._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true, startedAt: new Date(Date.now() - 36e5), rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 36e5), intervals: [] }] });
    const sub = await Submission.create({ workItemId: step._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.editor._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/forced' });
    return { piece, step, sub };
  }

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const plans = (await CalendarPlan.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ $or: [{ topic: new RegExp(`^${TAG}`) }, { planId: { $in: plans } }] }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: pieces } }).select('_id').lean()).map((s) => s._id);
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await SubmissionComment.deleteMany({ workItemId: { $in: steps } });
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
    await person('admin', 'admin');
    await person('cl', 'creative_lead');
    await person('cl2', 'creative_lead');
    await person('gl', 'growth_lead');
    await person('head', 'creative_head');
    await person('sm', 'sm_manager');
    await person('editor', 'executive', { jobRole: 'Video Editor' });
    await person('mate', 'executive', { jobRole: 'Graphic Designer' });
  }, 60000);
  afterAll(cleanup, 60000);
  afterEach(() => {
    reviewDecisionHooks.beforeClaim = null;
    planReviewHooks.afterRead = null;
    resolver.accessResolverHooks.afterRead = null;
  });

  it('T6: two reviewers on one version: the approval that checked first but claims last gets 409', async () => {
    const { sub } = await waiting();
    const p = pauseOnce(({ toStatus }) => toStatus === 'approved');
    reviewDecisionHooks.beforeClaim = p.hook;
    const first = request(app).post(`/api/submissions/${sub._id}/approve`).set(as('cl')).send({ score: 4, feedback: 'Clean work.', tags: [] }).then((r) => r);
    await p.paused; // cl has passed every check and is about to claim
    const second = await request(app).post(`/api/submissions/${sub._id}/request-revision`).set(as('cl2')).send({ comment: 'Tighten the cut.' });
    expect(second.status).toBe(200);
    p.release();
    const res = await first;
    expect([res.status, res.body.error?.code]).toEqual([409, 'ALREADY_DECIDED']);
    expect((await Submission.findById(sub._id).lean()).status).toBe('changes_requested');
    expect(await Rating.countDocuments({ submissionId: sub._id })).toBe(0);
  });

  it('M3 / issue 1: two leads on one plan row: the one that read first but writes last gets 409 and changes nothing', async () => {
    const plan = await CalendarPlan.create({ code: `${TAG}-${Date.now()}`, title: `${TAG} plan`, calendar: 'sm', periodStart: new Date('2037-11-01'), periodEnd: new Date('2037-11-30'), createdById: P.sm._id });
    const row = await ContentPiece.create({ planId: plan._id, topic: `${TAG} row`, contentType: 'Static Post', type: 'Static Post', pipeline: 'design', postingDate: new Date('2037-11-20'), status: 'Not Started', calendar: 'sm', rowStatus: 'submitted', createdById: P.sm._id, submittedById: P.sm._id, brief: 'Brief.' });
    const p = pauseOnce(({ action }) => action === 'approve_selected');
    planReviewHooks.afterRead = p.hook;
    const first = request(app).post(`/api/calendar-plans/${plan._id}/review`).set(as('cl')).send({ action: 'approve_selected', approvedRowIds: [String(row._id)] }).then((r) => r);
    await p.paused; // cl has read the row as submitted
    const second = await request(app).post(`/api/calendar-plans/${plan._id}/review`).set(as('cl2')).send({ action: 'request_changes', changes: [{ rowId: String(row._id), comment: 'Change the hook.' }] });
    expect(second.status).toBe(200);
    p.release();
    const res = await first;
    expect([res.status, res.body.error?.code]).toEqual([409, 'ROW_ALREADY_DECIDED']);
    expect((await ContentPiece.findById(row._id).lean()).rowStatus).toBe('changes_requested');
    expect(await WorkItem.countDocuments({ contentPieceId: row._id })).toBe(0);
  });

  it('M8: a request that read the old settings before a save cannot put them back in the cache (two real requests)', async () => {
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    const p = pauseOnce(({ calendar }) => calendar === 'ads');
    resolver.accessResolverHooks.afterRead = p.hook;
    // Request A reads Ads (still: the Marketing Growth Manager reviews it) and is held before filling the cache.
    const first = request(app).get('/api/auth/me').set(as('cl')).then((r) => r);
    await p.paused;
    // Request B saves Ads: the Creative Manager reviews it now.
    const save = await request(app).put('/api/access-admin/calendars/ads').set(as('admin')).send({ version: 0, reason: 'Ads to the lead', changes: { reviewers: { roles: ['creative_lead'], userIds: [] } } });
    expect(save.status).toBe(200);
    p.release();
    expect((await first).status).toBe(200);
    await tick();
    // Within the 5 s cache time, the next request must see the saved settings, not A's old read.
    const me = await request(app).get('/api/auth/me').set(as('cl'));
    const calendars = me.body.access?.calendars?.['review.decide'] || me.body.data?.access?.calendars?.['review.decide'] || [];
    expect(calendars).toContain('ads');
  });

  it('review.read_all: a teammate who passes the route\'s access check but lacks the permission is refused by it', async () => {
    const { piece, step, sub } = await waiting();
    await SubmissionComment.create({ submissionId: sub._id, workItemId: step._id, authorId: P.cl._id, text: 'Private review note', anchor: null, parentId: null });
    // The teammate owns another step of the same piece: requireSubmissionAccess lets them through.
    await WorkItem.create({ title: `${TAG} Design`, workType: 'Reel', stageKey: 'Design', stageOrder: 2, status: 'Approved', calendar: 'sm', ownerId: P.mate._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 2 * 864e5) });
    const get = (k) => request(app).get(`/api/submissions/${sub._id}/comments`).set(as(k));
    const mate = await get('mate');
    expect([mate.status, mate.body.error?.code]).toEqual([403, 'FORBIDDEN_COMMENT_ACCESS']);
    expect((await get('editor')).status).toBe(200); // the step owner
    for (const k of ['sm', 'head', 'cl']) expect((await get(k)).status, k).toBe(200); // they hold review.read_all
  });
});
