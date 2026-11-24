import cron from 'node-cron';
import { logger } from './logger.js';
import {
  runOverdueEscalationJob,
  runTodoEscalationJob,
  runBlockerAlertsJob,
  runRevisionPatternFlagJob,
  runPauseRemindersJob,
} from '../modules/jobs/processors.js';

export const SCHEDULER_TIMEZONE = 'Asia/Kolkata';

export const SCHEDULED_TASKS = [
  {
    name: 'overdue_escalation',
    schedule: '*/15 * * * *',
    runner: runOverdueEscalationJob,
    description: 'Overdue task escalation (every 15 minutes)',
  },
  {
    name: 'todo_escalation',
    schedule: '0 9 * * *',
    runner: runTodoEscalationJob,
    description: 'Stale todo escalation (daily at 9:00 AM IST)',
  },
  {
    name: 'blocker_dependency_alert',
    schedule: '0 10 * * *',
    runner: runBlockerAlertsJob,
    description: 'Blocker dependency alert (daily at 10:00 AM IST)',
  },
  {
    name: 'revision_pattern_flag',
    schedule: '0 * * * *',
    runner: runRevisionPatternFlagJob,
    description: 'Revision pattern flag (hourly at minute 0)',
  },
  {
    name: 'pause_reminders',
    schedule: '0 * * * *',
    runner: runPauseRemindersJob,
    description: 'Pause request reminders (hourly at minute 0)',
  },
];

let isStarted = false;
const activeCronJobs = [];
const runningJobs = new Set();

/**
 * Execute a scheduled job guarded against overlapping runs.
 * If the previous execution of this job is still running, the new trigger is skipped.
 *
 * @param {string} name - Name of the task
 * @param {Function} runner - Async executor function
 * @returns {Promise<{ status: string, durationMs?: number, result?: any, error?: string, reason?: string }>}
 */
export async function executeGuardedJob(name, runner) {
  if (runningJobs.has(name)) {
    logger.warn({ job: name }, `[Scheduler] Job execution skipped: previous run of "${name}" is still in progress`);
    return { status: 'skipped', reason: 'already_running' };
  }

  runningJobs.add(name);
  const start = Date.now();
  logger.info({ job: name }, `[Scheduler] Starting scheduled job: ${name}`);

  try {
    const result = await runner({ id: `cron-${Date.now()}`, name });
    const durationMs = Date.now() - start;
    logger.info({ job: name, durationMs }, `[Scheduler] Successfully finished job: ${name}`);
    return { status: 'completed', durationMs, result };
  } catch (err) {
    const durationMs = Date.now() - start;
    logger.error({ job: name, durationMs, err: err.message }, `[Scheduler] Error during scheduled job: ${name}`);
    return { status: 'failed', durationMs, error: err.message };
  } finally {
    runningJobs.delete(name);
  }
}

/**
 * Start all 5 node-cron scheduled jobs.
 * Enforces singleton initialization so it only starts once per application process.
 *
 * @param {object} [options]
 * @param {boolean} [options.runInitialSweep=true] - Whether to trigger an immediate non-blocking sweep of all jobs
 * @returns {Promise<boolean>} - True if started, false if already running
 */
export async function startScheduler({ runInitialSweep = true } = {}) {
  if (isStarted) {
    logger.info('[Scheduler] Scheduler is already initialized');
    return false;
  }
  isStarted = true;

  logger.info({ timezone: SCHEDULER_TIMEZONE }, '🕒 Initializing node-cron scheduler...');

  for (const task of SCHEDULED_TASKS) {
    const cronJob = cron.schedule(
      task.schedule,
      () => {
        executeGuardedJob(task.name, task.runner).catch((err) => {
          logger.error({ job: task.name, err: err.message }, '[Scheduler] Unhandled job error');
        });
      },
      {
        timezone: SCHEDULER_TIMEZONE,
      }
    );
    activeCronJobs.push({ name: task.name, cronJob });
    logger.info({ job: task.name, schedule: task.schedule, timezone: SCHEDULER_TIMEZONE }, `[Scheduler] Registered job "${task.name}"`);
  }

  // Non-blocking initial sweep after startup
  if (runInitialSweep) {
    setImmediate(async () => {
      logger.info('[Scheduler] Running initial post-startup sweep for scheduled automations...');
      for (const task of SCHEDULED_TASKS) {
        try {
          await executeGuardedJob(task.name, task.runner);
        } catch (err) {
          logger.error({ job: task.name, err: err.message }, '[Scheduler] Initial sweep job error');
        }
      }
      logger.info('[Scheduler] Initial post-startup sweep complete');
    });
  }

  return true;
}

/**
 * Stop all active cron jobs and reset scheduler state.
 */
export function stopScheduler() {
  if (!isStarted) return;
  logger.info('[Scheduler] Stopping all scheduled cron jobs...');
  for (const { name, cronJob } of activeCronJobs) {
    try {
      cronJob.stop();
    } catch (err) {
      logger.warn({ job: name, err: err.message }, '[Scheduler] Failed to stop cron job cleanly');
    }
  }
  activeCronJobs.length = 0;
  runningJobs.clear();
  isStarted = false;
  logger.info('[Scheduler] Scheduler stopped cleanly');
}

/**
 * Utility for inspection/testing
 */
export function isSchedulerRunning() {
  return isStarted;
}

export function getActiveJobNames() {
  return activeCronJobs.map((j) => j.name);
}
