// Help requests on a step: who can ask whom, validation, one notification, replies and
// resolve by role, other workers 404, no effect on the step, Tracker and Review Hub counts.
// Disposable test DB, synthetic people and steps.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { HelpRequest } from '../src/modules/workItems/helpRequest.model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import { openHelpCounts } from '../src/modules/workItems/help.service.js';

const EMAIL = /@help-req-test\.com$/;
const TAG = 'HELPT';
const H = 3600000;

describe('Help requests', () => {
  const P = {};
  const tokens = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (who) => ({
    get: (url) => request(app).get(url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url, body) => request(app).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });
  const dept = new mongoose.Types.ObjectId();
  const piece = new mongoose.Types.ObjectId();

  const step = (owner, extra = {}) =>
    WorkItem.create({
      title: `${TAG} ${extra.stageKey || 'Edit'} ${Math.round(Math.random() * 1e9)}`,
      workType: 'Reel',
      stageKey: 'Edit',
      stageOrder: 3,
      status: 'In Progress',
      isLocked: false,
      reviewRequired: true,
      calendar: 'sm',
      ownerId: P[owner]._id,
      departmentId: dept,
      contentPieceId: piece,
      deadline: new Date(Date.now() + 5 * 86400000),
      startedAt: new Date(Date.now() - 3 * H),
      rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 3 * H), intervals: [] }],
      ...extra,
    });
  const url = (w) => `/api/work/${w._id}/help-requests`;
  const ask = (who, w, body = {}) => as(who).post(url(w), { topic: 'brief_unclear', message: 'Which cut of the logo should I use?', helperId: String(P.creativeLead._id), ...body });
  const notes = (who, type) => Notification.countDocuments({ recipient: P[who]._id, type });

  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG} `) }).select('_id').lean()).map((w) => w._id);
    await HelpRequest.deleteMany({ workItemId: { $in: steps } });
    await ActivityEvent.deleteMany({ entityId: { $in: [...steps, ...steps.map(String)] } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await Notification.deleteMany({ recipient: { $in: ids } });
    await Person.deleteMany({ email: EMAIL });
  };

  let edit; let script; let lonely;
  beforeAll(async () => {
    await connectDB();
    await cleanup();
    for (const [key, role] of [
      ['admin', 'admin'],
      ['creativeLead', 'creative_lead'],
      ['growthLead', 'growth_lead'],
      ['creativeHead', 'creative_head'],
      ['sm', 'sm_manager'],
      ['worker', 'executive'],
      ['writer', 'executive'],
      ['outsider', 'executive'],
    ]) {
      P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@help-req-test.com`, role, status: 'active' });
      tokens[key] = make(P[key]);
    }
    script = await step('writer', { stageKey: 'Script', stageOrder: 1, status: 'Approved' });
    edit = await step('worker');
    lonely = await step('outsider', { contentPieceId: new mongoose.Types.ObjectId() });
  }, 60000);
  afterAll(cleanup, 60000);

  it('lists the people the owner can ask, with the deciding lead as the default', async () => {
    const res = await as('worker').get(url(edit));
    expect(res.status).toBe(200);
    const { canAsk, options, defaultHelperId } = res.body.data;
    expect(canAsk).toBe(true);
    const mine = options.filter((o) => o.name.startsWith(TAG));
    expect(mine.map((o) => [o.kind, o.name])).toEqual(
      expect.arrayContaining([
        ['lead', `${TAG} creativeLead`],
        ['sm_manager', `${TAG} sm`],
        ['step_owner', `${TAG} writer`],
      ])
    );
    // SM calendar: the Creative Lead decides, not the Growth Lead.
    expect(mine.some((o) => o.name === `${TAG} growthLead`)).toBe(false);
    const def = options.find((o) => o.personId === defaultHelperId);
    expect(def.kind).toBe('lead');
    expect(options.some((o) => o.personId === String(P.worker._id))).toBe(false);
  });

  it('validates the topic, message, link and helper', async () => {
    const bad = async (body) => (await ask('worker', edit, body)).status;
    expect(await bad({ topic: 'nope' })).toBe(400);
    expect(await bad({ message: '   ' })).toBe(400);
    expect(await bad({ message: 'x'.repeat(1001) })).toBe(400);
    expect(await bad({ link: 'http://example.com/a' })).toBe(400);
    expect(await bad({ link: 'javascript:alert(1)' })).toBe(400);
    expect(await bad({ helperId: String(P.growthLead._id) })).toBe(400);
    expect(await bad({ helperId: String(P.outsider._id) })).toBe(400);
    expect(await HelpRequest.countDocuments({ workItemId: edit._id })).toBe(0);
  });

  it('only the owner asks; another worker on the piece gets 404; leadership 403', async () => {
    expect((await ask('writer', edit)).status).toBe(404);
    expect((await ask('outsider', edit)).status).toBe(404);
    expect((await ask('creativeLead', edit)).status).toBe(403);
    expect((await ask('creativeHead', edit)).status).toBe(403);
  });

  let helpId;
  it('sending creates the request, notifies the chosen person once, and leaves the step alone', async () => {
    const before = await WorkItem.findById(edit._id).lean();
    const leadNotes = await notes('creativeLead', 'help_requested');
    const smNotes = await notes('sm', 'help_requested');
    const res = await ask('worker', edit, { link: 'https://drive.google.com/file/d/abc' });
    expect(res.status).toBe(201);
    helpId = res.body.data._id;
    expect(res.body.data).toMatchObject({ topic: 'brief_unclear', topicLabel: 'Brief unclear', status: 'open', link: 'https://drive.google.com/file/d/abc' });
    expect(res.body.data.helper).toMatchObject({ _id: String(P.creativeLead._id), kind: 'lead' });
    expect(await notes('creativeLead', 'help_requested')).toBe(leadNotes + 1);
    expect(await notes('sm', 'help_requested')).toBe(smNotes);
    const n = await Notification.findOne({ recipient: P.creativeLead._id, type: 'help_requested' }).sort({ createdAt: -1 }).lean();
    expect(n.link).toBe(`/work/${edit._id}#help`);
    // No pause, no block, no interval, no status change.
    const after = await WorkItem.findById(edit._id).lean();
    expect(after.status).toBe(before.status);
    expect(after.pauseState ?? null).toBe(before.pauseState ?? null);
    expect(JSON.stringify(after.rounds)).toBe(JSON.stringify(before.rounds));
    expect(String(after.updatedAt)).toBe(String(before.updatedAt));
  });

  it('who sees it: the owner and leadership; another worker on the piece and an outsider get 404', async () => {
    expect((await as('worker').get(url(edit))).body.data.open).toHaveLength(1);
    expect((await as('creativeHead').get(url(edit))).body.data.open).toHaveLength(1);
    expect((await as('sm').get(url(edit))).body.data.open).toHaveLength(1);
    expect((await as('writer').get(url(edit))).status).toBe(404);
    expect((await as('outsider').get(url(edit))).status).toBe(404);
    const head = (await as('creativeHead').get(url(edit))).body.data.open[0];
    expect(head.canReply).toBe(false);
    expect(head.canResolve).toBe(false);
  });

  it('replies: the helper and the asker can; the read-only head cannot; another worker 404', async () => {
    const reply = (who, text = 'Use the white one') => as(who).post(`${url(edit)}/${helpId}/replies`, { text });
    const askerNotes = await notes('worker', 'help_reply');
    expect((await reply('creativeLead')).status).toBe(200);
    expect(await notes('worker', 'help_reply')).toBe(askerNotes + 1);
    expect((await reply('worker', 'Thanks')).status).toBe(200);
    expect((await reply('creativeHead')).status).toBe(403);
    expect((await reply('writer')).status).toBe(404);
    expect((await reply('outsider')).status).toBe(404);
    expect((await reply('worker', '  ')).status).toBe(400);
    const data = (await as('worker').get(url(edit))).body.data.open[0];
    expect(data.replies.map((r) => r.text)).toEqual(['Use the white one', 'Thanks']);
  });

  it('a step owner asked for help sees and answers only that request', async () => {
    const res = await ask('worker', edit, { helperId: String(P.writer._id), topic: 'need_files', message: 'Where is the raw script?' });
    expect(res.status).toBe(201);
    const seen = await as('writer').get(url(edit));
    expect(seen.status).toBe(200);
    expect(seen.body.data.open.map((r) => r._id)).toEqual([res.body.data._id]);
    expect(seen.body.data.canAsk).toBe(false);
    expect((await as('writer').post(`${url(edit)}/${helpId}/replies`, { text: 'x' })).status).toBe(404);
    expect((await as('writer').post(`${url(edit)}/${res.body.data._id}/resolve`)).status).toBe(200);
  });

  it('resolve: the lead resolves; then no more replies; Tracker and Review Hub counts follow', async () => {
    expect((await openHelpCounts([edit._id])).get(String(edit._id))).toBe(1);
    const tl = await as('creativeLead').get(`/api/review-hub/steps/${edit._id}/timeline`);
    expect(tl.status).toBe(200);
    expect(tl.body.data.step.openHelpCount).toBe(1);
    const asked = tl.body.data.events.filter((e) => e.kind === 'help_requested');
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ by: `${TAG} worker`, topic: 'Brief unclear' });
    expect((await as('creativeHead').post(`${url(edit)}/${helpId}/resolve`)).status).toBe(403);
    const res = await as('creativeLead').post(`${url(edit)}/${helpId}/resolve`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('resolved');
    expect((await as('creativeLead').post(`${url(edit)}/${helpId}/resolve`)).status).toBe(409);
    expect((await as('worker').post(`${url(edit)}/${helpId}/replies`, { text: 'late' })).status).toBe(409);
    const list = (await as('worker').get(url(edit))).body.data;
    expect(list.open).toHaveLength(0);
    expect(list.resolved).toHaveLength(2);
    expect((await openHelpCounts([edit._id])).get(String(edit._id))).toBeUndefined();
  });

  it('SM Manager and admin can reply and resolve; a finished step cannot get new requests', async () => {
    const res = await ask('worker', edit, { helperId: String(P.sm._id), topic: 'technical_issue', message: 'Export keeps failing' });
    const id = res.body.data._id;
    expect((await as('admin').post(`${url(edit)}/${id}/replies`, { text: 'Try again now' })).status).toBe(200);
    expect((await as('sm').post(`${url(edit)}/${id}/resolve`)).status).toBe(200);
    expect((await as('writer').get(url(script))).body.data.canAsk).toBe(false);
    expect((await ask('writer', script, { helperId: String(P.sm._id) })).status).toBe(409);
  });

  it('a worker on another piece gets 404 on every help route', async () => {
    expect((await as('worker').get(url(lonely))).status).toBe(404);
    expect((await ask('worker', lonely)).status).toBe(404);
  });
});
