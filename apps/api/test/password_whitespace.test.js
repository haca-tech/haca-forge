// Passwords ignore spaces at the start and end (temporary passwords pasted from WhatsApp/email).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { app } from '../src/server.js';
import { Person } from '../src/modules/people/model.js';
import { cleanPassword, passwordMatches } from '../src/lib/passwords.js';

const EMAIL = 'spaces@pw-whitespace-test.local';
const OLD = 'legacy@pw-whitespace-test.local';

describe('Password whitespace', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGODB_URI_TEST || 'mongodb://127.0.0.1:27017/marketing_portal_test');
    await Person.deleteMany({ email: { $in: [EMAIL, OLD] } });
    await Person.create({ name: 'PW Spaces', email: EMAIL, role: 'executive', status: 'active', passwordHash: await bcrypt.hash('Temp@Pass123', 10) });
    // Saved before the rule, with a real trailing space.
    await Person.create({ name: 'PW Legacy', email: OLD, role: 'executive', status: 'active', passwordHash: await bcrypt.hash('Old@Pass123 ', 10) });
  });
  afterAll(() => Person.deleteMany({ email: { $in: [EMAIL, OLD] } }));

  it('signs in when the password is typed or pasted with spaces around it', async () => {
    for (const pw of ['Temp@Pass123', ' Temp@Pass123', 'Temp@Pass123 ', '\tTemp@Pass123  ']) {
      const res = await request(app).post('/api/auth/login').send({ email: EMAIL, password: pw });
      expect(res.status, JSON.stringify(pw)).toBe(200);
    }
    expect((await request(app).post('/api/auth/login').send({ email: EMAIL, password: 'Temp@ Pass123' })).status).toBe(401); // inner spaces still count
  });

  it('a password saved with a real outer space still works, as typed or trimmed', async () => {
    expect(await passwordMatches('Old@Pass123 ', (await Person.findOne({ email: OLD }).select('+passwordHash')).passwordHash)).toBe(true);
    expect((await request(app).post('/api/auth/login').send({ email: OLD, password: 'Old@Pass123 ' })).status).toBe(200);
  });

  it('new passwords are saved without outer spaces', () => {
    expect(cleanPassword('  New@Pass1 ')).toBe('New@Pass1');
    expect(cleanPassword(undefined)).toBe('');
  });
});
