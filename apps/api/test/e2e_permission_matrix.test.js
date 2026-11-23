// Phase E1: the end-to-end permission matrix, through the real HTTP routes on a throwaway
// database (marketing_portal_matrix, dropped before and after).
// A. Every permission-guarded API route × every role (and a calendar-limited lead, a named
//    reviewer, a suspended user): the guard lets in exactly the roles the catalog gives.
// B. The calendar-routed decisions × 5 calendars × owner / non-owner: review, classify, pause,
//    post, plan approval, against the resolver and the fixed rules (no self-approval).
// Writes the tables to $MATRIX_OUT when set.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import request from 'supertest';
import { CALENDAR_KEYS, PERMISSION_CATALOG, ROLE_KEYS, ROLE_LABELS, can } from '@mmp/shared';

const DB = 'mongodb://127.0.0.1:27017/marketing_portal_matrix';
process.env.MONGODB_URI = DB;
const { app } = await import('../src/server.js');
const { env } = await import('../src/config/env.js');
const { Person } = await import('../src/modules/people/model.js');
const { WorkItem } = await import('../src/modules/workItems/model.js');
const { PauseRequest } = await import('../src/modules/workItems/pauseRequest.model.js');
const { ContentPiece } = await import('../src/modules/calendar/contentPiece.model.js');
const { Submission } = await import('../src/modules/submissions/model.js');
const { RevisionFlag } = await import('../src/modules/feedback/model.js');
const { WorkflowConfig } = await import('../src/modules/accessConfig/workflowConfig.model.js');
const { seedReferenceData } = await import('../src/modules/referenceData/service.js');
const resolver = await import('../src/lib/accessResolver.js');
const { routeTable, routeKey } = await import('./helpers/routeTable.js');
const { ALLOW_UNGUARDED } = await import('./fixtures/unguarded_routes.js');

const SRC = path.resolve(__dirname, '../src');
const DENY_CODES = ['FORBIDDEN', 'ACCOUNT_SUSPENDED', 'READ_ONLY_ROLE'];
/** Routes whose service narrows the guard (documented): the key that really decides. */
const SERVICE_CHECKS = {
  // The Changes tab (operational audit log): guard team.profile.view, service people.manage_operational.
  'GET /api/team/:id/changes': [['people.manage_operational']],
};
const OUT = process.env.MATRIX_OUT || '';
const oid = () => new mongoose.Types.ObjectId();
const token = (u) => jwt.sign({ userId: String(u._id), role: u.role, email: u.email }, env.JWT_SECRET, { expiresIn: '2h' });

const U = {};
const USERS = [
  ...ROLE_KEYS.map((role) => [role, role, {}]),
  ['limited_lead', 'creative_lead', { calendarScope: ['sm'] }],
  ['named_growth', 'growth_lead', {}],
  ['suspended', 'creative_lead', { status: 'suspended' }],
];
const label = (key) => ({ limited_lead: 'Creative Manager limited to SM', named_growth: 'Marketing Growth Manager named on SM reviewers', suspended: 'Suspended Creative Manager' })[key] || ROLE_LABELS[key];

/** Every guarded API route from the real routers (any quote style, nested routers included). */
async function routeList() {
  const all = await routeTable(SRC);
  return all
    .filter((r) => r.guards.length)
    .map((r) => ({ method: r.method, path: r.path, guards: r.guards, hidesFromWorkers: r.handlers.includes('notFoundForWorkers') }));
}

describe('Phase E1: end-to-end permission matrix', () => {
  let step; // a real step for routes whose :id loads a work item
  const results = { guard: [], decisions: [] };

  const keepStep = async () => {
    if (await WorkItem.exists({ _id: step._id })) {
      await WorkItem.updateOne({ _id: step._id }, { $set: { status: 'In Progress', isSkipped: false } });
      return;
    }
    await WorkItem.create(step);
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await mongoose.connect(DB);
    await mongoose.connection.db.dropDatabase();
    await seedReferenceData();
    for (const [key, role, extra] of USERS) {
      U[key] = await Person.create({ name: `Matrix ${key}`, email: `${key}@matrix.invalid`, role, status: 'active', jobRole: role === 'executive' ? 'Video Editor' : '', ...extra });
    }
    // A named person: the second Marketing Growth Manager also reviews the SM calendar (beside the Creative Manager role).
    await WorkflowConfig.create({ calendar: 'sm', reviewers: { roles: ['creative_lead'], userIds: [String(U.named_growth._id)] }, planApprovers: { roles: ['creative_lead'], userIds: [] }, posters: { roles: ['sm_manager'], userIds: [] }, fallbackApprovers: { roles: ['admin'], userIds: [] } });
    resolver.clearAccessCache();
    const piece = await ContentPiece.create({ planId: oid(), topic: 'Matrix piece', contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'sm' });
    step = (await WorkItem.create({ title: 'Matrix step', workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', calendar: 'sm', ownerId: U.executive._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5) })).toObject();
  }, 120000);

  afterAll(async () => {
    if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 1));
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();
  }, 120000);

  it('T1. no route is unguarded unless it is on the named allow-list, with a reason', async () => {
    const all = await routeTable(SRC);
    const unguarded = all.filter((r) => !r.guards.length).map(routeKey);
    const missing = unguarded.filter((k) => !ALLOW_UNGUARDED[k]);
    expect(missing, 'unguarded routes: add a permission guard, or list them in test/fixtures/unguarded_routes.js with a reason').toEqual([]);
    // Every entry still names a real unguarded route, and has a real reason.
    const stale = Object.keys(ALLOW_UNGUARDED).filter((k) => !unguarded.includes(k));
    expect(stale, 'allow-list entries that are no longer unguarded routes').toEqual([]);
    // Every entry names its check (module#export under src/, or public) and a real reason; the named
    // function exists. unguarded_route_checks.test.js asserts each one is actually called.
    for (const [k, entry] of Object.entries(ALLOW_UNGUARDED)) {
      expect(String(entry.reason).length, k).toBeGreaterThan(20);
      expect(entry.check, k).toMatch(/^public$|^(middleware|modules)\/[\w./-]+\.js#\w+$/);
      if (entry.check !== 'public') {
        const [file, fn] = entry.check.split('#');
        expect(typeof (await import(path.join(SRC, file)))[fn], `${k}: ${entry.check} is an exported function`).toBe('function');
      }
    }
    expect(all.length).toBeGreaterThan(200);
  });

  it('T1. mounts are found whatever the quote style (double, single, backtick; aliased imports)', async () => {
    const os = await import('os');
    const { mountsOf } = await import('./helpers/routeTable.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mounts-'));
    try {
      fs.writeFileSync(path.join(dir, 'server.js'), [
        'import a from "./modules/a/routes.js";',
        "import b from './modules/b/routes.js';",
        'import { c as cee } from `./modules/c/routes.js`;',
        'app.use("/api/a", a);',
        "app.use('/api/b', limiter, b);",
        'app.use(`/api/c`, cee);',
        // Middleware with its own parentheses, braces and commas stays one argument; comments with
        // apostrophes inside inline handlers don't break the scan.
        "import dee from './modules/d/routes.js';",
        'app.use("/api/d", rateLimit({ windowMs: 60_000, max: (5) }), wrap(auth, ["x", "y"]), dee);',
        "app.use('/api/my-work', (req, res, next) => {\n  // don't break: it's a comment\n  next();\n});",
        "import eee from './modules/e/routes.js';",
        "app.use('/api/e', (req, res, next) => next(), eee);",
        'app.use(express.json({ limit: "10mb" }));',
      ].join('\n'));
      expect(mountsOf(dir).map((m) => [m.prefix, m.file, m.name])).toEqual([
        ['/api/a', 'modules/a/routes.js', 'default'],
        ['/api/b', 'modules/b/routes.js', 'default'],
        ['/api/c', 'modules/c/routes.js', 'c'],
        ['/api/d', 'modules/d/routes.js', 'default'],
        ['/api/e', 'modules/e/routes.js', 'default'],
      ]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('A. every guarded route admits exactly the roles the catalog gives (and nobody suspended)', async () => {
    const routes = await routeList();
    expect(routes.length).toBeGreaterThan(100);
    const mismatches = [];
    for (const r of routes) {
      const url = r.path.replace(/:(id|stageItemId|workItemId)\b/g, String(step._id)).replace(/:\w+/g, String(oid()));
      for (const [key] of USERS) {
        await keepStep();
        const user = U[key];
        const fresh = await Person.findById(user._id).lean();
        const keysNeeded = SERVICE_CHECKS[`${r.method.toUpperCase()} ${r.path}`] || r.guards;
        const expected = fresh.status === 'active' && keysNeeded.every((keys) => keys.some((k) => can(fresh, k)));
        const res = await request(app)[r.method](url).set('Authorization', `Bearer ${token(user)}`).send(r.method === 'get' ? undefined : {});
        const code = res.body?.error?.code;
        // Denied: the guard (FORBIDDEN), the read-only check before it (READ_ONLY_ROLE), a suspended
        // account, or a route that answers 404 to hide itself: workers anywhere, and anyone without
        // team.profile.view on the team routes (notFoundForWorkers; the Viewer). A 404 for a role the
        // guard admits is a missing test record, not a denial.
        const hidden = res.status === 404 && !expected && (r.hidesFromWorkers || (can(fresh, 'work.update.own') && !can(fresh, 'work.view_all')));
        const deniedByGuard = (res.status === 403 && DENY_CODES.includes(code)) || hidden;
        const row = { route: `${r.method.toUpperCase()} ${r.path}`, keys: r.guards.map((g) => g.join('|')).join(' & '), user: key, expected: expected ? 'allow' : 'deny', got: deniedByGuard ? 'deny' : 'allow', status: res.status, code };
        results.guard.push(row);
        if (expected === deniedByGuard) mismatches.push(row);
      }
    }
    expect(mismatches).toEqual([]);
  }, 900000);

  // ------------------------------------------------------------ B. calendar-routed decisions
  const deciders = ['admin', 'creative_head', 'production_head', 'creative_lead', 'growth_lead', 'sm_manager', 'executive', 'viewer', 'limited_lead', 'named_growth'];
  const as = (key) => ({ Authorization: `Bearer ${token(U[key])}` });
  const config = async (cal) => resolver.getWorkflowConfig(cal);

  async function stepOn(calendar, ownerId, extra = {}) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `Matrix ${calendar}`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar });
    return WorkItem.create({ title: `Matrix ${calendar} step`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', calendar, ownerId, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5), reviewRequired: true, ...extra });
  }

  const ACTIONS = {
    'review.decide (approve a version)': {
      expect: (u, cal, ownerId, cfg) => can(u, 'review.decide', { calendar: cal, ownerId }, cfg),
      run: async (key, cal, ownerId) => {
        const s = await stepOn(cal, ownerId, { status: 'Pending' });
        const v = await Submission.create({ workItemId: s._id, contentPieceId: s.contentPieceId, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: ownerId, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/matrix' });
        return request(app).post(`/api/submissions/${v._id}/approve`).set(as(key)).send({ score: 4, feedback: 'Clean work.', tags: [] });
      },
    },
    'revision.classify': {
      expect: (u, cal, ownerId, cfg) => can(u, 'revision.classify', { calendar: cal, ownerId }, cfg),
      run: async (key, cal, ownerId) => {
        const s = await stepOn(cal, ownerId);
        const f = await RevisionFlag.create({ workItemId: s._id, ownerId, revisionsCount: 4, baselineAvg: 1, isFlagged: true, flaggedAt: new Date(), rootCause: null });
        return request(app).post(`/api/revisions/flags/${f._id}/classify`).set(as(key)).send({ rootCause: 'Brief unclear' });
      },
    },
    'pause decision (review.decide)': {
      expect: (u, cal, ownerId, cfg) => can(u, 'review.decide', { calendar: cal, ownerId }, cfg),
      run: async (key, cal, ownerId) => {
        const s = await stepOn(cal, ownerId, { pauseState: 'requested', startedAt: new Date(Date.now() - 36e5) });
        await PauseRequest.create({ workItemId: s._id, ownerId, reason: 'other', note: 'Matrix' });
        return request(app).post(`/api/work/${s._id}/pause-request/decide`).set(as(key)).send({ decision: 'reject' });
      },
    },
    'publish.post (mark a Post step posted)': {
      // The step's owner may mark it posted (if their role works its own steps), or a poster of the calendar.
      expect: (u, cal, ownerId, cfg) => (String(ownerId) === String(u._id) && can(u, 'work.update.own')) || can(u, 'publish.post', { calendar: cal }, cfg),
      run: async (key, cal, ownerId) => {
        const s = await stepOn(cal, ownerId, { stageKey: 'Post', reviewRequired: false });
        return request(app).post(`/api/work/${s._id}/transition`).set(as(key)).send({ toStatus: 'Published', publishedUrl: 'https://www.instagram.com/reel/matrix/' });
      },
    },
  };

  it('B. calendar-routed decisions × 5 calendars × owner / non-owner follow the resolver and the fixed rules', async () => {
    const mismatches = [];
    for (const [action, def] of Object.entries(ACTIONS)) {
      for (const cal of CALENDAR_KEYS) {
        const cfg = await config(cal);
        for (const key of deciders) {
          for (const owner of ['other', 'self']) {
            const ownerId = owner === 'self' ? U[key]._id : U.executive._id === U[key]._id ? U.sm_manager._id : U.executive._id;
            const u = await Person.findById(U[key]._id).lean();
            const expected = def.expect(u, cal, ownerId, cfg);
            const res = await def.run(key, cal, ownerId);
            const got = res.status >= 200 && res.status < 300;
            const row = { action, calendar: cal, user: key, owner, expected: expected ? 'allow' : 'deny', got: got ? 'allow' : 'deny', status: res.status, code: res.body?.error?.code };
            results.decisions.push(row);
            if (expected !== got) mismatches.push(row);
          }
        }
      }
    }
    // A suspended user decides nothing.
    const s = await stepOn('sm', U.executive._id, { status: 'Pending' });
    const v = await Submission.create({ workItemId: s._id, contentPieceId: s.contentPieceId, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: U.executive._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/matrix' });
    const susp = await request(app).post(`/api/submissions/${v._id}/approve`).set(as('suspended')).send({ score: 4, feedback: 'x', tags: [] });
    results.decisions.push({ action: 'review.decide (approve a version)', calendar: 'sm', user: 'suspended', owner: 'other', expected: 'deny', got: susp.status === 200 ? 'allow' : 'deny', status: susp.status, code: susp.body?.error?.code });
    expect(susp.status).toBe(403);
    expect(mismatches).toEqual([]);
  }, 900000);

  it('B. plan approval × 5 calendars × own plan / someone else\'s plan', async () => {
    const mismatches = [];
    let n = 0;
    for (const cal of CALENDAR_KEYS) {
      const cfg = await config(cal);
      for (const key of deciders) {
        for (const owner of ['other', 'self']) {
          const creator = owner === 'self' ? key : key === 'sm_manager' ? 'admin' : 'sm_manager';
          const u = await Person.findById(U[key]._id).lean();
          if (owner === 'self' && !can(u, 'calendar.plan')) continue; // cannot own a plan
          n += 1;
          const month = `2034-${String((n % 12) + 1).padStart(2, '0')}`;
          const saved = await request(app).post('/api/calendar-plans/grid/rows').set(as(creator)).send({ calendar: cal, month, rows: [{ clientKey: `r${n}`, cells: { postingDate: `${month}-20`, topic: `Matrix ${n}`, type: 'Static Post', brief: 'Matrix plan row.' } }] });
          expect(saved.status, JSON.stringify(saved.body?.error || {})).toBe(201);
          const planId = saved.body.data.plan._id;
          const rowId = saved.body.data.results[0].rowId;
          expect((await request(app).post(`/api/calendar-plans/${planId}/submit`).set(as(creator))).status).toBe(200);
          // Fixed rule: nobody approves their own plan.
          const expected = can(u, 'calendar.approve', { calendar: cal }, cfg) && owner !== 'self';
          const res = await request(app).post(`/api/calendar-plans/${planId}/review`).set(as(key)).send({ action: 'approve_selected', approvedRowIds: [rowId] });
          const got = res.status === 200;
          const row = { action: 'calendar.approve (approve a plan row)', calendar: cal, user: key, owner, expected: expected ? 'allow' : 'deny', got: got ? 'allow' : 'deny', status: res.status, code: res.body?.error?.code };
          results.decisions.push(row);
          if (expected !== got) mismatches.push(row);
        }
      }
    }
    expect(mismatches).toEqual([]);
  }, 900000);

  it('the catalog has no permission the matrix does not know', () => {
    expect(PERMISSION_CATALOG.length).toBe(40);
  });
});
