import { logger } from './logger.js';
import { deliver, renderEmail } from './email/index.js';

export const QUEUE_NAMES = Object.freeze({
  EMAIL: 'email-direct',
  SCHEDULED: 'scheduled-cron',
});

export const emailQueue = null;
export const scheduledJobsQueue = null;

export function getRedisConnection() {
  return null;
}

export async function initQueues() {
  return true;
}

export function isRedisReady() {
  return false;
}

/**
 * Deliver an email directly via the configured email driver (SMTP / console).
 * Pass a rendered message ({ to, subject, html, text }) or a template ({ to, template, context }).
 * Employs direct delivery with retry. Never throws, ensuring an email error does not crash callers.
 *
 * @param {object} options
 * @param {string} options.to
 * @param {string} [options.subject]
 * @param {string} [options.html]
 * @param {string} [options.text]
 * @param {string} [options.template]
 * @param {object} [options.context]
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string, mode: 'direct' }>}
 */
export async function enqueueEmail({ to, subject, html, text, template, context } = {}) {
  try {
    if (template) {
      try {
        const rendered = renderEmail(template, context || {});
        subject = subject || rendered.subject;
        html = rendered.html;
        text = rendered.text;
      } catch (err) {
        logger.error({ err: err.message, template, to }, 'Email template failed to render');
        return { success: false, error: err.message, mode: 'direct' };
      }
    }

    const result = await deliver({ to, subject, html, text, template });
    if (result.ok) {
      return { success: true, messageId: result.messageId, mode: 'direct' };
    }

    logger.error({ err: result.error, to, subject, template }, 'Direct email delivery failed');
    return { success: false, error: result.error, mode: 'direct' };
  } catch (err) {
    logger.error({ err: err.message, to, subject, template }, 'Unexpected error in email dispatch');
    return { success: false, error: err.message, mode: 'direct' };
  }
}
