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
| **Posted by** | Who posts finished work. A new row's Post step goes to the first active poster (inside their calendar limit). Posters own Post steps, so only roles that take steps count: the admin can mark a piece posted but is never a poster. | Roles and people who can own Post steps (SM Manager) |
| **Fallback** | Who decides (reviews, plan approvals, pauses, classify) when nobody in *Plans approved by* or *Work reviewed by* is active and able to act, for example the only named reviewer is suspended or their role changed. The fallback people then see the work in their queues and can decide; their open tabs update at once, and each is told once about the reviews, pause requests and plan rows already waiting there (new work notifies them as it arrives). If the fallback has nobody active either, every active admin is the final fallback, told the same way, and always able to decide. | Roles and people who can review |

Defaults (also used when no settings are stored at all): Ads → Growth Lead; the other calendars → Creative Lead; posters → SM Manager; fallback → Admin.

**What a save does.** Waiting reviews, waiting plan rows and pause requests follow the new settings at once (nothing is copied; queues are read live). Each person who newly receives work is told once, with a count. Steps already in progress keep their owners. A Post step that has **not started** moves to the first poster only when its owner is no longer a poster for that calendar. Every save makes a new version and a History entry with the reason.

**Two admins saving at once.** A save carries the version the card showed. If someone saved that calendar in between, the save is refused with **"Settings changed — reload"** and the card shows the latest settings; nothing is overwritten. Every save gets its own version number.

**Health check.** Saving is blocked while a calendar would have **nobody active who can own Post steps** (posters have no fallback; the admin does not count), or while someone is put in a setting their role cannot do. Approving plans and reviewing are always covered, because active admins are the final fallback: a calendar covered only by the fallback, or only by the admins, gets a warning, not a block. Other warnings: a named person is suspended or invited, or limited to other calendars.

**Person changes are checked too.** Changing someone's role, status or calendar limit (on People & Roles, or from their profile) runs the same health check on every calendar. If the change would leave a calendar without cover, for example suspending its only poster, it is refused and the message names the calendars and settings to fix first, e.g. *"Fix these calendar settings first: Sales Calendar (Posted by)."* Name a replacement there, then make the change. A role, status or limit change and the person's other edits are saved together in one write: if the change is refused, nothing is saved.

**If a calendar has no poster anyway** (an older or hand-edited setting): new rows are still saved, with a note that nobody can post yet. Their Post steps wait without an owner, and when one is reached the holders of the posting roles, every SM Manager and every admin are told it needs an owner. The planner is never made the poster.

---

## 3. Fixed rules (no setting changes these)

1. **Direct messages are private**, the admin included. Only the two people in a DM can read it.
2. **No ranking or comparison.** Nothing lists people's performance side by side, ranks them, or compares one person with another. Team reports show team-level figures; each person's figures are on their own profile.
3. **Nobody decides on their own work**: no approving or sending back your own submitted work, your own plan, plan rows you added or submitted (even in someone else's plan), your own pause request, your own revision flag, your own clips, your own finished step (reopen), or a rating on your own work. This includes the admin.
4. **A rating average needs at least 3 ratings.** Below that it shows "Collecting baseline".
5. **Workers see only their own work.** Another person's step, profile, ratings or work history answers "not found" to a worker, teammates on the same piece included.
6. **Workers never see other people's contact details** (email, phone, WhatsApp).
7. **There is always at least one active admin.** The last active admin cannot be demoted, suspended or deleted by any route.
8. **Read-only roles can still manage their own account** (profile, settings, password, sign-out).
9. **Suspension is immediate.** The suspended person's next request is refused, their open tabs sign out, and their live connections are closed and cannot reconnect.

These are checked by `apps/api/test/e2e_fixed_rules.test.js`.

---

**Also always true (not settings):**
- Plan rows are decided only while they are waiting (submitted). If two approvers decide the same row at once, the first wins and the other is told it was already decided; the same holds for two reviewers deciding one version.
- A row always belongs to its plan's calendar. To change the calendar, move the whole plan; its waiting work follows.
- Help requests on a step are answered and resolved by the asker, the person asked, the people who review or post on that step's calendar, and admins. Other leads can read them.
- Role and status changes always need a reason and appear in History, whichever screen they are made from.
- **One owner rule.** Every way of giving a step an owner (assigning, reassigning, overriding a suggestion, Work Detail, plan rows) needs an active person who can own that step: production steps by job role, Post steps only a poster on that calendar. Otherwise it is refused with the reason. Owner lists offer only those people; a planned owner who can no longer own the step is dropped when the steps are created (the step waits for an owner).
- **Decisions on several plan rows** are made row by row: if another approver decided one of them first, the others still go through and the screen says so (for example "2 approved, 1 already decided"). An approved row whose steps were never created gets them when its plan is opened (or with `scripts/repair-missing-stages.js`).
- In the plan grid, rows you added or submitted show "Yours" and have no approve or send-back controls; another approver decides them.

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

**Calendar settings: History → Restore.** Open **Access & Approvals → History**, filter by the calendar, and press **Restore this version** on the entry you want to undo. You get the same health check and preview as a normal save; if someone changes that calendar between the preview and your confirm, the restore is refused with "Settings changed — reload" and nothing changes. Restoring saves a new version, so the restore itself can be undone the same way. Waiting work follows the restored settings at once.

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
- **Live updates.** A person change or a calendar save compares who decides / approves / posts where, and who is responsible for each calendar's work, before and after (`accessConfig/responsibility.js`); everyone whose part changed, fallback people and admins included, gets `access:changed`, and newly responsible people get one `access_rerouted` notice about the waiting work. The tabs reload `/auth/me` (also on reconnect and when the tab regains focus). A role, status or limit change then closes their sockets so they reconnect with the new access.
- **Slots and the fallback.** `slotEligibleRole(role, slot)` (shared) says whether a role can fill a slot: the slot's permission, and for posters also taking steps. The resolver's `peopleFor` keeps only named people who are active, inside their limit and whose *current* role is eligible. `can()` lets the fallback decide when the API resolver sets `primaryInactive` for that slot (it does, in `accessResolver.can`, only when the main list resolves to nobody); `decisionCalendars` and `/auth/me` include such calendars.
- **Person changes.** Role, status and limit are written only by `changePersonAccess`; every route that changes them (`/access-admin/people`, `/team/:id`, `/team/:id/status`, `/people/:id`, `/people/:id/suspend|reactivate`) goes through `savePersonChange` (reason, self and last-admin guards, health check on every calendar).
- **Cache.** Calendar settings are cached per API process, cleared on every save in that process, and re-read after **5 seconds** in any case. A generation counter stops a read that started before a save from putting the old settings back. Saves read the database directly (`readWorkflowConfigFresh`) and write with `findOneAndUpdate({ calendar, version })`. People (role, status, limit) are read on every request, never cached.
- **Several API instances (parked until deployment).** A save on instance A applies to decisions on instance B within 5 seconds (the TTL), and conflicting saves are refused by the version check. The live `access:changed` event, however, only reaches sockets connected to the instance that saved: users connected to another instance see the change when their tab regains focus or reconnects. Sending it across instances needs a shared Socket.IO adapter (Redis); it is not installed (no new dependencies) and is parked until the deployment is decided.
- **Signing out.** An open tab signs out when `/auth/me` answers 401, or 403 for a suspended account (fixed rule 9). A network or server error keeps the user; the next focus, reconnect or `access:changed` tries again.
- **Tests.** `e2e_permission_matrix` (every guarded route × every role; decisions × 5 calendars × owner / non-owner; T1: no route without a guard unless it is in `test/fixtures/unguarded_routes.js` with a reason), `access_parity` (T2: `test/fixtures/route_guard_snapshot.json`, one entry per method + path with its guards and roles; regenerate on purpose with `node apps/api/scripts/snapshot-route-guards.js` and review the diff), `service_only_permissions` (the 12 permissions no route guard checks: every role tries the real action), `e2e_routing_scenarios`, `e2e_fixed_rules`, `e2e_cache_and_rollback`, `access_admin_page`, `final_fix_h_nobody_can_act`, `final_fix_m_routing_and_races`, `final_fix_l_low`.
- **Test database hygiene.** Tests remove the users they create. `node apps/api/scripts/purge-test-users.js` (dry run; `--confirm` to delete) clears leftovers from `marketing_portal_test` and refuses any other database.
- **Not used yet.** `report.configure` and `automation.manage` are in the catalog (admin only), but no route or screen checks them today.
