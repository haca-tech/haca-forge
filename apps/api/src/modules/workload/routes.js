import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { getTeamWorkload } from '../assignment/service.js';
import { listWorkload, openStepsOf, setActiveStepLimit } from './service.js';

/**
 * Team workload (step counts). GET / returns the new fields (bands, people, jobRoles,
 * canEditLimit) next to the older department/hours fields, which stay for one release
 * (deprecated) while a screen still reads them.
 */
const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    const legacy = await getTeamWorkload(req.query, req.user);
    const current = await listWorkload(req.user, { jobRole: req.query.jobRole, band: req.query.band, q: req.query.q });
    res.json({ success: true, data: { ...legacy, ...current } });
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
