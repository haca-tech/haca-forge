#!/usr/bin/env node
/**
 * apps/api/scripts/setup-fresh-database.js
 *
 * Prepares an EMPTY database (for example a new MongoDB Atlas database) for the app. It creates
 * only:
 *   - the app's collections and their indexes;
 *   - the admin account (ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD);
 *   - the departments, the automation (reminder) rules, and the approval settings of the
 *     5 calendars (their defaults);
 *   - the Team Chat channel, with the admin as its only member.
 * No other users and no demo data.
 *
 *   node scripts/setup-fresh-database.js                                 dry run (default): reads only
 *   node scripts/setup-fresh-database.js --confirm --db-name=<name>       writes (local database)
 *   node scripts/setup-fresh-database.js --allow-remote --db-name=<name>  dry run on a remote database
 *   node scripts/setup-fresh-database.js --allow-remote --confirm --db-name=<name>   writes (remote)
 *
 * The database is the one named in MONGODB_URI (from apps/api/.env or the environment); nothing
 * else is touched. Safety:
 *   - refuses a URI without a database name, and marketing_portal_test;
 *   - a remote host (anything but localhost / 127.0.0.1 / ::1, every mongodb+srv:// URI) needs
 *     --allow-remote and --db-name equal to the URI's database, even for a dry run;
 *   - --confirm needs --db-name equal to the URI's database;
 *   - refuses unless the database is empty: no users, no plans, no work items. The one exception
 *     is a database this script already set up (its only user is the configured admin, no plans,
 *     no work items): every step only inserts what is missing, so a second run changes nothing;
 *   - prints the host and the database before anything is written. A dry run writes nothing (no
 *     collection or index is created when the models load).
 */
import path from 'path';
import { pathToFileURL } from 'url';
import {
  REFUSED_DATABASES,
  parseArgs,
  hostsOf,
  isLocalUri,
  dbNameOf,
  checkTarget,
  run,
} from './setup-fresh-database-core.js';

export {
  REFUSED_DATABASES,
  parseArgs,
  hostsOf,
  isLocalUri,
  dbNameOf,
  checkTarget,
  run,
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
