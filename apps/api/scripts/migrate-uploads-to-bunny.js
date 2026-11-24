#!/usr/bin/env node
/**
 * apps/api/scripts/migrate-uploads-to-bunny.js (docs/STORAGE.md)
 *
 * Copies every file in apps/api/uploads to Bunny Storage under the same key ("uploads/<path>"),
 * and rewrites stored file values from "/uploads/..." to the storage key "uploads/...".
 * Local files are never deleted.
 *
 *   node scripts/migrate-uploads-to-bunny.js                                   dry run (default): reads only
 *   node scripts/migrate-uploads-to-bunny.js --confirm --db-name=<name>        uploads and updates
 *   Options: --uploads-dir=<path> (default apps/api/uploads), --allow-remote (remote database)
 *
 * Needs the Bunny settings (BUNNY_STORAGE_ZONE, BUNNY_STORAGE_HOST, BUNNY_STORAGE_KEY,
 * BUNNY_CDN_URL, BUNNY_TOKEN_KEY) whatever STORAGE_DRIVER says. Safety:
 *   - a remote database (any host other than localhost / 127.0.0.1 / ::1, every mongodb+srv:// URI)
 *     needs --allow-remote and --db-name equal to the URI's database, even for a dry run;
 *   - --confirm needs --db-name equal to the URI's database;
 *   - refuses a URI without a database name, and marketing_portal_test;
 *   - a file already in Bunny with the same size is skipped, and records already holding keys are
 *     left alone, so a second run changes nothing.
 * Secrets are never printed.
 */
import path from 'path';
import { pathToFileURL } from 'url';
import {
  FILE_FIELDS,
  parseArgs,
  checkTarget,
  run,
} from './migrate-uploads-to-bunny-core.js';

export { FILE_FIELDS, parseArgs, checkTarget, run };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // exitCode, not process.exit(): on Windows, exiting while fetch's sockets are closing can crash Node.
  run()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error(err.message);
      process.exitCode = 1;
    });
}
