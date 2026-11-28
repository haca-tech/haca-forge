// Login loop on the hosted app: the web app (Vercel) and API (Render) were different sites, so the
// login cookie was third-party and Safari/Brave/incognito dropped it. The web app now calls /api on
// its own domain; the socket and uploads go to the API host with short-lived single-purpose tokens.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { issueDirectToken, verifyDirectToken } from '../src/lib/directTokens.js';
import { getCookieOptions } from '../src/lib/authCookies.js';

const EMAIL = /@direct-token-test\.local$/;

describe('Direct tokens (socket and upload) and first-party cookies', () => {
  let user;
  let token;
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/marketing_portal_test');
    await Person.deleteMany({ email: EMAIL });
    user = await Person.create({ name: 'DT Writer', email: 'writer@direct-token-test.local', role: 'executive', jobRole: 'Writer', status: 'active' });
    token = jwt.sign({ userId: String(user._id), role: user.role, email: user.email }, env.JWT_SECRET, { expiresIn: '1h' });
  });
  afterAll(() => Person.deleteMany({ email: EMAIL }));

  it('issues a short-lived token per purpose, only to a signed-in user', async () => {
    expect((await request(app).get('/api/auth/direct-token?purpose=socket')).status).toBe(401);
    const res = await request(app).get('/api/auth/direct-token?purpose=upload').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data.expiresIn).toBe(120);
    expect(verifyDirectToken(res.body.data.token, 'upload')).toBe(String(user._id));
    expect((await request(app).get('/api/auth/direct-token?purpose=admin').set('Authorization', `Bearer ${token}`)).status).toBe(400);
  });

  it('a direct token is not a login token, and a socket token cannot upload', async () => {
    const { token: socketToken } = issueDirectToken(user._id, 'socket');
    expect((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${socketToken}`)).status).toBe(401);
    expect(() => verifyDirectToken(socketToken, 'upload')).toThrow();
    // The upload route ignores a socket token (authenticate answers 401).
    expect((await request(app).post('/api/uploads/file').set('X-Upload-Token', socketToken)).status).toBe(401);
  });

  it('the upload route accepts a valid upload token in place of the cookie', async () => {
    const { token: uploadToken } = issueDirectToken(user._id, 'upload');
    // No file: past authentication, the handler refuses the empty upload (not 401).
    const res = await request(app).post('/api/uploads/file').set('X-Upload-Token', uploadToken);
    expect(res.status).not.toBe(401);
  });

  it('never sets a cookie domain the browser site cannot accept', () => {
    const prev = env.COOKIE_DOMAIN;
    env.COOKIE_DOMAIN = 'mmp-api-t3z8.onrender.com';
    try {
      const reqFrom = (origin, host = 'mmp-api-t3z8.onrender.com') => ({ get: (h) => (h === 'origin' ? origin : undefined), hostname: host });
      expect(getCookieOptions(1000, reqFrom('https://haca-forge.vercel.app')).domain).toBeUndefined();
      expect(getCookieOptions(1000, reqFrom('https://mmp-api-t3z8.onrender.com')).domain).toBe('mmp-api-t3z8.onrender.com');
    } finally {
      env.COOKIE_DOMAIN = prev;
    }
  });
});
