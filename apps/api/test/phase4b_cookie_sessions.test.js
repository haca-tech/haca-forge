import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { io as ioClient } from 'socket.io-client';
import { app, server } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';
import { getCookieOptions, getClearCookieOptions } from '../src/lib/authCookies.js';

const PASSWORD = 'CookieOnly123!';

/** name -> { value, attrs } from a Set-Cookie header list */
function readCookies(res) {
  const out = {};
  for (const line of res.headers['set-cookie'] || []) {
    const [pair, ...attrs] = line.split(';').map((s) => s.trim());
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = { value: pair.slice(i + 1), attrs: attrs.map((a) => a.toLowerCase()) };
  }
  return out;
}

const cookieHeader = (access, refresh) =>
  [access && `accessToken=${access}`, refresh && `refreshToken=${refresh}`].filter(Boolean).join('; ');

describe('Phase 4b: login tokens only in httpOnly cookies', () => {
  const salt = `p4b-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  let user;
  let port;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(env.MONGODB_URI);
    user = await Person.create({
      name: 'P4b Cookie User',
      email: `cookie.${salt}@p4b.test`,
      role: 'executive',
      status: 'active',
      passwordHash: await bcrypt.hash(PASSWORD, 10),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(() => resolve()));
    await Person.deleteMany({ _id: user._id });
  });

  const login = () => request(app).post('/api/auth/login').send({ email: user.email, password: PASSWORD });

  const connect = (cookie) =>
    new Promise((resolve) => {
      const socket = ioClient(`http://127.0.0.1:${port}`, {
        transports: ['websocket'],
        extraHeaders: cookie ? { cookie } : {},
        reconnection: false,
        forceNew: true,
      });
      socket.on('connect', () => resolve({ ok: true, socket }));
      socket.on('connect_error', (err) => {
        socket.close();
        resolve({ ok: false, error: err.message });
      });
    });

  it('login sets httpOnly cookies and returns no token in the body', async () => {
    const res = await login();
    expect(res.status).toBe(200);
    expect(res.body.user).toBeDefined();
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/eyJ[\w-]+\.[\w-]+\./);
    const cookies = readCookies(res);
    for (const name of ['accessToken', 'refreshToken']) {
      expect(cookies[name]?.value).toBeTruthy();
      expect(cookies[name].attrs).toContain('httponly');
      expect(cookies[name].attrs).toContain('samesite=lax');
      expect(cookies[name].attrs).toContain('path=/');
    }
  });

  it('REST works with the cookie alone', async () => {
    const { accessToken } = readCookies(await login());
    const res = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(accessToken.value));
    expect(res.status).toBe(200);
  });

  it('refresh works from the cookie alone and returns no token in the body', async () => {
    const { refreshToken } = readCookies(await login());
    const res = await request(app).post('/api/auth/refresh').set('Cookie', cookieHeader(null, refreshToken.value));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeUndefined();
    expect(res.body.refreshToken).toBeUndefined();
    const cookies = readCookies(res);
    expect(cookies.accessToken?.value).toBeTruthy();
    expect(cookies.refreshToken?.value).toBeTruthy();
  });

  it('after the access cookie expires, a refresh restores REST', async () => {
    const { refreshToken } = readCookies(await login());
    const expired = jwt.sign({ userId: String(user._id), role: user.role, exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET);
    const denied = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(expired, refreshToken.value));
    expect(denied.status).toBe(401);
    expect(denied.body.error.code).toBe('TOKEN_EXPIRED');

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookieHeader(expired, refreshToken.value));
    expect(refreshed.status).toBe(200);
    const fresh = readCookies(refreshed);
    const again = await request(app).get('/api/auth/me').set('Cookie', cookieHeader(fresh.accessToken.value, fresh.refreshToken.value));
    expect(again.status).toBe(200);
  });

  it('a socket connects with the cookie alone', async () => {
    const { accessToken } = readCookies(await login());
    const result = await connect(cookieHeader(accessToken.value));
    expect(result.ok).toBe(true);
    result.socket.close();
  });

  it('a socket is refused with an expired cookie, and connects again after refresh', async () => {
    const { refreshToken } = readCookies(await login());
    const expired = jwt.sign({ userId: String(user._id), role: user.role, exp: Math.floor(Date.now() / 1000) - 60 }, env.JWT_SECRET);
    const refused = await connect(cookieHeader(expired, refreshToken.value));
    expect(refused.ok).toBe(false);
    expect(refused.error.toLowerCase()).toContain('authentication');

    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookieHeader(expired, refreshToken.value));
    const fresh = readCookies(refreshed);
    const result = await connect(cookieHeader(fresh.accessToken.value));
    expect(result.ok).toBe(true);
    result.socket.close();
  });

  it('a socket with no cookie is refused', async () => {
    const result = await connect(null);
    expect(result.ok).toBe(false);
  });

  describe('cookie configuration & clearing consistency', () => {
    const originalEnv = env.NODE_ENV;
    const originalCookieDomain = env.COOKIE_DOMAIN;

    afterAll(() => {
      env.NODE_ENV = originalEnv;
      env.COOKIE_DOMAIN = originalCookieDomain;
    });

    it('production cookie options enforce sameSite=none, secure=true, httpOnly=true', () => {
      env.NODE_ENV = 'production';
      env.COOKIE_DOMAIN = '';
      const opts = getCookieOptions(15 * 60 * 1000);
      expect(opts).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        domain: undefined,
        path: '/',
        maxAge: 15 * 60 * 1000,
      });

      const clearOpts = getClearCookieOptions();
      expect(clearOpts).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: 'none',
        domain: undefined,
        path: '/',
      });
    });

    it('development cookie options enforce sameSite=lax, secure=false, httpOnly=true', () => {
      env.NODE_ENV = 'development';
      env.COOKIE_DOMAIN = '';
      const opts = getCookieOptions(7 * 24 * 60 * 60 * 1000);
      expect(opts).toMatchObject({
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        domain: undefined,
        path: '/',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      const clearOpts = getClearCookieOptions();
      expect(clearOpts).toMatchObject({
        httpOnly: true,
        secure: false,
        sameSite: 'lax',
        domain: undefined,
        path: '/',
      });
    });

    it('preserves custom COOKIE_DOMAIN if set and trims whitespace', () => {
      env.COOKIE_DOMAIN = ' .haca.tech ';
      const opts = getCookieOptions(1000);
      expect(opts.domain).toBe('.haca.tech');

      env.COOKIE_DOMAIN = '   ';
      const emptyOpts = getCookieOptions(1000);
      expect(emptyOpts.domain).toBeUndefined();
    });

    it('logout clears both cookies with consistent path and attributes', async () => {
      env.NODE_ENV = 'development';
      const { accessToken } = readCookies(await login());
      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', cookieHeader(accessToken.value));
      expect(res.status).toBe(200);

      const cookies = readCookies(res);
      expect(cookies.accessToken).toBeDefined();
      expect(cookies.refreshToken).toBeDefined();
      expect(cookies.accessToken.attrs).toContain('httponly');
      expect(cookies.accessToken.attrs).toContain('path=/');
      expect(cookies.refreshToken.attrs).toContain('httponly');
      expect(cookies.refreshToken.attrs).toContain('path=/');
    });
  });
});
