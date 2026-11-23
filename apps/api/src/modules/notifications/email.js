// Notification emails (overdue, blocked, reminders) through the shared "notification" template.
// They honor the recipient's email setting for the notification's category
// (Settings → Notifications), which the email footer links to.

import { User } from '../people/model.js';
import { enqueueEmail } from '../../lib/queue.js';
import { logger } from '../../lib/logger.js';
import { resolveNotificationCategory } from './service.js';

/**
 * @param {object} o
 * @param {{_id:any, name?:string, email?:string, notificationPrefs?:object}} o.recipient
 * @param {string} o.type      notification type; picks the settings category (security is always sent)
 * @param {string} o.title     heading, and the subject unless `subject` is given
 * @param {string} [o.subject]
 * @param {string} o.message
 * @param {string} [o.itemName]
 * @param {string} [o.link]    app path such as /work/123; becomes the "Open in HACA Forge" button
 */
export async function sendNotificationEmail({ recipient, type, title, subject, message, itemName, link }) {
  try {
    if (!recipient?.email) return { sent: false, reason: 'no_email' };
    const category = resolveNotificationCategory(type);
    if (category !== 'security') {
      let prefs = recipient.notificationPrefs;
      if (prefs === undefined && recipient._id) {
        const user = await User.findById(recipient._id).select('notificationPrefs').lean();
        prefs = user?.notificationPrefs;
      }
      if (prefs?.[category]?.email === false) return { sent: false, reason: 'turned_off' };
    }
    const result = await enqueueEmail({
      to: recipient.email,
      template: 'notification',
      context: { name: recipient.name, title, subject, message, itemName, url: link },
    });
    return { sent: Boolean(result.success), mode: result.mode };
  } catch (err) {
    logger.warn({ err: err.message, type }, 'Notification email not sent');
    return { sent: false, reason: 'error' };
  }
}
