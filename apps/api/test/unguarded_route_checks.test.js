// T1 (review follow-up): every route on the unguarded allow-list names the check that protects it,
// and calling the route really runs that check. The modules holding the checks are wrapped in
// pass-through spies, so the routers import the spied functions; each route is called once and its
// named check must have run. 'public' routes must answer without a session; routes protected by
// `authenticate` are called without a token and must answer 401.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { wrap } = vi.hoisted(() => ({
  /** The module with every exported function replaced by a pass-through spy. */
  wrap: (mod) => Object.fromEntries(Object.entries(mod).map(([k, v]) => [k, typeof v === 'function' && !/^[A-Z]/.test(k) ? vi.fn(v) : v])),
}));
vi.mock('../src/middleware/auth.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/notifications/service.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/submissions/service.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/people/service.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/calendar/contentPiece.read.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/reports/live.controller.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/workItems/pause.service.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/workItems/access.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/workload/service.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/published/service.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/reviewHub/service.js', async (orig) => wrap(await orig()));
vi.mock('../src/modules/team/profileAccess.js', async (orig) => wrap(await orig()));

const { default: mongoose } = await import('mongoose');
const { default: request } = await import('supertest');
const { default: jwt } = await import('jsonwebtoken');
const { app } = await import('../src/server.js');
const { env } = await import('../src/config/env.js');
const { Person } = await import('../src/modules/people/model.js');
const { WorkItem } = await import('../src/modules/workItems/model.js');
const { ContentPiece } = await import('../src/modules/calendar/contentPiece.model.js');
const { Submission, SubmissionComment, Rating } = await import('../src/modules/submissions/model.js');
const { MediaItem } = await import('../src/modules/media/model.js');
const { HelpRequest } = await import('../src/modules/workItems/helpRequest.model.js');
const { ALLOW_UNGUARDED } = await import('./fixtures/unguarded_routes.js');

const TAG = 'UGCHECK';
const DOMAIN = '@unguarded-check-test.com';
const EMAIL = /@unguarded-check-test\.com$/;
const MOCKED = [
  'middleware/auth.js', 'modules/notifications/service.js', 'modules/submissions/service.js', 'modules/people/service.js',
  'modules/calendar/contentPiece.read.js', 'modules/reports/live.controller.js', 'modules/workItems/pause.service.js',
  'modules/workItems/access.js', 'modules/workload/service.js', 'modules/published/service.js', 'modules/reviewHub/service.js',
  'modules/team/profileAccess.js',
];
const oid = () => new mongoose.Types.ObjectId();

describe('T1: each allow-listed route runs the check it names', () => {
  const P = {};
  const ids = {};
  const bearer = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ topic: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ contentPieceId: { $in: pieces } }).select('_id').lean()).map((s) => s._id);
    await HelpRequest.deleteMany({ workItemId: { $in: steps } });
    await MediaItem.deleteMany({ stageItemId: { $in: steps } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await SubmissionComment.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ _id: { $in: pieces } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    P.admin = await Person.create({ name: `${TAG} admin`, email: `admin${DOMAIN}`, role: 'admin', status: 'active' });
    P.worker = await Person.create({ name: `${TAG} worker`, email: `worker${DOMAIN}`, role: 'executive', status: 'active', jobRole: 'All Rounder' });
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'sm' });
    const step = await WorkItem.create({ title: `${TAG} Shoot`, workType: 'Reel', stageKey: 'Shoot', stageOrder: 2, status: 'In Progress', calendar: 'sm', ownerId: P.worker._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), reviewRequired: true });
    const sub = await Submission.create({ workItemId: step._id, contentPieceId: piece._id, stageKey: 'Shoot', version: 1, kind: 'link', status: 'submitted', submittedById: P.worker._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/ug' });
    const comment = await SubmissionComment.create({ submissionId: sub._id, workItemId: step._id, authorId: P.admin._id, text: 'Note', anchor: null, parentId: null });
    const rating = await Rating.create({ workItemId: step._id, workerId: P.worker._id, raterId: P.admin._id, score: 4, feedback: 'ok', stageKey: 'Shoot', submissionId: sub._id });
    const clip = await MediaItem.create({ stageItemId: step._id, url: 'https://drive.google.com/file/d/ugclip', title: `${TAG} clip`, type: 'video', uploadedById: P.worker._id });
    const help = await HelpRequest.create({ workItemId: step._id, contentPieceId: piece._id, askerId: P.worker._id, helperId: P.admin._id, helperKind: 'lead', topic: 'other', message: 'Help' }).catch(async () =>
      HelpRequest.create({ workItemId: step._id, contentPieceId: piece._id, askerId: P.worker._id, helperId: P.admin._id, helperKind: 'lead', topic: (await import('@mmp/shared')).HELP_TOPICS[0], message: 'Help' })
    );
    Object.assign(ids, { piece: String(piece._id), step: String(step._id), sub: String(sub._id), comment: String(comment._id), rating: String(rating._id), clip: String(clip._id), help: String(help._id), person: String(P.worker._id) });
  }, 60000);
  afterAll(cleanup, 60000);

  /** The concrete URL for a route path, with this test's records for its parameters. */
  const urlFor = (path) =>
    path
      .replace(/^\/api\/clips\/:id/, `/api/clips/${ids.clip}`)
      .replace(/^\/api\/submissions\/ratings\/:id/, `/api/submissions/ratings/${ids.rating}`)
      .replace(/^\/api\/submissions\/comments\/:id/, `/api/submissions/comments/${ids.comment}`)
      .replace(/^\/api\/submissions\/:id/, `/api/submissions/${ids.sub}`)
      .replace(/^\/api\/(content-pieces|reports\/projects)\/:id/, (_m, p) => `/api/${p}/${ids.piece}`)
      .replace(/:pieceId/, ids.piece)
      .replace(/:(id|stageItemId|workItemId)\b/, (m) => (/^\/api\/(team|people)\//.test(path) ? ids.person : ids.step))
      .replace(/:(personId)/, ids.person)
      .replace(/:helpId/, ids.help)
      .replace(/:(messageId|commentId)/, String(oid()));

  /** Who calls the route, and with what: admins pass the param checks and reach the services. */
  const callFor = (key) => {
    const [method, path] = key.split(' ');
    let url = urlFor(path);
    let as = 'admin';
    let body = {};
    if (key === 'GET /api/submissions') url += `?workItemId=${ids.step}`;
    if (key === 'POST /api/submissions') { as = 'worker'; body = { workItemId: ids.step }; }
    if (key === 'PUT /api/workload/:personId/limit') body = { limit: 5 };
    if (key === 'PUT /api/published/:pieceId/live-link') body = { liveUrl: 'https://www.instagram.com/p/ugcheck/' };
    return { method: method.toLowerCase(), url, as, body };
  };

  it('every named check module is spied in this file', () => {
    for (const [key, entry] of Object.entries(ALLOW_UNGUARDED)) {
      if (entry.check === 'public') continue;
      expect(MOCKED, `${key}: ${entry.check}`).toContain(entry.check.split('#')[0]);
    }
  });

  it('public routes do not require a session (authenticate never runs; refresh judges its own token)', async () => {
    const auth = await import('../src/middleware/auth.js');
    for (const [key, entry] of Object.entries(ALLOW_UNGUARDED)) {
      if (entry.check !== 'public') continue;
      const { method, url } = callFor(key);
      auth.authenticate.mockClear();
      const res = await request(app)[method](url).send({});
      expect(auth.authenticate.mock.calls.length, `${key}: no session check`).toBe(0);
      expect(res.status, key).toBeLessThan(500);
    }
  });

  it('routes protected by sign-in run authenticate and refuse a request without a session (401)', async () => {
    const auth = await import('../src/middleware/auth.js');
    for (const [key, entry] of Object.entries(ALLOW_UNGUARDED)) {
      if (entry.check !== 'middleware/auth.js#authenticate') continue;
      const { method, url } = callFor(key);
      auth.authenticate.mockClear();
      const res = await request(app)[method](url).send({});
      expect(auth.authenticate.mock.calls.length, `${key}: authenticate ran`).toBeGreaterThan(0);
      expect(res.status, key).toBe(401);
    }
  });

  it('every other route runs the check function it names', async () => {
    const missed = [];
    let checked = 0;
    for (const [key, entry] of Object.entries(ALLOW_UNGUARDED)) {
      if (entry.check === 'public' || entry.check === 'middleware/auth.js#authenticate') continue;
      const [file, fn] = entry.check.split('#');
      const mod = await import(`../src/${file}`);
      expect(vi.isMockFunction(mod[fn]), `${entry.check} is spied`).toBe(true);
      mod[fn].mockClear();
      const { method, url, as, body } = callFor(key);
      const res = await request(app)[method](url).set(bearer(as)).send(body);
      checked += 1;
      if (!mod[fn].mock.calls.length) missed.push(`${key} → ${entry.check} not called (status ${res.status} ${res.body?.error?.code || ''})`);
    }
    expect(missed).toEqual([]);
    expect(checked).toBeGreaterThan(60);
  });
});
