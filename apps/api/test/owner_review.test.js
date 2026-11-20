// Review Studio for the step owner: read everything on their own step, reply (text only),
// nothing else. Notifications: reviewer comment/reply -> owner; owner reply -> the lead who
// wrote the comment (or the calendar's deciding leads), once per comment.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { Submission, SubmissionComment, Rating } from '../src/modules/submissions/model.js';
import { RevisionFlag } from '../src/modules/feedback/model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';

const EMAIL = /@owner-review-test\.com$/;
const TAG = 'ORVT';

describe('Review Studio for the step owner', () => {
  const P = {};
  const tokens = {};
  const make = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const as = (who) => ({
    get: (url) => request(app).get(url).set('Authorization', `Bearer ${tokens[who]}`),
    post: (url, body) => request(app).post(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
    patch: (url, body) => request(app).patch(url).set('Authorization', `Bearer ${tokens[who]}`).send(body),
  });
  const dept = new mongoose.Types.ObjectId();

  async function stepWithVersion(owner, calendar = 'sm') {
    const piece = await ContentPiece.create({
      planId: new mongoose.Types.ObjectId(), topic: `${TAG} ${calendar} piece`, contentType: 'Reel', pipeline: 'reel_a', calendar,
      postingDate: new Date(Date.now() + 9 * 86400000), status: 'In Progress', rowStatus: 'approved', needsScript: false, needsShoot: false, needsContent: true,
    });
    const w = await WorkItem.create({
      title: `${TAG} ${calendar} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'Feedback', isLocked: false, reviewRequired: true,
      contentPieceId: piece._id, departmentId: dept, calendar, ownerId: P[owner]._id,
      deadline: new Date(Date.now() + 3 * 86400000), dueDate: new Date(Date.now() + 3 * 86400000), submittedAt: new Date(),
      rounds: [{ roundNumber: 1, startedAt: new Date(Date.now() - 3600000), submittedAt: new Date() }],
    });
    const v = await Submission.create({ workItemId: w._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P[owner]._id, submittedAt: new Date(), linkUrl: `https://drive.google.com/file/d/${TAG}-${calendar}` });
    return { w, v, piece };
  }
  const oid = (id) => new mongoose.Types.ObjectId(String(id));
  const notes = (who, commentId) => Notification.countDocuments({ recipient: P[who]._id, 'metadata.commentId': oid(commentId) });

  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG} `) }).select('_id').lean()).map((w) => w._id);
    await SubmissionComment.deleteMany({ workItemId: { $in: steps } });
    await Rating.deleteMany({ workItemId: { $in: steps } });
    await RevisionFlag.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await ActivityEvent.deleteMany({ entityId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG} `) });
    await Notification.deleteMany({ recipient: { $in: ids } });
    await Person.deleteMany({ email: EMAIL });
  };

  let sm;
  let ads;
  beforeAll(async () => {
    await connectDB();
    await cleanup();
    for (const [key, role, extra] of [
      ['admin', 'admin'],
      ['creativeLead', 'creative_lead'],
      ['growthLead', 'growth_lead'],
      ['creativeHead', 'creative_head'],
      ['owner', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'] }],
      ['other', 'executive', { jobRole: 'Video Editor', workPreferences: ['Edit'] }],
    ]) {
      P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key.toLowerCase()}@owner-review-test.com`, role, status: 'active', ...(extra || {}) });
      tokens[key] = make(P[key]);
    }
    sm = await stepWithVersion('owner', 'sm');
    ads = await stepWithVersion('owner', 'ads');
  }, 60000);
  afterAll(cleanup, 60000);

  it('the owner reads every comment, pin and reply on their own step; another worker gets 404', async () => {
    const pin = await as('creativeLead').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Trim the intro here', anchor: { type: 'time', seconds: 3 } });
    expect(pin.status).toBe(201);
    const general = await as('creativeLead').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Colour looks great' });
    await as('creativeLead').post(`/api/submissions/comments/${general.body.data._id}/resolve`);

    const sub = await as('owner').get(`/api/submissions/${sm.v._id}`);
    expect(sub.status).toBe(200);
    const texts = sub.body.data.comments.map((c) => c.text);
    expect(texts).toEqual(expect.arrayContaining(['Trim the intro here', 'Colour looks great']));
    expect(sub.body.data.comments.find((c) => c.text === 'Trim the intro here').anchor).toMatchObject({ type: 'time', seconds: 3 });
    expect(sub.body.data.comments.find((c) => c.text === 'Colour looks great').resolved).toBe(true);
    expect((await as('owner').get(`/api/submissions/${sm.v._id}/comments`)).status).toBe(200);
    const list = (await as('owner').get(`/api/submissions?workItemId=${sm.w._id}`)).body;
    expect((Array.isArray(list) ? list : list.data).length).toBe(1);

    expect((await as('other').get(`/api/submissions/${sm.v._id}`)).status).toBe(404);
    expect((await as('other').get(`/api/submissions/${sm.v._id}/comments`)).status).toBe(404);
  });

  it('the owner can reply (text only), threaded under the first comment', async () => {
    const root = await SubmissionComment.findOne({ workItemId: sm.w._id, text: 'Trim the intro here' });
    const reply = await as('owner').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Trimmed to 2 seconds', parentId: String(root._id) });
    expect(reply.status).toBe(201);
    expect(String(reply.body.data.parentId)).toBe(String(root._id));
    // A reply to a reply joins the same thread.
    const nested = await as('owner').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Also fixed the cut', parentId: reply.body.data._id });
    expect(String(nested.body.data.parentId)).toBe(String(root._id));
    // A parent from another step is refused.
    const elsewhere = await SubmissionComment.create({ submissionId: ads.v._id, workItemId: ads.w._id, authorId: P.growthLead._id, text: 'Ads note' });
    expect((await as('owner').post(`/api/submissions/${sm.v._id}/comments`, { text: 'x', parentId: String(elsewhere._id) })).status).toBe(400);
  });

  it('the owner gets 403 on new comments, pins, resolve, approve, request revision, rating and classify', async () => {
    const root = await SubmissionComment.findOne({ workItemId: sm.w._id, text: 'Trim the intro here' });
    const top = await as('owner').post(`/api/submissions/${sm.v._id}/comments`, { text: 'A new thread' });
    expect(top.status).toBe(403);
    expect(top.body.error?.code ?? top.body.code).toBe('OWNER_REPLY_ONLY');
    expect((await as('owner').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Pin', anchor: { type: 'point', x: 10, y: 10 } })).status).toBe(403);
    expect((await as('owner').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Pin reply', parentId: String(root._id), anchor: { type: 'point', x: 1, y: 1 } })).status).toBe(403);
    expect((await as('owner').post(`/api/submissions/comments/${root._id}/resolve`)).status).toBe(403);
    expect((await SubmissionComment.findById(root._id)).resolved).toBe(false);
    expect((await as('owner').post(`/api/submissions/${sm.v._id}/approve`, { score: 5 })).status).toBe(403);
    expect((await as('owner').post(`/api/submissions/${sm.v._id}/request-revision`, { comment: 'Self note' })).status).toBe(403);
    // Rating and classify on their own step.
    const rating = await Rating.create({ submissionId: sm.v._id, workItemId: sm.w._id, stageKey: 'Edit', workerId: P.owner._id, raterId: P.creativeLead._id, score: 3 });
    expect((await as('owner').patch(`/api/submissions/ratings/${rating._id}`, { score: 5, reason: 'Mine' })).status).toBe(403);
    const flag = await RevisionFlag.create({ workItemId: sm.w._id, ownerId: P.owner._id, revisionsCount: 3, isFlagged: true, flaggedAt: new Date() });
    expect((await as('owner').post(`/api/revisions/flags/${flag._id}/classify`, { rootCause: 'Brief unclear' })).status).toBe(403);
    expect(await SubmissionComment.countDocuments({ workItemId: sm.w._id, text: { $in: ['A new thread', 'Pin', 'Pin reply'] } })).toBe(0);
  });

  it('the read-only heads view only: they read comments but cannot comment, reply or resolve', async () => {
    const root = await SubmissionComment.findOne({ workItemId: sm.w._id, text: 'Trim the intro here' });
    expect((await as('creativeHead').get(`/api/submissions/${sm.v._id}`)).body.data.comments.length).toBeGreaterThan(0);
    expect((await as('creativeHead').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Head note' })).status).toBe(403);
    expect((await as('creativeHead').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Head reply', parentId: String(root._id) })).status).toBe(403);
    expect((await as('creativeHead').post(`/api/submissions/comments/${root._id}/resolve`)).status).toBe(403);
  });

  it('notifications: a lead comment -> the owner once; the owner reply -> that lead once', async () => {
    const c = await as('creativeLead').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Add the logo at the end' });
    expect(await notes('owner', c.body.data._id)).toBe(1);
    const n = await Notification.findOne({ recipient: P.owner._id, 'metadata.commentId': oid(c.body.data._id) }).lean();
    expect(n.link).toBe(`/work/${sm.w._id}/review`);
    const r = await as('owner').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Logo added', parentId: c.body.data._id });
    expect(await notes('creativeLead', r.body.data._id)).toBe(1);
    expect(await notes('growthLead', r.body.data._id)).toBe(0);
    expect(await notes('owner', r.body.data._id)).toBe(0);
    // A lead reply in the thread -> the owner, once.
    const lr = await as('creativeLead').post(`/api/submissions/${sm.v._id}/comments`, { text: 'Thanks', parentId: c.body.data._id });
    expect(await notes('owner', lr.body.data._id)).toBe(1);
    expect((await Notification.findOne({ recipient: P.owner._id, 'metadata.commentId': oid(lr.body.data._id) }).lean()).title).toBe('New reply on your review');
  });

  it('Ads step: the Growth Lead and the owner exchange; a reply to someone who no longer decides goes to the deciding lead', async () => {
    const g = await as('growthLead').post(`/api/submissions/${ads.v._id}/comments`, { text: 'Headline too long' });
    expect(await notes('owner', g.body.data._id)).toBe(1);
    const r = await as('owner').post(`/api/submissions/${ads.v._id}/comments`, { text: 'Shortened', parentId: g.body.data._id });
    expect(await notes('growthLead', r.body.data._id)).toBe(1);
    expect(await notes('creativeLead', r.body.data._id)).toBe(0);
    // The Creative Lead commented on the Ads step but does not decide Ads: the reply goes to the Growth Lead.
    const c = await as('creativeLead').post(`/api/submissions/${ads.v._id}/comments`, { text: 'Brand colour check' });
    const r2 = await as('owner').post(`/api/submissions/${ads.v._id}/comments`, { text: 'Checked', parentId: c.body.data._id });
    expect(await notes('creativeLead', r2.body.data._id)).toBe(0);
    expect(await notes('growthLead', r2.body.data._id)).toBe(1);
  });

  it('the owner can open the step timeline (decision and rating messages) for their own step only', async () => {
    expect((await as('owner').get(`/api/review-hub/steps/${sm.w._id}/timeline`)).status).toBe(200);
    expect((await as('other').get(`/api/review-hub/steps/${sm.w._id}/timeline`)).status).toBe(404);
  });
});
