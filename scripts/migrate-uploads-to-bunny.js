#!/usr/bin/env node
/**
 * Convenience entry point at the repo root:
 *   node scripts/migrate-uploads-to-bunny.js [--confirm] [--db-name=<name>] [--allow-remote]
 * For full documentation, see docs/STORAGE.md and apps/api/scripts/migrate-uploads-to-bunny.js.
 */
import { run } from '../apps/api/scripts/migrate-uploads-to-bunny.js';

run()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
