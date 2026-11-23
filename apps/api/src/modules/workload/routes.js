import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { requireAnyPermission, requirePermission } from '../../middleware/requirePermission.js';
import { listWorkload, openStepsOf, setActiveStepLimit } from './service.js';

/**
 * Team workload (step counts): bands, people (by name), jobRoles, canEditLimit.
 * No hours, capacity or percentages.
 */
const router = Router();
router.use(authenticate);
// Not the Viewer: it sees the plan, not people's load.
const seesWorkload = requireAnyPermission('people.view', 'work.update.own');

router.get('/', seesWorkload, async (req, res, next) => {
  try {
    res.json({ success: true, data: await listWorkload(req.user, { jobRole: req.query.jobRole, band: req.query.band, q: req.query.q }) });
  } catch (err) {
    next(err);
  }
});

router.get('/:personId/steps', seesWorkload, async (req, res, next) => {
  try {
    res.json({ success: true, data: await openStepsOf(req.params.personId, req.user) });
  } catch (err) {
    next(err);
  }
});

router.put('/:personId/limit', requirePermission('people.manage_operational'), async (req, res, next) => {
  try {
    res.json({ success: true, data: await setActiveStepLimit(req.params.personId, req.body?.limit, req.user) });
  } catch (err) {
    next(err);
  }
});

export default router;
