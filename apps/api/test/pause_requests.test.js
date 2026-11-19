// Pause work with lead approval: requests, decisions by calendar, resume, work time (merged
// intervals), guards, reassignment, plan moves, reminders, Tracker and Work Detail data.
// Disposable test DB, synthetic people and steps.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import {
  BLOCKER_DEPENDENCY_REASONS,
  BLOCKER_REASONS,
  calculateIndividualWorkMeasures,
  calculateIntervalDurationInWindow,
  calculateIntervalDurationInWindowUnmerged,
  isWorkingDayIST,
  nextWorkingDayKeyIST,
  reworkTimeMs,
  stepTimeLabels,
  WORKING_DAYS_IST,
} from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { PauseRequest } from '../src/modules/workItems/pauseRequest.model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { Blocker } from '../src/modules/blockers/model.js';
import { runPauseReminders } from '../src/modules/workItems/pause.service.js';
import { pauseLaterSteps, resumePausedSteps } from '../src/modules/workItems/reopen.js';

const EMAIL = /@pause-req-test\.com$/;
const TAG = 'PAUSET';
const H = 3600000;

describe('Pause work with lead approval', () => {
  const P = {};
  const tokens = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (who) => ({
    get: (url, q) => request(app).get(url).query(q || {}).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url, body) => request(app).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url, body) => request(app).patch(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });
  const dept = new mongoose.Types.ObjectId();

  const step = (owner, extra = {}) =>
    WorkItem.create({
      title: `${TAG} ${extra.stageKey || 'Edit'} ${Math.round(Math.random() * 1e9)}`,
      workType: 'Reel',
      stageKey: 'Edit',
      stageOrder: 2,
      status: 'In Progress',
      isLocked: false,
      reviewRequired: true,
      calendar: 'sm',
      ownerId: P[owner]._id,
      departmentId: dept,
      deadline: new Date(Date.now() + 5 * 86400000),
      startedAt: new Date(Date.now() - 3 * H),
      rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 3 * H), intervals: [] }],
      ...extra,
    });
  const ask = (who, w, body = {}) => as(who).post(`/api/work/${w._id}/pause-request`, { reason: 'urgent_task', note: 'Launch video is due today', ...body });
  const decide = (who, w, decision, message) => as(who).post(`/api/work/${w._id}/pause-request/decide`, { decision, message });
  const fresh = (w) => WorkItem.findById(w._id).lean();
  const notes = (who, filter = {}) => Notification.countDocuments({ recipient: P[who]._id, ...filter });

  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG} `) }).select('_id').lean()).map((w) => w._id);
    await PauseRequest.deleteMany({ workItemId: { $in: steps } });
    await Blocker.deleteMany({ workItemId: { $in: steps } });
    await ActivityEvent.deleteMany({ entityId: { $in: [...steps, ...steps.map(String)] } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG} `) });
    await CalendarPlan.deleteMany({ title: new RegExp(`^${TAG} `) });
    await Notification.deleteMany({ recipient: { $in: ids } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    for (const [key, role] of [
      ['admin', 'admin'],
      ['creativeLead', 'creative_lead'],
      ['growthLead', 'growth_lead'],
      ['creativeHead', 'creative_head'],
      ['sm', 'sm_manager'],
      ['worker', 'executive'],
      ['other', 'executive'],
    ]) {
      P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@pause-req-test.com`, role, status: 'active' });
      tokens[key] = make(P[key]);
    }
  }, 60000);
  afterAll(cleanup, 60000);

  describe('The shared calculator merges overlapping intervals', () => {
    const t0 = new Date('2034-01-02T00:00:00Z');
    const at = (h) => new Date(t0.getTime() + h * H);
    it('blocked, reopen pause and manual pause overlapping are subtracted once', () => {
      const ivs = [
        { kind: 'blocked', startedAt: at(1), endedAt: at(3) },
        { kind: 'paused', startedAt: at(2), endedAt: at(5) },
        { kind: 'manual_pause', startedAt: at(4), endedAt: at(6) },
        { kind: 'manual_pause', startedAt: at(8), endedAt: null },
      ];
      expect(calculateIntervalDurationInWindow(ivs, at(0), at(10)) / H).toBe(7); // 1–6 and 8–10
      expect(calculateIntervalDurationInWindowUnmerged(ivs, at(0), at(10)) / H).toBe(9);
      const item = { status: 'In Progress', startedAt: at(0), rounds: [{ roundNumber: 1, startedAt: at(0), intervals: ivs }] };
      expect(calculateIndividualWorkMeasures(item, at(10)).workTimeMs / H).toBe(3);
      // Contained and identical intervals count once too.
      expect(calculateIntervalDurationInWindow([{ startedAt: at(1), endedAt: at(9) }, { startedAt: at(2), endedAt: at(3) }, { startedAt: at(1), endedAt: at(9) }], at(0), at(10)) / H).toBe(8);
    });
    it('rework time uses the same merged rule', () => {
      const item = {
        status: 'In Progress',
        rounds: [
          { roundNumber: 1, startedAt: at(0), submittedAt: at(1), decision: 'changes_requested' },
          { roundNumber: 2, startedAt: at(2), intervals: [{ kind: 'blocked', startedAt: at(3), endedAt: at(5) }, { kind: 'manual_pause', startedAt: at(4), endedAt: at(6) }] },
        ],
      };
      expect(reworkTimeMs(item, at(8)) / H).toBe(3); // 6h gross minus 3–6 merged
    });
    it('working days are Monday to Saturday (IST)', () => {
      expect([...WORKING_DAYS_IST]).toEqual([1, 2, 3, 4, 5, 6]);
      expect(isWorkingDayIST('2034-01-07T06:00:00Z')).toBe(true); // Saturday
      expect(isWorkingDayIST('2034-01-08T06:00:00Z')).toBe(false); // Sunday
      expect(nextWorkingDayKeyIST('2034-01-07T06:00:00Z')).toBe('2034-01-09'); // Saturday -> Monday
      expect(nextWorkingDayKeyIST('2034-01-04T06:00:00Z')).toBe('2034-01-05');
    });
  });

  describe('Requesting and cancelling', () => {
    it('only while In Progress: not started, waiting, blocked, locked or reopen-paused steps are refused', async () => {
      for (const extra of [
        { status: 'Not Started', startedAt: null, rounds: [] },
        { status: 'Feedback' },
        { status: 'Pending' },
        { status: 'Blocked' },
        { isLocked: true },
        { pausedBy: [new mongoose.Types.ObjectId()] },
      ]) {
        const w = await step('worker', extra);
        const r = await ask('worker', w);
        expect(r.status, JSON.stringify(extra)).toBe(409);
        expect((await fresh(w)).pauseState).toBeNull();
      }
    });

    it('the owner asks once; a second request, other people and bad input are refused', async () => {
      const w = await step('worker');
      expect((await ask('other', w)).status).toBe(404); // a worker not on the step
      expect((await ask('sm', w)).status).toBe(403);
      expect((await ask('worker', w, { reason: 'holiday' })).status).toBe(400);
      expect((await ask('worker', w, { note: '  ' })).status).toBe(400);
      expect((await ask('worker', w, { pauseUntil: '2020-01-01' })).status).toBe(400);
      const someoneElses = await step('other');
      expect((await ask('worker', w, { urgentStepId: String(someoneElses._id) })).body.error.code).toBe('INVALID_URGENT_STEP');
      const urgent = await step('worker', { stageKey: 'Script' });
      const ok = await ask('worker', w, { urgentStepId: String(urgent._id), pauseUntil: '2034-06-01' });
      expect(ok.status).toBe(201);
      expect(ok.body.data).toMatchObject({ status: 'pending', reason: 'urgent_task', pauseUntil: '2034-06-01' });
      expect((await fresh(w)).pauseState).toBe('requested');
      expect((await fresh(w)).status).toBe('In Progress');
      const again = await ask('worker', w);
      expect(again.status).toBe(409);
      expect(await PauseRequest.countDocuments({ workItemId: w._id, status: 'pending' })).toBe(1);
    });

    it('the owner can cancel a pending request; nothing to cancel is 409', async () => {
      const w = await step('worker');
      await ask('worker', w);
      expect((await as('creativeLead').post(`/api/work/${w._id}/pause-request/cancel`)).status).toBe(403);
      const r = await as('worker').post(`/api/work/${w._id}/pause-request/cancel`);
      expect(r.status).toBe(200);
      expect(r.body.data.status).toBe('cancelled');
      expect((await fresh(w)).pauseState).toBeNull();
      expect((await as('worker').post(`/api/work/${w._id}/pause-request/cancel`)).status).toBe(409);
      expect((await ask('worker', w)).status).toBe(201); // may ask again
    });
  });

  describe('Deciding: the lead of the step calendar', () => {
    it('wrong lead 403 WRONG_CALENDAR, worker and read-only head 403, right lead approves', async () => {
      const w = await step('worker');
      await ask('worker', w);
      const wrong = await decide('growthLead', w, 'approve');
      expect(wrong.status).toBe(403);
      expect(wrong.body.error.code).toBe('WRONG_CALENDAR');
      expect((await decide('other', w, 'approve')).status).toBe(404);
      const head = await decide('creativeHead', w, 'approve');
      expect(head.status).toBe(403);
      expect(head.body.error.code).toBe('READ_ONLY_ROLE');
      expect((await decide('sm', w, 'approve')).status).toBe(403);
      const ok = await decide('creativeLead', w, 'approve');
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('approved');
      const s = await fresh(w);
      expect(s.pauseState).toBe('paused');
      expect(s.status).toBe('In Progress');
      expect(s.intervals.filter((iv) => iv.kind === 'manual_pause' && !iv.endedAt)).toHaveLength(1);
      expect(s.rounds.at(-1).intervals.filter((iv) => iv.kind === 'manual_pause' && !iv.endedAt)).toHaveLength(1);
      expect(String(s.deadline)).toBe(String(w.deadline)); // due date unchanged
    });

    it('Ads steps go to the Growth Lead; admin decides any calendar; nobody decides their own request', async () => {
      const ads = await step('worker', { calendar: 'ads' });
      await ask('worker', ads);
      expect((await decide('creativeLead', ads, 'approve')).body.error.code).toBe('WRONG_CALENDAR');
      expect((await decide('growthLead', ads, 'reject', 'Finish first, it is due today')).status).toBe(200);
      const viaAdmin = await step('worker');
      await ask('worker', viaAdmin);
      expect((await decide('admin', viaAdmin, 'approve')).status).toBe(200);
      // The lead's own step: they cannot decide it; admin can.
      const leadOwn = await step('creativeLead');
      expect((await ask('creativeLead', leadOwn)).status).toBe(201);
      const self = await decide('creativeLead', leadOwn, 'approve');
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('FORBIDDEN_SELF_DECISION');
      expect((await decide('admin', leadOwn, 'approve')).status).toBe(200);
    });

    it('a step that is no longer In Progress at decision time returns 409', async () => {
      const w = await step('worker');
      await ask('worker', w);
      await WorkItem.updateOne({ _id: w._id }, { $set: { status: 'Feedback' } }); // submitted meanwhile
      const r = await decide('creativeLead', w, 'approve');
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('STEP_NOT_IN_PROGRESS');
      expect((await fresh(w)).pauseState).toBe('requested');
      expect((await fresh(w)).intervals.some((iv) => iv.kind === 'manual_pause')).toBe(false);
    });
  });

  describe('Work time', () => {
    it('pending and rejected: time keeps counting; approved: stops from approval; resumed: counts again', async () => {
      const w = await step('worker');
      await ask('worker', w);
      const afterAsk = await fresh(w);
      const t = Date.now();
      const m = (doc, ms) => calculateIndividualWorkMeasures(doc, new Date(ms)).workTimeMs;
      expect(m(afterAsk, t + H) - m(afterAsk, t)).toBe(H); // pending: counting
      await decide('creativeLead', w, 'reject', 'Not now');
      const rejected = await fresh(w);
      expect(rejected.pauseState).toBeNull();
      expect(m(rejected, t + 2 * H) - m(rejected, t + H)).toBe(H); // rejected: counting

      await ask('worker', w);
      await decide('creativeLead', w, 'approve');
      const paused = await fresh(w);
      const approvedAt = new Date(paused.intervals.find((iv) => iv.kind === 'manual_pause').startedAt).getTime();
      expect(m(paused, approvedAt + 3 * H)).toBe(m(paused, approvedAt)); // stopped from approval

      const resume = await as('worker').post(`/api/work/${w._id}/resume`);
      expect(resume.status).toBe(200);
      const running = await fresh(w);
      expect(running.pauseState).toBeNull();
      expect(running.intervals.every((iv) => iv.kind !== 'manual_pause' || iv.endedAt)).toBe(true);
      const now = Date.now();
      expect(m(running, now + H) - m(running, now)).toBe(H); // counting again
    });

    it('stays correct with blocked, reopen and manual pauses in the same step', async () => {
      const t0 = new Date('2034-02-01T00:00:00Z').getTime();
      const at = (h) => new Date(t0 + h * H);
      const w = await step('worker', {
        startedAt: at(0),
        rounds: [{ roundNumber: 1, startedAt: at(0), intervals: [] }],
        intervals: [],
      });
      await WorkItem.updateOne(
        { _id: w._id },
        {
          $set: {
            intervals: [
              { kind: 'blocked', startedAt: at(1), endedAt: at(2) },
              { kind: 'paused', startedAt: at(3), endedAt: at(6) },
              { kind: 'manual_pause', startedAt: at(4), endedAt: at(7) },
            ],
            'rounds.0.intervals': [
              { kind: 'blocked', startedAt: at(1), endedAt: at(2) },
              { kind: 'paused', startedAt: at(3), endedAt: at(6) },
              { kind: 'manual_pause', startedAt: at(4), endedAt: at(7) },
            ],
          },
        }
      );
      const doc = await fresh(w);
      // 10h gross minus 1–2 and 3–7 (merged) = 5h.
      expect(calculateIndividualWorkMeasures(doc, at(10)).workTimeMs / H).toBe(5);
    });
  });

  describe('Keeping the pause kinds apart', () => {
    it('a reopen pause and a manual pause on the same step do not end each other', async () => {
      const piece = await ContentPiece.create({ planId: new mongoose.Types.ObjectId(), topic: `${TAG} reopen piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 9 * 86400000), status: 'In Progress' });
      const earlier = await step('other', { stageKey: 'Script', stageOrder: 1, status: 'Approved', approvedAt: new Date(), contentPieceId: piece._id });
      const later = await step('worker', { stageKey: 'Edit', stageOrder: 2, contentPieceId: piece._id });
      await ask('worker', later);
      await decide('creativeLead', later, 'approve');

      // The earlier step is reopened: the later step also gets a reopen pause.
      await pauseLaterSteps(await WorkItem.findById(earlier._id));
      let s = await fresh(later);
      expect(s.pausedBy.map(String)).toEqual([String(earlier._id)]);
      expect(s.intervals.filter((iv) => !iv.endedAt).map((iv) => iv.kind).sort()).toEqual(['manual_pause', 'paused']);

      // Approved again: the reopen pause ends, the manual pause does not.
      await resumePausedSteps(await WorkItem.findById(earlier._id));
      s = await fresh(later);
      expect(s.intervals.filter((iv) => !iv.endedAt).map((iv) => iv.kind)).toEqual(['manual_pause']);
      expect(s.pauseState).toBe('paused');

      // Reopened again, then the worker resumes: only the manual pause ends.
      await pauseLaterSteps(await WorkItem.findById(earlier._id));
      expect((await as('worker').post(`/api/work/${later._id}/resume`)).status).toBe(200);
      s = await fresh(later);
      expect(s.intervals.filter((iv) => !iv.endedAt).map((iv) => iv.kind)).toEqual(['paused']);
      expect(s.pausedBy).toHaveLength(1);
    });

    it('unblocking closes only blocked and waiting intervals', async () => {
      const w = await step('worker', { status: 'Blocked' });
      const open = { startedAt: new Date(Date.now() - H), endedAt: null };
      await WorkItem.updateOne(
        { _id: w._id },
        { $set: { intervals: [{ kind: 'blocked', ...open }, { kind: 'paused', ...open }], 'rounds.0.intervals': [{ kind: 'blocked', ...open }, { kind: 'paused', ...open }] } }
      );
      const r = await as('worker').post(`/api/work/${w._id}/transition`, { toStatus: 'In Progress' });
      expect(r.status).toBe(200);
      const s = await fresh(w);
      expect(s.intervals.find((iv) => iv.kind === 'blocked').endedAt).toBeTruthy();
      expect(s.intervals.find((iv) => iv.kind === 'paused').endedAt).toBeNull();
      expect(s.rounds.at(-1).intervals.find((iv) => iv.kind === 'paused').endedAt).toBeNull();
    });

    it('a paused step refuses submitting, blocking and other moves until resumed', async () => {
      const w = await step('worker');
      await ask('worker', w);
      await decide('creativeLead', w, 'approve');
      const sub = await as('worker').post(`/api/work/${w._id}/submit-link`, { links: ['https://drive.google.com/file/d/pause-cut/view'] });
      expect(sub.status).toBe(409);
      expect(sub.body.error.code).toBe('STEP_MANUALLY_PAUSED');
      const reason = BLOCKER_REASONS.find((r) => !BLOCKER_DEPENDENCY_REASONS.includes(r));
      const block = await as('worker').post(`/api/work/${w._id}/transition`, { toStatus: 'Blocked', blockerReason: reason });
      expect(block.body.error.code).toBe('STEP_MANUALLY_PAUSED');
      const blocker = await as('worker').post('/api/blockers', { workItemId: String(w._id), reason, notes: 'x' });
      expect(blocker.body.error?.code).toBe('STEP_MANUALLY_PAUSED');
      expect((await ask('worker', w)).status).toBe(409);
      // Resume: the owner, a lead of the calendar, or admin; not the other lead, a head or another worker.
      expect((await as('growthLead').post(`/api/work/${w._id}/resume`)).status).toBe(403);
      expect((await as('creativeHead').post(`/api/work/${w._id}/resume`)).status).toBe(403);
      expect((await as('sm').post(`/api/work/${w._id}/resume`)).status).toBe(403);
      expect((await as('creativeLead').post(`/api/work/${w._id}/resume`)).status).toBe(200);
      expect((await as('creativeLead').post(`/api/work/${w._id}/resume`)).status).toBe(409);
      expect((await as('worker').post(`/api/work/${w._id}/submit-link`, { links: ['https://drive.google.com/file/d/pause-cut/view'] })).status).toBe(201);
    });
  });

  describe('History and notifications', () => {
    it('each change is logged; each person is told once', async () => {
      const w = await step('worker');
      const before = { cl: await notes('creativeLead'), gl: await notes('growthLead'), sm: await notes('sm'), worker: await notes('worker') };
      await ask('worker', w);
      expect(await notes('creativeLead', { type: 'pause_requested' })).toBeGreaterThan(0);
      expect(await notes('creativeLead')).toBe(before.cl + 1);
      expect(await notes('growthLead')).toBe(before.gl);
      await decide('creativeLead', w, 'reject', 'Finish this first');
      expect(await notes('worker')).toBe(before.worker + 1);
      expect(await notes('sm')).toBe(before.sm);
      await ask('worker', w);
      await decide('creativeLead', w, 'approve');
      expect(await notes('worker')).toBe(before.worker + 2);
      expect(await notes('sm')).toBe(before.sm + 1); // approved: the SM Manager too
      await as('worker').post(`/api/work/${w._id}/resume`);
      expect(await notes('creativeLead')).toBe(before.cl + 3); // two requests + resumed
      expect(await notes('sm')).toBe(before.sm + 2);
      expect(await notes('worker')).toBe(before.worker + 2); // not told about their own resume
      const actions = (await ActivityEvent.find({ entityId: { $in: [w._id, String(w._id)] }, action: /pause/ }).sort({ timestamp: 1 }).lean()).map((e) => e.action);
      expect(actions).toEqual(['work_item.pause_requested', 'work_item.pause_rejected', 'work_item.pause_requested', 'work_item.pause_approved', 'work_item.pause_resumed']);
    });

    it('reminders: the lead once on the next working day from 09:00 IST, the worker once on the pause-until morning', async () => {
      const w = await step('worker');
      await ask('worker', w);
      // Asked on Saturday 7 Jan 2034 (IST): the next working day is Monday 9 Jan.
      await PauseRequest.updateOne({ workItemId: w._id, status: 'pending' }, { $set: { requestedAt: new Date('2034-01-07T08:00:00Z') } });
      const reminders = () => notes('creativeLead', { type: 'pause_request_reminder', 'metadata.workItemId': w._id });
      await runPauseReminders(new Date('2034-01-08T06:00:00Z')); // Sunday
      await runPauseReminders(new Date('2034-01-09T02:00:00Z')); // Monday 07:30 IST
      expect(await reminders()).toBe(0);
      await runPauseReminders(new Date('2034-01-09T04:00:00Z')); // Monday 09:30 IST
      await runPauseReminders(new Date('2034-01-09T05:00:00Z'));
      expect(await reminders()).toBe(1);
      expect(await notes('growthLead', { type: 'pause_request_reminder', 'metadata.workItemId': w._id })).toBe(0);

      await decide('creativeLead', w, 'approve');
      await PauseRequest.updateOne({ workItemId: w._id, status: 'approved' }, { $set: { pauseUntil: '2034-01-10' } });
      const until = () => notes('worker', { type: 'pause_until_reminder', 'metadata.workItemId': w._id });
      await runPauseReminders(new Date('2034-01-09T05:00:00Z'));
      expect(await until()).toBe(0);
      await runPauseReminders(new Date('2034-01-10T04:00:00Z'));
      await runPauseReminders(new Date('2034-01-10T06:00:00Z'));
      expect(await until()).toBe(1);
      expect((await fresh(w)).pauseState).toBe('paused'); // never ends automatically
    });
  });

  describe('Submitting withdraws a pending request', () => {
    const withdrawn = (who, w) => notes(who, { type: 'pause_withdrawn', 'metadata.workItemId': w._id });

    it('submit-link: the request is cancelled "on submit", logged, and the lead told once', async () => {
      const w = await step('worker');
      await ask('worker', w);
      const sub = await as('worker').post(`/api/work/${w._id}/submit-link`, { links: ['https://drive.google.com/file/d/pause-submit/view'] });
      expect(sub.status).toBe(201);
      const s = await fresh(w);
      expect(s.status).toBe('Feedback');
      expect(s.pauseState).toBeNull();
      const r = await PauseRequest.findOne({ workItemId: w._id }).lean();
      expect(r).toMatchObject({ status: 'cancelled', cancelReason: 'cancelled_on_submit' });
      const ev = await ActivityEvent.findOne({ entityId: { $in: [w._id, String(w._id)] }, action: 'work_item.pause_cancelled' }).lean();
      expect(ev.metadata.cancelReason).toBe('cancelled_on_submit');
      expect(await withdrawn('creativeLead', w)).toBe(1);
      expect(await withdrawn('growthLead', w)).toBe(0);
      expect(await withdrawn('worker', w)).toBe(0);
      // Nothing left to decide.
      expect((await decide('creativeLead', w, 'approve')).body.error.code).toBe('NOT_PENDING');
    });

    it('posting a Post step withdraws it too (Ads: the Growth Lead is told)', async () => {
      const post = await step('sm', { stageKey: 'Post', calendar: 'ads', reviewRequired: false });
      expect((await ask('sm', post)).status).toBe(201);
      const res = await as('sm').post(`/api/work/${post._id}/transition`, { toStatus: 'Published', publishedUrl: 'https://www.instagram.com/reel/C8xYz12AbCd/' });
      expect(res.status).toBe(200);
      expect((await fresh(post)).pauseState).toBeNull();
      expect((await PauseRequest.findOne({ workItemId: post._id }).lean()).cancelReason).toBe('cancelled_on_submit');
      expect(await withdrawn('growthLead', post)).toBe(1);
      expect(await withdrawn('creativeLead', post)).toBe(0);
    });

    it('a submit without a pending request changes no request and tells nobody', async () => {
      const w = await step('worker');
      const before = await Notification.countDocuments({ type: 'pause_withdrawn', 'metadata.workItemId': w._id });
      expect((await as('worker').post(`/api/work/${w._id}/submit-link`, { links: ['https://drive.google.com/file/d/pause-none/view'] })).status).toBe(201);
      expect(await PauseRequest.countDocuments({ workItemId: w._id })).toBe(0);
      expect(await Notification.countDocuments({ type: 'pause_withdrawn', 'metadata.workItemId': w._id })).toBe(before);
    });
  });

  describe('Reassignment and plan moves', () => {
    it('reassigning cancels a pending request and tells the old owner; a paused step stays paused for the new owner', async () => {
      const w = await step('worker');
      await ask('worker', w);
      const before = await notes('worker', { type: 'pause_cancelled' });
      expect((await as('admin').patch(`/api/work/${w._id}`, { ownerId: String(P.other._id) })).status).toBe(200);
      expect(await notes('worker', { type: 'pause_cancelled' })).toBe(before + 1);
      expect((await PauseRequest.findOne({ workItemId: w._id }).lean()).cancelReason).toBe('reassigned');
      expect((await fresh(w)).pauseState).toBeNull();

      const p = await step('worker');
      await ask('worker', p);
      await decide('creativeLead', p, 'approve');
      await as('admin').patch(`/api/work/${p._id}`, { ownerId: String(P.other._id) });
      expect((await fresh(p)).pauseState).toBe('paused');
      expect((await as('worker').post(`/api/work/${p._id}/resume`)).status).toBe(404); // no longer on the step
      expect((await as('other').post(`/api/work/${p._id}/resume`)).status).toBe(200);
    });

    it('a plan moved to Ads sends its pending requests to the Growth Lead', async () => {
      const plan = await CalendarPlan.create({ code: `PT-${Date.now()}`, title: `${TAG} plan`, calendar: 'sm', kind: 'monthly', periodStart: new Date('2034-03-01'), periodEnd: new Date('2034-03-31'), createdById: P.sm._id });
      const w = await step('worker', { calendarPlanId: plan._id });
      await ask('worker', w);
      const before = await notes('growthLead', { 'metadata.workItemId': w._id });
      expect((await as('sm').patch(`/api/calendar-plans/${plan._id}/calendar`, { calendar: 'ads' })).status).toBe(200);
      expect(await notes('growthLead', { 'metadata.workItemId': w._id })).toBe(before + 1);
      expect((await decide('creativeLead', w, 'approve')).body.error.code).toBe('WRONG_CALENDAR');
      expect((await decide('growthLead', w, 'approve')).status).toBe(200);
    });
  });

  describe('Reads', () => {
    it('the lead list shows each lead their calendars; admin sees all', async () => {
      const sm = await step('worker');
      const ads = await step('worker', { calendar: 'ads' });
      await ask('worker', sm);
      await ask('worker', ads);
      const ids = async (who) => (await as(who).get('/api/work/pause-requests')).body.data.map((r) => r.workItem._id);
      expect(await ids('creativeLead')).toContain(String(sm._id));
      expect(await ids('creativeLead')).not.toContain(String(ads._id));
      expect(await ids('growthLead')).toContain(String(ads._id));
      expect(await ids('growthLead')).not.toContain(String(sm._id));
      expect(await ids('admin')).toEqual(expect.arrayContaining([String(sm._id), String(ads._id)]));
      const mine = await ids('worker');
      expect(mine).toEqual(expect.arrayContaining([String(sm._id), String(ads._id)]));
      expect(await ids('other')).not.toContain(String(sm._id));
      const head = (await as('creativeHead').get('/api/work/pause-requests')).body.data;
      expect(head.find((r) => r.workItem._id === String(sm._id)).canDecide).toBe(false);
    });

    it('Work Detail: state, permissions, "Paused N times · total"; a paused overdue step shows Overdue and Paused', async () => {
      const w = await step('worker', { deadline: new Date(Date.now() - 3 * 86400000) });
      await ask('worker', w);
      let wd = (await as('worker').get(`/api/work/${w._id}`)).body.data;
      expect(wd.pause).toMatchObject({ state: 'requested', canCancel: true, canRequest: false, canDecide: false, count: 0 });
      expect(wd.pause.request).toMatchObject({ reasonLabel: 'Urgent task', note: 'Launch video is due today' });
      const lead = (await as('creativeLead').get(`/api/work/${w._id}`)).body.data;
      expect(lead.pause.canDecide).toBe(true);
      const head = (await as('creativeHead').get(`/api/work/${w._id}`)).body.data;
      expect(head.pause).toMatchObject({ state: 'requested', canDecide: false, canResume: false });
      await decide('creativeLead', w, 'approve');
      wd = (await as('worker').get(`/api/work/${w._id}`)).body.data;
      expect(wd.pause).toMatchObject({ state: 'paused', canResume: true, count: 1 });
      expect(wd.timeLabels.map((l) => l.kind)).toEqual(expect.arrayContaining(['overdue', 'paused']));
      expect(stepTimeLabels({ status: 'In Progress', pauseState: 'paused' }).map((l) => l.kind)).toEqual(['paused']);
    });

    it('Tracker stages carry the pause state and reason', async () => {
      const piece = await ContentPiece.create({ planId: new mongoose.Types.ObjectId(), topic: `${TAG} tracker piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(), status: 'In Progress', calendar: 'sm' });
      const w = await step('worker', { contentPieceId: piece._id, stageOrder: 1 });
      await ask('worker', w, { reason: 'other', note: 'Doctor visit' });
      await decide('creativeLead', w, 'approve');
      const res = await as('admin').get('/api/content-pieces');
      const row = (res.body.data || []).find((p) => String(p._id) === String(piece._id));
      expect(row.hasPaused).toBe(true);
      const st = row.stages.find((s) => String(s._id) === String(w._id));
      expect(st.pauseState).toBe('paused');
      expect(st.pauseReason).toBe('Other: Doctor visit');
    });
  });
});
