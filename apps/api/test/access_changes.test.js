// Phase C4: access changes reach people live. One function changes role / status / calendar
// limit (history, access:changed, then sockets closed); a WorkflowConfig change notifies the old
// and new people; socket events go to the user rooms the resolver picks (no role rooms); and no
// other code writes these fields (guard).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { Submission, SubmissionComment } from '../src/modules/submissions/model.js';
import { AccessChange } from '../src/modules/accessConfig/accessChange.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { changePersonAccess, DISCONNECT_DELAY_MS } from '../src/modules/accessConfig/personAccess.service.js';
import { updateWorkflowConfig } from '../src/modules/accessConfig/workflowConfig.service.js';
import { setSocketServer } from '../src/lib/socketHub.js';
import { registerSocketIO } from '../src/modules/notifications/service.js';
import { addComment } from '../src/modules/submissions/service.js';
import * as resolver from '../src/lib/accessResolver.js';

const EMAIL = /@access-changes-test\.com$/;
const TAG = 'ACHANGES';
const SRC = path.resolve(__dirname, '../src');

/** A Socket.IO stand-in that records emits (by room) and disconnects. */
function fakeIo() {
  const emits = [];
  const disconnected = [];
  return {
    emits,
    disconnected,
    to(rooms) {
      const list = [].concat(rooms);
      return { emit: (event, payload) => emits.push({ rooms: list, event, payload }) };
    },
    in(room) {
      return { disconnectSockets: () => disconnected.push(room), socketsLeave: () => {} };
    },
  };
}

describe('Access changes reach people live', () => {
  const P = {};
  let io;
  const person = async (key, role, extra = {}) =>
    (P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@access-changes-test.com`, role, status: 'active', ...extra }));
  const cleanup = async () => {
    const ids = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    await SubmissionComment.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG}`) });
    await AccessChange.deleteMany({ $or: [{ entityId: { $in: ids.map(String) } }, { entityType: 'workflow_config' }] });
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    await person('admin', 'admin');
    await person('lead', 'creative_lead');
    await person('growth', 'growth_lead');
    await person('sm', 'sm_manager');
    await person('worker', 'executive', { jobRole: 'Video Editor' });
  }, 60000);
  afterAll(async () => {
    setSocketServer(null);
    registerSocketIO(null);
    await cleanup();
  }, 60000);
  beforeEach(() => {
    io = fakeIo();
    setSocketServer(io);
    registerSocketIO(io);
  });

  describe('changePersonAccess: the one way to change role, status and calendar limit', () => {
    it('saves, records history, sends access:changed, then closes the sockets', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
      try {
        await changePersonAccess(P.worker._id, { role: 'sm_manager' }, P.admin, { note: 'promotion' });
        expect((await Person.findById(P.worker._id).lean()).role).toBe('sm_manager');
        const hist = await AccessChange.find({ entityId: String(P.worker._id) }).lean();
        expect(hist.map((h) => [h.field, h.before, h.after, String(h.actorId), h.note])).toEqual([['role', 'executive', 'sm_manager', String(P.admin._id), 'promotion']]);
        // access:changed first, to that user's room only; sockets closed only after the delay.
        expect(io.emits).toEqual([{ rooms: [`user:${P.worker._id}`], event: 'access:changed', payload: expect.objectContaining({ at: expect.any(String) }) }]);
        expect(io.disconnected).toEqual([]);
        vi.advanceTimersByTime(DISCONNECT_DELAY_MS);
        expect(io.disconnected).toEqual([`user:${P.worker._id}`]);
      } finally {
        vi.useRealTimers();
      }
      await changePersonAccess(P.worker._id, { role: 'executive' }, P.admin);
    });

    it('sets and clears a calendar limit; validates; does nothing when nothing changes', async () => {
      await changePersonAccess(P.lead, { calendarScope: ['sales', 'sm', 'sales'] }, P.admin);
      expect((await Person.findById(P.lead._id).lean()).calendarScope).toEqual(['sales', 'sm']);
      // The limit applies to decisions: the lead no longer reviews the Other calendar.
      expect(await resolver.can(await Person.findById(P.lead._id).lean(), 'review.decide', { calendar: 'other' })).toBe(false);
      expect(await resolver.can(await Person.findById(P.lead._id).lean(), 'review.decide', { calendar: 'sales' })).toBe(true);
      await changePersonAccess(P.lead._id, { calendarScope: [] }, P.admin);
      expect((await Person.findById(P.lead._id).lean()).calendarScope).toBeUndefined();
      await expect(changePersonAccess(P.lead._id, { role: 'boss' }, P.admin)).rejects.toMatchObject({ statusCode: 400 });
      await expect(changePersonAccess(P.lead._id, { calendarScope: ['mars'] }, P.admin)).rejects.toMatchObject({ statusCode: 400 });
      io.emits.length = 0;
      await changePersonAccess(P.lead._id, { role: 'creative_lead' }, P.admin);
      expect(io.emits).toEqual([]);
    });

    it('the last active admin cannot be demoted through it', async () => {
      const others = await Person.collection.find({ role: 'admin', status: 'active', _id: { $ne: P.admin._id } }).project({ _id: 1 }).toArray();
      if (others.length) await Person.collection.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { status: 'suspended' } });
      try {
        await expect(changePersonAccess(P.admin._id, { role: 'creative_lead' }, P.admin)).rejects.toMatchObject({ code: 'LAST_ADMIN' });
        expect(io.emits).toEqual([]);
      } finally {
        if (others.length) await Person.collection.updateMany({ _id: { $in: others.map((o) => o._id) } }, { $set: { status: 'active' } });
      }
    });
  });

  describe('WorkflowConfig changes', () => {
    it('saves a new version, records history, and tells the old and new people', async () => {
      const cfg = await updateWorkflowConfig('sales', { reviewers: { roles: [], userIds: [String(P.growth._id)] } }, P.admin);
      expect(cfg.reviewers.userIds).toEqual([String(P.growth._id)]);
      expect((await WorkflowConfig.findOne({ calendar: 'sales' }).lean()).updatedBy.toString()).toBe(String(P.admin._id));
      const hist = await AccessChange.find({ entityType: 'workflow_config', entityId: 'sales' }).lean();
      expect(hist.map((h) => [h.field, h.before.roles, h.after.userIds])).toEqual([['reviewers', ['creative_lead'], [String(P.growth._id)]]]);
      const rooms = io.emits.filter((e) => e.event === 'access:changed').flatMap((e) => e.rooms);
      // The Creative Lead (old list, by role) and the Growth Lead (new list) are told.
      expect(rooms).toEqual(expect.arrayContaining([`user:${P.lead._id}`, `user:${P.growth._id}`]));
      expect(rooms).not.toContain(`user:${P.sm._id}`);
      expect(io.disconnected).toEqual([]);
      // The resolver follows at once.
      expect(await resolver.can(P.growth, 'review.decide', { calendar: 'sales' })).toBe(true);
      expect(await resolver.can(P.lead, 'review.decide', { calendar: 'sales' })).toBe(false);
      await updateWorkflowConfig('sales', { reviewers: { roles: ['creative_lead'], userIds: [] } }, P.admin);
    });

    it('rejects unknown calendars, roles and ids; no change means no write', async () => {
      await expect(updateWorkflowConfig('mars', {}, P.admin)).rejects.toMatchObject({ statusCode: 400 });
      await expect(updateWorkflowConfig('sm', { posters: { roles: ['boss'] } }, P.admin)).rejects.toMatchObject({ statusCode: 400 });
      await expect(updateWorkflowConfig('sm', { posters: { roles: [], userIds: ['nope'] } }, P.admin)).rejects.toMatchObject({ statusCode: 400 });
      const before = await AccessChange.countDocuments({ entityType: 'workflow_config' });
      await updateWorkflowConfig('sm', { posters: { roles: ['sm_manager'], userIds: [] } }, P.admin);
      expect(await AccessChange.countDocuments({ entityType: 'workflow_config' })).toBe(before);
    });
  });

  describe('Socket events go to the resolver recipients (no role rooms)', () => {
    it('a review comment reaches the owner, the calendar\'s reviewers and the admins, exactly', async () => {
      const piece = await ContentPiece.create({ planId: new mongoose.Types.ObjectId(), topic: `${TAG} piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(), status: 'In Progress', calendar: 'ads' });
      const w = await WorkItem.create({ title: `${TAG} Edit`, workType: 'Reel', stageKey: 'Edit', stageOrder: 3, status: 'Pending', calendar: 'ads', ownerId: P.worker._id, departmentId: new mongoose.Types.ObjectId(), contentPieceId: piece._id, deadline: new Date(Date.now() + 864e5), reviewRequired: true });
      const v = await Submission.create({ workItemId: w._id, contentPieceId: piece._id, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.worker._id, submittedAt: new Date(), linkUrl: `https://drive.google.com/file/d/${TAG}` });
      await addComment(String(v._id), { text: 'Tighten the intro' }, P.growth);
      const sent = io.emits.filter((e) => e.event === 'comment:new');
      expect(sent).toHaveLength(1);
      const expected = [P.worker, ...(await resolver.recipientsFor('comment.posted', w))].map((p) => `user:${p._id}`);
      expect([...new Set(sent[0].rooms)].sort()).toEqual([...new Set(expected)].sort());
      expect(sent[0].rooms.every((r) => r.startsWith('user:'))).toBe(true);
      // Ads: the Growth Lead reviews; the Creative Lead does not get it.
      expect(sent[0].rooms).toContain(`user:${P.growth._id}`);
      expect(sent[0].rooms).not.toContain(`user:${P.lead._id}`);
      expect(sent[0].rooms).toContain(`user:${P.admin._id}`);
    });

    it('nothing joins or targets role rooms any more', () => {
      const code = fs.readFileSync(path.join(SRC, 'server.js'), 'utf8') + fs.readFileSync(path.join(SRC, 'lib/socketHub.js'), 'utf8');
      expect(code).not.toMatch(/join\(`role:/);
      expect(code).not.toMatch(/roleRooms/);
    });
  });

  describe('Guard: role, status and calendar limit are written only by changePersonAccess', () => {
    it('no direct assignment or bulk update of these fields outside personAccess.service.js', () => {
      const files = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.js')) files.push(p);
        }
      };
      walk(SRC);
      const ALLOW = new Set(['modules/accessConfig/personAccess.service.js']);
      const hits = [];
      for (const f of files) {
        const rel = path.relative(SRC, f).replace(/\\/g, '/');
        if (ALLOW.has(rel)) continue;
        const text = fs.readFileSync(f, 'utf8');
        if (!/\b(Person|User)\b/.test(text)) continue;
        text.split('\n').forEach((line, i) => {
          // person/target/user/member/doc .role|status|calendarScope = ... (not ==, not normalisation in place)
          if (/\b(person|target|user|member|doc)\.(role|status|calendarScope)\s*=[^=]/.test(line) && !/= normalizeRole\(user\.role\)/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
        for (const m of text.matchAll(/\b(Person|User)\.(updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|bulkWrite)\(([\s\S]{0,400}?)\);/g)) {
          if (/\b(role|status|calendarScope)\b\s*:/.test(m[3].split('},').slice(1).join('},') || m[3])) {
            const line = text.slice(0, m.index).split('\n').length;
            hits.push(`${rel}:${line}: ${m[0].slice(0, 120)}`);
          }
        }
      }
      expect(hits).toEqual([]);
    });
  });
});
