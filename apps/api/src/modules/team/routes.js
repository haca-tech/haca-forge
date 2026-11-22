import express from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import * as teamController from './controller.js';
import { hasPermission } from '../../lib/roleAccess.js';
import { requireProfileAccess } from './profileAccess.js';

const router = express.Router();

// Roles without 'team.profile.view' (only executive (worker) today) get 404, not 403, for the
// directory and for another person's records, so the response does not confirm that
// the resource exists (same anti-harvesting rule as requireProfileAccess). Requests for
// your own :id fall through to the normal permission check unchanged.
function notFoundForWorkers(req, res, next) {
  if (req.user && !hasPermission(req.user, 'team.profile.view')) {
    const userIdStr = (req.user._id || req.user.id || req.user.userId)?.toString();
    const targetIdStr = req.params.id?.toString();
    if (!targetIdStr || targetIdStr !== userIdStr) {
      return res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Not found' },
      });
    }
  }
  return next();
}

router.use(authenticate);

// Directory list - requires team.profile.view (executive (worker): 404)
router.get('/', notFoundForWorkers, requirePermission('team.profile.view'), teamController.getDirectory);

// Individual Profile Endpoints
router.get('/:id', requireProfileAccess, teamController.getBaseProfile);
router.get('/:id/overview', requireProfileAccess, teamController.getOverview);
router.get('/:id/work', requireProfileAccess, teamController.getWork);
router.get('/:id/performance', requireProfileAccess, teamController.getPerformance);
// Phase 8: profile KPIs for a period (same access as the profile) and the downloadable
// report (admin, creative_lead/growth_lead and creative_head/production_head only; enforced in the service).
router.get('/:id/kpis', requireProfileAccess, teamController.getKpis);
router.get('/:id/report', requireProfileAccess, teamController.getReport);
router.get('/:id/ratings', requireProfileAccess, teamController.getRatings);
router.get('/:id/activity', requireProfileAccess, teamController.getActivity);
router.get('/:id/changes', notFoundForWorkers, requirePermission('team.profile.view'), teamController.getChanges);

// Mutations. PATCH: admins (every field) and leads (operational fields of workers and SM
// Managers only); a role or status change also needs user.manage and goes through the admin
// page's savePersonChange (reason, self and last-admin guards, calendar health check).
router.patch('/:id', requireAnyPermission('user.manage', 'people.manage_operational'), teamController.updateDetails);
router.post('/:id/reassign', requirePermission('assignment.override'), teamController.reassign);
router.post('/:id/status', requirePermission('user.manage'), teamController.toggleStatusHandler);
router.post('/:id/reset-password', requirePermission('user.manage'), teamController.resetPasswordHandler);
router.post('/:id/force-logout', requirePermission('user.manage'), teamController.forceLogoutHandler);

export default router;
