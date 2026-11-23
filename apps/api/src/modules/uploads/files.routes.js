import { Router } from 'express';
import { storageKeyOf } from '@mmp/shared';
import { authenticate } from '../../middleware/auth.js';
import { assertCanReadFile } from './fileAccess.js';
import { notFound } from '../workItems/access.js';

/**
 * A fresh URL for a file whose signed URL expired (images, videos and downloads ask once).
 * The access rules run first (fileAccess.js); anyone else gets the same 404 as a missing file.
 * The response carries the key in `url`; signFileUrls turns it into the URL for this driver.
 */
const router = Router();
router.use(authenticate);

router.post('/refresh', async (req, res, next) => {
  try {
    const key = storageKeyOf(req.body?.url);
    if (!key) throw notFound();
    await assertCanReadFile(req.user, key);
    res.json({ data: { url: key } });
  } catch (err) {
    next(err);
  }
});

export default router;
