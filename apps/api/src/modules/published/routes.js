import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { editLiveLink, listPublished } from './service.js';

/** Published page: the list (every signed-in role; workers scoped to their pieces) and Edit live link. */
const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    res.json({ data: await listPublished(req.query, req.user) });
  } catch (err) {
    next(err);
  }
});

// Edit live link: SM Manager and admin (read-only roles are refused by authenticate, others here).
router.put('/:pieceId/live-link', async (req, res, next) => {
  try {
    res.json({ data: await editLiveLink(req.params.pieceId, req.body, req.user) });
  } catch (err) {
    next(err);
  }
});

export default router;
