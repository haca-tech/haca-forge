// Fixed rules that no configuration may change (Phase B): admin cannot read DMs; nobody
// approves their own work; there is always at least one active admin (model level).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { CALENDAR_KEYS, ROLE_KEYS, can, canDecide } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { Person } from '../src/modules/people/model.js';
import { Channel } from '../src/modules/chat/channel.model.js';
import { ChannelMember } from '../src/modules/chat/channelMember.model.js';
import { ChatMessage } from '../src/modules/chat/chatMessage.model.js';

const EMAIL = /@fixed-rules-test\.com$/;
const TAG = 'FIXEDRULES';

describe('Fixed rules', () => {
  const P = {};
  let dm;
  const token = (u) => jwt.sign({ userId: u._id.toString(), email: u.email, role: u.role }, env.JWT_SECRET, { expiresIn: '1h' });
  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const channels = (await Channel.find({ name: new RegExp(`^${TAG}`) }).select('_id').lean()).map((c) => c._id);
    await ChatMessage.deleteMany({ channelId: { $in: channels } });
    await ChannelMember.deleteMany({ $or: [{ channelId: { $in: channels } }, { userId: { $in: people } }] });
    await Channel.deleteMany({ _id: { $in: channels } });
    // Raw delete: the last-admin guard does not run on deleteMany (test clean-up).
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    await connectDB();
    await cleanup();
    for (const [key, role] of [['admin', 'admin'], ['a', 'executive'], ['b', 'executive'], ['lead', 'creative_lead']]) {
      P[key] = await Person.create({ name: `${TAG} ${key}`, email: `${key}@fixed-rules-test.com`, role, status: 'active' });
    }
    dm = await Channel.create({ type: 'dm', name: `${TAG} dm` });
    await ChannelMember.create([{ channelId: dm._id, userId: P.a._id, role: 'member' }, { channelId: dm._id, userId: P.b._id, role: 'member' }]);
    await ChatMessage.create({ channelId: dm._id, authorId: P.a._id, content: 'private hello' });
  }, 60000);
  afterAll(cleanup, 60000);

  describe('Admin cannot read DMs', () => {
    it('the DM members can open it; an admin who is not a member gets 403 on messages and details', async () => {
      const asA = await request(app).get(`/api/chat/channels/${dm._id}/messages`).set('Authorization', `Bearer ${token(P.a)}`);
      expect(asA.status).toBe(200);
      expect(JSON.stringify(asA.body)).toContain('private hello'); // the message is really there
      for (const url of [`/api/chat/channels/${dm._id}/messages`, `/api/chat/channels/${dm._id}`]) {
        const res = await request(app).get(url).set('Authorization', `Bearer ${token(P.admin)}`);
        expect(res.status, url).toBe(403);
        expect(JSON.stringify(res.body)).not.toContain('private hello');
      }
    });
  });

  describe('No self-approval', () => {
    it('no role, admin included, can decide on its own work on any calendar (old and new rules)', () => {
      const me = new mongoose.Types.ObjectId().toString();
      for (const role of ROLE_KEYS) {
        for (const calendar of CALENDAR_KEYS) {
          const user = { _id: me, role, status: 'active' };
          expect(can(user, 'review.decide', { calendar, ownerId: me }), `${role} ${calendar}`).toBe(false);
          expect(can(user, 'review.decide', { ownerId: me }), `${role} any calendar`).toBe(false);
          expect(canDecide(user, calendar, { ownerId: me }), `old ${role} ${calendar}`).toBe(false);
        }
      }
    });
  });

  describe('At least one active admin (model level)', () => {
    let setAside = [];
    beforeAll(async () => {
      // Make P.admin the only active admin: other active admins in the test database are set
      // aside with a raw write (not through the model) and restored afterwards.
      const others = await Person.collection.find({ role: 'admin', status: 'active', _id: { $ne: P.admin._id } }).project({ _id: 1 }).toArray();
      setAside = others.map((o) => o._id);
      if (setAside.length) await Person.collection.updateMany({ _id: { $in: setAside } }, { $set: { status: 'suspended' } });
    });
    afterAll(async () => {
      if (setAside.length) await Person.collection.updateMany({ _id: { $in: setAside } }, { $set: { status: 'active' } });
    });

    const expectLastAdmin = async (fn) => {
      const err = await fn().then(() => null, (e) => e);
      expect(err?.code).toBe('LAST_ADMIN');
      expect(err?.statusCode).toBe(409);
      const fresh = await Person.findById(P.admin._id).lean();
      expect(fresh).toBeTruthy();
      expect([fresh.role, fresh.status]).toEqual(['admin', 'active']);
    };

    it('the last active admin cannot be demoted, suspended or deleted, by any model path', async () => {
      const doc = await Person.findById(P.admin._id);
      doc.role = 'creative_lead';
      await expectLastAdmin(() => doc.save());
      const doc2 = await Person.findById(P.admin._id);
      doc2.status = 'suspended';
      await expectLastAdmin(() => doc2.save());
      await expectLastAdmin(() => Person.updateOne({ _id: P.admin._id }, { $set: { status: 'suspended' } }));
      await expectLastAdmin(() => Person.findOneAndUpdate({ _id: P.admin._id }, { role: 'sm_manager' }));
      await expectLastAdmin(() => Person.updateMany({ role: 'admin' }, { $set: { status: 'invited' } }));
      await expectLastAdmin(() => Person.deleteOne({ _id: P.admin._id }));
      await expectLastAdmin(() => Person.findOneAndDelete({ _id: P.admin._id }));
    });

    it('with a second active admin, the first can be changed; other people are never blocked', async () => {
      const second = await Person.create({ name: `${TAG} admin2`, email: 'admin2@fixed-rules-test.com', role: 'admin', status: 'active' });
      await Person.updateOne({ _id: P.admin._id }, { $set: { status: 'suspended' } });
      expect((await Person.findById(P.admin._id).lean()).status).toBe('suspended');
      // Now `second` is the last one.
      await expect(Person.updateOne({ _id: second._id }, { $set: { role: 'creative_lead' } })).rejects.toMatchObject({ code: 'LAST_ADMIN' });
      await Person.updateOne({ _id: P.admin._id }, { $set: { status: 'active' } });
      // Non-admins and unrelated fields are untouched by the guard.
      await Person.updateOne({ _id: P.lead._id }, { $set: { status: 'suspended' } });
      await Person.updateOne({ _id: P.admin._id }, { $set: { name: `${TAG} admin renamed` } });
      expect((await Person.findById(P.lead._id).lean()).status).toBe('suspended');
    });
  });
});
