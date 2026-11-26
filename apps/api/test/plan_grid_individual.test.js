// Individual work (kind 'individual', its own small plan) is listed in the plan grid for its calendar
// and month, next to the monthly plan, and can be reviewed there through its own plan.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { WorkItem } from '../src/modules/workItems/model.js';

const EMAIL = /@pg-indiv-test\.com$/;
const MONTH = '2032-02';
const CAL = 'academics_management';

describe('Plan grid lists individual work', () => {
  const people = {};
  const tokens = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const pids = (await CalendarPlan.find({ createdById: { $in: ids } }).select('_id').lean()).map((p) => p._id);
    await WorkItem.deleteMany({ calendarPlanId: { $in: pids } });
    await ContentPiece.deleteMany({ planId: { $in: pids } });
    await CalendarPlan.deleteMany({ _id: { $in: pids } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    const mk = async (key, role, extra = {}) => {
      people[key] = await Person.create({ name: `PGI ${key}`, email: `${key}@pg-indiv-test.com`, role, status: 'active', ...extra });
      tokens[key] = make(people[key]);
    };
    await mk('sm', 'sm_manager');
    await mk('head', 'creative_lead');
    await mk('designer', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Design'] });
    await mk('writer', 'executive', { jobRole: 'Writer', workPreferences: ['Content'] });
  });
  afterAll(cleanup);

  it('shows the month plan rows and the individual work row (marked, read-only), and the reviewer approves the individual row through its own plan', async () => {
    // A monthly plan row, saved through the grid.
    const monthly = await request(app)
      .post('/api/calendar-plans/grid/rows')
      .set(as('sm'))
      .send({ calendar: CAL, month: MONTH, rows: [{ clientKey: 'm', cells: { postingDate: '2032-02-20', topic: 'PGI monthly post', type: 'Static Post' } }] });
    expect(monthly.status).toBe(201);
    const monthlyPlanId = monthly.body.data.plan._id;

    // Individual work, created the way the Plans tab does it.
    const indiv = await request(app)
      .post('/api/calendar-plans')
      .set(as('sm'))
      .send({
        title: 'PGI individual',
        calendar: CAL,
        kind: 'individual',
        periodStart: '2032-02-10',
        periodEnd: '2032-02-10',
        rows: [{ topic: 'PGI individual post', type: 'Static Post', postingDate: '2032-02-10', brief: 'One-off.', needsScript: false, needsShoot: false }],
      });
    expect(indiv.status).toBe(201);
    const indivPlanId = String(indiv.body.data._id);
    const indivRow = await ContentPiece.findOne({ planId: indivPlanId }).lean();
    if (indivRow.rowStatus !== 'submitted') {
      expect((await request(app).post(`/api/calendar-plans/${indivPlanId}/submit`).set(as('sm'))).status).toBe(200);
    }

    // Both people see both rows; the individual row names its own plan and is not editable in the grid.
    for (const who of ['sm', 'head']) {
      const grid = await request(app).get('/api/calendar-plans/grid').query({ calendar: CAL, month: MONTH }).set(as(who));
      expect(grid.status).toBe(200);
      expect(grid.body.data.plan._id).toBe(monthlyPlanId);
      const byTopic = Object.fromEntries(grid.body.data.rows.map((r) => [r.topic, r]));
      expect(byTopic['PGI monthly post']).toMatchObject({ planId: monthlyPlanId, planKind: 'monthly' });
      expect(byTopic['PGI individual post']).toMatchObject({ planId: indivPlanId, planKind: 'individual', editable: false, rowStatus: 'submitted' });
    }

    // The reviewer approves it through its own plan, and the grid shows it approved.
    const approved = await request(app)
      .post(`/api/calendar-plans/${indivPlanId}/review`)
      .set(as('head'))
      .send({ action: 'approve_selected', approvedRowIds: [String(indivRow._id)] });
    expect(approved.status).toBe(200);
    const after = await request(app).get('/api/calendar-plans/grid').query({ calendar: CAL, month: MONTH }).set(as('head'));
    expect(after.body.data.rows.find((r) => r.topic === 'PGI individual post').rowStatus).toBe('approved');
    // Another month does not list it.
    const other = await request(app).get('/api/calendar-plans/grid').query({ calendar: CAL, month: '2032-03' }).set(as('head'));
    expect(other.body.data.rows.some((r) => r.topic === 'PGI individual post')).toBe(false);
  });
});
