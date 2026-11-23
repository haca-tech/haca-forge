// The one email module (docs/EMAIL.md). Every email the app sends goes through here:
//   sendEmail({ to, template, data })   render a template and deliver it (retry once, never throws)
//   sendEmailOrFail(...)                same, but throws EMAIL_SEND_FAILED (503) when both tries fail
//   deliver({ to, subject, html, text }) deliver an already-rendered message
// plus a per-recipient throttle for codes and resets, and the startup connection check.

import { env } from '../../config/env.js';
import { logger } from '../logger.js';
import { createDriver } from './drivers.js';
import { renderTemplate } from './templates.js';

export { renderTemplate, TEMPLATES, TEMPLATE_NAMES, maskEmail, maskPhone } from './templates.js';
export { escapeHtml } from './layout.js';

export const EMAIL_SEND_FAILED_MESSAGE = "We couldn't send the email. Try again.";
export const DEFAULT_FROM = 'HACA Forge <no-reply@localhost>';

let driver = null;
let retryDelayMs = 1500;

export function getDriver() {
  if (!driver) driver = createDriver(env.EMAIL_DRIVER, env, { logger });
  return driver;
}

/** Tests: swap in a driver (a console driver with a spy, or an SMTP driver on a mocked transport). */
export function setEmailDriver(next) {
  driver = next;
}

/** Tests: shorten the pause before the one retry. */
export function setRetryDelay(ms) {
  retryDelayMs = ms;
}

export function templateContext() {
  return { appUrl: env.FRONTEND_URL, logoUrl: env.EMAIL_LOGO_URL || '' };
}

export function renderEmail(name, data) {
  return renderTemplate(name, data, templateContext());
}

/** Safe fields of a send error. Never the transport config, so never the SMTP password. */
export function describeError(err) {
  return {
    message: err?.message,
    code: err?.code,
    responseCode: err?.responseCode,
    command: err?.command,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deliver a rendered message. Tries once, and again after a short pause when that fails
 * (`retries: 0` for the BullMQ worker, which retries the job itself). Never throws.
 * @returns {Promise<{ok:true, messageId:string}|{ok:false, error:string}>}
 */
export async function deliver({ to, subject, html, text, template }, { retries = 1 } = {}) {
  const from = env.EMAIL_FROM || DEFAULT_FROM;
  let lastError = null;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      const info = await getDriver().send({ from, to, subject, html, text });
      return { ok: true, messageId: info?.messageId };
    } catch (err) {
      lastError = err;
      logger.warn({ err: describeError(err), to, subject, template, attempt }, 'Email send failed');
      if (attempt <= retries) await sleep(retryDelayMs);
    }
  }
  logger.error({ err: describeError(lastError), to, subject, template }, 'Email not sent');
  return { ok: false, error: lastError?.message || 'Email send failed' };
}

/** Render a template and deliver it. Never throws; check `ok`. */
export async function sendEmail({ to, template, data, subject }, options) {
  let rendered;
  try {
    rendered = renderEmail(template, data);
  } catch (err) {
    logger.error({ err: err.message, template }, 'Email template failed to render');
    return { ok: false, error: err.message };
  }
  return deliver({ to, subject: subject || rendered.subject, html: rendered.html, text: rendered.text, template }, options);
}

export function emailSendFailedError() {
  const error = new Error(EMAIL_SEND_FAILED_MESSAGE);
  error.statusCode = 503;
  error.code = 'EMAIL_SEND_FAILED';
  return error;
}

/** sendEmail for codes and resets: throws EMAIL_SEND_FAILED (503) when both tries fail. */
export async function sendEmailOrFail(message, options) {
  const result = await sendEmail(message, options);
  if (!result.ok) throw emailSendFailedError();
  return result;
}

// ---- Throttle: at most one code or reset email per recipient per type per minute ----------------

export const THROTTLE_WINDOW_MS = 60_000;
const lastSentAt = new Map();

const throttleKey = (type, to) => `${type}:${String(to || '').toLowerCase().trim()}`;

/** @returns {{allowed:boolean, retryAfterSeconds:number}} */
export function checkEmailThrottle(type, to, now = Date.now()) {
  const last = lastSentAt.get(throttleKey(type, to));
  if (last && now - last < THROTTLE_WINDOW_MS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((THROTTLE_WINDOW_MS - (now - last)) / 1000) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Record a sent code or reset (only after it was actually sent, so a failure can be retried at once). */
export function recordEmailSent(type, to, now = Date.now()) {
  for (const [key, at] of lastSentAt) {
    if (now - at >= THROTTLE_WINDOW_MS) lastSentAt.delete(key);
  }
  lastSentAt.set(throttleKey(type, to), now);
}

export function resetEmailThrottle() {
  lastSentAt.clear();
}

// ---- Startup ---------------------------------------------------------------------------------------

/** Check the SMTP connection once at start and log the result (host and port only, no secrets). */
export async function verifyEmailOnStartup() {
  if (env.EMAIL_DRIVER === 'console') {
    if (env.NODE_ENV === 'production') {
      logger.warn('Email: EMAIL_DRIVER=console in production, so emails are logged and not sent');
    } else {
      logger.info('Email: console driver (emails are logged, not sent)');
    }
    return { ok: true, driver: 'console' };
  }
  try {
    await getDriver().verify();
    logger.info({ host: env.SMTP_HOST, port: env.SMTP_PORT }, 'Email: SMTP connection verified');
    return { ok: true, driver: env.EMAIL_DRIVER };
  } catch (err) {
    logger.error({ err: describeError(err), host: env.SMTP_HOST, port: env.SMTP_PORT }, 'Email: SMTP connection check failed');
    return { ok: false, driver: env.EMAIL_DRIVER, error: err?.message };
  }
}
