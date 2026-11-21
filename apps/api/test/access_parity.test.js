// PERMANENT parity test (Phase B): the new access resolver must return exactly what today's
// hard-coded rules return, for access (7 roles × every action × 5 calendars × owner and
// non-owner) and for routing (reviewer, plan approver, poster, notification recipients,
// eligibility). Old rules are called directly where they are functions, or mirrored from the
// cited source line where they are inline queries. 100% equal or the test fails.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import {
  APPROVER_ROLES,
  CALENDAR_KEYS,
  JOB_ROLES,
  PERMISSION_KEYS,
  PERMISSION_KEYS_V2,
  PORTAL_VIEW_SPLIT,
  ROLE_KEYS,
  ROLE_PERMISSIONS,
  STAGE_KEYS,
  can,
  canDecide,
  canManageOperationalFields,
  canReview,
  canSeeAllReviewText,
  canSeeContactDetails,
  canViewProfileReport,
  dataScopeOf,
  decisionCalendars,
  decisionCalendarsFor,
  deciderRoleFor,
  eligibleStepsFor,
  isApprover,
  isReadOnlyRole,
  isReadOnlyViewer,
  seesContactDetails,
  stepEligibility,
  takesSteps,
} from '@mmp/shared';
import { connectDB } from '../src/config/db.js';
import { resolveScope } from '../src/lib/scope.js';
import { WORKLOAD_ROLES } from '../src/modules/workload/service.js';
import { decidersFor } from '../src/modules/workItems/deciders.js';
import { Person } from '../src/modules/people/model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { planWorkflowSeed, applyWorkflowSeed } from '../src/modules/accessConfig/seed.js';
import * as resolver from '../src/lib/accessResolver.js';

const SRC = path.resolve(__dirname, '../src');
const ME = new mongoose.Types.ObjectId().toString();
const OTHER = new mongoose.Types.ObjectId().toString();
const userOf = (role, extra = {}) => ({ _id: ME, role, status: 'active', ...extra });
const ids = (list) => [...new Set((list || []).map((p) => String(p?._id || p)))].sort();

// ------------------------------------------------------------------ access matrix

const has = (role, key) => role === 'admin' || (ROLE_PERMISSIONS[role] || []).includes(key);
const LEADERS = ['admin', ...APPROVER_ROLES, 'sm_manager'];

/** Every decision-type action: [name, old(role, calendar, ownerId), new(user, calendar, ownerId)]. */
const ACTIONS = [
  ['review.decide (canDecide)', (r, c, o) => canDecide(userOf(r), c, { ownerId: o }), (u, c, o) => can(u, 'review.decide', { calendar: c, ownerId: o })],
  ['review buttons (canReview, not own)', (r, c, o) => canReview(r) && o !== ME, (u, c, o) => can(u, 'review.decide', { ownerId: o })],
  ['plan approve (plan.service 1160+1169)', (r, c) => (isApprover(r) || r === 'admin') && canDecide(r, c), (u, c) => can(u, 'calendar.approve', { calendar: c })],
  // Phase C5 (documented change): classifying a flag on your own step is blocked, like every other decision.
  ['classify flag (route + feedback 418; C5: not own)', (r, c, o) => has(r, 'revision.classify') && canDecide(r, c) && o !== ME, (u, c, o) => can(u, 'revision.classify', { calendar: c, ownerId: o })],
  ['mark Post posted, not owner (transition 204)', (r) => r === 'sm_manager' || r === 'admin', (u, c) => can(u, 'publish.post', { calendar: c })],
  ['edit live link (published 185)', (r) => r === 'sm_manager' || r === 'admin', (u) => can(u, 'publish.edit_live_link')],
  ['resolve any blocker (transition 256)', (r) => r === 'sm_manager' || r === 'admin', (u) => can(u, 'blocker.resolve.any')],
  ['change owner / date / skip (shared 2217)', (r) => r === 'sm_manager' || r === 'admin', (u) => can(u, 'work.manage_steps')],
  ['read review text (canSeeAllReviewText or owner)', (r, c, o) => canSeeAllReviewText(r) || o === ME, (u, c, o) => can(u, 'review.read_all') || String(o) === ME],
  ['contact details (canSeeContactDetails)', (r) => canSeeContactDetails(r), (u) => seesContactDetails(u)],
  ['operational fields (canManageOperationalFields)', (r) => canManageOperationalFields(r), (u) => can(u, 'people.manage_operational')],
  ['profile report (canViewProfileReport)', (r) => canViewProfileReport(r), (u) => can(u, 'team.profile.report')],
  ['@everyone (chat 665)', (r) => LEADERS.includes(r), (u) => can(u, 'chat.mention_all')],
  ['pin any (chat 871)', (r) => LEADERS.includes(r), (u) => can(u, 'chat.moderate')],
  ['share any asset (chat 1060)', (r) => LEADERS.includes(r), (u) => can(u, 'chat.share_asset')],
  ['revoke any share (chat 1154)', (r) => ['admin', ...APPROVER_ROLES].includes(r), (u) => can(u, 'chat.revoke_share')],
  ['manage any group (chat 303..779)', (r) => r === 'admin', (u) => can(u, 'chat.manage_groups')],
  ['read-only role (auth.js 99)', (r) => isReadOnlyViewer(r), (u) => isReadOnlyRole(u)],
  ['takes steps (WORKLOAD_ROLES)', (r) => WORKLOAD_ROLES.includes(r), (u) => takesSteps(u)],
];

describe('Access parity: old rules vs the resolver', () => {
  it('every v1 permission key (but portal.view) gives the same answer for every role', () => {
    const v1 = PERMISSION_KEYS.filter((k) => k !== 'portal.view');
    for (const k of v1) expect(PERMISSION_KEYS_V2, `${k} is in catalog v2`).toContain(k);
    let checks = 0;
    for (const role of ROLE_KEYS) {
      for (const k of v1) {
        expect(can(userOf(role), k), `${role} ${k}`).toBe(has(role, k));
        checks++;
      }
    }
    expect(checks).toBe(ROLE_KEYS.length * v1.length);
  });

  it('every API route guard admits exactly the roles it admitted before Phase C2 (frozen snapshot)', () => {
    // test/fixtures/route_guard_snapshot.json: each guard's admitted roles, generated from the
    // pre-C2 routes (v1 keys, admin bypass) by scripts/snapshot-route-guards.js.
    const snapshot = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'fixtures/route_guard_snapshot.json'), 'utf8'));
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/routes\.js$/.test(e.name)) files.push(p);
      }
    };
    walk(path.join(SRC, 'modules'));
    const current = {};
    for (const f of files) {
      const rel = path.relative(path.join(SRC, 'modules'), f).replace(/\\/g, '/');
      const guards = [];
      for (const m of fs.readFileSync(f, 'utf8').matchAll(/require(?:Any)?Permission\(([^)]*)\)/g)) {
        const keys = [...m[1].matchAll(/['"]([a-z_.]+)['"]/g)].map((x) => x[1]);
        if (keys.length) guards.push(keys);
      }
      if (guards.length) current[rel] = guards;
    }
    // Route files added after the snapshot: each guard admits only the locked admin role.
    const ADDED_LATER = ['accessConfig/accessAdmin.routes.js']; // Phase D: Access & Approvals
    for (const file of ADDED_LATER) {
      expect(current[file], `${file} is guarded`).toBeTruthy();
      for (const keys of current[file]) expect(ROLE_KEYS.filter((role) => keys.some((k) => can(userOf(role), k)))).toEqual(['admin']);
      delete current[file];
    }
    expect(Object.keys(current).sort()).toEqual(Object.keys(snapshot).sort());
    let checked = 0;
    for (const [file, guards] of Object.entries(snapshot)) {
      expect(current[file].length, `${file}: number of guards`).toBe(guards.length);
      guards.forEach((g, i) => {
        const keys = current[file][i];
        for (const k of keys) expect(PERMISSION_KEYS_V2, `${file} #${i} uses catalog v2 keys`).toContain(k);
        const admitted = ROLE_KEYS.filter((role) => keys.some((k) => can(userOf(role), k)));
        expect(admitted, `${file} #${i} [${keys.join(', ')}] was [${g.keys.join(', ')}]`).toEqual(g.roles);
        checked++;
      });
    }
    expect(checked).toBe(101);
  });

  it(`decision actions: 7 roles × ${ACTIONS.length} actions × 5 calendars × owner/non-owner are 100% equal`, () => {
    let checks = 0;
    const diffs = [];
    for (const role of ROLE_KEYS) {
      for (const calendar of CALENDAR_KEYS) {
        for (const ownerId of [ME, OTHER]) {
          for (const [name, oldFn, newFn] of ACTIONS) {
            const a = Boolean(oldFn(role, calendar, ownerId));
            const b = Boolean(newFn(userOf(role), calendar, ownerId));
            if (a !== b) diffs.push(`${name} ${role} ${calendar} ${ownerId === ME ? 'owner' : 'non-owner'}: old ${a}, new ${b}`);
            checks++;
          }
        }
      }
    }
    expect(diffs).toEqual([]);
    expect(checks).toBe(ROLE_KEYS.length * CALENDAR_KEYS.length * 2 * ACTIONS.length);
  });

  it('data scope (scope.js) and decision calendars (decisionCalendarsFor) match', async () => {
    for (const role of ROLE_KEYS) {
      const scope = await resolveScope(userOf(role));
      expect(dataScopeOf(userOf(role)) === 'all', role).toBe(scope.scopeType === 'all');
      expect(decisionCalendars(userOf(role)), role).toEqual(decisionCalendarsFor(role));
    }
  });

  it('step eligibility matches eligibleStepsFor for every role, job role, stage and calendar', () => {
    let checks = 0;
    for (const role of ROLE_KEYS) {
      for (const jobRole of [...JOB_ROLES, '', null]) {
        const person = userOf(role, { jobRole });
        for (const stageKey of STAGE_KEYS) {
          for (const calendar of CALENDAR_KEYS) {
            expect(stepEligibility(person, { stageKey, calendar }), `${role} ${jobRole} ${stageKey} ${calendar}`).toBe(eligibleStepsFor(person).includes(stageKey));
            checks++;
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(1500);
  });
});

// ------------------------------------------------------------------ routing (database)

const EMAIL = /@access-parity-test\.com$/;
const TAG = 'APARITY';

describe('Routing parity: reviewers, plan approvers, posters, recipients', () => {
  const P = {};
  const deptA = new mongoose.Types.ObjectId();
  const deptB = new mongoose.Types.ObjectId();
  const person = async (key, role, extra = {}) => {
    P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@access-parity-test.com`, role, status: 'active', ...extra });
    return P[key];
  };
  const cleanup = async () => {
    await Person.deleteMany({ email: EMAIL });
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
  };

  // Legacy oracles, mirrored from the cited lines.
  const legacy = {
    allSm: () => Person.find({ role: 'sm_manager', status: 'active' }), // transition 689, handoff 155, blockers 138, pause 67
    firstSm: () => Person.findOne({ role: 'sm_manager', status: 'active' }).lean(), // plan.service 508, 880
    flagged: (item) =>
      Person.find({
        $or: [
          { role: deciderRoleFor(item.calendar || 'sm'), status: 'active' },
          ...(item.departmentId ? [{ role: 'sm_manager', departmentId: item.departmentId, status: 'active' }] : []),
        ],
      }), // feedback/service 360-366
    escalated: async (item) => [
      ...(await Person.find({ role: deciderRoleFor(item.calendar || 'sm'), status: { $ne: 'suspended' } }).lean()),
      ...(await Person.find({ role: 'admin', status: { $ne: 'suspended' } }).lean()),
    ], // automation/runner 431-439
    // Phase C5 (documented change): every SM Manager of the department, else every SM Manager (was: the first one).
    overdueManager: async (item) => {
      const inDept = item.departmentId ? await Person.find({ departmentId: item.departmentId, role: 'sm_manager', status: 'active' }).lean() : [];
      return inDept.length ? inDept : Person.find({ role: 'sm_manager', status: 'active' }).lean();
    },
    admins: () => Person.find({ role: 'admin', status: 'active' }), // notifications/service 184
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    await person('cl1', 'creative_lead');
    await person('cl2', 'creative_lead');
    await person('clSusp', 'creative_lead', { status: 'suspended' });
    await person('clInv', 'creative_lead', { status: 'invited' });
    await person('gl1', 'growth_lead');
    await person('glInv', 'growth_lead', { status: 'invited' });
    await person('ad1', 'admin');
    await person('adSusp', 'admin', { status: 'suspended' });
    await person('smA1', 'sm_manager', { departmentId: deptA });
    await person('smA2', 'sm_manager', { departmentId: deptA });
    await person('smB', 'sm_manager', { departmentId: deptB });
    await person('smNone', 'sm_manager');
    await person('smSusp', 'sm_manager', { status: 'suspended', departmentId: deptA });
    await person('head', 'creative_head');
    await person('ex', 'executive', { jobRole: 'Writer' });
  }, 60000);
  afterAll(cleanup, 60000);

  const items = () => [
    ...CALENDAR_KEYS.map((calendar) => ({ calendar })),
    { calendar: 'sm', departmentId: deptA },
    { calendar: 'ads', departmentId: deptB },
    { calendar: null, departmentId: new mongoose.Types.ObjectId() },
    {},
  ];

  async function expectParity(label) {
    let checks = 0;
    for (const item of items()) {
      const tag = `${label} ${item.calendar ?? '(none)'}${item.departmentId ? ' +dept' : ''}`;
      expect(ids((await resolver.reviewersFor(item)).primary), `reviewers ${tag}`).toEqual(ids(await decidersFor(item.calendar || 'sm')));
      expect(ids((await resolver.planApproversFor(item)).primary), `plan approvers ${tag}`).toEqual(ids(await decidersFor(item.calendar || 'sm')));
      const posters = await resolver.postersFor(item);
      expect(ids(posters.people), `posters ${tag}`).toEqual(ids(await legacy.allSm()));
      expect(String(posters.defaultPoster?._id), `default poster ${tag}`).toBe(String((await legacy.firstSm())?._id));
      expect(ids(await resolver.recipientsFor('submission.ready', item)), `submission.ready ${tag}`).toEqual(ids(await decidersFor(item.calendar || 'sm')));
      expect(ids(await resolver.recipientsFor('plan.submitted', item)), `plan.submitted ${tag}`).toEqual(ids(await decidersFor(item.calendar || 'sm')));
      expect(ids(await resolver.recipientsFor('revision.flagged', item)), `revision.flagged ${tag}`).toEqual(ids(await legacy.flagged(item)));
      expect(ids(await resolver.recipientsFor('revision.flag_escalated', item)), `flag escalated ${tag}`).toEqual(ids(await legacy.escalated(item)));
      expect(ids(await resolver.recipientsFor('step.needs_owner', item)), `needs owner ${tag}`).toEqual(ids(await legacy.allSm()));
      expect(ids(await resolver.recipientsFor('step.overdue_manager', item)), `overdue manager ${tag}`).toEqual(ids(await legacy.overdueManager(item)));
      expect(ids(await resolver.recipientsFor('access.requested', item)), `access requested ${tag}`).toEqual(ids(await legacy.admins()));
      checks += 11;
    }
    for (const p of Object.values(P)) {
      for (const stageKey of STAGE_KEYS) {
        for (const calendar of CALENDAR_KEYS) {
          expect(await resolver.stepEligibility(p, { stageKey, calendar }), `eligibility ${p.name} ${stageKey}`).toBe(eligibleStepsFor(p).includes(stageKey) && p.status !== 'suspended');
          expect(await resolver.can(p, 'review.decide', { calendar, ownerId: OTHER }), `can ${p.name} ${calendar}`).toBe(p.status !== 'suspended' && canDecide(p, calendar, { ownerId: OTHER }));
        }
      }
    }
    return checks;
  }

  it('with no stored config (the code default)', async () => {
    expect(await WorkflowConfig.countDocuments()).toBe(0);
    expect(await expectParity('default')).toBe(items().length * 11);
  }, 120000);

  it('with the seeded WorkflowConfig documents', async () => {
    const created = await applyWorkflowSeed(await planWorkflowSeed());
    expect(created.sort()).toEqual([...CALENDAR_KEYS].sort());
    resolver.clearAccessCache();
    await expectParity('seeded');
  }, 120000);

  it('the resolver follows a changed config: named reviewers, version bump, cache cleared', async () => {
    const before = await resolver.getWorkflowConfig('sales');
    const doc = await WorkflowConfig.findOne({ calendar: 'sales' });
    doc.reviewers = { roles: [], userIds: [P.smA1._id] };
    await doc.save();
    const after = await resolver.getWorkflowConfig('sales');
    expect(after.version).toBe(before.version + 1);
    // Final fix H3: a named person whose role cannot review is skipped, so the fallback (every
    // active admin) takes the work instead of someone who cannot act on it.
    const named = await resolver.reviewersFor({ calendar: 'sales' });
    expect(named.primary).toEqual([]);
    expect(ids(named.people)).toEqual(ids(await Person.find({ role: 'admin', status: 'active' })));
    // SM Manager lacks review.decide: being named does not grant the permission.
    expect(await resolver.can(P.smA1, 'review.decide', { calendar: 'sales', ownerId: OTHER })).toBe(false);
    expect(await resolver.can(P.cl1, 'review.decide', { calendar: 'sales', ownerId: OTHER })).toBe(false);
    // No active reviewer: the fallback (every active admin) is used (fixed rule 12).
    doc.reviewers = { roles: ['growth_lead'], userIds: [] };
    await doc.save();
    await Person.updateOne({ _id: P.gl1._id }, { $set: { status: 'suspended' } });
    const r = await resolver.reviewersFor({ calendar: 'sales' });
    expect(r.primary).toEqual([]);
    expect(ids(r.people)).toEqual(ids(await Person.find({ role: 'admin', status: 'active' })));
    await Person.updateOne({ _id: P.gl1._id }, { $set: { status: 'active' } });
  });
});
