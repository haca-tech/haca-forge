// Small fix: the plan grid's automatic owner fill and the import suggestions use the owner
// dropdown's candidates (the one owner rule: active, job role for production steps, a poster on the
// calendar for Post), narrowed by preferences but never down to nobody; pickOwner chooses among them.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { autofillRowPlan } from '../src/modules/calendar/autofill.service.js';
import { validateImportRows } from '../src/modules/calendar/import.service.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'AUTOFILLRULE';
const DOMAIN = '@autofill-rule-test.com';
const EMAIL = /@autofill-rule-test\.com$/;
const DESIGNERS = { status: 'active', role: 'executive', jobRole: { $in: ['Graphic Designer', 'All Rounder'] } };

describe('Grid autofill and import suggestions follow the owner rule', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  const ownerOf = (plan, stageKey) => plan.stages.find((s) => s.stageKey === stageKey)?.ownerId || null;
  const fill = (calendar = 'sm') => autofillRowPlan({ type: 'Static Post', postingDate: new Date(Date.now() + 10 * 864e5), calendar });

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const plans = (await CalendarPlan.find({ createdById: { $in: people } }).select('_id').lean()).map((p) => p._id);
    await ContentPiece.deleteMany({ planId: { $in: plans } });
    await CalendarPlan.deleteMany({ _id: { $in: plans } });
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await person('sm', 'sm_manager');
    await person('smSales', 'sm_manager', { calendarScope: ['sales'] });
  }, 60000);
  afterAll(cleanup, 60000);
  beforeEach(async () => {
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await Person.deleteMany({ email: EMAIL, jobRole: { $in: ['Graphic Designer', 'All Rounder'] } });
  });

  it('a worker with no preferences, the only eligible person, is auto-assigned (grid autofill, the grid save, the import)', async () => {
    const designer = await person('designer', 'executive', { jobRole: 'Graphic Designer', workPreferences: [] });
    expect(await Person.countDocuments(DESIGNERS)).toBe(1); // precondition: nobody else can own Design
    // The autofill service.
    expect(String(ownerOf(await fill(), 'Design'))).toBe(String(designer._id)); // was: no owner
    // Through the grid save, as the plan grid uses it: the saved row's planned Design owner.
    const res = await request(app).post('/api/calendar-plans/grid/rows').set(as('sm')).send({ calendar: 'sm', month: '2038-03', rows: [{ clientKey: 'a', cells: { postingDate: '2038-03-12', topic: `${TAG} grid`, type: 'Static Post', brief: 'Autofill.' } }] });
    expect(res.status).toBe(201);
    const row = await ContentPiece.findById(res.body.data.results[0].rowId).lean();
    expect(String(row.stagePlan.find((st) => st.stageKey === 'Design')?.ownerId)).toBe(String(designer._id));
    // The import suggestion.
    const imported = await validateImportRows([{ rowIndex: 2, topic: `${TAG} import`, contentType: 'Static Post', postingDate: new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10) }]);
    expect(JSON.stringify(imported)).toContain(String(designer._id));
  });

  it('preferences only narrow: someone who prefers the step is chosen first; nobody preferring it falls back to everyone eligible', async () => {
    const other = await person('notKeen', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Content'] });
    expect(String(ownerOf(await fill(), 'Design'))).toBe(String(other._id)); // the only eligible: fallback
    const keen = await person('keen', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Design'] });
    expect(String(ownerOf(await fill(), 'Design'))).toBe(String(keen._id));
  });

  it('Post is filled only with a poster on the row\'s calendar', async () => {
    // Sales posts only through the Sales-limited SM Manager; SM keeps the SM Manager role.
    await WorkflowConfig.create({ calendar: 'sales', reviewers: { roles: ['creative_lead'], userIds: [] }, planApprovers: { roles: ['creative_lead'], userIds: [] }, posters: { roles: [], userIds: [String(P.smSales._id)] }, fallbackApprovers: { roles: ['admin'], userIds: [] } });
    resolver.clearAccessCache();
    expect(String(ownerOf(await fill('sales'), 'Post'))).toBe(String(P.smSales._id));
    expect(String(ownerOf(await fill('sm'), 'Post'))).not.toBe(String(P.smSales._id)); // limited to Sales
  });
});
