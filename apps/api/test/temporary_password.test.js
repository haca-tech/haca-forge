import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { io as ioClient } from 'socket.io-client';
import { WORKER_ROLE } from '@mmp/shared';
import { app, server } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';

describe('Temporary Password & Mandatory Password Change Flow', () => {
  const salt = `tp-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  let adminUser;
  let adminToken;
  let serverPort;

  const ADMIN_PASSWORD = 'AdminPass123!';
  const TEMP_PASSWORD = 'TempPass123!';
  const NEW_PERM_PASSWORD = 'PermanentPass456!';

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(env.MONGODB_URI);

    adminUser = await Person.create({
      name: 'TempPass Admin',
      email: `admin.${salt}@test.com`,
      role: 'admin',
      status: 'active',
      passwordHash: await bcrypt.hash(ADMIN_PASSWORD, 10),
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    serverPort = server.address().port;

    // Login as admin to get admin cookie/token
    const adminLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: adminUser.email, password: ADMIN_PASSWORD });
    expect(adminLoginRes.status).toBe(200);
    adminToken = adminLoginRes.headers['set-cookie'];
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await Person.deleteMany({ email: new RegExp(salt) });
  });

  const connectSocket = (cookie) =>
    new Promise((resolve) => {
      const socket = ioClient(`http://127.0.0.1:${serverPort}`, {
        transports: ['websocket'],
        extraHeaders: cookie ? { cookie } : {},
        reconnection: false,
        forceNew: true,
      });
      socket.on('connect', () => {
        socket.disconnect();
        resolve({ ok: true });
      });
      socket.on('connect_error', (err) => {
        resolve({ ok: false, message: err.message });
      });
    });

  describe('1. Admin User Invitation with Temporary Password', () => {
    it('rejects temporary password shorter than 8 characters', async () => {
      const res = await request(app)
        .post('/api/people')
        .set('Cookie', adminToken)
        .send({
          name: 'Short Pass User',
          email: `short.${salt}@test.com`,
          role: WORKER_ROLE,
          temporaryPassword: 'Sh1!',
          confirmTemporaryPassword: 'Sh1!',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/at least 8 characters/i);
    });

    it('rejects temporary password without uppercase letter', async () => {
      const res = await request(app)
        .post('/api/people')
        .set('Cookie', adminToken)
        .send({
          name: 'No Upper User',
          email: `noupper.${salt}@test.com`,
          role: WORKER_ROLE,
          temporaryPassword: 'nouppercase123!',
          confirmTemporaryPassword: 'nouppercase123!',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/uppercase letter/i);
    });

    it('rejects temporary password without numbers', async () => {
      const res = await request(app)
        .post('/api/people')
        .set('Cookie', adminToken)
        .send({
          name: 'No Num User',
          email: `nonum.${salt}@test.com`,
          role: WORKER_ROLE,
          temporaryPassword: 'NoNumberPass!',
          confirmTemporaryPassword: 'NoNumberPass!',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/number/i);
    });

    it('rejects mismatched temporary password confirmation', async () => {
      const res = await request(app)
        .post('/api/people')
        .set('Cookie', adminToken)
        .send({
          name: 'Mismatch User',
          email: `mismatch.${salt}@test.com`,
          role: WORKER_ROLE,
          temporaryPassword: TEMP_PASSWORD,
          confirmTemporaryPassword: 'OtherPass123!',
        });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toMatch(/do not match/i);
    });

    it('successfully creates account with temporary password, hashes it, and sets mustChangePassword: true', async () => {
      const targetEmail = `invited.${salt}@test.com`;
      const res = await request(app)
        .post('/api/people')
        .set('Cookie', adminToken)
        .send({
          name: 'Invited Worker',
          email: targetEmail,
          role: WORKER_ROLE,
          temporaryPassword: TEMP_PASSWORD,
          confirmTemporaryPassword: TEMP_PASSWORD,
        });

      expect(res.status).toBe(201);
      // Ensure plain password and passwordHash are not exposed in response
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('temporaryPassword');
      expect(res.body).not.toHaveProperty('passwordHash');

      // Verify in MongoDB
      const createdUser = await Person.findOne({ email: targetEmail }).select('+passwordHash');
      expect(createdUser).toBeTruthy();
      expect(createdUser.mustChangePassword).toBe(true);
      expect(createdUser.mustSetPassword).toBe(false);
      expect(createdUser.passwordHash).toBeTruthy();
      expect(createdUser.passwordHash).not.toBe(TEMP_PASSWORD);

      const isValidHash = await bcrypt.compare(TEMP_PASSWORD, createdUser.passwordHash);
      expect(isValidHash).toBe(true);
    });
  });

  describe('2. Login and Protected Route Access Control', () => {
    let tempUserCookies;
    const userEmail = `login.${salt}@test.com`;

    beforeAll(async () => {
      // Create user with temporary password
      await request(app)
        .post('/api/people')
        .set('Cookie', adminToken)
        .send({
          name: 'Temporary User',
          email: userEmail,
          role: WORKER_ROLE,
          temporaryPassword: TEMP_PASSWORD,
          confirmTemporaryPassword: TEMP_PASSWORD,
        });
    });

    it('logs in successfully and returns mustChangePassword: true', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: userEmail, password: TEMP_PASSWORD });

      expect(res.status).toBe(200);
      expect(res.body.user.mustChangePassword).toBe(true);
      expect(res.headers['set-cookie']).toBeTruthy();
      tempUserCookies = res.headers['set-cookie'];
    });

    it('blocks normal protected APIs (e.g. /api/people) with 403 MUST_CHANGE_PASSWORD', async () => {
      const res = await request(app)
        .get('/api/people')
        .set('Cookie', tempUserCookies);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('MUST_CHANGE_PASSWORD');
      expect(res.body.error.message).toMatch(/must change your temporary password/i);
    });

    it('rejects socket.io handshake while mustChangePassword is true', async () => {
      const cookieStr = tempUserCookies.join('; ');
      const res = await connectSocket(cookieStr);
      expect(res.ok).toBe(false);
      expect(res.message).toMatch(/Password change required/i);
    });

    it('allows /api/auth/me while mustChangePassword is true', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', tempUserCookies);

      expect(res.status).toBe(200);
      expect(res.body.user.mustChangePassword).toBe(true);
    });

    it('allows changing password via /api/me/password and clears mustChangePassword', async () => {
      const res = await request(app)
        .post('/api/me/password')
        .set('Cookie', tempUserCookies)
        .send({
          currentPassword: TEMP_PASSWORD,
          newPassword: NEW_PERM_PASSWORD,
          confirmPassword: NEW_PERM_PASSWORD,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify in DB that mustChangePassword is now false
      const updatedUser = await Person.findOne({ email: userEmail });
      expect(updatedUser.mustChangePassword).toBe(false);

      // Verify /api/auth/me now reflects mustChangePassword: false
      const meRes = await request(app)
        .get('/api/auth/me')
        .set('Cookie', tempUserCookies);
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.mustChangePassword).toBe(false);
    });

    it('allows socket.io connection after password is changed', async () => {
      const cookieStr = tempUserCookies.join('; ');
      const res = await connectSocket(cookieStr);
      expect(res.ok).toBe(true);
    });

    it('authenticates with new password on subsequent login', async () => {
      // Old password fails
      const failRes = await request(app)
        .post('/api/auth/login')
        .send({ email: userEmail, password: TEMP_PASSWORD });
      expect(failRes.status).toBe(401);

      // New password succeeds
      const successRes = await request(app)
        .post('/api/auth/login')
        .send({ email: userEmail, password: NEW_PERM_PASSWORD });
      expect(successRes.status).toBe(200);
      expect(successRes.body.user.mustChangePassword).toBe(false);
    });
  });
});
