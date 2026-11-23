// T1: the API routes that have no permission guard of their own. Each entry names the check that
// protects it (`module#export` under src/, or 'public' for the signed-out flow and health checks)
// and the reason it is enough. The permission matrix fails on any unguarded route missing here and on
// any entry that is no longer an unguarded route; unguarded_route_checks.test.js calls every route
// and asserts its named check function actually runs.

const PUBLIC = 'Public: health checks and the signed-out sign-in flow (rate-limited where it matters).';
const SESSION = 'Signed-in user only (authenticate); acts on the caller\'s own session.';
const OWN_ACCOUNT = 'Own account only: /me routes act on the signed-in person (fixed rule 8: read-only roles keep these).';
const PROFILE_ACCESS = 'requireProfileAccess: team.profile.view, or the person themselves; workers get 404 for anyone else.';
const PEOPLE_SELF_OR_SEES_ALL = 'Service check: the person themselves or a role that sees everyone; workers get 404 (fixed rule 5).';
const REFERENCE = 'Read-only reference data (departments, labels) every signed-in user needs to render forms.';
const OWN_NOTIFICATIONS = 'Own notifications only: every query is filtered by the signed-in recipient.';
const CONTENT_PIECE = 'Service check: leadership sees every piece; workers only pieces where they own a step, else 404.';
const PROJECT_KPI = 'Service check (requireParticipant-style): project KPIs for roles that see all, else 404; no contact fields.';
const CLIP_PARTICIPANT = 'clipParam + service check: the step owner or a participant; decisions go through assertDecidesOn (calendar + owner).';
const CLIP_LOCKED = 'clipParam + refuseWhenWorkspacesLocked + service check: only the clip\'s step owner edits it.';
const PAUSE = 'Service checks: the step owner asks/cancels/resumes; decide uses assertDecidesOn (calendar routing, never your own).';
const HELP = 'Service checks: asker, person asked, deciders or posters of the step\'s calendar, admins (L1); others 404.';
const SUBMISSION = 'Service checks: requireParticipant (owner or a role that sees all; workers 404 elsewhere); decisions via assertReviewer (calendar + owner).';
const RATINGS = 'Service checks: own ratings for workers (404 otherwise); edits need the rater/admin, never on own work, review.decide on the calendar.';
const QUEUE = 'Service check: decisionCalendarFilter limits the queue to the calendars the user reviews; workers see their own submissions.';
const WORKLOAD = 'Service checks: workers see only themselves (404 otherwise); editing a limit needs people.manage_operational.';
const PUBLISHED = 'Service checks: workers see only pieces they worked on; editing a live link needs publish.edit_live_link.';
const WORK_STEP = 'Work item router: router.param(id/stageItemId) runs workItemParam (owner, or a role that sees all; workers 404 elsewhere), then the service checks the step owner.';
const REVIEW_HUB = 'Service checks: decisionCalendarFilter and canDecideOn per step; workers see only their own steps.';

export const ALLOW_UNGUARDED = {
  'GET /api/status': { check: 'public', reason: PUBLIC },
  'GET /api/health': { check: 'public', reason: PUBLIC },
  'GET /api/ready': { check: 'public', reason: PUBLIC },
  'POST /api/auth/login': { check: 'public', reason: PUBLIC },
  'POST /api/auth/refresh': { check: 'public', reason: PUBLIC },
  'POST /api/auth/request-access': { check: 'public', reason: PUBLIC },
  'GET /api/auth/verify-token': { check: 'public', reason: PUBLIC },
  'POST /api/auth/set-password': { check: 'public', reason: PUBLIC },
  'POST /api/auth/forgot-password': { check: 'public', reason: PUBLIC },
  'POST /api/auth/logout': { check: 'middleware/auth.js#authenticate', reason: SESSION },
  'GET /api/auth/me': { check: 'middleware/auth.js#authenticate', reason: SESSION },
  'POST /api/auth/change-password': { check: 'middleware/auth.js#authenticate', reason: SESSION },
  'GET /api/me/profile': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'PATCH /api/me/profile': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/phone-otp/send': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/phone-otp/verify': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/avatar/sign': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/avatar': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'DELETE /api/me/avatar': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'GET /api/me/settings': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'PATCH /api/me/settings': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/password': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'GET /api/me/sessions': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'DELETE /api/me/sessions/:id': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/sessions/revoke-others': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/change-request': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'POST /api/me/welcome': { check: 'middleware/auth.js#authenticate', reason: OWN_ACCOUNT },
  'GET /api/team/:id': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: PROFILE_ACCESS },
  'GET /api/team/:id/overview': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: PROFILE_ACCESS },
  'GET /api/team/:id/work': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: PROFILE_ACCESS },
  'GET /api/team/:id/performance': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: PROFILE_ACCESS },
  'GET /api/team/:id/kpis': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: PROFILE_ACCESS },
  'GET /api/team/:id/report': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: `${PROFILE_ACCESS} The download itself needs team.profile.report (service).` },
  'GET /api/team/:id/ratings': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: PROFILE_ACCESS },
  'GET /api/team/:id/activity': { check: 'modules/team/profileAccess.js#requireProfileAccess', reason: PROFILE_ACCESS },
  'GET /api/people/:id/ratings': { check: 'modules/submissions/service.js#getRatingsSummary', reason: PEOPLE_SELF_OR_SEES_ALL },
  'GET /api/people/:id/profile': { check: 'modules/people/service.js#getPersonProfile', reason: PEOPLE_SELF_OR_SEES_ALL },
  'GET /api/people/:id/work-history': { check: 'modules/people/service.js#getPersonWorkHistory', reason: PEOPLE_SELF_OR_SEES_ALL },
  'GET /api/reference-data': { check: 'middleware/auth.js#authenticate', reason: REFERENCE },
  'GET /api/reference-data/departments': { check: 'middleware/auth.js#authenticate', reason: REFERENCE },
  'GET /api/departments': { check: 'middleware/auth.js#authenticate', reason: REFERENCE },
  'GET /api/notifications': { check: 'modules/notifications/service.js#getUserNotifications', reason: OWN_NOTIFICATIONS },
  'PUT /api/notifications/preferences': { check: 'modules/notifications/service.js#updateUserPreferences', reason: OWN_NOTIFICATIONS },
  'PATCH /api/notifications/:id/read': { check: 'modules/notifications/service.js#markAsRead', reason: OWN_NOTIFICATIONS },
  'PATCH /api/notifications/read-all': { check: 'modules/notifications/service.js#markAllAsRead', reason: OWN_NOTIFICATIONS },
  'DELETE /api/notifications/:id': { check: 'modules/notifications/service.js#deleteNotification', reason: OWN_NOTIFICATIONS },
  'GET /api/content-pieces/:id': { check: 'modules/calendar/contentPiece.read.js#getContentPieceForViewer', reason: CONTENT_PIECE },
  'GET /api/reports/projects/:id': { check: 'modules/reports/live.controller.js#projectKpiHandler', reason: PROJECT_KPI },
  'PATCH /api/clips/:id': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_LOCKED },
  'POST /api/clips/:id/replace': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_LOCKED },
  'DELETE /api/clips/:id': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_LOCKED },
  'POST /api/clips/:id/review': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_PARTICIPANT },
  'GET /api/clips/:id/messages': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_PARTICIPANT },
  'POST /api/clips/:id/messages': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_PARTICIPANT },
  'POST /api/clips/:id/messages/seen': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_PARTICIPANT },
  'PATCH /api/clips/:id/messages/:messageId/toggle-done': { check: 'modules/workItems/access.js#clipParam', reason: CLIP_PARTICIPANT },
  'GET /api/work/pause-requests': { check: 'modules/workItems/pause.service.js#listPauseRequests', reason: PAUSE },
  'POST /api/work/:id/pause-request': { check: 'modules/workItems/access.js#workItemParam', reason: PAUSE },
  'POST /api/work/:id/pause-request/cancel': { check: 'modules/workItems/access.js#workItemParam', reason: PAUSE },
  'POST /api/work/:id/pause-request/decide': { check: 'modules/workItems/access.js#workItemParam', reason: PAUSE },
  'POST /api/work/:id/resume': { check: 'modules/workItems/access.js#workItemParam', reason: PAUSE },
  'GET /api/work/:id/help-requests': { check: 'modules/workItems/access.js#workItemParam', reason: HELP },
  'POST /api/work/:id/help-requests': { check: 'modules/workItems/access.js#workItemParam', reason: HELP },
  'POST /api/work/:id/help-requests/:helpId/replies': { check: 'modules/workItems/access.js#workItemParam', reason: HELP },
  'POST /api/work/:id/help-requests/:helpId/resolve': { check: 'modules/workItems/access.js#workItemParam', reason: HELP },
  'GET /api/submissions/review-queue': { check: 'modules/submissions/service.js#getReviewQueue', reason: QUEUE },
  'GET /api/submissions/queue': { check: 'modules/submissions/service.js#getReviewQueue', reason: QUEUE },
  'POST /api/submissions/ratings/:id/seen': { check: 'modules/workItems/access.js#requireRatingAccess', reason: RATINGS },
  'PATCH /api/submissions/ratings/:id': { check: 'modules/workItems/access.js#requireRatingAccess', reason: RATINGS },
  'GET /api/submissions/ratings/summary/:personId': { check: 'modules/submissions/service.js#getRatingsSummary', reason: RATINGS },
  'PATCH /api/submissions/comments/:id/resolve': { check: 'modules/workItems/access.js#requireCommentAccess', reason: SUBMISSION },
  'POST /api/submissions/comments/:id/resolve': { check: 'modules/workItems/access.js#requireCommentAccess', reason: SUBMISSION },
  'GET /api/submissions': { check: 'modules/submissions/service.js#listSubmissions', reason: SUBMISSION },
  'POST /api/submissions': { check: 'modules/workItems/access.js#requireParticipant', reason: SUBMISSION },
  'GET /api/submissions/:id': { check: 'modules/workItems/access.js#requireSubmissionAccess', reason: SUBMISSION },
  'POST /api/submissions/:id/comments': { check: 'modules/workItems/access.js#requireSubmissionAccess', reason: SUBMISSION },
  'GET /api/submissions/:id/comments': { check: 'modules/workItems/access.js#requireSubmissionAccess', reason: SUBMISSION },
  'POST /api/submissions/:id/approve': { check: 'modules/workItems/access.js#requireSubmissionAccess', reason: SUBMISSION },
  'POST /api/submissions/:id/request-revision': { check: 'modules/workItems/access.js#requireSubmissionAccess', reason: SUBMISSION },
  'GET /api/workload': { check: 'modules/workload/service.js#listWorkload', reason: WORKLOAD },
  'GET /api/workload/:personId/steps': { check: 'modules/workload/service.js#openStepsOf', reason: WORKLOAD },
  'PUT /api/workload/:personId/limit': { check: 'modules/workload/service.js#setActiveStepLimit', reason: WORKLOAD },
  'GET /api/published': { check: 'modules/published/service.js#listPublished', reason: PUBLISHED },
  'PUT /api/published/:pieceId/live-link': { check: 'modules/published/service.js#editLiveLink', reason: PUBLISHED },
  'GET /api/work/:id/draft': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'PUT /api/work/:id/draft': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:id/submit': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:id/submit-link': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'GET /api/work/:id/submissions': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:id/editor-lock': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'DELETE /api/work/:id/editor-lock': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'GET /api/work/:id/editor-lock': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'GET /api/work/:id/comments': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:id/comments': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'PATCH /api/work/:id/comments/:commentId/resolve': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:id/comments/:commentId/resolve': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:stageItemId/clips': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'GET /api/work/:stageItemId/clips': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'PUT /api/work/:stageItemId/clips/reorder': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:stageItemId/submit-clips': { check: 'modules/workItems/access.js#workItemParam', reason: WORK_STEP },
  'POST /api/work/:stageItemId/shoot-review': { check: 'modules/workItems/access.js#workItemParam', reason: `${WORK_STEP} Finishing a shoot review is a decision: assertReviewer (calendar routing + never your own step).` },
  'GET /api/review-hub': { check: 'modules/reviewHub/service.js#reviewInbox', reason: REVIEW_HUB },
  'GET /api/review-hub/steps/:workItemId/timeline': { check: 'modules/reviewHub/service.js#stepTimeline', reason: REVIEW_HUB },
};
