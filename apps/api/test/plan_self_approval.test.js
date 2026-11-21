// Phase E fix: nobody approves (or sends back) their own plan. calendar.approve is self-forbidden
// like review.decide and revision.classify; the plan's creator is its owner.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { can, SELF_FORBIDDEN_PERMISSIONS } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { CalendarPlan } from '../src/modules/calendar/plan.model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { seedReferenceData } from '../src/modules/referenceData/service.js';

const EMAIL = /@plan-self-test\.com$/;
const tok = (u) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(u._id), role: u.role, email: u.email }, env.JWT_SECRET, { expiresIn: '1h' })}` });

describe('No self-approval of plans', () => {
  const P = {};
  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const plans = (await CalendarPlan.find({ createdById: { $in: ids } }).select('_id').lean()).map((p) => p._id);
    await ContentPiece.deleteMany({ planId: { $in: plans } });
    await CalendarPlan.deleteMany({ _id: { $in: plans } });
    await Person.deleteMany({ email: EMAIL });
  };
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await seedReferenceData();
    for (const [k, role] of [['admin1', 'admin'], ['admin2', 'admin'], ['lead', 'creative_lead'], ['sm', 'sm_manager']]) {
      P[k] = await Person.create({ name: `PSA ${k}`, email: `${k}@plan-self-test.com`, role, status: 'active' });
    }
  }, 60000);
  afterAll(cleanup, 60000);

  const planBy = async (who, month) => {
    const saved = await request(app).post('/api/calendar-plans/grid/rows').set(tok(P[who])).send({ calendar: 'sm', month, rows: [{ clientKey: 'r', cells: { postingDate: `${month}-20`, topic: `PSA ${who}`, type: 'Static Post', brief: 'Self approval test.' } }] });
    expect(saved.status, JSON.stringify(saved.body?.error || {})).toBe(201);
    const planId = saved.body.data.plan._id;
    expect((await request(app).post(`/api/calendar-plans/${planId}/submit`).set(tok(P[who]))).status).toBe(200);
    return { planId, rowId: saved.body.data.results[0].rowId };
  };

  it('the rule is in the shared resolver', () => {
    expect(SELF_FORBIDDEN_PERMISSIONS).toContain('calendar.approve');
    expect(can(P.admin1, 'calendar.approve', { calendar: 'sm', ownerId: P.admin1._id })).toBe(false);
    expect(can(P.admin1, 'calendar.approve', { calendar: 'sm', ownerId: P.sm._id })).toBe(true);
  });

  it('an admin cannot approve or send back the plan they made; another admin or the lead can', async () => {
    const { planId, rowId } = await planBy('admin1', '2035-03');
    for (const body of [{ action: 'approve_selected', approvedRowIds: [rowId] }, { action: 'request_changes_all', message: 'Again' }]) {
      const own = await request(app).post(`/api/calendar-plans/${planId}/review`).set(tok(P.admin1)).send(body);
      expect(own.status).toBe(403);
      expect(own.body.error.code).toBe('SELF_DECISION');
    }
    expect((await ContentPiece.findById(rowId).lean()).rowStatus).toBe('submitted');
    // The grid does not offer review controls on your own plan.
    const grid = await request(app).get('/api/calendar-plans/grid').query({ calendar: 'sm', month: '2035-03', planId }).set(tok(P.admin1));
    expect(grid.body.data.permissions.canReview).toBe(false);
    const other = await request(app).get('/api/calendar-plans/grid').query({ calendar: 'sm', month: '2035-03', planId }).set(tok(P.admin2));
    expect(other.body.data.permissions.canReview).toBe(true);
    expect((await request(app).post(`/api/calendar-plans/${planId}/review`).set(tok(P.lead)).send({ action: 'approve_selected', approvedRowIds: [rowId] })).status).toBe(200);
  });

  it('an SM Manager\'s plan is approved by the lead as before', async () => {
    const { planId, rowId } = await planBy('sm', '2035-04');
    expect((await request(app).post(`/api/calendar-plans/${planId}/review`).set(tok(P.admin1)).send({ action: 'approve_selected', approvedRowIds: [rowId] })).status).toBe(200);
  });
});
