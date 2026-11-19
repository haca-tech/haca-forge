import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { listPublished } from './service.js';

/** Published page (read-only). Every signed-in role; the service scopes workers to their pieces. */
const router = Router();
router.use(authenticate);

router.get('/', async (req, res, next) => {
  try {
    res.json({ data: await listPublished(req.query, req.user) });
  } catch (err) {
    next(err);
  }
});

export default router;
