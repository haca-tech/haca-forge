// Email drivers (docs/EMAIL.md). Each driver has the same shape:
//   name: string
//   send({ from, to, subject, html, text }) -> Promise<{ messageId }>
//   verify() -> Promise<void>   (throws when the connection or login fails)
// EMAIL_DRIVER picks one. Nothing outside lib/email talks to a driver directly.

import nodemailer from 'nodemailer';

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
 * "resend": not built yet. To add it later: install the `resend` package, read RESEND_API_KEY in
 * config/env.js (and require it in emailSettingsProblems), and return
 *   { name: 'resend', send: (m) => resend.emails.send(m).then((r) => ({ messageId: r.data?.id })), verify: async () => {} }
 * here. Startup refuses EMAIL_DRIVER=resend until then, so this is never reached.
 */
export function createResendDriver() {
  throw new Error('The resend email driver is not built yet (see docs/EMAIL.md).');
}

export function createDriver(name, settings, deps) {
  switch (name) {
    case 'smtp':
      return createSmtpDriver(
        { host: settings.SMTP_HOST, port: settings.SMTP_PORT, secure: settings.SMTP_SECURE, user: settings.SMTP_USER, pass: settings.SMTP_PASS },
        deps
      );
    case 'resend':
      return createResendDriver(settings, deps);
    case 'console':
    default:
      return createConsoleDriver(deps);
  }
}
