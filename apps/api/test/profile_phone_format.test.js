// Edit Profile: phone and WhatsApp numbers typed with spaces, dashes or brackets
// ("+91 90721 90088") are accepted and saved without them; a number that is really invalid is
// refused with the field's own message. The seeded user is removed afterwards.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/server.js';
import { env } from '../src/config/env.js';
import { Person } from '../src/modules/people/model.js';

describe('Profile: phone number format', () => {
  const salt = `pfmt-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  let person;
  let token;

  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) await mongoose.connect(env.MONGODB_URI);
    person = await Person.create({
      name: 'Format Tester',
      email: `${salt}@pfmt.test`,
      role: 'executive',
      status: 'active',
      phone: '+919072190088',
      phoneVerified: true,
    });
    token = jwt.sign({ userId: String(person._id), role: person.role }, env.JWT_SECRET, { expiresIn: '1h' });
  });

  afterAll(async () => {
    await Person.deleteMany({ email: new RegExp(salt) });
  });

  const patch = (body) => request(app).patch('/api/me/profile').set('Authorization', `Bearer ${token}`).send(body);

  it('a WhatsApp number with spaces saves (cleaned), with the rest of the form', async () => {
    const res = await patch({ name: 'MUBASHIR', preferredName: '', whatsappNumber: '+91 9072190088', about: '', languages: [], skills: [] });
    expect(res.status).toBe(200);
    expect((await Person.findById(person._id)).whatsappNumber).toBe('+919072190088');

    const dashed = await patch({ whatsappNumber: '(+91) 907-219-0088' });
    expect(dashed.status).toBe(200);
    expect((await Person.findById(person._id)).whatsappNumber).toBe('+919072190088');
  });

  it('an invalid number is refused with the field and its message', async () => {
    const res = await patch({ whatsappNumber: '12ab' });
    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual([
      { field: 'whatsappNumber', message: 'WhatsApp number must be a valid format (e.g. +919876543210)' },
    ]);
  });

  it('the phone-code endpoints accept a spaced number too', async () => {
    const res = await request(app).post('/api/me/phone-otp/send').set('Authorization', `Bearer ${token}`).send({ phone: '+91 98765 43210' });
    expect(res.status).toBe(200);
    const { PhoneVerification } = await import('../src/modules/profile/phoneVerification.model.js');
    expect(await PhoneVerification.countDocuments({ userId: person._id, phone: '+919876543210' })).toBe(1);
    await PhoneVerification.deleteMany({ userId: person._id });
  });
});
