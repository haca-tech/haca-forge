import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { deliver, renderEmail } from './email/index.js';

let redisClient = null;
let isRedisAvailable = false;
let emailQueue = null;
let scheduledJobsQueue = null;

const QUEUE_NAMES = {
  EMAIL: 'email-queue',
  SCHEDULED: 'scheduled-jobs-queue',
};

// Initialize Redis connection safely
export function getRedisConnection() {
  if (redisClient) return redisClient;

  try {
    const url = env.REDIS_URL || 'redis://127.0.0.1:6379';
    redisClient = new Redis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      connectTimeout: 2000,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 2) {
          // Stop retrying quickly in local dev without Redis
          return null;
        }
        return Math.min(times * 500, 2000);
      },
    });

    redisClient.on('connect', () => {
      isRedisAvailable = true;
      logger.info('Connected to Redis successfully');
    });

    redisClient.on('error', (err) => {
      isRedisAvailable = false;
      logger.warn({ err: err.message }, 'Redis connection warning - background queue falling back to in-memory/direct mode');
    });
  } catch (err) {
    isRedisAvailable = false;
    logger.warn({ err: err.message }, 'Could not initialize Redis client');
  }

  return redisClient;
}

export async function initQueues() {
  const connection = getRedisConnection();
  if (!connection) return false;

  try {
    await connection.connect();
    isRedisAvailable = true;

    emailQueue = new Queue(QUEUE_NAMES.EMAIL, { connection });
    scheduledJobsQueue = new Queue(QUEUE_NAMES.SCHEDULED, { connection });

    logger.info('BullMQ Queues initialized with Redis backend');
    return true;
  } catch (err) {
    isRedisAvailable = false;
    logger.info({ message: err.message }, 'Redis offline or unreachable; using in-memory direct processing for background jobs');
    return false;
  }
}

export function isRedisReady() {
  return isRedisAvailable;
}

/**
 * Queue an email for the background worker, or deliver it now when Redis is not available.
 * Pass a rendered message ({ to, subject, html, text }) or a template ({ to, template, context }).
 * The worker tries a job twice (once, then one retry); a direct send retries once too. Never throws.
 */
export async function enqueueEmail({ to, subject, html, text, template, context }) {
  if (template) {
    try {
      const rendered = renderEmail(template, context || {});
      subject = subject || rendered.subject;
      html = rendered.html;
      text = rendered.text;
    } catch (err) {
      logger.error({ err: err.message, template }, 'Email template failed to render');
      return { success: false, error: err.message, mode: 'none' };
    }
  }

  if (isRedisAvailable && emailQueue) {
    try {
      const job = await emailQueue.add(
        'send-email',
        { to, subject, html, text, template },
        {
          attempts: 2,
          backoff: { type: 'fixed', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: 100,
        }
      );
      return { success: true, jobId: job.id, mode: 'queued' };
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to enqueue email to BullMQ, sending directly');
    }
  }

  const result = await deliver({ to, subject, html, text, template });
  return result.ok
    ? { success: true, messageId: result.messageId, mode: 'direct' }
    : { success: false, error: result.error, mode: 'direct' };
}

export { QUEUE_NAMES, emailQueue, scheduledJobsQueue };
