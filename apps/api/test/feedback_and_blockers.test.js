import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import { app } from '../src/server.js';
import { Person } from '../src/modules/people/model.js';
import { Department } from '../src/modules/departments/model.js';
import { Profile } from '../src/modules/referenceData/profile.model.js';
import { Submission } from '../src/modules/submissions/model.js';
import { WorkItem } from '../src/modules/workItems/model.js';
import { FeedbackEntry, RevisionFlag } from '../src/modules/feedback/model.js';
import { Blocker } from '../src/modules/blockers/model.js';
import { ActivityEvent } from '../src/modules/activity/model.js';
import jwt from 'jsonwebtoken';
import { env } from '../src/config/env.js';

const makeToken = (user) =>
  jwt.sign(
    { userId: user._id.toString(), role: user.role, email: user.email },
    env.JWT_SECRET || 'test-secret',
    { expiresIn: '1h' }
  );

describe('Phase 5: Feedback Loops, Revision Flags & Blockers', () => {
  let adminUser, leadUser, memberUser, dependencyOwner;
  let adminToken, leadToken, memberToken, dependencyToken;
  let profileHaca, deptDesign;
  let testWorkItem;

  beforeAll(async () => {
    const mongoUri =
      process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/marketing_portal_test';
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(mongoUri);
    }

    // Clean test collections
    await FeedbackEntry.deleteMany({});
    await RevisionFlag.deleteMany({});
    await Blocker.deleteMany({});
    await WorkItem.deleteMany({});
    await ActivityEvent.deleteMany({});
    await Person.deleteMany({ email: /@feedback-test\.com$/ });
    await Department.deleteMany({ code: 'test_feedback_dept' });
    await Profile.deleteMany({ code: 'test_feedback_profile' });

    profileHaca = await Profile.create({
      name: 'Test Profile Phase 5',
      code: 'test_feedback_profile',
      active: true,
    });

    deptDesign = await Department.findOne({ name: 'Design' });
    if (!deptDesign) {
      deptDesign = await Department.create({
        name: 'Design',
        code: 'test_feedback_dept',
      });
    }

    adminUser = await Person.create({
      name: 'Admin Reviewer',
      email: 'admin@feedback-test.com',
      role: 'admin',
      departmentId: deptDesign._id,
      profileAccess: [profileHaca._id],
      status: 'active',
      weeklyCapacityHours: 40,
    });

    leadUser = await Person.create({
      name: 'Creative Head Reviewer',
      email: 'lead@feedback-test.com',
      role: 'creative_lead',
      departmentId: deptDesign._id,
      profileAccess: [profileHaca._id],
      status: 'active',
      weeklyCapacityHours: 40,
    });

    memberUser = await Person.create({
      name: 'Creative Owner Member',
      email: 'member@feedback-test.com',
      role: 'executive',
      jobRole: 'Graphic Designer',
      departmentId: deptDesign._id,
      profileAccess: [profileHaca._id],
      status: 'active',
      weeklyCapacityHours: 40,
    });

    dependencyOwner = await Person.create({
      name: 'Content Dependency Owner',
      email: 'content.dep@feedback-test.com',
      role: 'executive',
      jobRole: 'Writer',
      departmentId: deptDesign._id,
      profileAccess: [profileHaca._id],
      status: 'active',
      weeklyCapacityHours: 40,
    });

    adminToken = makeToken(adminUser);
    leadToken = makeToken(leadUser);
    memberToken = makeToken(memberUser);
    dependencyToken = makeToken(dependencyOwner);

    testWorkItem = await WorkItem.create({
      title: 'Phase 5 Carousel Deliverable',
      profileId: profileHaca._id,
      departmentId: deptDesign._id,
      ownerId: memberUser._id,
      workType: 'Carousel',
      deadline: new Date(Date.now() + 5 * 24 * 3600 * 1000),
      estimatedEffortHrs: 4,
      status: 'In Progress',
      priority: 'High',
      revisions: 0,
      createdBy: leadUser._id,
    });
  });

  afterAll(async () => {
    await Submission.deleteMany({ workItemId: testWorkItem._id });
    await FeedbackEntry.deleteMany({});
    await RevisionFlag.deleteMany({});
    await Blocker.deleteMany({});
    await WorkItem.deleteMany({});
    await Person.deleteMany({ email: /@feedback-test\.com$/ });
    await Department.deleteMany({ code: 'test_feedback_dept' });
    await Profile.deleteMany({ code: 'test_feedback_profile' });
  });

  // A reviewer's revision decides the latest submitted version, so each round needs one.
  let nextVersion = 1;
  const submitNewVersion = async () => {
    await WorkItem.findByIdAndUpdate(testWorkItem._id, { status: 'Feedback' });
    await Submission.create({
      workItemId: testWorkItem._id,
      kind: 'image',
      version: nextVersion++,
      status: 'submitted',
      submittedById: memberUser._id,
      submittedAt: new Date(Date.now() + 5),
      linkUrl: 'https://example.test/carousel',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };

  // Revisions go through the version (Review Studio and Work Detail both call this).
  const requestRevision = async (comment) => {
    const latest = await Submission.findOne({ workItemId: testWorkItem._id }).sort({ version: -1 });
    return request(app)
      .post(`/api/submissions/${latest._id}/request-revision`)
      .set('Authorization', `Bearer ${leadToken}`)
      .send({ comment, rootCause: 'Brief unclear' });
  };

  describe('Part A: Feedback-page writes are retired (Review Hub)', () => {
    it('a reviewer revision on the Feedback route returns 410 and points to Review Studio; nothing changes', async () => {
      await submitNewVersion();
      const res = await request(app)
        .post(`/api/feedback/work-item/${testWorkItem._id}`)
        .set('Authorization', `Bearer ${leadToken}`)
        .send({ round: 1, roundStatus: 'Revision Required', text: 'Slide 3 font is too small.', isResponse: false });
      expect(res.status).toBe(410);
      expect(res.body.error?.code || res.body.code).toBe('FEEDBACK_REVISION_RETIRED');
      const item = await WorkItem.findById(testWorkItem._id);
      expect(item.revisions).toBe(0);
      expect(await FeedbackEntry.countDocuments({ workItemId: testWorkItem._id })).toBe(0);
    });

    it('prevents non-owner member from submitting owner response', async () => {
      const res = await request(app)
        .post(`/api/feedback/work-item/${testWorkItem._id}`)
        .set('Authorization', `Bearer ${dependencyToken}`) // different member
        .send({ round: 1, text: 'Attempting to respond on behalf of owner', isResponse: true });
      // Not on this deliverable, so the item is not confirmed to exist.
      expect(res.status).toBe(404);
    });

    it('an owner response returns 410 and points to Resubmit', async () => {
      const res = await request(app)
        .post(`/api/feedback/work-item/${testWorkItem._id}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ round: 1, text: 'Fixed slide 3.', isResponse: true });
      expect(res.status).toBe(410);
      expect(res.body.error?.code || res.body.code).toBe('FEEDBACK_REPLY_RETIRED');
    });

    it('older entries stay readable, grouped by round', async () => {
      await FeedbackEntry.create({ workItemId: testWorkItem._id, round: 1, fromPersonId: leadUser._id, roundStatus: 'Revision Required', text: 'Older reviewer note', isResponse: false });
      await FeedbackEntry.create({ workItemId: testWorkItem._id, round: 1, fromPersonId: memberUser._id, text: 'Older owner reply', isResponse: true });
      const res = await request(app)
        .get(`/api/feedback/work-item/${testWorkItem._id}`)
        .set('Authorization', `Bearer ${memberToken}`);
      expect(res.status).toBe(200);
      expect(res.body.data.rounds).toHaveLength(1);
      expect(res.body.data.rounds[0].reviewerFeedback).not.toBeNull();
      expect(res.body.data.rounds[0].ownerResponse).not.toBeNull();
    });

    it('the feedback route cannot approve, for anyone', async () => {
      const res = await request(app)
        .post(`/api/feedback/work-item/${testWorkItem._id}`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({ round: 2, roundStatus: 'Approved', text: 'I approve my own work', isResponse: false });
      expect(res.status).toBe(410);
      expect((await WorkItem.findById(testWorkItem._id)).status).not.toBe('Approved');
    });
  });

  describe('Part B: Automatic Revision Flagging Engine', () => {
    it('flags the step once it reaches round 4 (the third change request)', async () => {
      for (const [n, text] of [[1, 'First round revisions needed'], [2, 'Second round revisions needed'], [3, 'Third round: design direction issue']]) {
        if (n > 1) await submitNewVersion();
        const res = await requestRevision(text);
        expect(res.status).toBeLessThan(300);
        if (n < 3) expect(await RevisionFlag.findOne({ workItemId: testWorkItem._id })).toBeNull();
      }

      const updatedItem = await WorkItem.findById(testWorkItem._id);
      expect(updatedItem.revisions).toBe(3);

      const flag = await RevisionFlag.findOne({ workItemId: testWorkItem._id });
      expect(flag).not.toBeNull();
      expect(flag.isFlagged).toBe(true);
      expect(flag.revisionsCount).toBe(3);
      expect(flag.rootCause).toBeNull(); // unclassified initially

      const activity = await ActivityEvent.findOne({ entityId: testWorkItem._id, action: 'revision.flagged' });
      expect(activity).not.toBeNull();
    });

    it('prevents team member from classifying revision root cause', async () => {
      const flag = await RevisionFlag.findOne({ workItemId: testWorkItem._id });
      const res = await request(app)
        .post(`/api/revisions/flags/${flag._id}/classify`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          rootCause: 'Brief unclear',
        });

      expect(res.status).toBe(403);
    });

    it('rejects invalid root causes outside the 7 fixed taxonomies', async () => {
      const flag = await RevisionFlag.findOne({ workItemId: testWorkItem._id });
      const res = await request(app)
        .post(`/api/revisions/flags/${flag._id}/classify`)
        .set('Authorization', `Bearer ${leadToken}`)
        .send({
          rootCause: 'Random Invalid Cause',
        });

      expect(res.status).toBe(400);
    });

    it('allows Creative Head to classify root cause with 1 of 7 fixed values', async () => {
      const flag = await RevisionFlag.findOne({ workItemId: testWorkItem._id });
      const res = await request(app)
        .post(`/api/revisions/flags/${flag._id}/classify`)
        .set('Authorization', `Bearer ${leadToken}`)
        .send({
          rootCause: 'Creative direction unclear',
          rootCauseNotes: 'Client changed tone of voice mid-stream from corporate to playful.',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.rootCause).toBe('Creative direction unclear');
      expect(res.body.data.rootCauseNotes).toContain('tone of voice');
      expect(res.body.data.classifiedBy).not.toBeNull();

      // Verify ActivityEvent logged
      const classifiedActivity = await ActivityEvent.findOne({
        entityId: testWorkItem._id,
        action: 'revision.classified',
      });
      expect(classifiedActivity).not.toBeNull();
    });

    it('lists revision flags with filters', async () => {
      const res = await request(app)
        .get('/api/revisions/flags?status=classified')
        .set('Authorization', `Bearer ${leadToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].rootCause).toBe('Creative direction unclear');
    });

    it('evaluates escalation window if flag remains unclassified for >48h', async () => {
      // Create a simulated unclassified flag older than 48h
      const pastDate = new Date(Date.now() - 50 * 3600 * 1000);
      const staleWorkItem = await WorkItem.create({
        title: 'Stale Deliverable for Escalation',
        profileId: profileHaca._id,
        departmentId: deptDesign._id,
        ownerId: memberUser._id,
        workType: 'Post',
        deadline: new Date(Date.now() + 2 * 24 * 3600 * 1000),
        status: 'Feedback',
        revisions: 4,
        createdBy: leadUser._id,
      });

      await RevisionFlag.create({
        workItemId: staleWorkItem._id,
        ownerId: memberUser._id,
        revisionsCount: 4,
        baselineAvg: 1.0,
        isFlagged: true,
        flaggedAt: pastDate,
        rootCause: null,
      });

      const res = await request(app)
        .get('/api/revisions/flags?status=escalated')
        .set('Authorization', `Bearer ${leadToken}`);

      expect(res.status).toBe(200);
      const escalatedFlag = res.body.data.find(
        (f) => f.workItemId?._id?.toString() === staleWorkItem._id.toString()
      );
      expect(escalatedFlag).toBeDefined();
      expect(escalatedFlag.isEscalated).toBe(true);
    });
  });

  describe('Part C: Blocker Engine & Dependency Alerting', () => {
    let blockerWorkItem;

    beforeAll(async () => {
      blockerWorkItem = await WorkItem.create({
        title: 'Ad Set Deliverable for Blocker Test',
        profileId: profileHaca._id,
        departmentId: deptDesign._id,
        ownerId: memberUser._id,
        workType: 'Ad Set',
        deadline: new Date(Date.now() + 3 * 24 * 3600 * 1000),
        status: 'In Progress',
        createdBy: leadUser._id,
      });
    });

    it('rejects blocker creation if reason is in BLOCKER_DEPENDENCY_REASONS and dependencyOwnerId is missing', async () => {
      const res = await request(app)
        .post('/api/blockers')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          workItemId: blockerWorkItem._id.toString(),
          reason: 'Waiting for content',
          // Missing dependencyOwnerId!
        });

      expect(res.status).toBe(400);
    });

    it('creates active blocker with dependencyOwnerId and transitions work item to Blocked', async () => {
      const res = await request(app)
        .post('/api/blockers')
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          workItemId: blockerWorkItem._id.toString(),
          reason: 'Waiting for content',
          notes: 'Need headline copy and pricing disclosures from Writer.',
          dependencyOwnerId: dependencyOwner._id.toString(),
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.reason).toBe('Waiting for content');
      expect(res.body.data.status).toBe('Active');
      expect(res.body.data.dependencyOwnerId?._id.toString()).toBe(dependencyOwner._id.toString());

      // Verify workItem status is Blocked
      const updatedItem = await WorkItem.findById(blockerWorkItem._id);
      expect(updatedItem.status).toBe('Blocked');
      expect(updatedItem.blockerReason).toBe('Waiting for content');

      // Verify ActivityEvent logged
      const blockerActivity = await ActivityEvent.findOne({
        entityId: blockerWorkItem._id,
        action: 'work_item.blocked',
      });
      expect(blockerActivity).not.toBeNull();
    });

    it('allows sending reminder to dependency owner via /notify endpoint', async () => {
      const blocker = await Blocker.findOne({ workItemId: blockerWorkItem._id, status: 'Active' });
      const res = await request(app)
        .post(`/api/blockers/${blocker._id}/notify`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('Reminder sent');

      const updatedBlocker = await Blocker.findById(blocker._id);
      expect(updatedBlocker.lastNotifiedAt).not.toBeNull();
    });

    it('resolves blocker and restores work item status to "In Progress"', async () => {
      const blocker = await Blocker.findOne({ workItemId: blockerWorkItem._id, status: 'Active' });
      const res = await request(app)
        .patch(`/api/blockers/${blocker._id}/resolve`)
        .set('Authorization', `Bearer ${memberToken}`)
        .send({
          resolutionNotes: 'Writer delivered approved headlines.',
          resumeStatus: 'In Progress',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('Resolved');
      expect(res.body.data.resolutionNotes).toContain('Writer delivered');

      // Verify work item restored
      const updatedItem = await WorkItem.findById(blockerWorkItem._id);
      expect(updatedItem.status).toBe('In Progress');
      expect(updatedItem.blockerReason).toBeNull();

      // Verify ActivityEvent logged
      const unblockedActivity = await ActivityEvent.findOne({
        entityId: blockerWorkItem._id,
        action: 'work_item.unblocked',
      });
      expect(unblockedActivity).not.toBeNull();
    });
  });
});
