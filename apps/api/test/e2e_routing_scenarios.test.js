// Phase E2: routing scenarios end to end (real routes on the test database), and every
// notification event sends to exactly the resolver's recipients, once each.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { PauseRequest } from '../src/modules/workItems/pauseRequest.model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { Submission } from '../src/modules/submissions/model.js';
import { RevisionFlag } from '../src/modules/feedback/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { AccessRequest } from '../src/modules/access/model.js';
import { seedReferenceData } from '../src/modules/referenceData/service.js';
import { checkAndCreateRevisionFlag } from '../src/modules/feedback/service.js';
import { ensureAutomationRules, executeAutomationRule } from '../src/modules/automation/runner.js';
import { submitAccessRequest } from '../src/modules/access/service.js';
import { initDomainEventListeners } from '../src/modules/notifications/service.js';
import { decidersFor } from '../src/modules/workItems/deciders.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'E2ROUTE';
const EMAIL = /@e2-routing-test\.com$/;
const DOMAIN = '@e2-routing-test.com';
const oid = () => new mongoose.Types.ObjectId();
const auth = (u) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(u._id), role: u.role, email: u.email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
const ids = (list) => [...new Set(list.map((p) => String(p._id || p)))].sort();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Phase E2: routing scenarios', () => {
  const P = {};
  let dept;
  const as = (k) => auth(P[k]);
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));

  /** Notifications of a type about one work item: recipient → count. */
  const sentFor = async (type, workItemId) => {
    const rows = await Notification.find({ type, 'metadata.workItemId': workItemId }).select('recipient').lean();
    const counts = {};
    for (const r of rows) counts[String(r.recipient)] = (counts[String(r.recipient)] || 0) + 1;
    return counts;
  };
  const exactlyOnce = (counts, people) => {
    expect(Object.keys(counts).sort()).toEqual(ids(people));
    expect(Object.values(counts).every((n) => n === 1)).toBe(true);
  };

  async function step(calendar, extra = {}) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} ${calendar}`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar });
    return WorkItem.create({
      title: `${TAG} ${calendar} ${extra.stageKey || 'Edit'}`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', isLocked: false, calendar,
      ownerId: P.worker._id, departmentId: dept, contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true,
      startedAt: new Date(Date.now() - 36e5), rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 36e5), intervals: [] }], ...extra,
    });
  }
  async function waiting(calendar) {
    const s = await step(calendar, { status: 'Pending' });
    const v = await Submission.create({ workItemId: s._id, contentPieceId: s.contentPieceId, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.worker._id, submittedAt: new Date(), linkUrl: `https://drive.google.com/file/d/${TAG}` });
    return { step: s, sub: v };
  }
  const submit = (s) => request(app).post(`/api/work/${s._id}/submit-link`).set(as('worker')).send({ links: [`https://drive.google.com/file/d/${TAG}-${s._id}`] });
  const approve = (key, subId) => request(app).post(`/api/submissions/${subId}/approve`).set(as(key)).send({ score: 4, feedback: 'Clean work.', tags: [] });
  const setCalendar = (cal, changes) => request(app).put(`/api/access-admin/calendars/${cal}`).set(as('admin')).send({ changes, reason: 'Phase E routing test' });
  const resetConfigs = async () => {
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
  };

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    await PauseRequest.deleteMany({ workItemId: { $in: steps } });
    await RevisionFlag.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG}`) });
    const plans = (await CalendarPlan.find({ createdById: { $in: people } }).select('_id').lean()).map((p) => p._id);
    await ContentPiece.deleteMany({ planId: { $in: plans } });
    await CalendarPlan.deleteMany({ _id: { $in: plans } });
    await Notification.deleteMany({ $or: [{ recipient: { $in: people } }, { 'metadata.workItemId': { $in: steps } }] });
    await AccessRequest.deleteMany({ email: EMAIL });
    await AccessChange.deleteMany({ $or: [{ entityId: { $in: people.map(String) } }, { entityType: 'workflow_config' }] });
    await resetConfigs();
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await seedReferenceData();
    initDomainEventListeners(); // the server registers these at start
    dept = oid();
    await person('admin', 'admin');
    await person('cl', 'creative_lead');
    await person('cl2', 'creative_lead');
    await person('gl', 'growth_lead');
    await person('gl2', 'growth_lead');
    await person('sm', 'sm_manager', { departmentId: dept });
    await person('sm2', 'sm_manager');
    await person('worker', 'executive', { jobRole: 'Video Editor', departmentId: dept });
  }, 60000);
  afterAll(cleanup, 60000);

  it('a named reviewer is suspended: waiting reviews go to the fallback, and they get nothing', async () => {
    await resetConfigs();
    expect((await setCalendar('other', { reviewers: { roles: [], userIds: [String(P.gl2._id)] } })).status).toBe(200);
    const w = await waiting('other');
    const res = await request(app).patch(`/api/access-admin/people/${P.gl2._id}`).set(as('admin')).send({ status: 'suspended', reason: 'Left the team' });
    expect(res.status).toBe(200);
    const { primary, people } = await resolver.reviewersFor({ calendar: 'other' });
    expect(primary).toEqual([]);
    expect(ids(people)).toEqual(ids(await Person.find({ role: 'admin', status: 'active' })));
    // A new submission goes to the fallback, once each; the suspended person gets nothing.
    const s2 = await step('other');
    expect((await submit(s2)).status).toBeLessThan(300);
    const sent = await sentFor('submission_ready', s2._id);
    exactlyOnce(sent, people);
    expect(sent[String(P.gl2._id)]).toBeUndefined();
    // They cannot act; the fallback can.
    expect((await approve('gl2', w.sub._id)).status).toBe(403);
    expect((await approve('admin', w.sub._id)).status).toBe(200);
    await request(app).patch(`/api/access-admin/people/${P.gl2._id}`).set(as('admin')).send({ status: 'active', reason: 'Back' });
  });

  it('a plan moved to Ads and back follows the changed Ads plan approvers', async () => {
    await resetConfigs();
    expect((await setCalendar('ads', { planApprovers: { roles: [], userIds: [String(P.cl2._id)] } })).status).toBe(200);
    const saved = await request(app).post('/api/calendar-plans/grid/rows').set(as('sm')).send({ calendar: 'sm', month: '2036-01', rows: [{ clientKey: 'r', cells: { postingDate: '2036-01-20', topic: `${TAG} plan`, type: 'Static Post', brief: 'Routing test.' } }] });
    expect(saved.status).toBe(201);
    const planId = saved.body.data.plan._id;
    const rowId = saved.body.data.results[0].rowId;
    expect((await request(app).post(`/api/calendar-plans/${planId}/submit`).set(as('sm'))).status).toBe(200);
    const review = (key) => request(app).post(`/api/calendar-plans/${planId}/review`).set(as(key)).send({ action: 'request_changes', changes: [{ rowId, comment: 'Check the date' }] });
    // On Ads: only the named Creative Manager decides; the Marketing Growth Manager and the other Creative Manager are refused.
    expect((await request(app).patch(`/api/calendar-plans/${planId}/calendar`).set(as('sm')).send({ calendar: 'ads' })).status).toBe(200);
    expect((await review('gl')).body.error?.code).toBe('WRONG_CALENDAR');
    expect((await review('cl')).body.error?.code).toBe('WRONG_CALENDAR');
    // Back on SM: the Creative Manager role decides again; the Marketing Growth Manager is refused.
    expect((await request(app).patch(`/api/calendar-plans/${planId}/calendar`).set(as('sm')).send({ calendar: 'sm' })).status).toBe(200);
    expect((await review('gl')).body.error?.code).toBe('WRONG_CALENDAR');
    expect((await request(app).post(`/api/calendar-plans/${planId}/review`).set(as('cl')).send({ action: 'approve_selected', approvedRowIds: [rowId] })).status).toBe(200);
    // Moving to Ads first, the named Creative Manager could decide there.
    const again = await request(app).post('/api/calendar-plans/grid/rows').set(as('sm')).send({ calendar: 'ads', month: '2036-02', rows: [{ clientKey: 'r', cells: { postingDate: '2036-02-20', topic: `${TAG} ads plan`, type: 'Static Post', brief: 'Routing test.' } }] });
    const adsPlan = again.body.data.plan._id;
    await request(app).post(`/api/calendar-plans/${adsPlan}/submit`).set(as('sm'));
    // plan.submitted reached exactly the Ads plan approvers.
    const notes = await Notification.find({ type: 'plan_submitted', 'metadata.planId': { $in: [adsPlan, new mongoose.Types.ObjectId(adsPlan)] } }).select('recipient').lean();
    expect(ids(notes.map((n) => n.recipient))).toEqual(ids(await decidersFor('ads', { plans: true })));
    expect((await request(app).post(`/api/calendar-plans/${adsPlan}/review`).set(as('cl2')).send({ action: 'approve_selected', approvedRowIds: [again.body.data.results[0].rowId] })).status).toBe(200);
  });

  it('two reviewers on one calendar: both told once; deciding at the same time, one wins and the other gets 409', async () => {
    await resetConfigs();
    const s = await step('sales');
    expect((await submit(s)).status).toBeLessThan(300);
    const sent = await sentFor('submission_ready', s._id);
    exactlyOnce(sent, await decidersFor('sales'));
    expect(sent[String(P.cl._id)]).toBe(1);
    expect(sent[String(P.cl2._id)]).toBe(1);
    const sub = await Submission.findOne({ workItemId: s._id }).sort({ version: -1 }).lean();
    // Both decisions are sent at the same time (final fix T6): an approval and a revision request.
    const [a, b] = await Promise.all([
      approve('cl', sub._id),
      request(app).post(`/api/submissions/${sub._id}/request-revision`).set(as('cl2')).send({ comment: 'Tighten the cut.' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const decided = await Submission.findById(sub._id).lean();
    expect(decided.status).toBe(a.status === 200 ? 'approved' : 'changes_requested');
    // Exactly one decision is recorded: one rating if the approval won, none otherwise.
    const { Rating } = await import('../src/modules/submissions/model.js');
    expect(await Rating.countDocuments({ submissionId: sub._id })).toBe(a.status === 200 ? 1 : 0);
  });

  it('a lead limited to SM but named on Ads: the limit wins', async () => {
    await resetConfigs();
    expect((await request(app).patch(`/api/access-admin/people/${P.cl._id}`).set(as('admin')).send({ calendarScope: ['sm'], reason: 'SM only' })).status).toBe(200);
    const pre = await request(app).post('/api/access-admin/calendars/ads/preview').set(as('admin')).send({ changes: { reviewers: { roles: ['growth_lead'], userIds: [String(P.cl._id)] } } });
    expect(pre.body.data.health.warnings.map((w) => w.message)).toContain(`${TAG} cl is limited to other calendars.`);
    expect((await setCalendar('ads', { reviewers: { roles: ['growth_lead'], userIds: [String(P.cl._id)] } })).status).toBe(200);
    const fresh = await Person.findById(P.cl._id).lean();
    expect(await resolver.can(fresh, 'review.decide', { calendar: 'ads' })).toBe(false);
    const s = await step('ads');
    expect((await submit(s)).status).toBeLessThan(300);
    expect((await sentFor('submission_ready', s._id))[String(P.cl._id)]).toBeUndefined();
    const sub = await Submission.findOne({ workItemId: s._id }).lean();
    expect((await approve('cl', sub._id)).status).toBe(403);
    // Revision-flag alerts respect the limit too.
    const flagged = await step('ads', { revisions: 3, rounds: [] });
    await checkAndCreateRevisionFlag(flagged.toObject());
    const flagSent = await sentFor('revision.flagged', flagged._id);
    expect(flagSent[String(P.cl._id)]).toBeUndefined();
    expect(flagSent[String(P.gl._id)]).toBe(1);
    await request(app).patch(`/api/access-admin/people/${P.cl._id}`).set(as('admin')).send({ calendarScope: null, reason: 'All again' });
  });

  it('changing the poster: a Post step in progress keeps its owner, one not started moves', async () => {
    await resetConfigs();
    const inProgress = await step('sales', { stageKey: 'Post', reviewRequired: false, ownerId: P.sm._id, title: `${TAG} Post in progress` });
    const notStarted = await step('sales', { stageKey: 'Post', reviewRequired: false, ownerId: P.sm._id, status: 'Not Started', startedAt: null, title: `${TAG} Post not started` });
    const pre = await request(app).post('/api/access-admin/calendars/sales/preview').set(as('admin')).send({ changes: { posters: { roles: [], userIds: [String(P.sm2._id)] } } });
    expect(pre.body.data.counts.postSteps).toBe(1);
    const res = await setCalendar('sales', { posters: { roles: [], userIds: [String(P.sm2._id)] } });
    expect(res.body.data.movedPosts).toBe(1);
    expect(String((await WorkItem.findById(inProgress._id).lean()).ownerId)).toBe(String(P.sm._id));
    expect(String((await WorkItem.findById(notStarted._id).lean()).ownerId)).toBe(String(P.sm2._id));
  });

  it('pause and help requests follow the new reviewers', async () => {
    await resetConfigs();
    expect((await setCalendar('academics_management', { reviewers: { roles: [], userIds: [String(P.gl._id)] } })).status).toBe(200);
    const s = await step('academics_management');
    const help = await request(app).get(`/api/work/${s._id}/help-requests`).set(as('worker'));
    expect(help.body.data.defaultHelperId).toBe(String(P.gl._id));
    const asked = await request(app).post(`/api/work/${s._id}/pause-request`).set(as('worker')).send({ reason: 'other', note: 'Waiting on the client' });
    expect(asked.status).toBe(201);
    exactlyOnce(await sentFor('pause_requested', s._id), [P.gl]);
    expect((await request(app).post(`/api/work/${s._id}/pause-request/decide`).set(as('cl')).send({ decision: 'reject' })).status).toBe(403);
    expect((await request(app).post(`/api/work/${s._id}/pause-request/decide`).set(as('gl')).send({ decision: 'reject' })).status).toBe(200);
  });

  describe('every notification event goes to exactly the resolver\'s recipients, once', () => {
    it('submission.ready, revision.flagged, step.needs_owner (blocked), step.overdue_manager, revision.flag_escalated, access.requested', async () => {
      await resetConfigs();
      // submission.ready: covered above (exactlyOnce against decidersFor).
      // revision.flagged
      const flagged = await step('sm', { revisions: 3, rounds: [] });
      await checkAndCreateRevisionFlag(flagged.toObject());
      exactlyOnce(await sentFor('revision.flagged', flagged._id), await resolver.recipientsFor('revision.flagged', flagged));
      // step.needs_owner (a blocked step tells the calendar's posters)
      const blocked = await step('sm');
      const b = await request(app).post('/api/blockers').set(as('worker')).send({ workItemId: String(blocked._id), reason: 'Technical issue', notes: 'Render keeps failing' });
      expect(b.status).toBeLessThan(300);
      exactlyOnce(await sentFor('work_item.blocked', blocked._id), await resolver.recipientsFor('step.needs_owner', blocked));
      // step.overdue_manager
      await ensureAutomationRules();
      const late = await step('sm', { deadline: new Date(Date.now() - 3 * 864e5), dueDate: new Date(Date.now() - 3 * 864e5) });
      await executeAutomationRule('overdue_escalation', null, { force: true });
      const overdue = await Notification.find({ type: 'alert', title: `Overdue: ${late.title}`, recipient: { $ne: P.worker._id } }).select('recipient').lean();
      const managers = (await resolver.recipientsFor('step.overdue_manager', late)).filter((m) => String(m._id) !== String(P.worker._id));
      expect(ids(overdue.map((n) => n.recipient))).toEqual(ids(managers));
      expect(overdue.length).toBe(managers.length);
      // revision.flag_escalated
      await RevisionFlag.updateOne({ workItemId: flagged._id }, { $set: { flaggedAt: new Date(Date.now() - 72 * 36e5), rootCause: null, isEscalated: false } });
      await executeAutomationRule('revision_pattern_flag', null, { force: true });
      const flag = await RevisionFlag.findOne({ workItemId: flagged._id }).lean();
      const esc = await Notification.find({ 'metadata.flagId': flag._id }).select('recipient').lean();
      const leaders = await resolver.recipientsFor('revision.flag_escalated', flagged);
      expect(ids(esc.map((n) => n.recipient))).toEqual(ids(leaders));
      expect(esc.length).toBe(ids(leaders).length);
      // access.requested
      await submitAccessRequest({ name: `${TAG} applicant`, email: `applicant${DOMAIN}`, phone: '+919876543210', department: 'Video Production', jobRole: 'Video Editor', requestedRole: 'executive', reason: 'Joining the video team.' });
      const req = await AccessRequest.findOne({ email: `applicant${DOMAIN}` }).lean();
      const admins = await resolver.recipientsFor('access.requested');
      const reqQuery = { type: 'access.requested', $or: [{ 'metadata.id': req._id }, { 'metadata.id': String(req._id) }] };
      // The event handler runs after the request returns: wait until it has sent (or 20 s).
      for (let i = 0; i < 80 && (await Notification.countDocuments(reqQuery)) < admins.length; i++) await wait(250);
      await wait(250);
      const reqNotes = await Notification.find(reqQuery).select('recipient').lean();
      expect(ids(reqNotes.map((n) => n.recipient))).toEqual(ids(admins));
      expect(reqNotes.length).toBe(ids(admins).length);
    }, 60000);
  });
});
