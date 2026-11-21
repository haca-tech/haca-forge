// T1: the API routes that have no permission guard of their own, each with the reason it is safe.
// The permission matrix fails on any unguarded route missing here, and on any entry here that is
// no longer a route (or has gained a guard). Add a route only with a reason a reviewer can check.

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
  'GET /api/status': PUBLIC,
  'GET /api/health': PUBLIC,
  'GET /api/ready': PUBLIC,
  'POST /api/auth/login': PUBLIC,
  'POST /api/auth/refresh': PUBLIC,
  'POST /api/auth/request-access': PUBLIC,
  'GET /api/auth/verify-token': PUBLIC,
  'POST /api/auth/set-password': PUBLIC,
  'POST /api/auth/forgot-password': PUBLIC,
  'POST /api/auth/logout': SESSION,
  'GET /api/auth/me': SESSION,
  'POST /api/auth/change-password': SESSION,
  'GET /api/me/profile': OWN_ACCOUNT,
  'PATCH /api/me/profile': OWN_ACCOUNT,
  'POST /api/me/phone-otp/send': OWN_ACCOUNT,
  'POST /api/me/phone-otp/verify': OWN_ACCOUNT,
  'POST /api/me/avatar/sign': OWN_ACCOUNT,
  'POST /api/me/avatar': OWN_ACCOUNT,
  'DELETE /api/me/avatar': OWN_ACCOUNT,
  'GET /api/me/settings': OWN_ACCOUNT,
  'PATCH /api/me/settings': OWN_ACCOUNT,
  'POST /api/me/password': OWN_ACCOUNT,
  'GET /api/me/sessions': OWN_ACCOUNT,
  'DELETE /api/me/sessions/:id': OWN_ACCOUNT,
  'POST /api/me/sessions/revoke-others': OWN_ACCOUNT,
  'POST /api/me/change-request': OWN_ACCOUNT,
  'POST /api/me/welcome': OWN_ACCOUNT,
  'GET /api/team/:id': PROFILE_ACCESS,
  'GET /api/team/:id/overview': PROFILE_ACCESS,
  'GET /api/team/:id/work': PROFILE_ACCESS,
  'GET /api/team/:id/performance': PROFILE_ACCESS,
  'GET /api/team/:id/kpis': PROFILE_ACCESS,
  'GET /api/team/:id/report': `${PROFILE_ACCESS} The download itself needs team.profile.report (service).`,
  'GET /api/team/:id/ratings': PROFILE_ACCESS,
  'GET /api/team/:id/activity': PROFILE_ACCESS,
  'GET /api/people/:id/ratings': PEOPLE_SELF_OR_SEES_ALL,
  'GET /api/people/:id/profile': PEOPLE_SELF_OR_SEES_ALL,
  'GET /api/people/:id/work-history': PEOPLE_SELF_OR_SEES_ALL,
  'GET /api/reference-data': REFERENCE,
  'GET /api/reference-data/departments': REFERENCE,
  'GET /api/departments': REFERENCE,
  'GET /api/notifications': OWN_NOTIFICATIONS,
  'GET /api/notifications/preferences': OWN_NOTIFICATIONS,
  'PUT /api/notifications/preferences': OWN_NOTIFICATIONS,
  'PATCH /api/notifications/:id/read': OWN_NOTIFICATIONS,
  'PATCH /api/notifications/read-all': OWN_NOTIFICATIONS,
  'DELETE /api/notifications/:id': OWN_NOTIFICATIONS,
  'GET /api/content-pieces/:id': CONTENT_PIECE,
  'GET /api/reports/projects/:id': PROJECT_KPI,
  'PATCH /api/clips/:id': CLIP_LOCKED,
  'POST /api/clips/:id/replace': CLIP_LOCKED,
  'DELETE /api/clips/:id': CLIP_LOCKED,
  'POST /api/clips/:id/review': CLIP_PARTICIPANT,
  'GET /api/clips/:id/messages': CLIP_PARTICIPANT,
  'POST /api/clips/:id/messages': CLIP_PARTICIPANT,
  'POST /api/clips/:id/messages/seen': CLIP_PARTICIPANT,
  'PATCH /api/clips/:id/messages/:messageId/toggle-done': CLIP_PARTICIPANT,
  'GET /api/work/pause-requests': PAUSE,
  'POST /api/work/:id/pause-request': PAUSE,
  'POST /api/work/:id/pause-request/cancel': PAUSE,
  'POST /api/work/:id/pause-request/decide': PAUSE,
  'POST /api/work/:id/resume': PAUSE,
  'GET /api/work/:id/help-requests': HELP,
  'POST /api/work/:id/help-requests': HELP,
  'POST /api/work/:id/help-requests/:helpId/replies': HELP,
  'POST /api/work/:id/help-requests/:helpId/resolve': HELP,
  'GET /api/submissions/review-queue': QUEUE,
  'GET /api/submissions/queue': QUEUE,
  'POST /api/submissions/ratings/:id/seen': RATINGS,
  'PATCH /api/submissions/ratings/:id': RATINGS,
  'GET /api/submissions/ratings/summary/:personId': RATINGS,
  'PATCH /api/submissions/comments/:id/resolve': SUBMISSION,
  'POST /api/submissions/comments/:id/resolve': SUBMISSION,
  'GET /api/submissions': SUBMISSION,
  'POST /api/submissions': SUBMISSION,
  'GET /api/submissions/:id': SUBMISSION,
  'POST /api/submissions/:id/comments': SUBMISSION,
  'GET /api/submissions/:id/comments': SUBMISSION,
  'POST /api/submissions/:id/approve': SUBMISSION,
  'POST /api/submissions/:id/request-revision': SUBMISSION,
  'GET /api/workload': WORKLOAD,
  'GET /api/workload/:personId/steps': WORKLOAD,
  'PUT /api/workload/:personId/limit': WORKLOAD,
  'GET /api/published': PUBLISHED,
  'PUT /api/published/:pieceId/live-link': PUBLISHED,
  'GET /api/work/:id/draft': WORK_STEP,
  'PUT /api/work/:id/draft': WORK_STEP,
  'POST /api/work/:id/submit': WORK_STEP,
  'POST /api/work/:id/submit-link': WORK_STEP,
  'GET /api/work/:id/submissions': WORK_STEP,
  'POST /api/work/:id/editor-lock': WORK_STEP,
  'DELETE /api/work/:id/editor-lock': WORK_STEP,
  'GET /api/work/:id/editor-lock': WORK_STEP,
  'GET /api/work/:id/comments': WORK_STEP,
  'POST /api/work/:id/comments': WORK_STEP,
  'PATCH /api/work/:id/comments/:commentId/resolve': WORK_STEP,
  'POST /api/work/:id/comments/:commentId/resolve': WORK_STEP,
  'POST /api/work/:stageItemId/clips': WORK_STEP,
  'GET /api/work/:stageItemId/clips': WORK_STEP,
  'PUT /api/work/:stageItemId/clips/reorder': WORK_STEP,
  'POST /api/work/:stageItemId/submit-clips': WORK_STEP,
  'POST /api/work/:stageItemId/shoot-review': `${WORK_STEP} Finishing a shoot review is a decision: assertReviewer (calendar routing + never your own step).`,
  'GET /api/review-hub': REVIEW_HUB,
  'GET /api/review-hub/steps/:workItemId/timeline': REVIEW_HUB,
};
