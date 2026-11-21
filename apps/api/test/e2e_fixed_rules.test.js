// Phase E3: the fixed rules, one dedicated test each, through the real routes (and a real socket)
// on a throwaway database (marketing_portal_fixedrules, dropped before and after), so "the last
// active admin" really is the last one.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { io as ioClient } from 'socket.io-client';

const DB = 'mongodb://127.0.0.1:27017/marketing_portal_fixedrules';
process.env.MONGODB_URI = DB;
const { app, server, io } = await import('../src/server.js');
const { env } = await import('../src/config/env.js');
const { Person } = await import('../src/modules/people/model.js');
const { WorkItem } = await import('../src/modules/workItems/model.js');
const { PauseRequest } = await import('../src/modules/workItems/pauseRequest.model.js');
const { ContentPiece } = await import('../src/modules/calendar/contentPiece.model.js');
const { Submission } = await import('../src/modules/submissions/model.js');
const { RevisionFlag } = await import('../src/modules/feedback/model.js');
const { Channel } = await import('../src/modules/chat/channel.model.js');
const { ChannelMember } = await import('../src/modules/chat/channelMember.model.js');
const { ChatMessage } = await import('../src/modules/chat/chatMessage.model.js');
const { registerSocketIO } = await import('../src/modules/notifications/service.js');
const { setSocketServer } = await import('../src/lib/socketHub.js');
const { seedReferenceData } = await import('../src/modules/referenceData/service.js');

const oid = () => new mongoose.Types.ObjectId();
const tokenOf = (u) => jwt.sign({ userId: String(u._id), role: u.role, email: u.email }, env.JWT_SECRET, { expiresIn: '1h' });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Phase E3: fixed rules', () => {
  const P = {};
  let port;
  const as = (k) => ({ Authorization: `Bearer ${tokenOf(P[k])}` });
  const make = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `Rule ${key}`, email: `${key}.contact@fixedrules.invalid`, phone: `+91900000${String(Object.keys(P).length).padStart(4, '0')}`, whatsappNumber: `+91800000${String(Object.keys(P).length).padStart(4, '0')}`, role, status: 'active', ...extra }));

  async function step(ownerKey, extra = {}) {
    const piece = await ContentPiece.create({ planId: oid(), topic: 'Rule piece', contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'sm' });
    return WorkItem.create({ title: `Rule step ${ownerKey}`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', calendar: 'sm', ownerId: P[ownerKey]._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true, startedAt: new Date(Date.now() - 36e5), ...extra });
  }
  async function waiting(ownerKey) {
    const s = await step(ownerKey, { status: 'Pending' });
    const v = await Submission.create({ workItemId: s._id, contentPieceId: s.contentPieceId, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P[ownerKey]._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/rule' });
    return { step: s, sub: v };
  }
  const approve = (key, subId, score = 4) => request(app).post(`/api/submissions/${subId}/approve`).set(as(key)).send({ score, feedback: 'Clean work.', tags: [] });

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(DB);
    await mongoose.connection.db.dropDatabase();
    await seedReferenceData();
    await make('admin', 'admin');
    await make('lead', 'creative_lead');
    await make('head', 'creative_head');
    await make('sm', 'sm_manager');
    await make('worker', 'executive', { jobRole: 'Video Editor' });
    await make('worker2', 'executive', { jobRole: 'Video Editor' });
    registerSocketIO(io);
    setSocketServer(io);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }, 120000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 120000);

  describe('1. DMs are private, the admin included', () => {
    it('only the two members read it; an admin gets 403, and it is not in the admin\'s list or search', async () => {
      const dm = await Channel.create({ type: 'dm', name: 'rule dm' });
      await ChannelMember.create([{ channelId: dm._id, userId: P.worker._id, role: 'member' }, { channelId: dm._id, userId: P.worker2._id, role: 'member' }]);
      await ChatMessage.create({ channelId: dm._id, authorId: P.worker._id, content: 'zebra-private-hello' });
      const mine = await request(app).get(`/api/chat/channels/${dm._id}/messages`).set(as('worker'));
      expect(mine.status).toBe(200);
      expect(JSON.stringify(mine.body)).toContain('zebra-private-hello');
      for (const url of [`/api/chat/channels/${dm._id}/messages`, `/api/chat/channels/${dm._id}`]) {
        expect((await request(app).get(url).set(as('admin'))).status, url).toBe(403);
      }
      const list = await request(app).get('/api/chat/channels').set(as('admin'));
      expect(JSON.stringify(list.body)).not.toContain(String(dm._id));
      const search = await request(app).get('/api/chat/search').query({ q: 'zebra-private-hello' }).set(as('admin'));
      expect(JSON.stringify(search.body)).not.toContain('zebra-private-hello');
    });
  });

  describe('2. No ranking or comparison anywhere', () => {
    it('no aggregate endpoint ranks people or sets one person\'s score beside another\'s', async () => {
      const urls = ['/api/people/performance/team', '/api/dashboard', '/api/dashboard/overview', '/api/dashboard/summary', '/api/reports/overview', '/api/reports/overdue', '/api/reports/production', '/api/reports/quality', '/api/workload', '/api/team', `/api/team/${P.worker._id}/kpis`, `/api/team/${P.worker._id}/performance`, '/api/review-hub'];
      const BAD_KEY = /^(rank|ranking|rankings|leaderboard|percentile|position|topPerformers?|bottomPerformers?|vsTeam|teamAverage|comparedTo)$/i;
      const badKeys = [];
      const walk = (v, where) => {
        if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
        if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (BAD_KEY.test(k)) badKeys.push(`${where}.${k}`); walk(x, `${where}.${k}`); }
      };
      for (const url of urls) {
        for (const who of ['admin', 'lead']) {
          const res = await request(app).get(url).set(as(who));
          expect(res.status, `${who} ${url}`).toBeLessThan(500);
          walk(res.body, `${who} ${url}`);
        }
      }
      expect(badKeys).toEqual([]);
      // The team performance figures are team-level only: no per-person scores side by side.
      const team = await request(app).get('/api/people/performance/team').set(as('admin'));
      expect(team.status).toBe(200);
      expect(team.body.data?.members ?? team.body.members).toBeUndefined();
      // The directory never sorts by performance or load.
      const sorted = await request(app).get('/api/team').query({ sort: 'rating' }).set(as('admin'));
      const names = (sorted.body.data?.items || sorted.body.items || []).map((p) => p.name);
      expect(names.length).toBeGreaterThan(3);
      expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    });
  });

  describe('3. No self-approval', () => {
    it('reviews, plans, pauses and revision flags: never on your own work, the admin included', async () => {
      const own = await waiting('admin');
      const r = await approve('admin', own.sub._id);
      expect(r.status).toBe(403);
      expect(r.body.error?.code).toMatch(/SELF/);
      expect((await approve('lead', own.sub._id)).status).toBe(200);

      const saved = await request(app).post('/api/calendar-plans/grid/rows').set(as('admin')).send({ calendar: 'sm', month: '2037-01', rows: [{ clientKey: 'r', cells: { postingDate: '2037-01-20', topic: 'Own plan', type: 'Static Post', brief: 'Self approval.' } }] });
      expect(saved.status).toBe(201);
      await request(app).post(`/api/calendar-plans/${saved.body.data.plan._id}/submit`).set(as('admin'));
      const p = await request(app).post(`/api/calendar-plans/${saved.body.data.plan._id}/review`).set(as('admin')).send({ action: 'approve_selected', approvedRowIds: [saved.body.data.results[0].rowId] });
      expect([p.status, p.body.error?.code]).toEqual([403, 'SELF_DECISION']);

      const ps = await step('lead', { pauseState: 'requested' });
      await PauseRequest.create({ workItemId: ps._id, ownerId: P.lead._id, reason: 'other', note: 'Own pause' });
      const pz = await request(app).post(`/api/work/${ps._id}/pause-request/decide`).set(as('lead')).send({ decision: 'approve' });
      expect([pz.status, pz.body.error?.code]).toEqual([403, 'FORBIDDEN_SELF_DECISION']);

      const fs2 = await step('lead');
      const flag = await RevisionFlag.create({ workItemId: fs2._id, ownerId: P.lead._id, revisionsCount: 4, baselineAvg: 1, isFlagged: true, flaggedAt: new Date(), rootCause: null });
      const c = await request(app).post(`/api/revisions/flags/${flag._id}/classify`).set(as('lead')).send({ rootCause: 'Brief unclear' });
      expect([c.status, c.body.error?.code]).toEqual([403, 'SELF_DECISION']);
    });
  });

  describe('3b. No self-approval: clips, rating edits, reopen, rows you added (final fix T4)', () => {
    it('clip review, rating edits and reopen are refused on your own step, the admin included', async () => {
      const { MediaItem } = await import('../src/modules/media/model.js');
      const { Rating } = await import('../src/modules/submissions/model.js');
      // Clip review on the admin's own Shoot step.
      const shoot = await step('admin', { stageKey: 'Shoot' });
      const clip = await MediaItem.create({ stageItemId: shoot._id, url: 'https://drive.google.com/file/d/rule-clip', title: 'Rule clip', type: 'video', uploadedById: P.admin._id });
      const own = await request(app).post(`/api/clips/${clip._id}/review`).set(as('admin')).send({ action: 'approve' });
      expect([own.status, own.body.error?.code]).toEqual([403, 'SELF_DECISION']);
      const lead = await request(app).post(`/api/clips/${clip._id}/review`).set(as('lead')).send({ action: 'approve' });
      expect(lead.body.error?.code).not.toBe('SELF_DECISION');

      // Rating edit on the admin's own work (rated by the lead).
      const rated = await step('admin', { status: 'Approved' });
      const rating = await Rating.create({ workItemId: rated._id, workerId: P.admin._id, raterId: P.lead._id, score: 3, feedback: 'ok', stageKey: 'Edit', submissionId: oid() });
      const edit = await request(app).patch(`/api/submissions/ratings/${rating._id}`).set(as('admin')).send({ score: 5, reason: 'Mine, really' });
      expect([edit.status, edit.body.error?.code]).toEqual([403, 'SELF_DECISION']);
      expect((await Rating.findById(rating._id).lean()).score).toBe(3);

      // Reopening your own finished step.
      const done = await step('admin', { status: 'Approved', approvedAt: new Date() });
      const reopen = await request(app).post(`/api/work/${done._id}/transition`).set(as('admin')).send({ toStatus: 'Feedback', comment: 'Reopen my own' });
      expect([reopen.status, reopen.body.error?.code]).toEqual([403, 'FORBIDDEN_REOPEN']);
      expect((await WorkItem.findById(done._id).lean()).status).toBe('Approved');
    });

    it('an approver who adds a row to someone else\'s plan cannot approve that row; another approver can', async () => {
      const month = '2038-04';
      const smPlan = await request(app).post('/api/calendar-plans/grid/rows').set(as('sm')).send({ calendar: 'sm', month, rows: [{ clientKey: 'a', cells: { postingDate: `${month}-10`, topic: 'SM row', type: 'Static Post', brief: 'Planned by the SM Manager.' } }] });
      expect(smPlan.status).toBe(201);
      const planId = smPlan.body.data.plan._id;
      // The admin (who can also plan) adds a row to the SM Manager's plan.
      const added = await request(app).post('/api/calendar-plans/grid/rows').set(as('admin')).send({ calendar: 'sm', month, planId, rows: [{ clientKey: 'b', cells: { postingDate: `${month}-12`, topic: 'Admin row', type: 'Static Post', brief: 'Added by the admin.' } }] });
      expect(added.status).toBe(201);
      const adminRow = added.body.data.results[0].rowId;
      expect((await request(app).post(`/api/calendar-plans/${planId}/submit`).set(as('sm'))).status).toBe(200);
      const mine = await request(app).post(`/api/calendar-plans/${planId}/review`).set(as('admin')).send({ action: 'approve_selected', approvedRowIds: [adminRow] });
      expect([mine.status, mine.body.error?.code]).toEqual([403, 'SELF_DECISION']);
      const all = await request(app).post(`/api/calendar-plans/${planId}/review`).set(as('admin')).send({ action: 'approve_all' });
      expect([all.status, all.body.error?.code]).toEqual([403, 'SELF_DECISION']);
      expect((await request(app).post(`/api/calendar-plans/${planId}/review`).set(as('lead')).send({ action: 'approve_selected', approvedRowIds: [adminRow] })).status).toBe(200);
    });
  });

  describe('4. A rating average needs at least 3 ratings', () => {
    it('two ratings show "Collecting baseline"; the third shows the average', async () => {
      const profile = async () => (await request(app).get(`/api/team/${P.worker2._id}`).set(as('admin'))).body.data.kpis;
      for (const score of [5, 3]) {
        const w = await waiting('worker2');
        expect((await approve('lead', w.sub._id, score)).status).toBe(200);
      }
      expect(await profile()).toMatchObject({ ratingCount: 2, averageRating: null });
      const w3 = await waiting('worker2');
      expect((await approve('lead', w3.sub._id, 4)).status).toBe(200);
      expect(await profile()).toMatchObject({ ratingCount: 3, averageRating: 4 });
    });
  });

  describe('5. Workers get 404 on other people\'s work', () => {
    it('their own step opens; another worker\'s step and profile do not exist for them', async () => {
      const mine = await step('worker');
      const theirs = await step('worker2');
      expect((await request(app).get(`/api/work/${mine._id}`).set(as('worker'))).status).toBe(200);
      for (const url of [`/api/work/${theirs._id}`, `/api/team/${P.worker2._id}/work`, `/api/team/${P.worker2._id}/kpis`]) {
        expect((await request(app).get(url).set(as('worker'))).status, url).toBe(404);
      }
    });
  });

  describe('6. Workers never see other people\'s contact details', () => {
    it('no email, phone or WhatsApp of anyone else in what a worker can open', async () => {
      const s = await step('worker');
      const group = await Channel.create({ type: 'group', name: 'rule group' });
      await ChannelMember.create(['worker', 'lead', 'sm', 'worker2'].map((k) => ({ channelId: group._id, userId: P[k]._id, role: 'member' })));
      const urls = ['/api/my-work', `/api/work/${s._id}`, `/api/work/${s._id}/help-requests`, '/api/chat/channels', `/api/chat/channels/${group._id}`, `/api/team/${P.lead._id}`, `/api/team/${P.worker._id}`, '/api/review-hub', '/api/published', '/api/notifications', '/api/auth/me'];
      const others = ['lead', 'sm', 'worker2', 'admin', 'head'];
      const leaks = [];
      for (const url of urls) {
        const body = JSON.stringify((await request(app).get(url).set(as('worker'))).body);
        for (const k of others) for (const v of [P[k].email, P[k].phone, P[k].whatsappNumber]) if (body.includes(v)) leaks.push(`${url}: ${k} ${v}`);
      }
      expect(leaks).toEqual([]);
      // Leadership still sees them on the profile header (unchanged rule).
      expect(JSON.stringify((await request(app).get(`/api/team/${P.worker._id}`).set(as('admin'))).body)).toContain(P.worker.email);
    });
  });

  describe('7. There is always an active admin', () => {
    it('the only admin cannot be demoted or suspended by any route or model path', async () => {
      // Every route that changes a role or status, each with the exact refusal (a reason is sent, so
      // a missing reason can never be what refuses it). The only admin is the only one who could
      // act, so on the routes the self guard answers first; the last-admin guard itself is proven
      // below with another acting admin.
      const attempts = [
        ['PATCH access-admin role', request(app).patch(`/api/access-admin/people/${P.admin._id}`).set(as('admin')).send({ role: 'creative_lead', reason: 'try it' }), 403, 'SELF_DEMOTE'],
        ['PATCH access-admin status', request(app).patch(`/api/access-admin/people/${P.admin._id}`).set(as('admin')).send({ status: 'suspended', reason: 'try it' }), 403, 'SELF_SUSPEND'],
        ['POST people suspend', request(app).post(`/api/people/${P.admin._id}/suspend`).set(as('admin')).send({ reason: 'try it' }), 400, 'CANNOT_SUSPEND_SELF'],
        ['PATCH people role', request(app).patch(`/api/people/${P.admin._id}`).set(as('admin')).send({ role: 'creative_lead', reason: 'try it' }), 403, 'SELF_DEMOTE'],
        ['PATCH team role', request(app).patch(`/api/team/${P.admin._id}`).set(as('admin')).send({ role: 'creative_lead', reason: 'try it' }), 403, 'SELF_DEMOTE'],
        ['POST team status', request(app).post(`/api/team/${P.admin._id}/status`).set(as('admin')).send({ reason: 'try it' }), 403, 'SELF_SUSPEND'],
      ];
      for (const [name, pending, status, code] of attempts) {
        const res = await pending;
        expect([name, res.status, res.body.error?.code || res.body.code]).toEqual([name, status, code]);
      }
      // The last-admin guard: another admin acting (not the person themselves) still cannot demote or
      // suspend the last active admin, through the one path every route above uses.
      const { savePersonChange } = await import('../src/modules/accessConfig/accessAdmin.service.js');
      const otherAdmin = { _id: oid(), role: 'admin', status: 'active' };
      await expect(savePersonChange(String(P.admin._id), { role: 'creative_lead', reason: 'try it' }, otherAdmin)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
      await expect(savePersonChange(String(P.admin._id), { status: 'suspended', reason: 'try it' }, otherAdmin)).rejects.toMatchObject({ statusCode: 409, code: 'LAST_ADMIN' });
      await expect(Person.updateOne({ _id: P.admin._id }, { $set: { status: 'suspended' } })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
      expect(await Person.findById(P.admin._id).lean()).toMatchObject({ role: 'admin', status: 'active' });
    });
  });

  describe('8. Read-only roles can still edit their own account', () => {
    it('a Creative Head changes their own profile and settings, and nothing else', async () => {
      const prof = await request(app).patch('/api/me/profile').set(as('head')).send({ preferredName: 'Hugo' });
      expect(prof.status).toBe(200);
      expect((await Person.findById(P.head._id).lean()).preferredName).toBe('Hugo');
      expect((await request(app).patch('/api/me/settings').set(as('head')).send({ notificationPrefs: { chat: { inApp: false, email: false } } })).status).toBe(200);
      expect((await request(app).post('/api/work').set(as('head')).send({})).status).toBe(403);
    });
  });

  describe('9. A suspended user loses access at once: API, sockets, open tabs', () => {
    it('the same token is refused, the socket is closed after access:changed, and a new socket is refused', async () => {
      const victim = await make('leaving', 'creative_lead');
      const connect = () =>
        new Promise((resolve) => {
          const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { cookie: `accessToken=${tokenOf(victim)}` } });
          socket.events = [];
          socket.onAny((ev) => socket.events.push(ev));
          socket.on('connect', () => resolve({ ok: true, socket }));
          socket.on('connect_error', (err) => { socket.close(); resolve({ ok: false, error: err.message }); });
        });
      const { ok, socket } = await connect();
      expect(ok).toBe(true);
      expect((await request(app).get('/api/auth/me').set(as('leaving'))).status).toBe(200);
      const closed = new Promise((resolve) => socket.once('disconnect', resolve));
      const res = await request(app).patch(`/api/access-admin/people/${victim._id}`).set(as('admin')).send({ status: 'suspended', reason: 'Left' });
      expect(res.status).toBe(200);
      // API: the very next request with the same token.
      const me = await request(app).get('/api/auth/me').set(as('leaving'));
      expect([me.status, me.body.error?.code]).toEqual([403, 'ACCOUNT_SUSPENDED']);
      // Open tab: told first (access:changed makes it reload /auth/me, which now says 403), then closed.
      expect(await Promise.race([closed, wait(3000).then(() => 'timeout')])).toBe('io server disconnect');
      expect(socket.events).toContain('access:changed');
      expect((await connect()).ok).toBe(false);
    });
  });
});
