// Phase E leftover: the 12 catalog permissions that no route guard checks (the service does, or
// nothing does yet). For each, every system role tries the real action: the roles the catalog
// gives the permission succeed, every other role is refused. Two permissions (report.configure,
// automation.manage) have no route or screen at all today: they are checked at the resolver.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { ROLE_KEYS, can } from '@mmp/shared';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { ContentPiece } from '../src/modules/calendar/contentPiece.model.js';
import { Submission, SubmissionComment } from '../src/modules/submissions/model.js';
import { Channel } from '../src/modules/chat/channel.model.js';
import { ChannelMember } from '../src/modules/chat/channelMember.model.js';
import { ChatMessage } from '../src/modules/chat/chatMessage.model.js';
import { ShareGrant } from '../src/modules/chat/shareGrant.model.js';
import { WorkflowConfig } from '../src/modules/accessConfig/workflowConfig.model.js';
import { Notification } from '../src/modules/notifications/model.js';
import * as resolver from '../src/lib/accessResolver.js';

const TAG = 'SVCPERM';
const DOMAIN = '@service-perm-test.com';
const EMAIL = /@service-perm-test\.com$/;
const oid = () => new mongoose.Types.ObjectId();
const ok = (res) => res.status >= 200 && res.status < 300;

describe('Permissions checked only inside services: allowed roles succeed, others are refused', () => {
  const P = {};
  const as = (k) => ({ Authorization: `Bearer ${jwt.sign({ userId: String(P[k]._id), role: P[k].role, email: P[k].email }, env.JWT_SECRET, { expiresIn: '1h' })}` });
  const holds = (role, perm) => can({ role, status: 'active' }, perm);
  let group;

  async function step(extra = {}) {
    const piece = await ContentPiece.create({ planId: oid(), topic: `${TAG} piece`, contentType: 'Reel', pipeline: 'reel_a', postingDate: new Date(Date.now() + 5 * 864e5), status: 'In Progress', calendar: 'sm', ...(extra.piece || {}) });
    delete extra.piece;
    return WorkItem.create({ title: `${TAG} step`, workType: 'Reel', stageKey: 'Edit', stageOrder: 1, status: 'In Progress', calendar: 'sm', ownerId: P.owner._id, departmentId: oid(), contentPieceId: piece._id, deadline: new Date(Date.now() + 3 * 864e5), startedAt: new Date(Date.now() - 36e5), ...extra });
  }

  /** Runs `attempt(roleKey)` for each of the 7 roles and checks success matches the catalog. */
  async function matrix(perm, attempt) {
    const rows = [];
    for (const role of ROLE_KEYS) {
      const res = await attempt(role);
      rows.push([role, holds(role, perm) ? 'allow' : 'deny', ok(res) ? 'allow' : `deny ${res.status} ${res.body?.error?.code || ''}`.trim()]);
    }
    const wrong = rows.filter(([, expected, got]) => (expected === 'allow') !== (got === 'allow'));
    expect(wrong, `${perm}: role, expected, got`).toEqual([]);
    // Every permission is held by someone and refused to someone.
    expect(rows.some(([, e]) => e === 'allow') && rows.some(([, e]) => e === 'deny')).toBe(true);
  }

  const cleanup = async () => {
    const people = (await Person.find({ email: EMAIL }).select('_id').lean()).map((p) => p._id);
    const steps = (await WorkItem.find({ title: new RegExp(`^${TAG}`) }).select('_id').lean()).map((s) => s._id);
    await SubmissionComment.deleteMany({ workItemId: { $in: steps } });
    await Submission.deleteMany({ workItemId: { $in: steps } });
    await WorkItem.deleteMany({ _id: { $in: steps } });
    await ContentPiece.deleteMany({ topic: new RegExp(`^${TAG}`) });
    const channels = (await Channel.find({ name: new RegExp(`^${TAG}`) }).select('_id').lean()).map((c) => c._id);
    await ShareGrant.deleteMany({ channelId: { $in: channels } });
    await ChatMessage.deleteMany({ channelId: { $in: channels } });
    await ChannelMember.deleteMany({ $or: [{ channelId: { $in: channels } }, { userId: { $in: people } }] });
    await Channel.deleteMany({ _id: { $in: channels } });
    await Notification.deleteMany({ recipient: { $in: people } });
    await Person.deleteMany({ email: EMAIL });
  };

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI);
    await cleanup();
    await WorkflowConfig.deleteMany({});
    resolver.clearAccessCache();
    for (const role of ROLE_KEYS) {
      P[role] = await Person.create({ name: `${TAG} ${role}`, email: `${role}${DOMAIN}`, role, status: 'active', jobRole: role === 'executive' ? 'Video Editor' : '' });
    }
    // The owner of the work and assets: a worker who is not one of the role users above.
    P.owner = await Person.create({ name: `${TAG} owner`, email: `owner${DOMAIN}`, role: 'executive', status: 'active', jobRole: 'Video Editor' });
    group = await Channel.create({ type: 'group', name: `${TAG} group` });
    await ChannelMember.create([...ROLE_KEYS.map((r) => P[r]), P.owner].map((p) => ({ channelId: group._id, userId: p._id, role: 'member' })));
  }, 60000);
  afterAll(cleanup, 60000);

  it('work.manage_steps: change a step someone else owns', async () => {
    await matrix('work.manage_steps', async (role) => {
      const s = await step();
      return request(app).patch(`/api/work/${s._id}`).set(as(role)).send({ priority: 'Urgent' });
    });
  });

  it('blocker.resolve.any: unblock a step someone else owns', async () => {
    await matrix('blocker.resolve.any', async (role) => {
      const s = await step({ status: 'Blocked', blockerReason: 'Waiting for feedback' });
      return request(app).post(`/api/work/${s._id}/transition`).set(as(role)).send({ toStatus: 'In Progress' });
    });
  });

  it('review.read_all: read the review comments on someone else\'s step', async () => {
    const s = await step({ status: 'Pending', reviewRequired: true });
    const sub = await Submission.create({ workItemId: s._id, contentPieceId: s.contentPieceId, stageKey: 'Edit', version: 1, kind: 'link', status: 'submitted', submittedById: P.owner._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/svc' });
    await SubmissionComment.create({ submissionId: sub._id, workItemId: s._id, authorId: P.creative_lead._id, text: 'Private review note', anchor: null, parentId: null });
    await matrix('review.read_all', (role) => request(app).get(`/api/submissions/${sub._id}/comments`).set(as(role)));
  });

  it('publish.edit_live_link: correct the live link of a posted piece', async () => {
    let n = 0;
    await matrix('publish.edit_live_link', async (role) => {
      n += 1;
      const s = await step({ stageKey: 'Post', status: 'Published', postedAt: new Date(), publishedUrl: 'https://www.instagram.com/p/svcold/', piece: { publishedAt: new Date(), liveUrl: 'https://www.instagram.com/p/svcold/' } });
      return request(app).put(`/api/published/${s.contentPieceId}/live-link`).set(as(role)).send({ liveUrl: `https://www.instagram.com/p/svcnew${n}/` });
    });
  });

  it('people.manage_operational: read a person\'s operational change log', async () => {
    await matrix('people.manage_operational', (role) => request(app).get(`/api/team/${P.owner._id}/changes`).set(as(role)));
  });

  it('team.profile.report: download a person\'s profile report', async () => {
    await matrix('team.profile.report', (role) => request(app).get(`/api/team/${P.owner._id}/report`).set(as(role)));
  });

  it('chat.mention_all: mention @everyone', async () => {
    await matrix('chat.mention_all', (role) => request(app).post(`/api/chat/channels/${group._id}/messages`).set(as(role)).send({ content: `@everyone ${TAG} notice from ${role}` }));
  });

  it('chat.share_asset: share an approved output you do not own', async () => {
    const s = await step({ status: 'Approved' });
    const sub = await Submission.create({ workItemId: s._id, contentPieceId: s.contentPieceId, stageKey: 'Edit', version: 1, kind: 'link', status: 'approved', submittedById: P.owner._id, submittedAt: new Date(), linkUrl: 'https://drive.google.com/file/d/svcshare' });
    await matrix('chat.share_asset', async (role) => {
      await ShareGrant.deleteMany({ channelId: group._id }); // each role shares afresh
      return request(app).post('/api/chat/share').set(as(role)).send({ channelId: String(group._id), assetId: String(sub._id), assetType: 'finalCut', contentPieceId: String(s.contentPieceId), stageKey: 'Edit' });
    });
  });

  it('chat.revoke_share: revoke a share someone else made', async () => {
    const s = await step({ status: 'Approved' });
    await matrix('chat.revoke_share', async (role) => {
      const grant = await ShareGrant.create({ channelId: group._id, assetId: String(oid()), assetType: 'finalCut', contentPieceId: s.contentPieceId, stageKey: 'Edit', sharedById: P.owner._id, grantedBy: P.owner._id });
      return request(app).post(`/api/chat/share/${grant._id}/revoke`).set(as(role));
    });
  });

  it('chat.manage_groups: unarchive a group you do not own', async () => {
    const archived = await Channel.create({ type: 'group', name: `${TAG} archived`, isArchived: true });
    await matrix('chat.manage_groups', async (role) => {
      await Channel.updateOne({ _id: archived._id }, { $set: { isArchived: true } });
      return request(app).post(`/api/chat/channels/${archived._id}/unarchive`).set(as(role));
    });
  });

  it('report.configure and automation.manage: only the admin holds them (no route or screen uses them yet)', () => {
    for (const perm of ['report.configure', 'automation.manage']) {
      expect(ROLE_KEYS.filter((role) => holds(role, perm))).toEqual(['admin']);
    }
  });
});
