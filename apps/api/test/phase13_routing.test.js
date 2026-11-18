// Phase 13: approvals routed by calendar (Growth Lead: Ads; Creative Lead: every other calendar;
// admin: all; nobody on their own work) and plan-row Request changes with suggested values.
// Disposable test DB, synthetic people, steps and plans.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import ExcelJS from 'exceljs';
import { PLAN_TEMPLATE_HEADERS, canDecide, decisionCalendarsFor, deciderRoleFor } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { Submission, Rating } from '../src/modules/submissions/model.js';
import { RevisionFlag } from '../src/modules/feedback/model.js';
import { MediaItem, MediaMessage } from '../src/modules/media/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { executeAutomationRule } from '../src/modules/automation/runner.js';

const EMAIL = /@p13-routing-test\.com$/;
const MONTH = '2033-05';
const TAG = 'P13R';

describe('Phase 13: approval routing by calendar and plan row Request changes', () => {
  const P = {};
  const tokens = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const as = (who) => ({
    get: (url, q) => request(app).get(url).query(q || {}).set(auth(who)),
    post: (url, body) => request(app).post(url).set(auth(who)).send(body),
    patch: (url, body) => request(app).patch(url).set(auth(who)).send(body),
  });

  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const plans = await CalendarPlan.find({ createdById: { $in: ids } }).select('_id').lean();
    const pids = plans.map((p) => p._id);
    const pieces = (await ContentPiece.find({ planId: { $in: pids } }).select('_id').lean()).map((r) => r._id);
    const steps = (
      await WorkItem.find({ $or: [{ calendarPlanId: { $in: pids } }, { title: new RegExp(TAG) }] }).select('_id').lean()
    ).map((w) => w._id);
    await ActivityEvent.deleteMany({ entityId: { $in: [...pieces, ...pieces.map(String), ...pids, ...pids.map(String), ...steps, ...steps.map(String)] } });
    await RevisionFlag.deleteMany({ workItemId: { $in: steps } });
    const clips = (await MediaItem.find({ stageItemId: { $in: steps } }).select('_id').lean()).map((c) => c._id);
    await MediaMessage.deleteMany({ mediaItemId: { $in: clips } });
    await MediaItem.deleteMany({ _id: { $in: clips } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ planId: { $in: pids } });
    await CalendarPlan.deleteMany({ _id: { $in: pids } });
    await Notification.deleteMany({ recipient: { $in: ids } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    const mk = (key, role, extra = {}) =>
      Person.create({ name: `${TAG} ${key}`, email: `${key}@p13-routing-test.com`, role, status: 'active', ...extra }).then((p) => {
        P[key] = p;
        tokens[key] = make(p);
      });
    await mk('admin', 'admin');
    await mk('creativeLead', 'creative_lead');
    await mk('growthLead', 'growth_lead');
    await mk('creativeHead', 'creative_head');
    await mk('sm', 'sm_manager', { jobRole: 'Social Media Manager' });
    await mk('editor', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'] });
    await mk('designer', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Design'] });
  }, 60000);
  afterAll(cleanup, 60000);

  // A step waiting for a decision, owned by `owner`, in `calendar`.
  const step = (owner, calendar, extra = {}) =>
    WorkItem.create({
      title: `${TAG} step ${calendar}`,
      workType: 'Reel',
      stageKey: 'Edit',
      stageOrder: 1,
      status: 'Feedback',
      isLocked: false,
      reviewRequired: true,
      calendar,
      ownerId: P[owner]._id,
      departmentId: new mongoose.Types.ObjectId(),
      deadline: new Date(Date.now() + 5 * 86400000),
      startedAt: new Date(Date.now() - 3600000),
      rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 3600000), submittedAt: new Date(), intervals: [] }],
      ...extra,
    });
  const version = (w) =>
    Submission.create({
      workItemId: w._id,
      stageKey: w.stageKey,
      version: 1,
      kind: 'link',
      status: 'submitted',
      submittedById: w.ownerId,
      submittedAt: new Date(),
      linkUrl: 'https://drive.google.com/file/d/p13',
    });
  const waiting = async (owner, calendar) => {
    const w = await step(owner, calendar);
    return { w, v: await version(w) };
  };
  const notes = (who, filter = {}) => Notification.countDocuments({ recipient: P[who]._id, ...filter });

  describe('The shared rule', () => {
    it('Growth Lead decides Ads only; Creative Lead every other calendar; admin all; nobody their own work', () => {
      expect(decisionCalendarsFor('growth_lead')).toEqual(['ads']);
      expect(decisionCalendarsFor('creative_lead').sort()).toEqual(['academics_management', 'other', 'sales', 'sm']);
      expect(decisionCalendarsFor('admin')).toHaveLength(5);
      for (const role of ['sm_manager', 'executive', 'creative_head', 'production_head']) expect(decisionCalendarsFor(role)).toEqual([]);
      expect(deciderRoleFor('ads')).toBe('growth_lead');
      expect(deciderRoleFor(undefined)).toBe('creative_lead');
      expect(canDecide('growth_lead', 'ads')).toBe(true);
      expect(canDecide('growth_lead', 'sm')).toBe(false);
      expect(canDecide('creative_lead', 'ads')).toBe(false);
      expect(canDecide('creative_lead', null)).toBe(true);
      expect(canDecide({ _id: 'x', role: 'admin' }, 'ads', { ownerId: 'x' })).toBe(false);
    });
  });

  describe('Every decision path follows the calendar', () => {
    it('approve: the right lead may, the other lead gets 403 WRONG_CALENDAR, admin may', async () => {
      for (const [cal, right, wrong] of [['sm', 'creativeLead', 'growthLead'], ['ads', 'growthLead', 'creativeLead']]) {
        const a = await waiting('editor', cal);
        const no = await as(wrong).post(`/api/submissions/${a.v._id}/approve`, { score: 4 });
        expect(no.status, cal).toBe(403);
        expect(no.body.error.code).toBe('WRONG_CALENDAR');
        expect((await as(right).post(`/api/submissions/${a.v._id}/approve`, { score: 4 })).status, cal).toBe(200);
        const b = await waiting('editor', cal);
        expect((await as('admin').post(`/api/submissions/${b.v._id}/approve`, { score: 4 })).status, cal).toBe(200);
      }
    });

    it('request revision: the same routing', async () => {
      const a = await waiting('editor', 'ads');
      const no = await as('creativeLead').post(`/api/submissions/${a.v._id}/request-revision`, { comment: 'Tighter cut', rootCause: 'Brief unclear' });
      expect(no.status).toBe(403);
      expect(no.body.error.code).toBe('WRONG_CALENDAR');
      expect((await as('growthLead').post(`/api/submissions/${a.v._id}/request-revision`, { comment: 'Tighter cut', rootCause: 'Brief unclear' })).status).toBe(200);
    });

    it('self-review is blocked for the right lead and for admin', async () => {
      const own = await waiting('growthLead', 'ads');
      const r = await as('growthLead').post(`/api/submissions/${own.v._id}/approve`, { score: 5 });
      expect(r.status).toBe(403);
      expect(r.body.error.code).toBe('FORBIDDEN_SELF_APPROVAL');
      const mine = await waiting('admin', 'sm');
      expect((await as('admin').post(`/api/submissions/${mine.v._id}/approve`, { score: 5 })).status).toBe(403);
    });

    it('workers, the SM Manager and the read-only heads cannot decide', async () => {
      const a = await waiting('editor', 'sm');
      for (const who of ['designer', 'sm', 'creativeHead']) {
        expect([403, 404], who).toContain((await as(who).post(`/api/submissions/${a.v._id}/approve`, { score: 4 })).status);
      }
    });

    it('reopen a finished step: the lead of its calendar only', async () => {
      const done = await step('editor', 'ads', { status: 'Approved', approvedAt: new Date() });
      const no = await as('creativeLead').post(`/api/work/${done._id}/transition`, { toStatus: 'In Progress', comment: 'Reopen' });
      expect(no.status).toBe(403);
      expect(no.body.error.code).toBe('WRONG_CALENDAR');
      const ok = await as('growthLead').post(`/api/work/${done._id}/transition`, { toStatus: 'In Progress', comment: 'Reopen' });
      expect(ok.status).toBe(200);
    });

    it('clip review: the lead of its calendar only; the owner can still post clip messages', async () => {
      const w = await step('editor', 'ads', { stageKey: 'Shoot' });
      const clip = await MediaItem.create({ stageItemId: w._id, url: 'https://drive.google.com/file/d/p13-clip', title: 'P13 clip', status: 'uploaded' });
      const msg = await as('editor').post(`/api/clips/${clip._id}/messages`, { text: 'Lighting note' });
      expect(msg.status).toBe(201);
      const no = await as('creativeLead').post(`/api/clips/${clip._id}/review`, { action: 'approve' });
      expect(no.status).toBe(403);
      expect(no.body.error.code).toBe('WRONG_CALENDAR');
      expect((await as('growthLead').post(`/api/clips/${clip._id}/review`, { action: 'approve' })).status).toBe(200);
    });

    it('classify a revision flag: the lead of its calendar only', async () => {
      const w = await step('editor', 'ads');
      const flag = await RevisionFlag.create({ workItemId: w._id, ownerId: P.editor._id, revisionsCount: 4 });
      const no = await as('creativeLead').post(`/api/revisions/flags/${flag._id}/classify`, { rootCause: 'Brief unclear' });
      expect(no.status).toBe(403);
      expect(no.body.error.code).toBe('WRONG_CALENDAR');
      expect((await as('growthLead').post(`/api/revisions/flags/${flag._id}/classify`, { rootCause: 'Brief unclear' })).status).toBe(200);
    });
  });

  describe('Queues and notifications reach only the right lead', () => {
    it('review queue and feedback threads: each lead sees their calendars, admin sees all', async () => {
      const sm = await waiting('editor', 'sm');
      const ads = await waiting('editor', 'ads');
      const ids = async (who) => {
        const res = await as(who).get('/api/submissions/review-queue');
        expect(res.status).toBe(200);
        return (res.body.data || []).map((q) => String(q._id));
      };
      const cl = await ids('creativeLead');
      const gl = await ids('growthLead');
      const ad = await ids('admin');
      expect(cl).toContain(String(sm.v._id));
      expect(cl).not.toContain(String(ads.v._id));
      expect(gl).toContain(String(ads.v._id));
      expect(gl).not.toContain(String(sm.v._id));
      expect(ad).toEqual(expect.arrayContaining([String(sm.v._id), String(ads.v._id)]));

      const threads = async (who) => JSON.stringify((await as(who).get('/api/feedback/threads', { limit: 500 })).body);
      const clT = await threads('creativeLead');
      const glT = await threads('growthLead');
      expect(clT).toContain(String(sm.w._id));
      expect(clT).not.toContain(String(ads.w._id));
      expect(glT).toContain(String(ads.w._id));
      expect(glT).not.toContain(String(sm.w._id));
    });

    it('a submitted version notifies the lead of its calendar only', async () => {
      const w = await step('editor', 'ads', { status: 'In Progress', rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 3600000), intervals: [] }] });
      const before = { gl: await notes('growthLead'), cl: await notes('creativeLead') };
      const res = await as('editor').post(`/api/work/${w._id}/submit-link`, { links: ['https://drive.google.com/file/d/p13-ads-cut/view'], note: '' });
      expect(res.status).toBe(201);
      expect(await notes('growthLead')).toBe(before.gl + 1);
      expect(await notes('creativeLead')).toBe(before.cl);
    });

    it('the 48-hour unclassified-flag alert goes to the lead of the calendar (and admin), not the other lead', async () => {
      const w = await step('editor', 'ads');
      const flag = await RevisionFlag.create({
        workItemId: w._id,
        ownerId: P.editor._id,
        revisionsCount: 4,
        flaggedAt: new Date(Date.now() - 50 * 3600000),
      });
      await executeAutomationRule('revision_pattern_flag');
      const about = { 'metadata.flagId': flag._id };
      expect(await notes('growthLead', about)).toBe(1);
      expect(await notes('admin', about)).toBe(1);
      expect(await notes('creativeLead', about)).toBe(0);
    }, 60000);
  });

  // ---------------------------------------------------------------- plans
  const saveRows = (who, calendar, rows) => as(who).post('/api/calendar-plans/grid/rows', { calendar, month: MONTH, rows });
  const grid = async (who, calendar) => {
    const res = await as(who).get('/api/calendar-plans/grid', { calendar, month: MONTH });
    return Object.fromEntries(res.body.data.rows.map((r) => [r.rowId, r]));
  };
  const review = (who, planId, body) => as(who).post(`/api/calendar-plans/${planId}/review`, body);
  const history = async (planId, rowId, who = 'sm') => (await as(who).get(`/api/calendar-plans/${planId}/rows/${rowId}/history`)).body.data;

  describe('SM plan: a row sent back with suggestions, applied, resubmitted, approved', () => {
    let planId;
    let reel;
    let poster;

    beforeAll(async () => {
      const res = await saveRows('sm', 'sm', [
        { clientKey: 'reel', cells: { postingDate: '2033-05-16', topic: `${TAG} Campus tour reel`, type: 'Reel', brief: 'Walk through the new lab.' } },
        { clientKey: 'poster', cells: { postingDate: '2033-05-20', topic: `${TAG} Exam poster`, type: 'Poster', brief: 'Exam dates.' } },
      ]);
      expect(res.status).toBe(201);
      planId = res.body.data.plan._id;
      [reel, poster] = res.body.data.results.map((r) => r.rowId);
      expect((await as('sm').post(`/api/calendar-plans/${planId}/submit`)).status).toBe(200);
    }, 60000);

    it('the grid offers review to the right lead only', async () => {
      const perms = async (who) => (await as(who).get('/api/calendar-plans/grid', { calendar: 'sm', month: MONTH })).body.data.permissions.canReview;
      expect(await perms('creativeLead')).toBe(true);
      expect(await perms('growthLead')).toBe(false);
      expect(await perms('admin')).toBe(true);
    });

    it('the wrong lead, workers and read-only roles cannot request changes or approve', async () => {
      const bodies = [
        { action: 'approve_selected', approvedRowIds: [reel] },
        { action: 'request_changes', changes: [{ rowId: reel, comment: 'x' }] },
        { action: 'request_changes_all', message: 'x' },
      ];
      for (const body of bodies) {
        const g = await review('growthLead', planId, body);
        expect(g.status).toBe(403);
        expect(g.body.error.code).toBe('WRONG_CALENDAR');
        for (const who of ['designer', 'creativeHead', 'sm']) expect((await review(who, planId, body)).status, who).toBe(403);
      }
      expect((await ContentPiece.findById(reel).lean()).rowStatus).toBe('submitted');
    });

    it('a message is required and suggestions are validated', async () => {
      const bad = async (changes, code) => {
        const res = await review('creativeLead', planId, { action: 'request_changes', changes });
        expect(res.status).toBe(400);
        if (code) expect(res.body.error.code).toBe(code);
        return res;
      };
      await bad([{ rowId: reel, comment: '   ' }]);
      await bad([{ rowId: reel, comment: 'Move it', suggestions: { postingDate: '2033-06-02' } }], 'INVALID_SUGGESTION');
      await bad([{ rowId: reel, comment: 'Move it', suggestions: { postingDate: 'someday' } }], 'INVALID_SUGGESTION');
      await bad([{ rowId: poster, comment: 'Shoot it', suggestions: { workflow: 'full' } }], 'INVALID_SUGGESTION');
      await bad([{ rowId: reel, comment: 'Make it a static', suggestions: { type: 'Static Post', workflow: 'shoot_edit' } }], 'INVALID_SUGGESTION');
      await bad([{ rowId: reel, comment: 'x', suggestions: { owner: 'someone' } }]);
      expect((await ContentPiece.findById(reel).lean()).rowStatus).toBe('submitted');
    });

    it('the lead sends one row back with a message and suggested values; the SM Manager is notified', async () => {
      const before = await notes('sm', { type: 'plan_changes_requested' });
      const res = await review('creativeLead', planId, {
        action: 'request_changes',
        changes: [
          {
            rowId: reel,
            comment: 'Post it after the lab opening, and skip the script.',
            suggestions: { postingDate: '18 May, 2033', workflow: 'shoot_edit', topic: `${TAG} Campus tour reel` },
          },
        ],
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(await notes('sm', { type: 'plan_changes_requested' })).toBe(before + 1);
      const row = (await grid('sm', 'sm'))[reel];
      expect(row.rowStatus).toBe('changes_requested');
      // Only real changes are kept (the topic was the same).
      expect(row.changeRequest).toMatchObject({
        message: 'Post it after the lab opening, and skip the script.',
        suggestions: { postingDate: '2033-05-18', workflow: 'shoot_edit' },
      });
      expect(row.changeRequest.suggestions.topic).toBeUndefined();
      expect(row.postingDate).toBe('2033-05-16');
      expect(row.workflow).toBe('full');
      expect((await grid('sm', 'sm'))[poster].rowStatus).toBe('submitted');
    });

    it('an Excel re-upload does not wipe the change request', async () => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Calendar Plan');
      ws.addRow(PLAN_TEMPLATE_HEADERS);
      const cells = { 'Posting Date': '22 May, 2033', Topic: `${TAG} Uploaded story`, Type: 'Story' };
      ws.addRow(PLAN_TEMPLATE_HEADERS.map((h) => cells[h] ?? ''));
      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      const up = await request(app)
        .post('/api/calendar-plans/grid/upload')
        .set(auth('sm'))
        .field('calendar', 'sm')
        .field('month', MONTH)
        .field('planId', planId)
        .field('dryRun', 'false')
        .attach('file', buffer, { filename: 'plan.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      expect(up.status).toBeLessThan(300);
      const row = await ContentPiece.findById(reel).lean();
      expect(row.rowStatus).toBe('changes_requested');
      expect(row.changeRequest.message).toBe('Post it after the lab opening, and skip the script.');
      expect(row.changeRequest.suggestions.postingDate).toBe('2033-05-18');
    });

    it('workers and the lead cannot apply a suggestion; the SM Manager applies it and the request clears', async () => {
      for (const who of ['designer', 'creativeLead', 'creativeHead']) {
        expect((await as(who).post(`/api/calendar-plans/${planId}/rows/${reel}/apply-suggestion`)).status, who).toBe(403);
      }
      const res = await as('sm').post(`/api/calendar-plans/${planId}/rows/${reel}/apply-suggestion`);
      expect(res.status).toBe(200);
      const row = (await grid('sm', 'sm'))[reel];
      expect(row.postingDate).toBe('2033-05-18');
      expect(row.workflow).toBe('shoot_edit');
      expect(row.changeRequest).toBeNull();
      expect(row.rowStatus).toBe('changes_requested');
      // Nothing left to apply.
      expect((await as('sm').post(`/api/calendar-plans/${planId}/rows/${reel}/apply-suggestion`)).status).toBe(400);
    });

    it('resubmitting goes back to the same lead (notified), and the lead approves', async () => {
      const before = { cl: await notes('creativeLead', { type: 'plan_submitted' }), gl: await notes('growthLead', { type: 'plan_submitted' }) };
      expect((await as('sm').post(`/api/calendar-plans/${planId}/rows/${reel}/submit`)).status).toBe(200);
      expect(await notes('creativeLead', { type: 'plan_submitted' })).toBe(before.cl + 1);
      expect(await notes('growthLead', { type: 'plan_submitted' })).toBe(before.gl);
      expect((await review('creativeLead', planId, { action: 'approve_selected', approvedRowIds: [reel] })).status).toBe(200);
      expect((await ContentPiece.findById(reel).lean()).rowStatus).toBe('approved');
    });

    it("the row's history keeps the request, the applied values, the resubmit and the approval", async () => {
      const h = await history(planId, reel);
      expect(h.map((e) => e.action)).toEqual(['changes_requested', 'suggestion_applied', 'resubmitted', 'approved']);
      expect(h[0]).toMatchObject({ message: 'Post it after the lab opening, and skip the script.', suggestions: { postingDate: '2033-05-18', workflow: 'shoot_edit' } });
      expect(h[0].by.name).toBe(`${TAG} creativeLead`);
      expect(h[1].applied).toEqual({ postingDate: '2033-05-18', workflow: 'shoot_edit' });
      expect(h[3].by.name).toBe(`${TAG} creativeLead`);
      // Read-only roles can read it too.
      expect((await as('creativeHead').get(`/api/calendar-plans/${planId}/rows/${reel}/history`)).status).toBe(200);
    });

    it('a calendar move moves the pending decisions to the new lead', async () => {
      // A step of the approved row waits for review; the plan then moves from SM to Ads.
      const s = await WorkItem.findOne({ contentPieceId: reel, stageKey: { $ne: 'Post' } }).sort({ stageOrder: 1 });
      expect(s.calendar).toBe('sm');
      await WorkItem.updateOne(
        { _id: s._id },
        { $set: { status: 'Feedback', ownerId: P.editor._id, isLocked: false, startedAt: new Date(), rounds: [{ roundNumber: 1, startedAt: new Date(), submittedAt: new Date(), intervals: [] }] } }
      );
      const v = await version(await WorkItem.findById(s._id));
      const before = await notes('growthLead');
      expect((await as('sm').patch(`/api/calendar-plans/${planId}/calendar`, { calendar: 'ads' })).status).toBe(200);
      expect(await notes('growthLead')).toBeGreaterThan(before);
      expect((await WorkItem.findById(s._id).lean()).calendar).toBe('ads');
      const queue = (await as('growthLead').get('/api/submissions/review-queue')).body.data.map((q) => String(q._id));
      expect(queue).toContain(String(v._id));
      const no = await as('creativeLead').post(`/api/submissions/${v._id}/approve`, { score: 4 });
      expect(no.body.error.code).toBe('WRONG_CALENDAR');
      expect((await as('growthLead').post(`/api/submissions/${v._id}/approve`, { score: 4 })).status).toBe(200);
    });
  });

  describe('Ads plan: whole-plan Request changes leaves approved rows alone', () => {
    let planId;
    let first;
    let second;

    beforeAll(async () => {
      const res = await saveRows('sm', 'ads', [
        { clientKey: 'a', cells: { postingDate: '2033-05-08', topic: `${TAG} Admissions ad`, type: 'Static Post', brief: 'Apply now.' } },
        { clientKey: 'b', cells: { postingDate: '2033-05-09', topic: `${TAG} Scholarship ad`, type: 'Static Post', brief: 'Scholarships.' } },
      ]);
      expect(res.status).toBe(201);
      planId = res.body.data.plan._id;
      [first, second] = res.body.data.results.map((r) => r.rowId);
      expect((await as('sm').post(`/api/calendar-plans/${planId}/submit`)).status).toBe(200);
      expect((await review('growthLead', planId, { action: 'approve_selected', approvedRowIds: [first] })).status).toBe(200);
    }, 60000);

    it('"reject" is retired (400); a whole-plan request needs a message', async () => {
      const r = await review('growthLead', planId, { action: 'reject', rejectionConcern: 'old' });
      expect(r.status).toBe(400);
      expect((await review('growthLead', planId, { action: 'request_changes_all', message: '  ' })).status).toBe(400);
      expect((await review('growthLead', planId, { action: 'request_changes_all' })).status).toBe(400);
      expect((await ContentPiece.findById(second).lean()).rowStatus).toBe('submitted');
    });

    it('the Growth Lead sends the plan back: submitted rows get the message, the approved row is untouched', async () => {
      const res = await review('growthLead', planId, { action: 'request_changes_all', message: 'Use the new offer price everywhere.' });
      expect(res.status).toBe(200);
      const rows = await grid('sm', 'ads');
      expect(rows[first].rowStatus).toBe('approved');
      expect(rows[first].changeRequest).toBeNull();
      expect(rows[second]).toMatchObject({ rowStatus: 'changes_requested', changeRequest: { message: 'Use the new offer price everywhere.', suggestions: {} } });
      // No suggestion to apply: the SM Manager edits by hand.
      expect((await as('sm').post(`/api/calendar-plans/${planId}/rows/${second}/apply-suggestion`)).status).toBe(400);
    });

    it('Submit plan resubmits the row in bulk: history per row, one combined notification to the Growth Lead', async () => {
      const edit = await saveRows('sm', 'ads', [{ rowId: second, cells: { brief: 'Scholarships, new offer price.' } }]);
      expect(edit.body.data.results[0].status).toBe('saved');
      const before = { gl: await notes('growthLead', { type: 'plan_submitted' }), cl: await notes('creativeLead', { type: 'plan_submitted' }) };
      expect((await as('sm').post(`/api/calendar-plans/${planId}/submit`)).status).toBe(200);
      expect(await notes('growthLead', { type: 'plan_submitted' })).toBe(before.gl + 1);
      expect(await notes('creativeLead', { type: 'plan_submitted' })).toBe(before.cl);
      const row = await ContentPiece.findById(second).lean();
      expect(row.rowStatus).toBe('submitted');
      expect(row.changeRequest).toBeNull();
      const h = await history(planId, second);
      expect(h.map((e) => e.action)).toEqual(['changes_requested', 'resubmitted']);
      expect(h[0].withPlan).toBe(true);
      expect(h[1].withPlan).toBe(true);
    });

    it('the Growth Lead approves the resubmitted row', async () => {
      expect((await review('creativeLead', planId, { action: 'approve_selected', approvedRowIds: [second] })).status).toBe(403);
      expect((await review('growthLead', planId, { action: 'approve_selected', approvedRowIds: [second] })).status).toBe(200);
      expect((await ContentPiece.findById(second).lean()).rowStatus).toBe('approved');
      expect((await history(planId, second)).map((e) => e.action)).toEqual(['changes_requested', 'resubmitted', 'approved']);
    });
  });
});
