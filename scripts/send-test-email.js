#!/usr/bin/env node
/**
 * Convenience entry point at the repo root:
 *   node scripts/send-test-email.js --to=<address> [--template=<name>]
 * Sends one email through the configured driver (EMAIL_DRIVER). See docs/EMAIL.md and
 * apps/api/scripts/send-test-email.js.
 */
import { run } from '../apps/api/scripts/send-test-email.js';

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
