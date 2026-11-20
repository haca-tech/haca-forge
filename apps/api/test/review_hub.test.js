// Review Hub: round-4 flags on every revision path, the switched FeedbackEntry readers, the
// retired Feedback-page writes, the inbox (tabs, counts, scope) and the step timeline.
// Disposable test DB, synthetic people, steps and versions.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { Submission, Rating } from '../src/modules/submissions/model.js';
import { FeedbackEntry, RevisionFlag } from '../src/modules/feedback/model.js';
import { MediaItem } from '../src/modules/media/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { PauseRequest } from '../src/modules/workItems/pauseRequest.model.js';
import { checkAndCreateRevisionFlag, revisionCycleOf } from '../src/modules/feedback/service.js';
import { buildAutofillContext, autofillRowPlan } from '../src/modules/calendar/autofill.service.js';
import { calculatePersonPerformance, calculateTeamPerformance } from '../src/modules/people/metrics.js';
import { revisionNoteFor } from '../src/modules/workItems/reviewState.js';
import { revisionsLabel } from '../src/modules/reviewHub/service.js';
import { recommendAssignee } from '../src/modules/assignment/service.js';

const EMAIL = /@review-hub-test\.com$/;
const TAG = 'RHUBT';
const H = 3600000;

describe('Review Hub', () => {
  const P = {};
  const tokens = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (who) => ({
    get: (url, q) => request(app).get(url).query(q || {}).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url, body) => request(app).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });
  const dept = new mongoose.Types.ObjectId();
  const ago = (h) => new Date(Date.now() - h * H);

  /** A step with `changes` earlier change-request rounds and a current round in `status`. */
  async function step(owner, { calendar = 'sm', stageKey = 'Edit', status = 'Feedback', changes = 0, title, version = true, extra = {} } = {}) {
    const rounds = [];
    for (let i = 0; i < changes; i++) rounds.push({ roundNumber: i + 1, startedAt: ago(30 - i * 5), submittedAt: ago(29 - i * 5), decisionAt: ago(28 - i * 5), decision: 'changes_requested' });
    rounds.push({ roundNumber: changes + 1, startedAt: ago(6), submittedAt: status === 'In Progress' ? null : ago(5) });
    const w = await WorkItem.create({
      title: `${TAG} ${title || `${stageKey} ${Math.round(Math.random() * 1e9)}`}`,
      workType: 'Reel',
      stageKey,
      stageOrder: 1,
      status,
      isLocked: false,
      reviewRequired: true,
      calendar,
      ownerId: P[owner]._id,
      departmentId: dept,
      deadline: new Date(Date.now() + 5 * 86400000),
      startedAt: ago(30),
      revisions: changes,
      rounds,
      ...extra,
    });
    if (version && status !== 'In Progress') {
      for (let i = 0; i < changes; i++) {
        await Submission.create({ workItemId: w._id, stageKey, version: i + 1, kind: 'link', status: 'changes_requested', submittedById: P[owner]._id, submittedAt: ago(29 - i * 5), reviewedAt: ago(28 - i * 5), reviewedById: P.creativeLead._id, linkUrl: `https://drive.google.com/file/d/v${i + 1}` });
      }
      await Submission.create({ workItemId: w._id, stageKey, version: changes + 1, kind: 'link', status: 'submitted', submittedById: P[owner]._id, submittedAt: ago(5), linkUrl: `https://drive.google.com/file/d/v${changes + 1}` });
    }
    return w;
  }
  const latest = (w) => Submission.findOne({ workItemId: w._id, version: { $gt: 0 } }).sort({ version: -1 });
  const flagNotes = (who, w) => Notification.countDocuments({ recipient: P[who]._id, type: 'revision.flagged', 'metadata.workItemId': w._id });

  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG} `) }).select('_id').lean()).map((w) => w._id);
    const subs = (await Submission.find({ workItemId: { $in: steps } }).select('_id').lean()).map((s) => s._id);
    await ActivityEvent.deleteMany({ entityId: { $in: [...steps, ...steps.map(String), ...subs, ...subs.map(String)] } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await RevisionFlag.deleteMany({ workItemId: { $in: steps } });
    await FeedbackEntry.deleteMany({ workItemId: { $in: steps } });
    await MediaItem.deleteMany({ stageItemId: { $in: steps } });
    await PauseRequest.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG} `) });
    await Notification.deleteMany({ recipient: { $in: ids } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    for (const [key, role, extra] of [
      ['admin', 'admin'],
      ['creativeLead', 'creative_lead'],
      ['growthLead', 'growth_lead'],
      ['creativeHead', 'creative_head'],
      ['sm', 'sm_manager', { departmentId: dept }],
      ['worker', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'] }],
      ['other', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'] }],
    ]) {
      P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@review-hub-test.com`, role, status: 'active', ...(extra || {}) });
      tokens[key] = make(P[key]);
    }
  }, 60000);
  afterAll(cleanup, 60000);

  describe('Round-4 flags on every revision path', () => {
    it('Review Studio (request-revision): the third change request flags once and alerts the right lead once', async () => {
      const w = await step('worker', { changes: 2 });
      const r = await as('creativeLead').post(`/api/submissions/${(await latest(w))._id}/request-revision`, { comment: 'Cut the intro', rootCause: 'Brief unclear' });
      expect(r.status).toBe(200);
      const flag = await RevisionFlag.findOne({ workItemId: w._id }).lean();
      expect(flag).toMatchObject({ isFlagged: true, revisionsCount: 3, cycle: 0 });
      expect(await flagNotes('creativeLead', w)).toBe(1);
      expect(await flagNotes('growthLead', w)).toBe(0);
      expect(await flagNotes('sm', w)).toBe(1); // the department's SM Manager, as before
      // A fourth change request in the same cycle: no new flag, no new alert.
      await WorkItem.updateOne({ _id: w._id }, { $set: { status: 'Feedback' }, $push: { rounds: { roundNumber: 4, startedAt: new Date(), submittedAt: new Date() } } });
      await Submission.create({ workItemId: w._id, stageKey: 'Edit', version: 4, kind: 'link', status: 'submitted', submittedById: P.worker._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/v4' });
      expect((await as('creativeLead').post(`/api/submissions/${(await latest(w))._id}/request-revision`, { comment: 'Still long', rootCause: 'Brief unclear' })).status).toBe(200);
      expect(await RevisionFlag.countDocuments({ workItemId: w._id })).toBe(1);
      expect(await flagNotes('creativeLead', w)).toBe(1);
      expect((await RevisionFlag.findOne({ workItemId: w._id }).lean()).revisionsCount).toBe(4);
    });

    it('below round 4 nothing is flagged', async () => {
      const w = await step('worker', { changes: 1 });
      await as('creativeLead').post(`/api/submissions/${(await latest(w))._id}/request-revision`, { comment: 'Again', rootCause: 'Brief unclear' });
      expect(await RevisionFlag.countDocuments({ workItemId: w._id })).toBe(0);
    });

    it('Work Detail "Request Rework" on an Ads step (the version endpoint): flags once and alerts the Growth Lead once', async () => {
      const w = await step('worker', { calendar: 'ads', changes: 2 });
      const r = await as('growthLead').post(`/api/submissions/${(await latest(w))._id}/request-revision`, { comment: 'Wrong offer price', feedback: 'Wrong offer price', rootCause: 'Brief unclear' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await RevisionFlag.countDocuments({ workItemId: w._id })).toBe(1);
      expect(await flagNotes('growthLead', w)).toBe(1);
      expect(await flagNotes('creativeLead', w)).toBe(0);
    });

    it('Work Detail on a step without review (the transition fallback): flags once', async () => {
      const w = await step('worker', { status: 'Pending', changes: 2, version: false, extra: { reviewRequired: false } });
      const r = await as('creativeLead').post(`/api/work/${w._id}/transition`, { toStatus: 'Feedback', comment: 'Redo the caption' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await RevisionFlag.countDocuments({ workItemId: w._id })).toBe(1);
      expect(await flagNotes('creativeLead', w)).toBe(1);
    });

    it('Shoot review (a clip needs a reshoot): flags once', async () => {
      const w = await step('worker', { stageKey: 'Shoot', changes: 2 });
      await MediaItem.create({ stageItemId: w._id, url: 'https://drive.google.com/file/d/clip-a', title: 'Clip A', status: 'reshoot_needed' });
      const r = await as('creativeLead').post(`/api/work/${w._id}/shoot-review`, { note: 'Reshoot the wide' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(await RevisionFlag.countDocuments({ workItemId: w._id })).toBe(1);
      expect(await flagNotes('creativeLead', w)).toBe(1);
    });

    it('a flag write failure never fails the decision', async () => {
      const w = await step('worker', { changes: 2 });
      const spy = vi.spyOn(RevisionFlag, 'create').mockRejectedValueOnce(new Error('flag store down'));
      const r = await as('creativeLead').post(`/api/submissions/${(await latest(w))._id}/request-revision`, { comment: 'Fix audio', rootCause: 'Brief unclear' });
      spy.mockRestore();
      expect(r.status).toBe(200);
      expect((await WorkItem.findById(w._id).lean()).revisions).toBe(3);
      expect((await latest(w)).status).toBe('changes_requested');
      expect(await RevisionFlag.countDocuments({ workItemId: w._id })).toBe(0);
    });

    it('counts rounds per cycle: a reopened step that reaches round 4 again is flagged again (earlier crossing kept)', async () => {
      const r = (decision) => ({ roundNumber: 1, startedAt: ago(10), submittedAt: ago(9), decisionAt: ago(8), decision });
      const base = await step('worker', { changes: 0, status: 'In Progress', version: false });
      const doc = (rounds) => ({ ...base.toObject(), rounds, revisions: rounds.filter((x) => x.decision === 'changes_requested').length });
      const cycle0 = [r('changes_requested'), r('changes_requested'), r('changes_requested')];
      expect(revisionCycleOf(doc(cycle0))).toEqual({ cycle: 0, changeRequests: 3, round: 4 });
      await checkAndCreateRevisionFlag(doc(cycle0));
      await checkAndCreateRevisionFlag(doc(cycle0));
      expect(await flagNotes('creativeLead', base)).toBe(1);
      await RevisionFlag.updateOne({ workItemId: base._id }, { $set: { rootCause: 'Brief unclear', classifiedAt: new Date() } });
      // Approved, reopened: the next cycle starts after the approval.
      const reopened = [...cycle0, r('approved'), r('changes_requested'), r('changes_requested')];
      expect(revisionCycleOf(doc(reopened))).toEqual({ cycle: 1, changeRequests: 2, round: 3 });
      await checkAndCreateRevisionFlag(doc(reopened));
      expect(await flagNotes('creativeLead', base)).toBe(1);
      const crossing2 = [...reopened, r('changes_requested')];
      await checkAndCreateRevisionFlag(doc(crossing2));
      const flag = await RevisionFlag.findOne({ workItemId: base._id }).lean();
      expect(flag).toMatchObject({ cycle: 1, revisionsCount: 3, rootCause: null });
      expect(flag.previousCrossings).toHaveLength(1);
      expect(flag.previousCrossings[0]).toMatchObject({ cycle: 0, rootCause: 'Brief unclear' });
      expect(await flagNotes('creativeLead', base)).toBe(2);
      expect(await RevisionFlag.countDocuments({ workItemId: base._id })).toBe(1);
    });
  });

  describe('Readers switched to the real review data', () => {
    it('autofill: revision count never changes a suggestion (eligibility, availability and workload only)', async () => {
      // Two equally loaded editors: the shared rule breaks the tie by name (editorA).
      for (const key of ['editorA', 'editorB']) {
        P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@review-hub-test.com`, role: 'executive', status: 'active', jobRole: 'Video Editor', workPreferences: ['Edit'], weeklyCapacityHours: 40 });
      }
      const pair = async () => {
        const ctx = await buildAutofillContext();
        return { candidates: ctx.candidates.filter((c) => [String(P.editorA._id), String(P.editorB._id)].includes(String(c.member._id))) };
      };
      const postingDate = new Date(Date.now() + 10 * 86400000);
      const suggest = async () => {
        const plan = await autofillRowPlan({ type: 'Reel', postingDate, context: await pair() });
        return plan.stages.find((st) => st.stageKey === 'Edit');
      };
      const before = await suggest();
      expect(before.ownerId).toBeTruthy();
      const first = Object.keys(P).find((k) => ['editorA', 'editorB'].includes(k) && String(P[k]._id) === before.ownerId);
      // Five change requests in the last 90 days on the suggested person's versions, on a closed
      // step (so their workload is unchanged), plus an old Feedback-page entry naming them.
      const closed = await step(first, { status: 'Approved', changes: 5 });
      await FeedbackEntry.create({ workItemId: closed._id, round: 1, fromPersonId: P.creativeLead._id, roundStatus: 'Revision Required', text: 'Old note', isResponse: false, attachments: [{ name: 'cut.mp4', fromPersonId: P[first]._id, url: 'https://example.invalid/a' }] });
      expect(await Submission.countDocuments({ submittedById: P[first]._id, status: 'changes_requested' })).toBe(5);
      const after = await suggest();
      expect(after).toEqual(before);
      expect(after.reason).toMatch(/^Fewest due /);
      expect((await pair()).candidates.every((c) => !('revisionsCount' in c))).toBe(true);
    });

    it('Recommended Owner: revision history never changes the recommendation (eligibility, availability and workload only)', async () => {
      // Two editors with more free hours than anyone else, equally loaded: the tie goes by name (recA).
      for (const key of ['recA', 'recB']) {
        P[key] = await Person.create({ name: `0 ${TAG} ${key}`, email: `${key}@review-hub-test.com`, role: 'executive', status: 'active', jobRole: 'Video Editor', workPreferences: ['Edit'], weeklyCapacityHours: 168 });
      }
      const before = await recommendAssignee({ stageKey: 'Edit', estimatedEffortHrs: 4 }, P.admin);
      expect(String(before.recommendedPerson._id)).toBe(String(P.recA._id));
      const first = ['recA', 'recB'].find((k) => String(P[k]._id) === String(before.recommendedPerson._id));
      // Closed steps with many revisions for the recommended person (closed, so workload is unchanged).
      for (let i = 0; i < 3; i++) {
        const done = await step(first, { status: 'Approved', changes: 0 });
        await WorkItem.updateOne({ _id: done._id }, { $set: { revisions: 6 } });
      }
      expect(await WorkItem.countDocuments({ ownerId: P[first]._id, revisions: 6 })).toBe(3);
      const after = await recommendAssignee({ stageKey: 'Edit', estimatedEffortHrs: 4 }, P.admin);
      expect(String(after.recommendedPerson._id)).toBe(String(before.recommendedPerson._id));
      expect(after.rationale).toBe(before.rationale);
      expect(after.rationale).not.toMatch(/rev/i);
      expect('avgRevisions' in after.recommendedMetrics).toBe(false);
      expect(after.candidatePool.every((c) => !('avgRevisions' in c))).toBe(true);
    });

    it('Recommended Owner, autofill and import agree on the same person', async () => {
      const plan = await autofillRowPlan({ type: 'Reel', postingDate: new Date(Date.now() + 10 * 86400000) });
      const edit = plan.stages.find((st) => st.stageKey === 'Edit');
      const rec = await recommendAssignee({ stageKey: 'Edit', deadline: edit.dueDate }, P.admin);
      expect(edit.ownerId).toBe(String(rec.recommendedPerson._id));
    });

    it('reviewer turnaround: submit to decision on the versions the person decided', async () => {
      const subs = await Submission.find({ reviewedById: P.creativeLead._id, version: { $gt: 0 }, status: { $in: ['approved', 'changes_requested'] }, submittedAt: { $ne: null }, reviewedAt: { $ne: null } }).lean();
      expect(subs.length).toBeGreaterThan(0);
      const avg = subs.reduce((t, s) => t + Math.max((new Date(s.reviewedAt) - new Date(s.submittedAt)) / H, 0.5), 0) / subs.length;
      const perf = await calculatePersonPerformance(P.creativeLead._id, {}, { role: 'admin', _id: P.admin._id });
      expect(perf.dimensions.collaboration?.avgFeedbackResponseTimeHrs ?? JSON.stringify(perf).match(/"avgFeedbackResponseTimeHrs":([\d.]+)/)[1] * 1).toBeCloseTo(Number(avg.toFixed(1)), 5);
    });

    it('reviewer turnaround is the lead own figure only: the team list never sets it beside others', async () => {
      const team = await calculateTeamPerformance({}, { role: 'admin', _id: P.admin._id });
      const lead = team.members.find((m) => String(m.person._id) === String(P.creativeLead._id));
      expect(lead).toBeTruthy();
      expect(team.members.every((m) => !('avgFeedbackResponseTimeHrs' in m.dimensions.collaboration))).toBe(true);
      expect(JSON.stringify(team)).not.toContain('avgFeedbackResponseTimeHrs');
      // Still on the lead's own performance view.
      const own = await calculatePersonPerformance(P.creativeLead._id, {}, { role: 'admin', _id: P.admin._id });
      expect(typeof own.dimensions.collaboration.avgFeedbackResponseTimeHrs).toBe('number');
    }, 120000);

    it('reviewer note: the revision event first; an old entry only when nothing else has the message', async () => {
      const w = await step('worker', { changes: 0 });
      const v = await latest(w);
      await as('creativeLead').post(`/api/submissions/${v._id}/request-revision`, { comment: 'Use the new logo', rootCause: 'Brief unclear' });
      await FeedbackEntry.create({ workItemId: w._id, round: 1, fromPersonId: P.creativeLead._id, roundStatus: 'Revision Required', text: 'Old note', isResponse: false });
      const note = await revisionNoteFor(await WorkItem.findById(w._id).lean(), await latest(w));
      expect(note.text).toBe('Use the new logo');
      // No event and no status event: the old entry is used.
      const old = await step('worker', { changes: 0 });
      const ov = await latest(old);
      await Submission.updateOne({ _id: ov._id }, { $set: { status: 'changes_requested', reviewedAt: new Date() } });
      await FeedbackEntry.create({ workItemId: old._id, round: 1, fromPersonId: P.creativeLead._id, roundStatus: 'Revision Required', text: 'Only in the old entry', isResponse: false });
      expect((await revisionNoteFor(await WorkItem.findById(old._id).lean(), await latest(old))).text).toBe('Only in the old entry');
    });
  });

  describe('Retired Feedback-page writes', () => {
    it('return 410 with where to go; FeedbackEntry data is untouched', async () => {
      const w = await step('worker');
      await FeedbackEntry.create({ workItemId: w._id, round: 1, fromPersonId: P.creativeLead._id, roundStatus: 'Revision Required', text: 'Kept', isResponse: false });
      const before = await FeedbackEntry.countDocuments({});
      const lead = await as('creativeLead').post(`/api/feedback/work-item/${w._id}`, { roundStatus: 'Revision Required', text: 'x', isResponse: false });
      expect(lead.status).toBe(410);
      expect(lead.body.error).toMatchObject({ code: 'FEEDBACK_REVISION_RETIRED' });
      expect(lead.body.error.message).toMatch(/Use Review Studio/);
      const reply = await as('worker').post(`/api/feedback/work-item/${w._id}`, { round: 1, text: 'done', isResponse: true });
      expect(reply.status).toBe(410);
      expect(reply.body.error.message).toMatch(/Use Resubmit/);
      expect((await as('creativeLead').post('/api/feedback', { workItemId: String(w._id), text: 'x' })).status).toBe(410);
      expect(await FeedbackEntry.countDocuments({})).toBe(before);
      expect((await FeedbackEntry.findOne({ workItemId: w._id }).lean()).text).toBe('Kept');
      expect((await WorkItem.findById(w._id).lean()).status).toBe('Feedback');
    });
  });

  describe('Timeline', () => {
    it('two versions, a rework, a pause and an approval, oldest first, from the real records', async () => {
      const w = await step('worker', { status: 'In Progress', version: false, title: 'Timeline reel' });
      await FeedbackEntry.create({ workItemId: w._id, round: 1, fromPersonId: P.creativeLead._id, roundStatus: 'Revision Required', text: 'An old note', isResponse: false, createdAt: ago(40) });
      expect((await as('worker').post(`/api/work/${w._id}/submit-link`, { links: ['https://drive.google.com/file/d/tl-v1/view'], note: 'First cut' })).status).toBe(201);
      expect((await as('creativeLead').post(`/api/submissions/${(await latest(w))._id}/request-revision`, { comment: 'Shorter hook', rootCause: 'Brief unclear' })).status).toBe(200);
      expect((await as('worker').post(`/api/work/${w._id}/transition`, { toStatus: 'In Progress' })).status).toBe(200);
      expect((await as('worker').post(`/api/work/${w._id}/pause-request`, { reason: 'urgent_task', note: 'Launch video' })).status).toBe(201);
      expect((await as('creativeLead').post(`/api/work/${w._id}/pause-request/decide`, { decision: 'approve' })).status).toBe(200);
      expect((await as('worker').post(`/api/work/${w._id}/resume`)).status).toBe(200);
      expect((await as('worker').post(`/api/work/${w._id}/submit-link`, { links: ['https://drive.google.com/file/d/tl-v2/view'] })).status).toBe(201);
      expect((await as('creativeLead').post(`/api/submissions/${(await latest(w))._id}/approve`, { score: 5, feedback: 'Great hook now' })).status).toBe(200);

      const res = await as('creativeHead').get(`/api/review-hub/steps/${w._id}/timeline`);
      expect(res.status).toBe(200);
      const ev = res.body.data.events;
      expect(ev.map((e) => e.kind)).toEqual(['earlier_note', 'submitted', 'changes_requested', 'rework_started', 'pause_requested', 'pause_approved', 'pause_resumed', 'submitted', 'approved']);
      expect(ev[1]).toMatchObject({ version: 1, note: 'First cut', by: `${TAG} worker` });
      expect(ev[1].links[0].url).toBe('https://drive.google.com/file/d/tl-v1/view');
      expect(ev[2]).toMatchObject({ by: `${TAG} creativeLead`, message: 'Shorter hook', rootCause: 'Brief unclear' });
      expect(ev[8]).toMatchObject({ version: 2, rating: 5, message: 'Great hook now', by: `${TAG} creativeLead` });
      expect(ev[0]).toMatchObject({ message: 'An old note' });
      expect(res.body.data.step).toMatchObject({ revisionsLabel: '1 revision', version: 2, status: 'Approved' });
      expect(res.body.data.mainAction.kind).toBe('open_work_detail'); // read-only head
      // Workers see only their own steps.
      expect((await as('other').get(`/api/review-hub/steps/${w._id}/timeline`)).status).toBe(404);
      const own = (await as('worker').get(`/api/review-hub/steps/${w._id}/timeline`)).body.data;
      expect(own.events.find((e) => e.kind === 'approved').message).toBe('Great hook now');
    });

    it('the main action follows state and role', async () => {
      const action = async (who, w) => (await as(who).get(`/api/review-hub/steps/${w._id}/timeline`)).body.data.mainAction;
      const waiting = await step('worker');
      expect(await action('creativeLead', waiting)).toMatchObject({ kind: 'open_review_studio', href: `/feedback/review-studio?submissionId=${(await latest(waiting))._id}` });
      expect((await action('growthLead', waiting)).kind).toBe('open_work_detail'); // not their calendar
      expect((await action('creativeHead', waiting)).kind).toBe('open_work_detail');
      expect((await action('worker', waiting)).kind).toBe('open_work_detail');
      await as('creativeLead').post(`/api/submissions/${(await latest(waiting))._id}/request-revision`, { comment: 'x', rootCause: 'Brief unclear' });
      expect((await action('worker', waiting)).kind).toBe('start_rework');
      await as('worker').post(`/api/work/${waiting._id}/transition`, { toStatus: 'In Progress' });
      expect((await action('worker', waiting)).kind).toBe('resubmit');
      const flagged = await step('worker', { changes: 2 });
      await as('creativeLead').post(`/api/submissions/${(await latest(flagged))._id}/request-revision`, { comment: 'x', rootCause: 'Brief unclear' });
      expect(await action('creativeLead', flagged)).toMatchObject({ kind: 'classify' });
      expect((await action('creativeHead', flagged)).kind).toBe('open_work_detail');
    });
  });

  describe('Inbox', () => {
    it('tabs and counts per role and calendar; search and calendar filter; oldest waiting first', async () => {
      const q = `${TAG} inbox`;
      const smOld = await step('worker', { title: 'inbox sm old' });
      await Submission.updateOne({ workItemId: smOld._id }, { $set: { submittedAt: ago(48) } });
      const smNew = await step('worker', { title: 'inbox sm new' });
      const ads = await step('other', { calendar: 'ads', title: 'inbox ads' });
      const done = await step('worker', { title: 'inbox sm done' });
      await Submission.updateOne({ workItemId: done._id }, { $set: { status: 'approved', reviewedAt: ago(1), reviewedById: P.creativeLead._id } });
      await WorkItem.updateOne({ _id: done._id }, { $set: { status: 'Approved', approvedAt: ago(1) } });
      const sent = await step('worker', { title: 'inbox sm sent back' });
      await as('creativeLead').post(`/api/submissions/${(await latest(sent))._id}/request-revision`, { comment: 'x', rootCause: 'Brief unclear' });

      const inbox = async (who, extra = {}) => (await as(who).get('/api/review-hub', { q, ...extra })).body.data;
      const counts = (d) => Object.fromEntries(d.tabs.map((t) => [t.key, t.count]));
      const lead = await inbox('creativeLead');
      expect(lead.tabs.map((t) => t.key)).toEqual(['waiting', 'changes', 'pauses', 'plans', 'flagged', 'history']);
      expect(counts(lead)).toMatchObject({ waiting: 2, changes: 1, history: 1, flagged: 0 });
      expect(lead.items.map((i) => i.title)).toEqual([`${TAG} inbox sm old`, `${TAG} inbox sm new`]);
      expect(lead.items[0]).toMatchObject({ calendar: 'sm', version: 1, revisionsLabel: '0 revisions', owner: { name: `${TAG} worker` } });
      const growth = await inbox('growthLead');
      expect(counts(growth)).toMatchObject({ waiting: 1, changes: 0, history: 0 });
      expect(growth.items[0].title).toBe(`${TAG} inbox ads`);
      expect(counts(await inbox('admin'))).toMatchObject({ waiting: 3, changes: 1, history: 1 });
      expect(counts(await inbox('creativeHead'))).toMatchObject({ waiting: 3, changes: 1, history: 1 });
      const adsOnly = await inbox('admin', { calendar: 'ads' });
      expect(counts(adsOnly), JSON.stringify(adsOnly.items.map((i) => [i.title, i.calendar]))).toMatchObject({ waiting: 1, changes: 0 });
      // Owner-name search: every result is that person's step.
      const byOwner = await inbox('admin', { q: `${TAG} other` });
      expect(byOwner.items.length).toBeGreaterThan(0);
      expect(byOwner.items.every((i) => i.owner.name === `${TAG} other`)).toBe(true);
      const hist = await inbox('creativeLead', { tab: 'history' });
      expect(hist.items[0]).toMatchObject({ title: `${TAG} inbox sm done` });
      expect(hist.items[0].decidedAt).toBeTruthy();
      expect(ads).toBeTruthy();
      expect(smNew).toBeTruthy();
    });

    it('workers: their own steps only, with "Needs my action", "Waiting for review", "History"', async () => {
      const q = `${TAG} inbox`;
      const mine = (await as('worker').get('/api/review-hub', { q })).body.data;
      expect(mine.viewer).toBe('worker');
      expect(mine.tabs.map((t) => t.key)).toEqual(['needs_action', 'waiting', 'history']);
      expect(Object.fromEntries(mine.tabs.map((t) => [t.key, t.count]))).toMatchObject({ needs_action: 1, waiting: 2, history: 1 });
      expect(mine.items.every((i) => i.owner.name === `${TAG} worker`)).toBe(true);
      const other = (await as('other').get('/api/review-hub', { q, tab: 'waiting' })).body.data;
      expect(other.items.map((i) => i.title)).toEqual([`${TAG} inbox ads`]);
    });

    it('revision label wording', () => {
      expect(revisionsLabel(0)).toBe('0 revisions');
      expect(revisionsLabel(1)).toBe('1 revision');
      expect(revisionsLabel(2)).toBe('2 revisions');
    });
  });
});
