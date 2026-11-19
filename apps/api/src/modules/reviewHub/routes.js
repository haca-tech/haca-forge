import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { reviewInbox, stepTimeline } from './service.js';

/** Review Hub (read-only): the inbox with tab counts, and one step's review timeline. */
const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    res.json({ data: await reviewInbox(req.user, { tab: req.query.tab, q: req.query.q, calendar: req.query.calendar }) });
  } catch (err) {
    next(err);
  }
});

router.get('/steps/:workItemId/timeline', async (req, res, next) => {
  try {
    res.json({ data: await stepTimeline(req.params.workItemId, req.user) });
  } catch (err) {
    next(err);
  }
});

export default router;
