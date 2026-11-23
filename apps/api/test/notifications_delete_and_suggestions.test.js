// Small fix: (1) DELETE /api/notifications/:id deletes only the user's own notification (404
// otherwise; the web's notification center uses it); GET /api/notifications/preferences is removed
// (nothing used it, and it called a function that never existed). (2) The Tracker owner suggestion
// uses the owner rule's eligibility, so it always names someone the dropdown offers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'NOTIFSUG';
const DOMAIN = '@notif-suggest-test.com';
const EMAIL = /@notif-suggest-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();

describe('Notifications delete; Tracker suggestion follows the owner rule', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  const note = (k) => Notification.create({ recipient: P[k]._id, type: 'system', title: `${TAG} note`, message: 'Hello' });

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const pieces = (await ContentPiece.find({ topic: new RegExp(`^${TAG}`) }).select('_id').lean()).map((p) => p._id);
    await WorkItem.deleteMany({ contentPieceId: { $in: pieces } });
    await ContentPiece.deleteMany({ _id: { $in: pieces } });
    await Notification.deleteMany({ recipient: { $in: people } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await person('sm', 'sm_manager');
    await person('worker', 'executive', { jobRole: 'Video Editor' });
    await person('other', 'executive', { jobRole: 'Video Editor' });
  }, 60000);
  afterAll(cleanup, 60000);

  describe('1. notifications', () => {
    it('DELETE removes the user\'s own notification', async () => {
      const n = await note('worker');
      const res = await request(app).delete(`/api/notifications/${n._id}`).set(as('worker'));
      expect(res.status).toBe(200);
      expect(await Notification.exists({ _id: n._id })).toBeNull();
    });

    it('DELETE of someone else\'s notification, a missing one or a bad id is 404, and nothing is deleted', async () => {
      const theirs = await note('other');
      expect((await request(app).delete(`/api/notifications/${theirs._id}`).set(as('worker'))).status).toBe(404);
      expect(await Notification.exists({ _id: theirs._id })).toBeTruthy();
      expect((await request(app).delete(`/api/notifications/${oid()}`).set(as('worker'))).status).toBe(404);
      expect((await request(app).delete('/api/notifications/not-an-id').set(as('worker'))).status).toBe(404);
    });

    it('GET /api/notifications/preferences is gone (404, not 500)', async () => {
      const res = await request(app).get('/api/notifications/preferences').set(as('worker'));
      expect(res.status).toBe(404);
    });
  });

  describe('2. the Tracker suggestion agrees with the owner dropdown', () => {
    async function designStep() {
      const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece ${Date.now()}`, contentType: 'Static Post', pipeline: 'design', postingDate: new Date(Date.now() + 6 * 864e5), status: 'In Progress', calendar: 'sm' });
      await WorkItem.create({ title: `${TAG} Design`, workType: 'Static Post', stageKey: 'Design', stageOrder: 2, status: 'Not Started', calendar: 'sm', ownerId: null, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5) });
      return piece;
    }
    const recFor = async (piece) => {
      const res = await request(app).post('/api/content-pieces/recommend-owners').set(as('sm')).send({ pieceId: String(piece._id) });
      expect(res.status).toBe(200);
      return res.body.data.find((r) => r.stageKey === 'Design');
    };

    it('a designer with no work preferences, the only eligible person: the suggestion names them', async () => {
      const designer = await person('designer', 'executive', { jobRole: 'Graphic Designer', workPreferences: [] });
      try {
        // Precondition: no other active Graphic Designer in this database.
        expect(await Person.countDocuments({ status: 'active', role: 'executive', jobRole: { $in: ['Graphic Designer', 'All Rounder'] } })).toBe(1);
        const rec = await recFor(await designStep());
        expect(rec.eligibleOwners.map((p) => p._id)).toEqual([String(designer._id)]);
        expect(String(rec.recommendedPerson?._id)).toBe(String(designer._id)); // was: "Needs owner (nobody eligible)"
      } finally {
        await Person.deleteOne({ _id: designer._id });
      }
    });

    it('preferences only narrow: a designer whose preferences leave out Design is still suggested when nobody else can', async () => {
      const designer = await person('designer2', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Content'] });
      try {
        const rec = await recFor(await designStep());
        expect(String(rec.recommendedPerson?._id)).toBe(String(designer._id));
      } finally {
        await Person.deleteOne({ _id: designer._id });
      }
    });

    it('when someone eligible prefers the step, they are suggested over someone who left it out', async () => {
      const notKeen = await person('designer3', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Content'] });
      const keen = await person('designer4', 'executive', { jobRole: 'Graphic Designer', workPreferences: ['Design'] });
      try {
        const rec = await recFor(await designStep());
        expect(rec.eligibleOwners.map((p) => p._id).sort()).toEqual([String(notKeen._id), String(keen._id)].sort());
        expect(String(rec.recommendedPerson?._id)).toBe(String(keen._id));
      } finally {
        await Person.deleteMany({ _id: { $in: [notKeen._id, keen._id] } });
      }
    });
  });
});
