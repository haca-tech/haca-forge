# Access & Approvals

Who can do what in HACA Marketing OS, who approves and reviews on each calendar, the rules nobody can change, and how to undo a mistake. Admins manage all of this on **Access & Approvals** (`/settings/access`).

---

## 1. The seven roles

Everyone has exactly one role. The roles are fixed: their permissions come from the permission catalog in `packages/shared` and cannot be edited on the page. What you change is **who has which role**, an optional **calendar limit**, and **who approves on each calendar**. The **Role Guide** tab lists every permission of every role.

| Role | In plain words |
|---|---|
| **Admin** | Runs the system: people, roles, access requests, calendar settings, reports and automation. Can step in on any calendar as the fallback approver. Locked: always has every permission. |
| **Creative Head** | Sees everything, changes nothing (read-only), except their own account. |
| **Production Head** | Same as Creative Head: sees all calendars and work, read-only. |
| **Creative Lead** | Reviews work and approves plans on the calendars where they are named (by default every calendar except Ads). Rates approved work (1–5), requests changes, classifies revision causes, manages workers' operational details. |
| **Growth Lead** | The same powers as the Creative Lead; by default on the Ads calendar. |
| **SM Manager** | Plans the calendars, assigns owners and dates, handles blockers, and posts (owns the Post steps and marks them posted with the live link). Does not approve. |
| **Executive** | A production worker (writer, designer, videographer, editor, all-rounder). Works on their own steps and sees only their own work. |

**Calendar limit.** A Creative Lead, Growth Lead or SM Manager can be limited to some calendars. They then review, approve and post only there, and their queues show only those calendars, even if a calendar setting names them elsewhere: **the limit wins**. Roles without calendar-based work (Admin, the heads, Executive) never have a limit.

---

## 2. Calendar settings

Each of the five calendars (SM, Sales, Ads, Academics & Management, Other) has four settings, filled with roles and/or named people:

| Setting | What it decides | Who can be put there |
|---|---|---|
| **Plans approved by** | Who approves or sends back that calendar's plan rows. | Roles and people who can approve plans |
| **Work reviewed by** | Who reviews submitted work (approve with a rating, or request changes), decides pause requests, classifies revision flags, and is offered first in help requests. | Roles and people who can review |
| **Posted by** | Who posts finished work. A new row's Post step goes to the first active poster. | Roles and people who can post |
| **Fallback** | Who decides when nobody in the setting above is active (for example the only named reviewer is suspended). | Roles and people who can review |

Defaults (also used when no settings are stored at all): Ads → Growth Lead; the other calendars → Creative Lead; posters → SM Manager; fallback → Admin.

**What a save does.** Waiting reviews, waiting plan rows and pause requests follow the new settings at once (nothing is copied; queues are read live). Each person who newly receives work is told once, with a count. Steps already in progress keep their owners. A Post step that has **not started** moves to the first poster only when its owner is no longer a poster for that calendar. Every save makes a new version and a History entry with the reason.

**Health check.** Saving is blocked while any calendar would have nobody active to approve plans, review, or post (even counting the fallback), or while someone is put in a setting their role cannot do. Warnings (not blocking): a named person is suspended or invited, a named person is limited to other calendars, or a setting is only covered by the fallback.

---

## 3. Fixed rules (no setting changes these)

1. **Direct messages are private**, the admin included. Only the two people in a DM can read it.
2. **No ranking or comparison.** Nothing lists people's performance side by side, ranks them, or compares one person with another. Team reports show team-level figures; each person's figures are on their own profile.
3. **Nobody decides on their own work**: no approving or sending back your own submitted work, your own plan, your own pause request, or your own revision flag. This includes the admin.
4. **A rating average needs at least 3 ratings.** Below that it shows "Collecting baseline".
5. **Workers see only their own work.** Another person's step or profile answers "not found" to a worker.
6. **Workers never see other people's contact details** (email, phone, WhatsApp).
7. **There is always at least one active admin.** The last active admin cannot be demoted, suspended or deleted by any route.
8. **Read-only roles can still manage their own account** (profile, settings, password, sign-out).
9. **Suspension is immediate.** The suspended person's next request is refused, their open tabs sign out, and their live connections are closed and cannot reconnect.

These are checked by `apps/api/test/e2e_fixed_rules.test.js`.

---

## 4. Changing a reviewer safely

1. Open **Access & Approvals → Calendar Approvals** and find the calendar.
2. Remove or add roles and people in **Work reviewed by** (or another setting). The pickers only offer roles and active people who can do the job.
3. Read the health check on the card. Fix every red problem; read the yellow notes.
4. Read the preview, for example *"Changing Ads Calendar reviewers will re-route 3 waiting reviews and 1 pause request to Amjith."* Check that the named people are the ones you expect.
5. Type a reason and save. Confirm in the dialog.
6. Ask one of the new reviewers to open the Review Hub: the waiting work is already there.

**To take someone off temporarily** (leave, holiday), prefer naming a replacement in the calendar setting, then restore the old version when they return (step 5 below). Suspending a person is for people who leave.

---

## 5. Undoing a bad change

**Calendar settings: History → Restore.** Open **Access & Approvals → History**, filter by the calendar, and press **Restore this version** on the entry you want to undo. You get the same health check and preview as a normal save; restoring saves a new version, so the restore itself can be undone the same way. Waiting work follows the restored settings at once.

**A person's role, status or calendar limit:** open them on **People & Roles** and set it back, with a reason. History shows what it was before.

---

## 6. If no admin can sign in

The last active admin cannot be removed through the app, but a database edit or a forgotten password can still lock everyone out. Recovery is a local script that gives an existing account the admin role and Active status, recorded in History:

```bash
# Dry run: shows what would change, writes nothing
node apps/api/scripts/reactivate-admin.js --email=you@example.com

# Writes
node apps/api/scripts/reactivate-admin.js --email=you@example.com --confirm
```

It refuses to run against anything but a local database (`localhost`, `127.0.0.1`, `::1`; never `mongodb+srv://`) and with `NODE_ENV=production`. For a hosted database, restore a copy locally, run it there, or ask the database owner. It does not change passwords: use "Forgot password" afterwards.

---

## 7. For developers

- **One source of truth.** `packages/shared`: the permission catalog (40 keys), the 7 system roles, the pure `can(user, permission, { calendar, ownerId }, config)`, `SELF_FORBIDDEN_PERMISSIONS` (`review.decide`, `revision.classify`, `calendar.approve`).
- **API.** Route guards: `requirePermission` / `requireAnyPermission` (each guard carries its keys). Calendar decisions: `workItems/deciders.js` (`assertDecidesOn`, `decidersFor`) over `lib/accessResolver.js` (`reviewersFor`, `planApproversFor`, `postersFor`, `recipientsFor`). Role, status and calendar limit are written only by `changePersonAccess`; calendar settings only by `updateWorkflowConfig`.
- **Web.** `useAccess().can(permission, { calendar, ownerId })`; no role names in app code (guard test `NoRoleLiterals`).
- **Live updates.** A change sends `access:changed` to the affected people's sockets; their tabs reload `/auth/me` (also on reconnect and when the tab regains focus). A role, status or limit change then closes their sockets so they reconnect with the new access.
- **Cache.** Calendar settings are cached per API process, cleared on every save in that process, and re-read after **5 seconds** in any case. People (role, status, limit) are read on every request, never cached. **Several API instances:** a save on instance A applies to decisions on instance B within 5 seconds (the TTL). The live `access:changed` event, however, only reaches sockets connected to the instance that saved: users connected to another instance see the change when their tab regains focus or reconnects. Sending it across instances needs a shared Socket.IO adapter (Redis), which is not installed.
- **Tests.** `e2e_permission_matrix` (every guarded route × every role; decisions × 5 calendars × owner / non-owner), `e2e_routing_scenarios`, `e2e_fixed_rules`, `e2e_cache_and_rollback`, `access_admin_page`, `access_parity`.
