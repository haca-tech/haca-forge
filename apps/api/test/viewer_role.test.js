// The Viewer role: sees the whole plan and every step's status, nothing private, writes nothing
// but their own account, and is never routed anything (never an owner, reviewer, approver, poster
// or fallback).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ROLE_LABELS, SYSTEM_ROLES, can, roleGuide, seesContactDetails, slotEligibleRole } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { HelpRequest } from '../src/modules/workItems/helpRequest.model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { Submission, SubmissionComment, Rating } from '../src/modules/submissions/model.js';
import { MediaItem, MediaMessage } from '../src/modules/media/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { ChannelMember } from '../src/modules/chat/channelMember.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { ensureTeamChatChannel } from '../src/modules/chat/service.js';
import { eligibleOwners, ownerProblem } from '../src/modules/workItems/ownerRule.js';
import { buildAutofillContext } from '../src/modules/calendar/autofill.service.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'VIEWERT';
const DOMAIN = '@viewer-role-test.com';
/** Other people's addresses: the viewer's own email may appear (their own record). */
const OTHERS = ['admin', 'cl', 'sm', 'editor'].map((k) => `${k}${DOMAIN}`);
const EMAIL = /@viewer-role-test\.com$/;
const PHONE = '+15550009876';
const SECRET = 'Private note: tighten the first three seconds';
const oid = () => new mongoose.Types.ObjectId();

describe('Viewer role', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, phone: PHONE, whatsapp: PHONE, role, status: 'active', ...extra }));
  let plan;
  let piece;
  let step;
  let sub;
  let clip;

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const plans = (await CalendarPlan.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ $or: [{ topic: new RegExp(`^${TAG}`) }, { planId: { $in: plans } }] }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: pieces } }).select('_id').lean()).map((s) => s._id);
    const clips = (await MediaItem.find({ stageItemId: { $in: steps } }).select('_id').lean()).map((c) => c._id);
    await MediaMessage.deleteMany({ mediaItemId: { $in: clips } });
    await MediaItem.deleteMany({ _id: { $in: clips } });
    await HelpRequest.deleteMany({ workItemId: { $in: steps } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await SubmissionComment.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await ActivityEvent.deleteMany({ entityId: { $in: [...steps, ...steps.map(String)] } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ _id: { $in: pieces } });
    await CalendarPlan.deleteMany({ _id: { $in: plans } });
    await Notification.deleteMany({ recipient: { $in: people } });
    await ChannelMember.deleteMany({ userId: { $in: people } });
    await AccessChange.deleteMany({ $or: [{ entityId: { $in: people.map(String) } }, { entityType: 'workflow_config' }] });
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await person('admin', 'admin');
    await person('viewer', 'viewer');
    await person('cl', 'creative_lead');
    await person('sm', 'sm_manager');
    await person('editor', 'executive', { jobRole: 'Video Editor' });
    plan = await CalendarPlan.create({ code: `${TAG}-${Date.now()}`, title: `${TAG} plan`, calendar: 'sm', periodStart: new Date('2037-12-01'), periodEnd: new Date('2037-12-31'), createdById: P.sm._id });
    piece = await ContentPiece.create({ planId: plan._id, topic: `${TAG} piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'sm' });
    step = await WorkItem.create({ title: `${TAG} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'Feedback', calendar: 'sm', ownerId: P.editor._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true, revisions: 1 });
    sub = await Submission.create({ workItemId: step._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'changes_requested', submittedById: P.editor._id, submittedAt: new Date(), reviewedById: P.cl._id, reviewedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/viewer' });
    await SubmissionComment.create({ submissionId: sub._id, workItemId: step._id, authorId: P.cl._id, text: SECRET, anchor: null, parentId: null });
    await Rating.create({ workItemId: step._id, submissionId: sub._id, workerId: P.editor._id, raterId: P.cl._id, score: 3, feedback: SECRET, tags: [] }).catch(() => null);
    await ActivityEvent.create({ entityType: 'work_item', entityId: step._id, action: 'submission.revision_requested', actorId: P.cl._id, metadata: { comment: SECRET } });
    await HelpRequest.create({ workItemId: step._id, contentPieceId: piece._id, askerId: P.editor._id, helperId: P.cl._id, helperKind: 'lead', topic: 'Other', message: SECRET }).catch(() => null);
    clip = await MediaItem.create({ stageItemId: step._id, contentPieceId: piece._id, uploadedById: P.editor._id, title: `${TAG} clip`, url: 'https://example.invalid/clip.mp4', status: 'pending' }).catch(() => null);
  }, 60000);
  afterAll(cleanup, 60000);

  describe('the role', () => {
    it('is a read-only system role that sees all work, hides contacts and never takes steps', () => {
      const def = SYSTEM_ROLES.viewer;
      expect(ROLE_LABELS.viewer).toBe('Viewer');
      expect([def.dataScope, def.readOnly, def.takesSteps, def.locked]).toEqual(['all', true, false, false]);
      expect(seesContactDetails({ role: 'viewer' })).toBe(false);
      for (const k of ['review.read_all', 'chat.use', 'chat.read', 'people.view', 'team.profile.view', 'team.profile.report', 'feedback.view_all', 'settings.access.manage', 'user.manage']) {
        expect(can({ role: 'viewer', status: 'active' }, k), k).toBe(false);
      }
      for (const slot of ['reviewers', 'planApprovers', 'posters', 'fallbackApprovers']) expect(slotEligibleRole('viewer', slot), slot).toBe(false);
      expect(roleGuide().find((r) => r.role === 'viewer')?.label).toBe('Viewer');
    });
  });

  describe('allowed pages open', () => {
    it('dashboard, plans, Tracker, Work Items, Work Detail, Published, reports, Project KPIs', async () => {
      for (const url of [
        '/api/dashboard',
        '/api/calendar-plans',
        `/api/calendar-plans/${plan._id}`,
        '/api/work',
        `/api/work/${step._id}`,
        '/api/published',
        '/api/reports/overview',
        '/api/reports/production',
        `/api/reports/projects/${piece._id}`,
        `/api/content-pieces/${piece._id}`,
        '/api/auth/me',
        '/api/me/profile',
        '/api/notifications',
      ]) {
        const res = await request(app).get(url).set(as('viewer'));
        expect(res.status, url).toBeLessThan(300);
      }
    });
  });

  describe('forbidden pages and routes are refused', () => {
    it('chat, Team Workload, Review Hub, feedback and revision flags, people and admin pages: 403', async () => {
      for (const url of [
        '/api/chat/channels',
        '/api/workload',
        `/api/workload/${P.editor._id}/steps`,
        '/api/review-hub',
        `/api/review-hub/steps/${step._id}/timeline`,
        '/api/feedback/threads',
        '/api/revisions/flags',
        '/api/people',
        `/api/people/${P.editor._id}`,
        `/api/people/${P.editor._id}/performance`,
        '/api/admin/access-requests',
        '/api/access-admin/people',
        `/api/submissions/${sub._id}/comments`,
        `/api/work/${step._id}/comments`,
      ]) {
        const res = await request(app).get(url).set(as('viewer'));
        expect(res.status, url).toBe(403);
      }
      if (clip) expect((await request(app).get(`/api/clips/${clip._id}/messages`).set(as('viewer'))).status).toBe(403);
    });

    it('profiles, profile reports, work history and ratings of other people: 404', async () => {
      for (const url of [
        '/api/team',
        `/api/team/${P.editor._id}`,
        `/api/team/${P.editor._id}/report`,
        `/api/team/${P.editor._id}/kpis`,
        `/api/people/${P.editor._id}/profile`,
        `/api/people/${P.editor._id}/ratings`,
        `/api/people/${P.editor._id}/work-history`,
        `/api/submissions/ratings/summary/${P.editor._id}`,
      ]) {
        const res = await request(app).get(url).set(as('viewer'));
        expect(res.status, url).toBe(404);
      }
    });

    it('every write is refused except on their own account', async () => {
      const writes = [
        ['post', `/api/work/${step._id}/transition`, { toStatus: 'In Progress' }],
        ['post', `/api/submissions/${sub._id}/approve`, { score: 4, feedback: 'ok', tags: [] }],
        ['post', `/api/submissions/${sub._id}/comments`, { text: 'hi' }],
        ['post', '/api/calendar-plans', { calendar: 'sm', month: '2037-12' }],
        ['put', '/api/access-admin/calendars/sm', { version: 0, reason: 'x', changes: {} }],
        ['post', '/api/chat/channels/dm', { userId: String(P.cl._id) }],
      ];
      for (const [m, url, body] of writes) {
        const res = await request(app)[m](url).set(as('viewer')).send(body);
        expect(res.status, url).toBe(403);
      }
      const own = await request(app).patch('/api/me/profile').set(as('viewer')).send({ preferredName: 'View' });
      expect(own.status).toBeLessThan(300);
      const settings = await request(app).patch('/api/me/settings').set(as('viewer')).send({ notificationPrefs: {} });
      expect(settings.status).toBeLessThan(300);
    });
  });

  describe('no contact details and no private review text', () => {
    it('Work Detail keeps status and outputs but drops the reviewer note, the rating message, and contacts', async () => {
      const res = await request(app).get(`/api/work/${step._id}`).set(as('viewer'));
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain(SECRET);
      expect(body).not.toContain(DOMAIN);
      expect(body).not.toContain(PHONE);
      expect(res.body.data.status).toBe('Feedback');
      expect(res.body.data.latestFeedback).toBeUndefined();
      // A lead (review.read_all) still sees the note on the same step.
      const lead = await request(app).get(`/api/work/${step._id}`).set(as('cl'));
      expect(JSON.stringify(lead.body)).toContain(DOMAIN);
    });

    it('lists, activity, help requests and the dashboard carry no contacts or review text', async () => {
      for (const url of ['/api/work', '/api/calendar-plans', `/api/calendar-plans/${plan._id}`, '/api/dashboard', `/api/work/${step._id}/activity`, `/api/work/${step._id}/help-requests`, '/api/published', `/api/work/${step._id}/submissions`]) {
        const res = await request(app).get(url).set(as('viewer'));
        if (res.status >= 400) continue; // a route the viewer cannot open carries nothing either
        const body = JSON.stringify(res.body);
        expect(body, url).not.toContain(SECRET);
        for (const email of OTHERS) expect(body, url).not.toContain(email);
        expect(body, url).not.toContain(PHONE);
      }
      const help = await request(app).get(`/api/work/${step._id}/help-requests`).set(as('viewer'));
      expect(help.status).toBe(200);
      expect(help.body.data?.open ?? help.body.open).toEqual([]);
    });
  });

  describe('never in pickers or routing', () => {
    it('is no reviewer, approver, poster or fallback, even when named by id', async () => {
      await WorkflowConfig.create({
        calendar: 'sm',
        reviewers: { roles: [], userIds: [String(P.viewer._id)] },
        planApprovers: { roles: [], userIds: [String(P.viewer._id)] },
        posters: { roles: [], userIds: [String(P.viewer._id)] },
        fallbackApprovers: { roles: [], userIds: [String(P.viewer._id)] },
      });
      resolver.clearAccessCache();
      try {
        const ids = (list) => (list || []).map((p) => String(p._id));
        const v = String(P.viewer._id);
        expect(ids((await resolver.reviewersFor({ calendar: 'sm' })).people)).not.toContain(v);
        expect(ids((await resolver.planApproversFor({ calendar: 'sm' })).people)).not.toContain(v);
        expect(ids((await resolver.postersFor({ calendar: 'sm' })).people)).not.toContain(v);
        for (const event of ['submission.ready', 'plan.submitted', 'revision.flagged', 'revision.flag_escalated', 'step.needs_owner', 'step.overdue_manager', 'comment.posted']) {
          expect(ids(await resolver.recipientsFor(event, { calendar: 'sm' })), event).not.toContain(v);
        }
      } finally {
        await WorkflowConfig.deleteMany({});
        resolver.clearAccessCache();
      }
    });

    it('the settings refuse the Viewer role in any slot', async () => {
      // Beside a role that keeps the slot healthy, so the refusal is the Viewer's, not the health check's.
      const keep = { reviewers: 'admin', planApprovers: 'admin', posters: 'sm_manager', fallbackApprovers: 'admin' };
      for (const slot of Object.keys(keep)) {
        const res = await request(app).put('/api/access-admin/calendars/ads').set(as('admin')).send({ version: 0, reason: 'Try the viewer', changes: { [slot]: { roles: [keep[slot], 'viewer'], userIds: [] } } });
        expect([res.status, res.body.error?.message], slot).toEqual([400, `This role cannot be named in ${slot}: viewer`]);
      }
      expect(await WorkflowConfig.countDocuments({ calendar: 'ads' })).toBe(0);
    });

    it('owns no step: not eligible, not in autofill, not an assignment candidate', async () => {
      expect(await ownerProblem(P.viewer, { stageKey: 'Edit', calendar: 'sm' })).toBeTruthy();
      expect(await ownerProblem(P.viewer, { stageKey: 'Post', calendar: 'sm' })).toBeTruthy();
      const owners = await eligibleOwners([P.viewer, P.editor], { stageKey: 'Edit', calendar: 'sm' });
      expect(owners.map((p) => String(p._id))).toEqual([String(P.editor._id)]);
      const ctx = await buildAutofillContext({ calendar: 'sm' });
      expect(JSON.stringify(ctx)).not.toContain(String(P.viewer._id));
      const candidates = await request(app).get('/api/people/assignment-candidates').set(as('admin'));
      expect(candidates.status).toBe(200);
      expect(JSON.stringify(candidates.body)).not.toContain(String(P.viewer._id));
      const assign = await request(app).patch(`/api/work/${step._id}`).set(as('sm')).send({ ownerId: String(P.viewer._id), reason: 'Try the viewer' });
      expect(assign.status).toBeGreaterThanOrEqual(400);
    });

    it('is not a Team Chat member, and an admin can give the role', async () => {
      const team = await ensureTeamChatChannel();
      expect(await ChannelMember.exists({ channelId: team._id, userId: P.viewer._id })).toBeNull();
      expect(await ChannelMember.exists({ channelId: team._id, userId: P.editor._id })).toBeTruthy();
      const target = await person('promoted', 'executive', { jobRole: 'Video Editor' });
      const res = await request(app).patch(`/api/access-admin/people/${target._id}`).set(as('admin')).send({ reason: 'Read-only access', role: 'viewer' });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      expect((await Person.findById(target._id).lean()).role).toBe('viewer');
    });
  });
});
