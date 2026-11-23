# Setting up a fresh database (MongoDB Atlas)

How to prepare a new, empty database for HACA Marketing OS with `apps/api/scripts/setup-fresh-database.js`. The script is for an **empty** database only. It never wipes, migrates or edits existing data.

---

## What it creates

| What | Records |
|---|---|
| The app's collections and their indexes | 32 collections, all empty except those below |
| The admin account | 1 user, from `ADMIN_SEED_EMAIL` / `ADMIN_SEED_PASSWORD` (role Admin, Active, Tech department) |
| Departments | 7: Design, Video Production, Social Media, SEO & Content, WhatsApp, Performance Marketing, Tech |
| Automation (reminder) rules | 5: overdue_escalation, todo_escalation, blocker_dependency_alert, revision_pattern_flag, pause_reminders |
| Calendar approval settings | 5, the defaults. Ads: reviewed and approved by the Marketing Growth Manager. SM, Sales, Academics & Management and Other: the Creative Manager. Posted by the SM Manager on every calendar. Fallback: Admin. |
| Team Chat | 1 channel, with the admin as its only member |

Nothing else: no other users and no demo plans or work. Add people afterwards in the app (Access Requests, or Access & Approvals → People & Roles).

The app has no separate "settings" collection. Its settings are the calendar approval settings and the automation rules above. Each person's own settings are created when they first save them.

---

## Before you start

1. **Create the database user and network access in Atlas.** Allow your current IP address.
2. **Pick a database name**, for example `haca_marketing`. Put it in the connection string, after the host. Atlas's copied string usually has no name there, and the script refuses one without it.
3. **Set the variables** for the run, in `apps/api/.env` or in your shell:

   ```bash
   MONGODB_URI=mongodb+srv://<user>:<password>@<cluster>.mongodb.net/haca_marketing?retryWrites=true&w=majority
   ADMIN_SEED_EMAIL=<the admin's email>
   ADMIN_SEED_PASSWORD=<a strong password, at least 8 characters>
   JWT_SECRET=<32+ characters>            # the API's config needs these to load
   JWT_REFRESH_SECRET=<32+ characters>
   ```

   Your shell's values take precedence over `.env`. If you set them only for this run, your local `.env` (which points at your local database) stays as it is.

---

## Run it

From the repository root:

```bash
# 1. Dry run: connects, reads, prints the plan. Writes nothing (no collection or index is created).
node apps/api/scripts/setup-fresh-database.js --allow-remote --db-name=haca_marketing

# 2. Read the output: Host and Database must be the Atlas cluster and the name you chose.

# 3. Set it up.
node apps/api/scripts/setup-fresh-database.js --allow-remote --confirm --db-name=haca_marketing
```

Both runs print the host (never the credentials) and the database first. The write run ends with the record counts.

Then sign in to the app, pointed at this database, with the admin email and password. Change the password in Settings if it was shared to run the script.

---

## Safety checks

The script refuses, and writes nothing, when:

- the database is **not empty**: it has any user, plan or work item. The one exception is a database this script already set up (its only user is the configured admin, with no plans or work items). Every step only adds what is missing, so **running it a second time changes nothing**, and the admin's password is never reset.
- the host is **remote** (any `mongodb+srv://` URI, or any host other than `localhost` / `127.0.0.1` / `::1`) without `--allow-remote` **and** `--db-name` equal to the database in the URI. This applies to the dry run too.
- `--confirm` is given without a matching `--db-name`.
- the URI names **no database**, or names `marketing_portal_test`.
- `ADMIN_SEED_EMAIL` is missing, or `ADMIN_SEED_PASSWORD` is missing when the admin still has to be created.

It connects only to the database named in the URI and touches no other.

---

## Local use

On your own machine (a new, empty local database), `--allow-remote` is not needed:

```bash
MONGODB_URI=mongodb://127.0.0.1:27017/haca_fresh node apps/api/scripts/setup-fresh-database.js
MONGODB_URI=mongodb://127.0.0.1:27017/haca_fresh node apps/api/scripts/setup-fresh-database.js --confirm --db-name=haca_fresh
```

Your existing `marketing_portal` database has users, so the script refuses it. The other local scripts (`reset-and-seed.js`, `seed-workflow-config.js`, `reactivate-admin.js`, `migrate-roles.js`) keep their local-only rules and still refuse Atlas.

---

## Notes

- On start the API creates the admin from `ADMIN_SEED_EMAIL` when that account is missing, except with `NODE_ENV=production`. The API also adds the automation rules when they are missing. Both match what this script creates, so they add nothing after it.
- Mongoose prints `Duplicate schema index on {"status":1}` while loading the models. It comes from an existing model definition. It is harmless (the index is created once) and not caused by this script.
- Tests: `apps/api/test/setup_fresh_database.test.js` runs the script against disposable local databases.
