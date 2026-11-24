// Email drivers (docs/EMAIL.md). Each driver has the same shape:
//   name: string
//   send({ from, to, subject, html, text }) -> Promise<{ messageId }>
//   verify() -> Promise<void>   (throws when the connection or login fails)
// EMAIL_DRIVER picks one. Nothing outside lib/email talks to a driver directly.

import nodemailer from 'nodemailer';
import { Resend } from 'resend';

const PREVIEW_CHARS = 280;

/** "console": logs recipient, subject and a short preview of the text. Sends nothing. */
export function createConsoleDriver({ logger }) {
  return {
    name: 'console',
    async send({ from, to, subject, text }) {
      const preview = String(text || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_CHARS);
      logger.info({ to, from, subject }, `📨 [EMAIL (console)] To: ${to} | Subject: ${subject} | ${preview}`);
      return { messageId: `console-${Date.now()}` };
    },
    async verify() {},
  };
}

/**
 * "smtp": Nodemailer over SMTP (Gmail with an app password for now).
 * `createTransport` is injectable so tests use a mocked transport and never open a socket.
 */
export function createSmtpDriver({ host, port, secure, user, pass }, { createTransport = nodemailer.createTransport } = {}) {
  const transport = createTransport({
    host,
    port: Number(port),
    secure: secure === true || secure === 'true',
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return {
    name: 'smtp',
    async send(message) {
      const info = await transport.sendMail(message);
      return { messageId: info?.messageId };
    },
    async verify() {
      await transport.verify();
    },
  };
}

/**
 * "resend": Resend API email driver using the official Resend SDK.
 * `client` is injectable so tests can pass a mock client and avoid network calls.
 */
export function createResendDriver({ apiKey, from: defaultFrom }, { client = null } = {}) {
  const resend = client || (apiKey ? new Resend(apiKey) : null);
  return {
    name: 'resend',
    async send({ from, to, subject, html, text }) {
      if (!resend) throw new Error('Resend is not initialized: RESEND_API_KEY is missing');
      const recipient = Array.isArray(to) ? to : [to];
      const { data, error } = await resend.emails.send({
        from: from || defaultFrom,
        to: recipient,
        subject,
        html,
        text,
      });
      if (error) {
        throw new Error(error.message || 'Resend failed to send email');
      }
      return { messageId: data?.id };
    },
    async verify() {
      if (!apiKey) throw new Error('RESEND_API_KEY is missing');
      if (!resend) throw new Error('Resend client could not be created');
      const { error } = await resend.domains.list();
      if (error && error.statusCode === 401) {
        throw new Error(`Resend verification failed: ${error.message}`);
      }
    },
  };
}

export function createDriver(name, settings, deps) {
  switch (name) {
    case 'smtp':
      return createSmtpDriver(
        { host: settings.SMTP_HOST, port: settings.SMTP_PORT, secure: settings.SMTP_SECURE, user: settings.SMTP_USER, pass: settings.SMTP_PASS },
        deps
      );
    case 'resend':
      return createResendDriver(
        { apiKey: settings.RESEND_API_KEY, from: settings.EMAIL_FROM },
        deps
      );
    case 'console':
    default:
      return createConsoleDriver(deps);
  }
}
