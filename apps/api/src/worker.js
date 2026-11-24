import { connectDB } from './config/db.js';
import { logger } from './lib/logger.js';
import { verifyEmailOnStartup } from './lib/email/index.js';
import { startScheduler, stopScheduler } from './lib/scheduler.js';
import { ensureAutomationRules } from './modules/automation/runner.js';
import { fileURLToPath } from 'url';

/**
 * Standalone background scheduler entrypoint.
 * NOTE: In unified production deployments, the scheduler runs inside the API server (server.js).
 * This standalone runner is provided for backwards compatibility or dedicated scheduler processes.
 */
export async function startWorker() {
  logger.info('🚀 Starting Marketing Portal Standalone Scheduler...');

  // 1. Connect to MongoDB
  await connectDB();

  // 2. Check the email connection once
  await verifyEmailOnStartup();

  // 3. Ensure default automation rules exist
  await ensureAutomationRules();

  // 4. Start node-cron scheduler
  await startScheduler();

  logger.info('✅ Marketing Portal Scheduler running and ready');
}

export async function stopWorker() {
  logger.info('Stopping standalone scheduler...');
  stopScheduler();
  logger.info('Standalone scheduler stopped cleanly');
}

// Auto-run if executed directly as entrypoint
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  startWorker().catch((err) => {
    logger.fatal({ err }, 'Worker fatal startup error');
    process.exit(1);
  });

  process.on('SIGTERM', async () => {
    await stopWorker();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await stopWorker();
    process.exit(0);
  });
}
