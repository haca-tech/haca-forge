// Email: the driver module (console / smtp), retry and friendly failure, startup checks, the branded
// templates (snapshots, escaping, codes never in subjects), every email path going through the
// module, phone verification by email OTP, and the dev-only preview routes. No real email is sent:
// tests use the console driver, a recording driver, or the SMTP driver on a mocked transport.

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import { app } from '../src/server.js';
import { env, emailSettingsProblems, SMTP_SETTINGS, RESEND_SETTINGS } from '../src/config/env.js';
import { connectDB } from '../src/config/db.js';
import { logger } from '../src/lib/logger.js';
import { Person } from '../src/modules/people/model.js';
import { AccessRequest } from '../src/modules/access/model.js';
import { PhoneVerification } from '../src/modules/profile/phoneVerification.model.js';
import { createConsoleDriver, createSmtpDriver, createResendDriver, createDriver } from '../src/lib/email/drivers.js';
import {
  deliver,
  sendEmail,
  sendEmailOrFail,
  setEmailDriver,
  setRetryDelay,
  getDriver,
  renderEmail,
  verifyEmailOnStartup,
  resetEmailThrottle,
  checkEmailThrottle,
  recordEmailSent,
  TEMPLATES,
  TEMPLATE_NAMES,
  EMAIL_SEND_FAILED_MESSAGE,
  maskEmail,
  maskPhone,
} from '../src/lib/email/index.js';
import { FOOTER_ACCOUNT_LINE } from '../src/lib/email/layout.js';
import { rejectAccessRequest, requestInfoForAccess } from '../src/modules/access/service.js';
import { sendNotificationEmail } from '../src/modules/notifications/email.js';
import { mountDevRoutes } from '../src/modules/dev/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_ROOT = path.resolve(__dirname, '..');
const DOMAIN = '@email-smtp-test.com';

/** A driver that records every message instead of sending it. */
function recordingDriver({ failTimes = 0 } = {}) {
  const sent = [];
  let failuresLeft = failTimes;
  return {
    name: 'recording',
    sent,
    calls: 0,
    async send(message) {
      this.calls += 1;
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        const err = new Error('Connection timeout');
        err.code = 'ETIMEDOUT';
        throw err;
      }
      sent.push(message);
      return { messageId: `rec-${sent.length}` };
    },
    async verify() {},
  };
}

const originalDriver = getDriver();
let driver;

beforeEach(() => {
  driver = recordingDriver();
  setEmailDriver(driver);
  setRetryDelay(5);
  resetEmailThrottle();
});

afterEach(() => {
  vi.restoreAllMocks();
  setEmailDriver(originalDriver);
  setRetryDelay(1500);
});

// ---------------------------------------------------------------------------------------------------

describe('Drivers', () => {
  it('the console driver logs recipient, subject and a short preview, and sends nothing', async () => {
    const log = { info: vi.fn() };
    const consoleDriver = createConsoleDriver({ logger: log });
    const longText = `Hello ${'x'.repeat(2000)}`;
    const info = await consoleDriver.send({ from: 'f@x.com', to: 'a@b.com', subject: 'Hi', html: '<p>x</p>', text: longText });
    expect(info.messageId).toMatch(/^console-/);
    expect(log.info).toHaveBeenCalledTimes(1);
    const [fields, line] = log.info.mock.calls[0];
    expect(fields).toEqual({ to: 'a@b.com', from: 'f@x.com', subject: 'Hi' });
    expect(line).toContain('To: a@b.com');
    expect(line).toContain('Subject: Hi');
    expect(line.length).toBeLessThan(500); // a preview, not the whole body
  });

  it('the console driver is the default (dev and tests)', () => {
    expect(env.EMAIL_DRIVER).toBe('console');
    expect(originalDriver.name).toBe('console');
    expect(createDriver(undefined, {}, { logger }).name).toBe('console');
  });

  it('the SMTP driver sends from, to, subject, html and text through the transport', async () => {
    const sendMail = vi.fn(async () => ({ messageId: 'smtp-1' }));
    const createTransport = vi.fn(() => ({ sendMail, verify: vi.fn() }));
    const smtp = createSmtpDriver(
      { host: 'smtp.gmail.com', port: '465', secure: 'true', user: 'sender@gmail.com', pass: 'app-pass-abcd' },
      { createTransport }
    );
    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: 'sender@gmail.com', pass: 'app-pass-abcd' } })
    );

    setEmailDriver(smtp);
    const result = await sendEmail({ to: 'rafi@harisandcoacademy.com', template: 'test', data: { driver: 'smtp', sentAt: 'now' } });
    expect(result).toEqual({ ok: true, messageId: 'smtp-1' });
    expect(sendMail).toHaveBeenCalledTimes(1);
    const message = sendMail.mock.calls[0][0];
    expect(message.from).toBe(env.EMAIL_FROM);
    expect(message.to).toBe('rafi@harisandcoacademy.com');
    expect(message.subject).toBe('HACA Forge test email');
    expect(message.html).toContain('HACA FORGE');
    expect(message.text).toContain('Email is working');
  });

  it('SMTP_SECURE=false means STARTTLS on the given port', () => {
    const createTransport = vi.fn(() => ({ sendMail: vi.fn(), verify: vi.fn() }));
    createSmtpDriver({ host: 'h', port: 587, secure: 'false', user: 'u', pass: 'p' }, { createTransport });
    expect(createTransport.mock.calls[0][0]).toMatchObject({ port: 587, secure: false });
  });

  it('the Resend driver sends from, to, subject, html and text through the Resend client', async () => {
    const send = vi.fn(async () => ({ data: { id: 'resend-msg-123' }, error: null }));
    const mockClient = { emails: { send } };
    const resendDriver = createResendDriver(
      { apiKey: 're_test_key_123', from: 'HACA Forge <onboarding@resend.dev>' },
      { client: mockClient }
    );

    setEmailDriver(resendDriver);
    const result = await sendEmail({ to: 'team@example.com', template: 'test', data: { driver: 'resend', sentAt: 'now' } });
    expect(result).toEqual({ ok: true, messageId: 'resend-msg-123' });
    expect(send).toHaveBeenCalledTimes(1);
    const payload = send.mock.calls[0][0];
    expect(payload.to).toEqual(['team@example.com']);
    expect(payload.subject).toBe('HACA Forge test email');
    expect(payload.html).toContain('HACA FORGE');
  });

  it('the Resend driver throws error when client returns an error', async () => {
    const send = vi.fn(async () => ({ data: null, error: { message: 'Domain not verified' } }));
    const mockClient = { emails: { send } };
    const resendDriver = createResendDriver(
      { apiKey: 're_test_key_123', from: 'HACA Forge <onboarding@resend.dev>' },
      { client: mockClient }
    );

    await expect(resendDriver.send({ to: 'x@y.com', subject: 's', html: 'h', text: 't' })).rejects.toThrow('Domain not verified');
  });
});

describe('Retry once, then a friendly error; never a crash', () => {
  it('a failure is retried once and the second try succeeds', async () => {
    driver = recordingDriver({ failTimes: 1 });
    setEmailDriver(driver);
    const result = await deliver({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(result.ok).toBe(true);
    expect(driver.calls).toBe(2);
  });

  it('two failures return ok:false (no throw); sendEmailOrFail throws the friendly 503', async () => {
    driver = recordingDriver({ failTimes: 5 });
    setEmailDriver(driver);
    const result = await deliver({ to: 'a@b.com', subject: 's', html: 'h', text: 't' });
    expect(result).toEqual({ ok: false, error: 'Connection timeout' });
    expect(driver.calls).toBe(2);

    await expect(sendEmailOrFail({ to: 'a@b.com', template: 'test', data: {} })).rejects.toMatchObject({
      statusCode: 503,
      code: 'EMAIL_SEND_FAILED',
      message: "We couldn't send the email. Try again.",
    });
  });

  it('failures are logged without the SMTP password', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const error = vi.spyOn(logger, 'error');
    const sendMail = vi.fn(async () => {
      const err = new Error('Invalid login: 535 Username and Password not accepted');
      err.code = 'EAUTH';
      err.responseCode = 535;
      throw err;
    });
    setEmailDriver(createSmtpDriver({ host: 'smtp.gmail.com', port: 465, secure: true, user: 'u@gmail.com', pass: 'very-secret-app-pass' }, { createTransport: () => ({ sendMail }) }));
    const result = await sendEmail({ to: 'a@b.com', template: 'test', data: {} });
    expect(result.ok).toBe(false);
    expect(sendMail).toHaveBeenCalledTimes(2);
    const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('EAUTH');
    expect(logged).not.toContain('very-secret-app-pass');
  });

  it('the startup check logs success or failure, never secrets', async () => {
    const info = vi.spyOn(logger, 'info');
    const error = vi.spyOn(logger, 'error');
    const prevDriver = env.EMAIL_DRIVER;
    env.EMAIL_DRIVER = 'smtp';
    try {
      setEmailDriver({ name: 'smtp', send: vi.fn(), verify: vi.fn(async () => {}) });
      expect(await verifyEmailOnStartup()).toMatchObject({ ok: true });
      expect(JSON.stringify(info.mock.calls)).toContain('SMTP connection verified');

      setEmailDriver({ name: 'smtp', send: vi.fn(), verify: vi.fn(async () => { throw Object.assign(new Error('Greeting never received'), { code: 'ETIMEDOUT' }); }) });
      expect(await verifyEmailOnStartup()).toMatchObject({ ok: false });
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).toContain('SMTP connection check failed');
      expect(logged).not.toMatch(/pass/i);
    } finally {
      env.EMAIL_DRIVER = prevDriver;
    }
  });
});

describe('Startup settings', () => {
  it('EMAIL_DRIVER=smtp needs every SMTP setting and EMAIL_FROM; console needs none', () => {
    expect(SMTP_SETTINGS).toEqual(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM']);
    expect(RESEND_SETTINGS).toEqual(['RESEND_API_KEY', 'EMAIL_FROM']);
    expect(emailSettingsProblems({ EMAIL_DRIVER: 'console' })).toEqual([]);
    expect(emailSettingsProblems({})).toEqual([]);
    expect(emailSettingsProblems({ EMAIL_DRIVER: 'smtp', SMTP_HOST: 'smtp.gmail.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: 'u', SMTP_PASS: ' ' })).toEqual([
      'SMTP_PASS is missing or empty',
      'EMAIL_FROM is missing or empty',
    ]);
  });

  it('EMAIL_DRIVER=resend requires RESEND_API_KEY and EMAIL_FROM', () => {
    expect(emailSettingsProblems({ EMAIL_DRIVER: 'resend' })).toEqual([
      'RESEND_API_KEY is missing or empty',
      'EMAIL_FROM is missing or empty',
    ]);
    expect(emailSettingsProblems({ EMAIL_DRIVER: 'resend', RESEND_API_KEY: 're_123', EMAIL_FROM: 'HACA <onboarding@resend.dev>' })).toEqual([]);
  });

  it('PHONE_OTP_CHANNEL=sms (no provider) and an SVG logo are refused', () => {
    expect(emailSettingsProblems({ PHONE_OTP_CHANNEL: 'sms' })[0]).toMatch(/no SMS provider/);
    expect(emailSettingsProblems({ EMAIL_LOGO_URL: 'https://cdn.example.com/logo.svg' })[0]).toMatch(/PNG/);
    expect(emailSettingsProblems({ EMAIL_LOGO_URL: 'https://cdn.example.com/logo.png' })).toEqual([]);
  });

  const spawnEnv = (overrides) =>
    spawnSync(process.execPath, ['-e', "import('./src/config/env.js')"], {
      cwd: API_ROOT,
      env: { ...process.env, ...overrides },
      encoding: 'utf8',
    });

  it('the API refuses to start with an SMTP setting missing, naming it but never printing values', () => {
    // Empty strings (not absent) so apps/api/.env cannot fill them in.
    const res = spawnEnv({
      EMAIL_DRIVER: 'smtp',
      SMTP_HOST: '',
      SMTP_PORT: '465',
      SMTP_SECURE: 'true',
      SMTP_USER: 'sender-user@gmail.com',
      SMTP_PASS: 'secret-app-password-123',
      EMAIL_FROM: '',
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('SMTP_HOST is missing or empty');
    expect(res.stderr).toContain('EMAIL_FROM is missing or empty');
    expect(res.stderr).toContain('docs/EMAIL.md');
    expect(res.stderr).not.toContain('secret-app-password-123');
    expect(res.stderr).not.toContain('sender-user@gmail.com');
  });

  it('the API refuses PHONE_OTP_CHANNEL=sms at startup', () => {
    const res = spawnEnv({ PHONE_OTP_CHANNEL: 'sms' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('PHONE_OTP_CHANNEL=sms');
  });
});

// ---------------------------------------------------------------------------------------------------

describe('Branded templates', () => {
  const ctx = { appUrl: 'http://localhost:5173', logoUrl: '' };

  it.each(TEMPLATE_NAMES)('%s: base layout, HTML and plain text (snapshot)', (name) => {
    const { subject, html, text } = renderEmail(name, TEMPLATES[name].sample);
    expect(subject).toBeTruthy();
    // The one layout: wordmark, 600px card, footer, preheader, light color scheme.
    expect(html).toContain('HACA FORGE');
    expect(html).toContain('width="600"');
    expect(html).toContain('Haris &amp; Co Academy');
    expect(html).toContain(FOOTER_ACCOUNT_LINE.replace("'", '&#39;'));
    expect(html).toContain('http://localhost:5173');
    expect(html).toContain('mso-hide:all');
    expect(html).toContain('<meta name="color-scheme" content="light">');
    expect(html).not.toMatch(/<svg|\.svg/i);
    expect(text.startsWith('HACA FORGE\n')).toBe(true);
    expect(text).toContain(FOOTER_ACCOUNT_LINE);
    expect(text).toContain('Haris & Co Academy');
    expect({ subject, html, text }).toMatchSnapshot();
  });

  it('at most one primary button per email', () => {
    for (const name of TEMPLATE_NAMES) {
      const { html } = renderEmail(name, TEMPLATES[name].sample);
      expect(html.match(/border-radius:8px;"><a /g)?.length || 0).toBeLessThanOrEqual(1);
    }
  });

  it('only notification emails link to notification settings', () => {
    const notification = renderEmail('notification', TEMPLATES.notification.sample);
    expect(notification.html).toContain('/settings?tab=notifications');
    expect(notification.text).toContain('Notification settings: http://localhost:5173/settings?tab=notifications');
    expect(notification.html).toContain('Open in HACA Forge');
    for (const name of TEMPLATE_NAMES.filter((n) => n !== 'notification')) {
      expect(renderEmail(name, TEMPLATES[name].sample).html).not.toContain('/settings?tab=notifications');
    }
  });

  it('uses a PNG logo from EMAIL_LOGO_URL when set', () => {
    const { html } = TEMPLATES.test.render({ driver: 'smtp', sentAt: 'now' }, { ...ctx, logoUrl: 'https://cdn.example.com/logo.png' });
    expect(html).toContain('<img src="https://cdn.example.com/logo.png" alt="HACA FORGE"');
  });

  it('escapes all user-supplied text and drops unsafe links', () => {
    const evil = '<script>alert("x")</script>';
    const { html, text, subject } = renderEmail('notification', {
      name: '<b>Rafi</b>',
      title: `Overdue: ${evil}`,
      message: `Note: ${evil} & <img src=x onerror=alert(1)>`,
      itemName: '"quoted" <i>item</i>',
      url: 'javascript:alert(1)',
    });
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>Rafi</b>');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<i>item</i>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Rafi&lt;/b&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('Open in HACA Forge'); // unsafe link: no button
    expect(text).toContain(evil); // plain text stays as typed
    expect(subject).toBe(`Overdue: ${evil}`);

    const rejected = renderEmail('accessRejected', { name: 'A', reason: '</td></tr><a href="http://evil">click</a>' });
    expect(rejected.html).not.toContain('<a href="http://evil">');
    const access = renderEmail('accessRequestReceived', { name: '<x>', email: 'a@b.com', department: '<y>', requestedRole: 'executive' });
    expect(access.html).not.toMatch(/<x>|<y>/);
  });

  it('OTP emails show the code in the body, never in the subject', () => {
    for (const name of ['verificationCode', 'phoneVerificationCode']) {
      const { subject, html, text } = renderEmail(name, { name: 'Rafi', code: '918273', phone: '+919876543210', minutes: 10 });
      expect(subject).not.toContain('918273');
      expect(html).toContain('918273');
      expect(text).toContain('9 1 8 2 7 3'); // spaced in plain text
      expect(html).toContain('letter-spacing:10px');
      expect(text).toContain('valid for 10 minutes');
      expect(text).toContain("If you didn't request this, ignore this email.");
    }
  });

  it('the phone template shows the number masked except the last 4 digits', () => {
    expect(maskPhone('+919876543210')).toBe('+••••••••3210');
    expect(maskPhone('9000000011')).toBe('••••••0011');
    const { html, text } = renderEmail('phoneVerificationCode', { code: '111222', phone: '+919876543210' });
    expect(html).toContain('+••••••••3210');
    expect(html).not.toContain('9876543210');
    expect(text).not.toContain('9876543210');
  });

  it('masks the email the code was sent to', () => {
    expect(maskEmail('mohammed@harisandcoacademy.com')).toBe('m•••@harisandcoacademy.com');
  });
});

describe('Throttle: one code or reset email per recipient per type per minute', () => {
  it('blocks a second send inside the minute, per type and recipient', () => {
    const t0 = 1_000_000;
    recordEmailSent('phone_otp', 'A@b.com', t0);
    expect(checkEmailThrottle('phone_otp', 'a@b.com', t0 + 10_000)).toEqual({ allowed: false, retryAfterSeconds: 50 });
    expect(checkEmailThrottle('password_reset', 'a@b.com', t0 + 10_000).allowed).toBe(true);
    expect(checkEmailThrottle('phone_otp', 'c@d.com', t0 + 10_000).allowed).toBe(true);
    expect(checkEmailThrottle('phone_otp', 'a@b.com', t0 + 60_000).allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------

describe('Every email path goes through the module', () => {
  let admin;
  let worker;
  let workerToken;

  const token = (user) => jwt.sign({ userId: user._id.toString(), email: user.email, role: user.role }, env.JWT_SECRET, { expiresIn: '1h' });

  beforeAll(async () => {
    await connectDB();
    await Person.deleteMany({ email: new RegExp(`${DOMAIN.replace('.', '\\.')}$`) });
    await AccessRequest.deleteMany({ email: new RegExp(`${DOMAIN.replace('.', '\\.')}$`) });
    admin = await Person.create({ name: 'Email Admin', email: `admin${DOMAIN}`, role: 'admin', status: 'active', passwordHash: 'hash' });
    worker = await Person.create({
      name: 'Mohammed Rafi',
      email: `mohammed${DOMAIN}`,
      role: 'executive',
      jobRole: 'Writer',
      status: 'active',
      passwordHash: 'hash',
    });
    workerToken = token(worker);
  });

  afterAll(async () => {
    await Person.deleteMany({ email: new RegExp(`${DOMAIN.replace('.', '\\.')}$`) });
    await AccessRequest.deleteMany({ email: new RegExp(`${DOMAIN.replace('.', '\\.')}$`) });
    await PhoneVerification.deleteMany({ userId: worker?._id });
  });

  it('no code outside lib/email talks to nodemailer or the old mailer', () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) files.push(full);
      }
    };
    walk(path.join(API_ROOT, 'src'));
    walk(path.join(API_ROOT, 'scripts'));
    const offenders = files.filter((file) => {
      const rel = path.relative(API_ROOT, file).replace(/\\/g, '/');
      const src = fs.readFileSync(file, 'utf8');
      if (rel === 'src/lib/email/drivers.js') return false;
      return /from ['"]nodemailer['"]|lib\/mailer\.js|createTransport\(/.test(src);
    });
    expect(offenders).toEqual([]);
    expect(fs.existsSync(path.join(API_ROOT, 'src/lib/mailer.js'))).toBe(false);
  });

  it('password reset sends the branded reset email; a failure answers the friendly 503', async () => {
    const res = await request(app).post('/api/auth/forgot-password').send({ email: worker.email });
    expect(res.status).toBe(200);
    expect(driver.sent).toHaveLength(1);
    const mail = driver.sent[0];
    expect(mail.to).toBe(worker.email);
    expect(mail.subject).toBe('HACA Forge - Password Reset Request');
    expect(mail.html).toContain('Set Password &amp; Sign In');
    expect(mail.html).toContain('/set-password?token=');
    expect(mail.text).toContain('valid for 48 hours');

    // Second request inside the minute: same answer, nothing sent.
    const again = await request(app).post('/api/auth/forgot-password').send({ email: worker.email });
    expect(again.status).toBe(200);
    expect(driver.sent).toHaveLength(1);

    resetEmailThrottle();
    setEmailDriver(recordingDriver({ failTimes: 5 }));
    const failed = await request(app).post('/api/auth/forgot-password').send({ email: worker.email });
    expect(failed.status).toBe(503);
    expect(failed.body.error.message).toBe(EMAIL_SEND_FAILED_MESSAGE);
  });

  it('access request rejected and info needed use the module and the layout', async () => {
    const make = () =>
      AccessRequest.create({ name: 'Aisha <Noor>', email: `aisha${DOMAIN}`, phone: '+919000000123', department: 'Social Media', jobRole: 'Writer', reason: 'Joining' });
    await rejectAccessRequest((await make())._id, 'Not <this> time', admin);
    await requestInfoForAccess((await make())._id, 'Which brand?', admin);
    expect(driver.sent.map((m) => m.subject)).toEqual([
      'Update Regarding Your HACA Forge Access Request',
      'Action Needed: Your HACA Forge Access Request',
    ]);
    for (const mail of driver.sent) {
      expect(mail.to).toBe(`aisha${DOMAIN}`);
      expect(mail.html).toContain('HACA FORGE');
      expect(mail.html).toContain('Aisha &lt;Noor&gt;');
    }
    expect(driver.sent[0].html).toContain('Not &lt;this&gt; time');
  });

  it('notification emails use the shared template and honor the email setting', async () => {
    const recipient = { _id: worker._id, name: worker.name, email: worker.email };
    const sent = await sendNotificationEmail({
      recipient,
      type: 'overdue',
      title: 'Overdue: Ramadan reel',
      message: '"Ramadan reel" is now overdue.',
      itemName: 'Ramadan reel',
      link: '/work/abc',
    });
    expect(sent.sent).toBe(true);
    expect(driver.sent).toHaveLength(1);
    expect(driver.sent[0].subject).toBe('Overdue: Ramadan reel');
    expect(driver.sent[0].html).toContain('href="http://localhost:5173/work/abc"');
    expect(driver.sent[0].html).toContain('Open in HACA Forge');

    await Person.updateOne({ _id: worker._id }, { $set: { 'notificationPrefs.deadlinesOverdue.email': false } });
    const skipped = await sendNotificationEmail({ recipient, type: 'overdue', title: 'Overdue: x', message: 'm', link: '/work/x' });
    expect(skipped).toEqual({ sent: false, reason: 'turned_off' });
    expect(driver.sent).toHaveLength(1);
    await Person.updateOne({ _id: worker._id }, { $set: { 'notificationPrefs.deadlinesOverdue.email': true } });
  });

  it('automation and blocker emails go through sendNotificationEmail', () => {
    for (const rel of ['src/modules/automation/runner.js', 'src/modules/blockers/service.js']) {
      const src = fs.readFileSync(path.join(API_ROOT, rel), 'utf8');
      expect(src).toContain('sendNotificationEmail(');
      expect(src).not.toMatch(/enqueueEmail\(|sendMail\(/);
    }
  });

  // -------------------------------------------------------------------------------------------------

  describe('Phone verification by email OTP', () => {
    const phone = '+919812340001';
    const send = (body = { phone }) => request(app).post('/api/me/phone-otp/send').set('Authorization', `Bearer ${workerToken}`).send(body);
    const verify = (otp, p = phone) => request(app).post('/api/me/phone-otp/verify').set('Authorization', `Bearer ${workerToken}`).send({ phone: p, otp });

    beforeEach(async () => {
      await PhoneVerification.deleteMany({ userId: worker._id });
    });

    it('send goes to the registered email (not SMS) with the masked email in the answer', async () => {
      const res = await send();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        channel: 'email',
        sentTo: 'm•••@email-smtp-test.com',
        message: 'We sent a 6-digit code to m•••@email-smtp-test.com',
        resendAfterSeconds: 60,
      });
      expect(driver.sent).toHaveLength(1);
      const mail = driver.sent[0];
      expect(mail.to).toBe(worker.email);
      expect(mail.subject).toBe('Verify your phone number for HACA Forge');
      expect(mail.subject).not.toContain('123456');
      expect(mail.html).toContain('123456');
      expect(mail.html).toContain('+••••••••0001');
      expect(mail.text).toContain('1 2 3 4 5 6');

      const record = await PhoneVerification.findOne({ userId: worker._id, phone });
      expect(record.channel).toBe('email');
      expect(record.attempts).toBe(0);
      expect(record.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    });

    it('verify, then saving the profile stores the phone with verifiedVia "email"', async () => {
      await send();
      const res = await verify('123456');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ verified: true, verifiedVia: 'email' });

      const save = await request(app)
        .patch('/api/me/profile')
        .set('Authorization', `Bearer ${workerToken}`)
        .send({ phone, phoneVerificationToken: res.body.verificationToken });
      expect(save.status).toBe(200);
      expect(save.body.data.phone).toBe(phone);
      expect(save.body.data.phoneVerifiedVia).toBe('email');
      const saved = await Person.findById(worker._id);
      expect(saved.phone).toBe(phone);
      expect(saved.phoneVerified).toBe(true);
      expect(saved.phoneVerifiedVia).toBe('email');
    });

    it('a wrong code is refused and counts an attempt', async () => {
      await send();
      const res = await verify('999999');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_OTP');
      expect((await PhoneVerification.findOne({ userId: worker._id, phone })).attempts).toBe(1);
    });

    it('an expired code is refused', async () => {
      await send();
      await PhoneVerification.updateOne({ userId: worker._id, phone }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
      const res = await verify('123456');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('OTP_EXPIRED');
    });

    it('after 5 wrong codes even the right code is refused', async () => {
      await send();
      for (let i = 0; i < 5; i += 1) expect((await verify('999999')).body.code).toBe('INVALID_OTP');
      const res = await verify('123456');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('MAX_ATTEMPTS_EXCEEDED');
    });

    it('a second code inside the minute is refused with the wait time; after it, sending works', async () => {
      expect((await send()).status).toBe(200);
      const again = await send();
      expect(again.status).toBe(429);
      expect(again.body.code).toBe('OTP_COOLDOWN');
      expect(again.body.error.details.retryAfterSeconds).toBeGreaterThan(50);
      expect(driver.sent).toHaveLength(1);

      resetEmailThrottle(); // the minute has passed
      expect((await send()).status).toBe(200);
      expect(driver.sent).toHaveLength(2);
    });

    it('when the email cannot be sent: the friendly 503, no code left behind, no cooldown', async () => {
      setEmailDriver(recordingDriver({ failTimes: 5 }));
      const res = await send();
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('EMAIL_SEND_FAILED');
      expect(res.body.error.message).toBe("We couldn't send the email. Try again.");
      expect(await PhoneVerification.countDocuments({ userId: worker._id, phone })).toBe(0);

      setEmailDriver(driver);
      expect((await send()).status).toBe(200); // can try again at once
    });

    it('the code is no longer written to the logs', () => {
      const src = fs.readFileSync(path.join(API_ROOT, 'src/modules/profile/service.js'), 'utf8');
      const emailPath = src.slice(src.indexOf('export async function sendPhoneOtp'), src.indexOf('function sendPhoneOtpBySms'));
      expect(emailPath).not.toMatch(/logger\.\w+\([^)]*otp/);
      expect(emailPath).not.toContain('console.log');
    });
  });
});

describe('Dev-only email previews', () => {
  it('/api/dev/emails lists every template (subject, html, text) outside production', async () => {
    const res = await request(app).get('/api/dev/emails');
    expect(res.status).toBe(200);
    expect(res.body.data.map((e) => e.name)).toEqual(TEMPLATE_NAMES);
    for (const email of res.body.data) {
      expect(email.subject).toBeTruthy();
      expect(email.html).toContain('HACA FORGE');
      expect(email.text).toContain('HACA FORGE');
    }
  });

  it('is not mounted when NODE_ENV=production', async () => {
    const prodApp = express();
    expect(mountDevRoutes(prodApp, { NODE_ENV: 'production' })).toBe(false);
    const res = await request(prodApp).get('/api/dev/emails');
    expect(res.status).toBe(404);

    const devApp = express();
    expect(mountDevRoutes(devApp, { NODE_ENV: 'development' })).toBe(true);
    expect((await request(devApp).get('/api/dev/emails')).status).toBe(200);
  });
});
