# HACA Marketing OS — Master Project Context

**Current as of:** 10 November 2026 (after Phase 11)  
**Repository:** HACA Marketing OS (`haca-forge`)  
**Technology Stack:** Node 22 LTS, Express 5 (ESM), React 18, Vite 6, TypeScript, Tailwind CSS, MongoDB (Mongoose), Socket.io, BullMQ (Redis).  
**Test Suite Status:** **1765 tests passing across 118 test files (0 failures)**  
- `@mmp/api`: 1427 tests passed across 71 test files  
- `@mmp/web`: 338 tests passed across 47 test files  
- The API tests set their own test-only JWT secrets (`apps/api/vitest.config.js`), so a fresh checkout passes with no `.env`.  

---

## 1. Who and What

- **Owner & Developer:** Mubashir (Mubashir PP), MERN developer at HACA, founder of Orvynlabs. Prefers direct, actionable output, exact prompts, and code blocks over long conversational explanations.
- **Product:** HACA Marketing OS (formerly FORGE / Media Manager). Internal creative and marketing operations portal for HACA's in-house team to plan, assign, produce, review, publish, and track creative deliverables (Reels and 14 design types) across 5 creative calendars.
- **Stakeholders:** Abu Nabhan (Marketing Head), Social Media Manager, Creative Lead, and the internal creative/production team.
- **Operating Model:** Antigravity (AI IDE agent in Planning mode) writes and executes code. Claude / Assistant drafts specifications, diagnostics, and exact pasteable prompts following `PROMPT_STYLE_GUIDE.md`. One phase per session, verified with tests before advancing.

---

## 2. Working Agreement & Rules of Engagement

1. **Exact Pasteable Prompts:** Prompts must follow `PROMPT_STYLE_GUIDE.md` (`CONTEXT`, `STEP 1: INVESTIGATE`, `STEP 2: BUILD`, `TESTS`, `CONSTRAINTS`, `ACCEPTANCE CRITERIA`, `DELIVERABLES`).
2. **Investigate Before Changing:** Bug and change prompts must inspect files, confirm line numbers, and report root causes before proposing edits.
3. **Precondition & Verification Gate:** Every phase starts and ends with `npm install`, `npm run typecheck`, `npm run build`, and test suite execution. Record test counts in `docs/PROGRESS.md`.
4. **Strict Guardrails:**
   - **Zero ranking / leaderboards:** No comparing workers, no speed rankings, no incentive-linked performance metrics.
   - **No hour-based automated escalations:** All timers and measurements are display-only.
   - **Worker individual timing:** Timing counts from each worker's own `startedAt` (no shared clocks, no countdowns).
   - **Privacy isolation:** `executive` cannot harvest data or view other workers' profiles (`HTTP 404`). Creative Heads have read-only access with contact information redacted.
5. **Zero New Dependencies:** Strictly no unapproved npm packages.
6. **Data Safety:** Destructive scripts must have `--confirm` flags, dry-run by default, run only locally, and back up data outside the repository first.

---

## 3. History of Scope & Decisions

1. **Original FORGE:** Intake-and-pipeline portal for other departments. 8 roles. Removed.
2. **HACA Marketing OS Spec V1:** Campaigns, monthly targets, LSQ lead funnel, 7 brand profiles.
3. **Major Scope Reset (23 Oct 2026):**
   - **Completely removed:** Leads, LSQ, funnel, Data Center, Campaigns, Monthly Targets, multi-brand profiles, attendance/leave, file libraries.
   - Portal manages **work and team only**.
   - 5 canonical roles: `admin`, `creative_lead`, `sm_manager`, `creative_head`, `executive`.
4. **Creative Calendar & HACA-Only:** Single-brand system. 5 calendars (`sm`, `sales`, `ads`, `academics_management`, `other`). Step deadlines ($F-8$, $F-5$, $F-2$, $F$).
5. **Role Workspaces:** Writing Studio, Review Studio, clip-by-clip Shoot Workspace, Edit/Design/Post Workspaces.
6. **Individual Timing:** Removed shared clocks. Timing counts from each worker's own `startedAt`.
7. **Team Directory & Worker Profile:** `/team` and `/team/:id` for leadership; `/profile` for self-view.
8. **Phase PE (Profile Edit & Mobile OTP Verification):**
   - Mandatory `/welcome` gate removed; users enter directly into `/my-work` or `/dashboard`.
   - Edit Profile modal with avatar crop at `/profile` and `/team/:id`.
   - Registered email locked for users; editable only by Administrator.
   - Mobile phone number verified via 6-digit SMS OTP (`POST /api/me/phone-otp/send`, `POST /api/me/phone-otp/verify`).

---

## 4. Current Product Definition

### 4.1 Roles & Permissions (7 roles; Access Phases B–E)
**Full reference: [ACCESS.md](ACCESS.md)** (roles in plain words, calendar settings, fixed rules, safe changes, recovery). Access comes from one resolver: the permission catalog and the 7 fixed system roles in `@mmp/shared`, plus per-calendar settings (who approves plans, reviews, posts, and the fallback) that admins edit on **Access & Approvals** (`/settings/access`). Code asks for permissions (`can(permission, { calendar, ownerId })`), never role names; guard tests enforce it. Two keys were reused in Phase 12b: `creative_head` is read-only leadership and `executive` is a production worker; `team_member` no longer exists.

| Role Key | Title | Core Powers & Screen Permissions |
|---|---|---|
| `admin` | Admin | Full platform control: users, invites, access approvals, role grants, suspensions, password resets, forced logouts. Also approves and reviews any calendar as a backup. Only role with `report.configure` and `automation.manage`. |
| `creative_head` | Creative Head | Views everything, read-only: every write is refused (`HTTP 403 READ_ONLY_ROLE`) except their own account (sign-out, password, own profile and settings, notification and chat read markers). Sees contact details and review text (revision notes, rating feedback, clip threads). Cannot comment, rate or decide. |
| `production_head` | Production Head | Same access as Creative Head: views all calendars and works, read-only. |
| `creative_lead` | Creative Lead | Approves plan rows, reviews steps (mandatory 1–5 rating on approval), requests changes, reopens, classifies root causes. Manages workers' operational fields (job role, preferences, capacity, department). Views and downloads profile reports. Decides on the calendars where the calendar settings name them (default: every calendar except Ads). |
| `growth_lead` | Growth Lead | Same powers as Creative Lead, on the calendars where named (default: Ads); other calendars stay view-only. |
| `sm_manager` | SM Manager | Main planner: plans, owners, deadlines, reschedules, blockers. Owns every Post step and marks it posted with its live link. Cannot approve. |
| `executive` | Executive | Production worker (was `team_member`, unchanged access, including the 404s): works their own steps, sees their own work, profile and the pipeline of projects they belong to. Sees no one else's contact details. |

Fixed rules (no setting changes them; see ACCESS.md §3): nobody decides on their own work (reviews, plans, pauses, revision flags), DMs are private (admin included), no ranking or comparison, the 3-rating minimum, workers' 404s and contact privacy, at least one active admin, read-only roles manage their own account, suspension is immediate. A Creative Lead, Growth Lead or SM Manager can be limited to some calendars; the limit wins over any calendar setting. Public access requests can ask for `executive` or `sm_manager` only; only an Admin grants `admin`, `creative_head`, `production_head`, `creative_lead` or `growth_lead`.

**Worker job roles and step eligibility.** Job role sets eligibility; preferences can only narrow it (eligible steps are the ones in both, so a worker with no preferences is not suggested, as before; a preference outside it is refused with `400 PREFERENCE_NOT_ELIGIBLE`, and a job role change drops preferences the new job role does not allow). Writer: Script, Content. Cinematographer: Shoot. Graphic Designer: Design. Video Editor: Edit. All Rounder: Script, Content, Shoot, Design, Edit. Post: SM Managers only. Autofill, owner suggestions, plan validation and Excel import all use this one rule (`effectiveStepsFor`). Job titles kept: the 5 worker titles plus "Creative Manager (TL)" and "Social Media Manager"; Videographer, Designer, Social Specialist and the unused titles were removed.

**Access changes.** Role, status and calendar limit change only through `changePersonAccess` (History, `access:changed`, then the person's sockets close and reconnect); calendar settings only through `updateWorkflowConfig` (new version, History, `access:changed` to the old and new people). Open tabs reload `/auth/me` on `access:changed`, on reconnect and on focus. Socket events go to user rooms chosen by the resolver (no role rooms). With several API instances, settings reach every instance within 5 s (cache TTL); the live event reaches only the saving instance's sockets (no shared Socket.IO adapter).

**Migration.** `apps/api/scripts/migrate-roles.js` moves an existing database to this model (dry run by default; `--confirm --db-name=<db>` backs up with mongodump to `D:\haca-backups\<timestamp>\` first, local databases only, API stopped). Until it runs, accounts still on `team_member` are refused with `403 ROLE_MIGRATION_PENDING`.

### 4.2 Five Creative Calendars
Display names (Phase 10): SM Calendar, Sales Calendar, Ads Calendar, Academics & Management Calendar, Other. Keys unchanged.
1. `sm` — Social Media
2. `sales` — Sales Team
3. `ads` — Ads Team
4. `academics_management` — Academics & Management
5. `other` — Other

### 4.3 Deliverables, Pipelines & Review
- **Row workflows (Phase 10):** chosen per row until approval, stored as flags (`needsScript`, `needsShoot`, `needsContent`). Reel: Full (Script → Shoot → Edit → Post, default), Shoot + Edit (Shoot → Edit → Post) or Edit only (Edit → Post; needs a source video that is an app upload or a Google Drive / Docs link). Static Post and Carousel Post: With content (Content → Design → Post, default) or Design only (Design → Post). Other types keep fixed steps. Approval creates only the workflow's steps; deadlines use the existing offsets back from the posting date. A step with no earlier step gets "From the plan" (the row's brief; plus the source video for Edit only), worked out on read. Labels like "Reel · Edit only" show on Work Detail, Tracker and the Project KPI page.
- **15 Supported Deliverable Types:** Reel + 14 Design Types (Static Post, Carousel Post, Story, Cover Image, Thumbnail, Meta Ads Creative, Class Announcement, Orientation Creative, Graduation Creative, Brochure, Certificate, Offer Creative, Placement Poster, Custom Request).
- **Types that Go Live (Include Post Step):** Reel, Static Post, Carousel Post, Story.
- **Deadlines Relative to Publish Date ($F$):**
  - Reel (Script & Shoot): Script $F-8$, Shoot $F-5$, Edit $F-2$, Post $F$.
  - Reel (Shoot only): Shoot $F-5$, Edit $F-2$, Post $F$.
  - Reel (Edit only): Edit $F-2$, Post $F$.
  - Postable Design: Content $F-5$, Design $F-2$, Post $F$.
  - Non-Postable Design: Content $F-5$, Design $F-2$ (handover on $F$).
- **Review Steps:** Content, Script, Design, Edit, and Shoot go to the Creative Lead. Post is direct by the posting owner.
- **Autofill Suggestions:** Suggests workers by matching step preference, workload under 85%, fewest revisions in 90 days, earliest availability.

### 4.4 Individual Timing & Tracking
- **Recorded Timestamps:** `unlockedAt`, `assignedAt`, `startedAt`, `submittedAt`, `decisionAt`, `changesRequestedAt`, `resubmittedAt`, `approvedAt`, `postedAt`, plus paused interval logs (`blocked`, `pending`, and `paused` for a later step held while an earlier step is reopened).
- **Measures (Display-Only):**
  - Waiting to start: `startedAt` minus `unlockedAt`.
  - Time labels (Phase 7, computed only; dates compared in Asia/Kolkata, so a step due on a day is on time until 11:59 PM IST): Overdue (unlocked, unfinished, past its due date), Waiting: earlier step late (locked and past due; never Overdue), Done N days late / Done on time (by the first submission; a Post step by its posting), Late: earlier step (unlocked after its own due date), Blocked N days (active blocker). Project labels: Overdue (publish date passed, not posted or handed over) and Completed late. Shared in `@mmp/shared` (`stepTimeLabels`, `projectTimeLabel`).
  - Worker on-time rate leaves out "Late: earlier step" steps and shows "N steps delayed by earlier steps".
  - Priority is Normal or Urgent only (default Normal). Older stored Low, Medium and High stay unchanged in the database and show as Normal. My Work and Work Items sort Urgent first, then by due date.
  - Work time: round submission minus round start, minus blocked, pending and paused periods. Reports, the team digest and the Performance tab count submitted rounds only (`submittedWorkTimeMs` in `@mmp/shared`).
  - Approval wait: decision time minus submission time.
  - Late by: calendar days between submission date and step due date.
- Workers see only their own step's due date and elapsed work time since their own click on "Start".

### 4.5 Role Workspaces
- **Writing Studio (Content / Script):** Word-style rich editor (Tiptap), two-column Visual/Audio table, duration estimator, teleprompter, shot list generator, .docx export/import.
- **Review Studio (Creative Lead):** Centralized review queue. Media viewers with second-pinned video comments, coordinate-pinned image comments, 1–5 star mandatory approval rating, and 7-category revision root causes.
- **Shoot Workspace (Videographer):** Clip-by-clip upload with pause/resume, individual clip review ("Approve Clip" / "Reshoot Needed"), and WhatsApp-style per-clip discussion thread.
- **Edit / Design Workspaces:** Media upload with size guides, aspect ratio checks, approved copy side-by-side view, and revision checklist.
- **Post Workspace:** Caption (required to post) and hashtags written on the Post step, with copy buttons; download of the approved final assets; platform checklist, live link and post timestamp recording.

### 4.6 Team Directory & Profile
- **Team Directory (`/team`):** Operating status, workload percentage and band, 'Right Now' deliverable, and active counts (in progress, waiting for approval, late). Whitelist sorting: `name`, `department`, `jobRole`, `load`.
- **Worker Profile (`/team/:id` and `/profile`):** 6 tabs: Overview, Work (timeline traces), Performance (individual craftsmanship metrics), Ratings (feedback summary, $\ge 3$ threshold), Activity, and Changes (operational audit log for Admin & Creative Lead).
- **Edit Profile:** Name, preferred name, avatar upload with circular crop, locked registered email (Admin managed), phone number with 6-digit OTP verification, WhatsApp sync checkbox, bio, languages, and skills.

### 4.7 Team Chat
- Real-time messaging via Socket.io.
- Group channels created by Admin, Creative Lead, and SM Manager.
- Private DMs between non-executives (Admin cannot read DMs; Creative Head is read-only).
- **Share to Chat:** Approved creative assets from workspaces can be shared directly into channels with media preview cards.

---

## 5. Canonical Database Seed Users

Seeded only by `apps/api/scripts/reset-and-seed.js` (Phase 9: dry run by default; `--confirm --db-name=marketing_portal` on a local database only). Passwords are never in source or docs: each user uses `SEED_PASSWORD_<KEY>` and the admin `ADMIN_SEED_PASSWORD`, all in the git-ignored `apps/api/.env`. The keys are unchanged from Phase 9 so existing `.env` entries keep working; Phase 12b changed the roles behind them. `PRODUCTIONHEAD` and `GROWTHLEAD` are optional: seeded only when their passwords are set. The app creates the admin at startup only when it is missing and never rewrites users or passwords. Dev quick sign-in reads `VITE_QUICK_LOGINS` from the git-ignored `apps/web/.env.local` and is absent from production builds.

| # | Key | Role | Job Role | Department | Email | Phone |
|---|---|---|---|---|---|---|
| 1 | CREATIVEHEAD | `creative_lead` | Creative Manager (TL) | Design | `creativelead@demo.haca.local` | 9000000001 |
| 2 | SMMANAGER | `sm_manager` | Social Media Manager | Social Media | `smmanager@demo.haca.local` | 9000000002 |
| 3 | EXECUTIVE | `creative_head` | None | None | `creativehead@demo.haca.local` | 9000000003 |
| 4 | WRITER1 | `executive` | Writer | SEO & Content | `writer1@demo.haca.local` | 9000000011 |
| 5 | WRITER2 | `executive` | Writer | SEO & Content | `writer2@demo.haca.local` | 9000000012 |
| 6 | DESIGNER1 | `executive` | Graphic Designer | Design | `designer1@demo.haca.local` | 9000000013 |
| 7 | DESIGNER2 | `executive` | Graphic Designer | Design | `designer2@demo.haca.local` | 9000000014 |
| 8 | SHOOTER | `executive` | Cinematographer | Video Production | `shooter@demo.haca.local` | 9000000015 |
| 9 | EDITOR1 | `executive` | Video Editor | Video Production | `editor1@demo.haca.local` | 9000000016 |
| 10 | EDITOR2 | `executive` | Video Editor | Video Production | `editor2@demo.haca.local` | 9000000017 |
| 11 | POSTER | `executive` | None (to be assigned) | Social Media | `poster@demo.haca.local` | 9000000018 |
| 12 | ALLROUNDER | `executive` | All Rounder | Social Media | `allrounder@demo.haca.local` | 9000000019 |
| 13 | PRODUCTIONHEAD (optional) | `production_head` | None | None | `productionhead@demo.haca.local` | 9000000004 |
| 14 | GROWTHLEAD (optional) | `growth_lead` | None | Performance Marketing | `growthlead@demo.haca.local` | 9000000005 |
| — | (admin) | `admin` | System Admin | Tech | `ADMIN_SEED_EMAIL` | — |

---

## 6. Verification Status Checklist

| # | Item | Status | Verified Evidence |
|---|---|---|---|
| 1 | Scope reset R1 to R4 (leads, campaigns, targets removed; 5 roles; calendar plans) | **Done** | 302 tests passed; scope reset verified |
| 2 | Wipe scripts (`wipe-keep-users.js`, `reset-and-seed.js`) | **Done** | Scripts idempotent, dry-run by default |
| 3 | Workflow V2 backend (auto-fill, validation, plan rejection) | **Done** | Plan controllers, autofill service passing |
| 4 | Workflow V2 UI & Simple UI | **Done** | Max 8 menu items, one primary action per page |
| 5 | Plan list & row form fixes (counts, derived status, step deadlines) | **Done** | Row form shows step owner & date picker |
| 6 | Work actions by role (no "Lead" wording, role-based buttons) | **Done** | `getAvailableActions` tested across 5 roles |
| 7 | Pipeline visibility & stepper UI | **Done** | Teammates see read-only pipeline of own projects |
| 8 | Workspaces WS1 to WS4 (Writing, Review, Shoot, Edit, Design, Post) | **Done** | Workspaces passing tests and production build |
| 9 | Clip-by-clip Shoot workspace & feedback thread | **Done** | `ShootWorkspaceSuite.test.tsx` 13/13 passing |
| 10 | Team Chat (channels, DMs, share to chat) | **Done** | `chat_system.test.js` & `chat_share_polish.test.js` |
| 11 | HACA-Only (all other brands removed) | **Done** | Brand profiles wiped; 5 calendars active |
| 12 | Step deadlines in plan row form | **Done** | `step_deadlines_plan_form.test.js` passing |
| 13 | Individual tracking & timing | **Done** | `individual_tracking_and_timing.test.js` passing |
| 14 | Team Directory & Worker Profile (`/team`, `/team/:id`) | **Done** | `team_profile_api.test.js` passing |
| 15 | Mandatory `/welcome` gate removal | **Done** | Direct entry to `/my-work` or `/dashboard` |
| 16 | Edit Profile Modal & Mobile OTP Verification | **Done** | `phone_otp_profile.test.js` 9/9 passing |
| 17 | Approval integrity (approved version, review decisions) | **Done** | `review_decision_integrity.test.js` |
| 18 | Phase 3: access boundaries (participants, 404 to non-participants) | **Done** | Phase 3 tests; see docs/PROGRESS.md |
| 19 | Phase 4: uploads and sockets | **Done** | `phase4a_upload_safety.test.js` and Phase 4 tests |
| 20 | Phase 5: asset handoff, Drive links, caption on Post | **Done** | Phase 5 tests; 30/30 browser checks |
| 21 | Phase 6: blockers, reopening, plan delete, small fixes | **Done** | Phase 6 tests; see docs/PROGRESS.md |
| 22 | Phase 7: live reports, overdue and lateness labels, project KPIs | **Done** | Phase 7 tests; 49/49 browser checks; see docs/PROGRESS.md |
| 23 | Phase 8: worker and Creative Lead profile KPIs, profile report (PDF, CSV) | **Done** | Phase 8 tests; 41/41 browser checks; see docs/PROGRESS.md |
| 24 | Access Phases B–E: resolver, calendar settings, Access & Approvals page, verification | **Done** | `e2e_permission_matrix`, `e2e_routing_scenarios`, `e2e_fixed_rules`, `e2e_cache_and_rollback`; see docs/ACCESS.md and docs/PROGRESS.md |

---

## 7. Technical Commands Reference

```bash
# Typecheck
npm run typecheck

# Production Web Build
npm run build --workspace=@mmp/web

# Test API Suite
npm test --workspace=@mmp/api

# Test Web Suite
npm test --workspace=@mmp/web

# Database Reset & Seed (test users)
node apps/api/scripts/reset-and-seed.js --confirm --db-name=marketing_portal
```

