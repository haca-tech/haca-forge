import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { listWorkload, openStepsOf, setActiveStepLimit } from './service.js';

/**
 * Team workload (step counts): bands, people (by name), jobRoles, canEditLimit.
 * No hours, capacity or percentages.
 */
const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    res.json({ success: true, data: await listWorkload(req.user, { jobRole: req.query.jobRole, band: req.query.band, q: req.query.q }) });
  } catch (err) {
    next(err);
  }
});

router.get('/:personId/steps', async (req, res, next) => {
  try {
    res.json({ success: true, data: await openStepsOf(req.params.personId, req.user) });
  } catch (err) {
    next(err);
  }
});

router.put('/:personId/limit', async (req, res, next) => {
  try {
    res.json({ success: true, data: await setActiveStepLimit(req.params.personId, req.body?.limit, req.user) });
  } catch (err) {
    next(err);
  }
});

export default router;
