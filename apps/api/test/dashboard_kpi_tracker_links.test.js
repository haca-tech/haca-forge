// Home page KPI cards: each card counts the Content Flow Tracker's rows with the Tracker's own
// rules, for the selected month (IST) and the dashboard's department, owner and step-status
// filters. Each card's link opens that same Tracker view, so the number on the card is the number
// of rows the link shows. Disposable test DB; every seeded step is in a department of its own.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { DASHBOARD_KPI_STATUSES, trackerRowShown, monthKeyInAppTz } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';

const DAY = 24 * 60 * 60 * 1000;
const tokenFor = (u) => jwt.sign({ userId: String(u._id), role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });

// Publish dates 20 days ahead, so no row is overdue by its publish date (the Tracker's project rule).
const AHEAD = new Date(Date.now() + 20 * DAY);
const nextMonthKey = (key) => {
  const [y, m] = key.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

describe('Dashboard KPI cards = the Tracker rows their links open', () => {
  const salt = `kpi-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const month = monthKeyInAppTz(AHEAD);
  const thisMonth = monthKeyInAppTz(new Date());
  const dept = new mongoose.Types.ObjectId();
  const otherDept = new mongoose.Types.ObjectId();
  const pieces = [];
  let admin;
  let writer;
  let editor;
  const auth = () => ({ Authorization: `Bearer ${tokenFor(admin)}` });

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(env.MONGODB_URI);
    admin = await Person.create({ name: 'KPI admin', email: `admin.${salt}@kpi.test`, role: 'admin', status: 'active' });
    writer = await Person.create({ name: 'KPI writer', email: `writer.${salt}@kpi.test`, role: 'executive', status: 'active' });
    editor = await Person.create({ name: 'KPI editor', email: `editor.${salt}@kpi.test`, role: 'executive', status: 'active' });

    const planId = new mongoose.Types.ObjectId();
    const now = Date.now();
    const row = async (key, steps, extra = {}, postingDate = AHEAD) => {
      const piece = await ContentPiece.create({
        planId, topic: `${key} ${salt}`, contentType: 'Reel', pipeline: 'reel_a', postingDate, rowStatus: 'approved', needsScript: true, needsShoot: false, ...extra,
      });
      pieces.push(piece);
      let order = 1;
      for (const s of steps) {
        await WorkItem.create({
          title: `${key} ${s.stageKey || 'Script'} ${salt}`, workType: 'Reel', stageKey: s.stageKey || 'Script', stageOrder: order++,
          status: s.status, isLocked: false, contentPieceId: piece._id, calendarPlanId: planId,
          departmentId: s.dept || dept, ownerId: (s.owner || writer)._id, dueDate: s.due, deadline: s.due, estimatedEffortHrs: 1,
        });
      }
    };
    await row('overdue', [{ status: 'In Progress', due: new Date(now - 5 * DAY) }]);
    await row('atrisk', [{ status: 'In Progress', due: new Date(now + 1 * DAY), owner: editor }]);
    await row('blocked', [{ status: 'Blocked', due: new Date(now + 10 * DAY) }]);
    await row('waiting', [{ status: 'Pending', due: new Date(now + 10 * DAY) }]);
    await row('ontrack', [{ status: 'Not Started', due: new Date(now + 20 * DAY), owner: editor }]);
    await row('posted', [{ stageKey: 'Post', status: 'Published', due: new Date(now - 2 * DAY) }], { publishedAt: new Date(now - 2 * DAY) });
    // Not counted with this department: another department, and next month.
    await row('otherdept', [{ status: 'In Progress', due: new Date(now - 5 * DAY), dept: otherDept }]);
    await row('nextmonth', [{ status: 'In Progress', due: new Date(now - 5 * DAY) }], {}, new Date(`${nextMonthKey(month)}-15T06:30:00Z`));
  });

  afterAll(async () => {
    const ids = pieces.map((p) => p._id);
    await WorkItem.deleteMany({ contentPieceId: { $in: ids } });
    await ContentPiece.deleteMany({ _id: { $in: ids } });
    await Person.deleteMany({ email: new RegExp(salt) });
  });

  const dashboard = async (query) => {
    const res = await request(app).get('/api/dashboard/overview').query(query).set(auth());
    expect(res.status).toBe(200);
    return res.body.data.kpis;
  };

  /** What the Tracker shows for a card's link: the API rows, then the Tracker's status rule. */
  const trackerCount = async (apiQuery, status) => {
    const res = await request(app).get('/api/content-pieces').query(apiQuery).set(auth());
    expect(res.status).toBe(200);
    return res.body.data.filter((p) => trackerRowShown(p, status)).length;
  };

  it('counts the month\'s rows by the Tracker\'s rules (one department)', async () => {
    const kpis = await dashboard({ month, departmentId: String(dept) });
    expect(kpis).toMatchObject({
      month,
      planned: 6, // every row this month in the department (otherdept and nextmonth left out)
      completed: 1, // posted
      inProgress: 3, // on track: atrisk, waiting, ontrack (not posted, overdue or blocked)
      atRisk: 1,
      blocked: 1,
      pendingApproval: 1,
      overdue: 1,
    });
  });

  it('every card equals the Tracker rows its link opens (month, department, owner, step status)', async () => {
    const cases = [
      { dash: { month, departmentId: String(dept) }, api: { month, departmentId: String(dept) } },
      { dash: { month }, api: { month } },
      { dash: { month, departmentId: String(dept), ownerId: String(editor._id) }, api: { month, departmentId: String(dept), ownerId: String(editor._id) } },
      { dash: { month, status: 'In Progress' }, api: { month, stageStatus: 'In Progress' } },
    ];
    for (const { dash, api } of cases) {
      const kpis = await dashboard(dash);
      for (const [key, status] of Object.entries(DASHBOARD_KPI_STATUSES)) {
        expect(kpis[key], `${key} with ${JSON.stringify(dash)}`).toBe(await trackerCount(api, status));
      }
    }
  });

  it('the owner filter counts rows with a step that person owns', async () => {
    const kpis = await dashboard({ month, departmentId: String(dept), ownerId: String(editor._id) });
    expect(kpis).toMatchObject({ planned: 2, atRisk: 1, inProgress: 2, overdue: 0, blocked: 0 });
  });

  it('the dashboard month defaults to this month in IST, like the Tracker', async () => {
    const kpis = await dashboard({ departmentId: String(dept) });
    expect(kpis.month).toBe(thisMonth);
    expect(kpis.planned).toBe(month === thisMonth ? 6 : 0);
  });

  it('a row due within 3 days but already overdue is Overdue, not At risk; Tracker rows carry hasAtRisk', async () => {
    const res = await request(app).get('/api/content-pieces').query({ month, departmentId: String(dept) }).set(auth());
    const byKey = Object.fromEntries(res.body.data.map((p) => [p.topic.split(' ')[0], p]));
    expect(byKey.atrisk.hasAtRisk).toBe(true);
    expect(byKey.overdue.hasAtRisk).toBe(false);
    expect(byKey.ontrack.hasAtRisk).toBe(false);
    expect(byKey.waiting.hasAtRisk).toBe(false); // waiting on the reviewer, not on the owner
    expect(byKey.otherdept).toBeUndefined();
  });
});
