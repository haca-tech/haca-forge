// Final access fix, commit 3 (L1, L2): help requests follow calendar routing; workers get 404 on
// other people's ratings, profiles and work history (fixed rule 5), teammates included.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { HELP_TOPICS } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { HelpRequest } from '../src/modules/workItems/helpRequest.model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { Notification } from '../src/modules/notifications/model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'FIXL';
const DOMAIN = '@final-fix-l-test.com';
const EMAIL = /@final-fix-l-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();

describe('Final fix L1–L2', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}${DOMAIN}`, role, status: 'active', ...extra }));
  let piece;
  let adsStep;

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    await HelpRequest.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG}`) });
    await Notification.deleteMany({ recipient: { $in: people } });
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await person('admin', 'admin');
    await person('gl', 'growth_lead'); // reviews Ads (default)
    await person('cl', 'creative_lead'); // not on Ads
    await person('cl2', 'creative_lead'); // not on Ads
    await person('sm', 'sm_manager'); // posts everywhere
    await person('smSales', 'sm_manager', { calendarScope: ['sales'] }); // posts on Sales only
    await person('worker', 'executive', { jobRole: 'Video Editor' });
    await person('mate', 'executive', { jobRole: 'Graphic Designer' });
    piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'ads' });
    adsStep = await WorkItem.create({ title: `${TAG} ads Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'In Progress', calendar: 'ads', ownerId: P.worker._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5) });
    // The teammate owns another step on the same piece.
    await WorkItem.create({ title: `${TAG} ads Design`, workType: 'Reel', stageKey: 'Design', stageOrder: 2, status: 'Approved', calendar: 'ads', ownerId: P.mate._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 2 * 864e5) });
  }, 60000);
  afterAll(cleanup, 60000);

  describe('L1: help requests follow the calendar', () => {
    const ask = (helper) => HelpRequest.create({ workItemId: adsStep._id, contentPieceId: piece._id, askerId: P.worker._id, helperId: P[helper]._id, helperKind: 'lead', topic: HELP_TOPICS[0], message: `${TAG} please help` });
    const resolve = (k, r) => request(app).post(`/api/work/${adsStep._id}/help-requests/${r._id}/resolve`).set(as(k));
    const reply = (k, r) => request(app).post(`/api/work/${adsStep._id}/help-requests/${r._id}/replies`).set(as(k)).send({ text: 'On it' });

    it('only people who decide or post on the step\'s calendar (and admins) manage; leads elsewhere only read', async () => {
      const r = await ask('gl');
      // A Creative Lead outside Ads routing reads the request but cannot reply or resolve it.
      const list = await request(app).get(`/api/work/${adsStep._id}/help-requests`).set(as('cl2'));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).toContain(String(r._id));
      expect((await reply('cl2', r)).status).toBe(403);
      expect((await resolve('cl2', r)).status).toBe(403);
      // An SM Manager limited to Sales does not post on Ads: refused too.
      expect((await resolve('smSales', r)).status).toBe(403);
      // The Ads reviewer, an SM Manager who posts on Ads, and an admin manage it.
      expect((await reply('gl', r)).status).toBeLessThan(300);
      expect((await reply('sm', r)).status).toBeLessThan(300);
      expect((await reply('admin', r)).status).toBeLessThan(300);
      expect((await resolve('sm', r)).status).toBeLessThan(300);
    });

    it('the person asked keeps replying and resolving, even outside the calendar; so does the asker', async () => {
      const toLead = await ask('cl');
      expect((await reply('cl', toLead)).status).toBeLessThan(300);
      expect((await resolve('cl', toLead)).status).toBeLessThan(300);
      const own = await ask('gl');
      expect((await resolve('worker', own)).status).toBeLessThan(300);
    });
  });

  describe('L2: workers get 404 on other people', () => {
    it('ratings, profile and work history of anyone else are "not found", teammates on the same piece included', async () => {
      for (const url of [`/api/people/${P.mate._id}/ratings`, `/api/people/${P.mate._id}/profile`, `/api/people/${P.mate._id}/work-history`, `/api/people/${P.gl._id}/profile`]) {
        expect((await request(app).get(url).set(as('worker'))).status, url).toBe(404);
      }
      // Their own are unchanged.
      for (const url of [`/api/people/${P.worker._id}/ratings`, `/api/people/${P.worker._id}/profile`, `/api/people/${P.worker._id}/work-history`]) {
        expect((await request(app).get(url).set(as('worker'))).status, url).toBe(200);
      }
      // Leadership still opens them.
      expect((await request(app).get(`/api/people/${P.mate._id}/profile`).set(as('cl'))).status).toBe(200);
    });
  });
});
