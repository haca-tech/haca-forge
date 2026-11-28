import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { verifyDirectToken } from '../../lib/directTokens.js';
import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { authenticate } from '../../middleware/auth.js';
import { requireAnyPermission } from '../../middleware/requirePermission.js';
import * as uploadController from './controller.js';
import { allowedFileFilter, storedFileName } from './fileTypes.js';

// Multer streams the upload to a temp file (never into memory); the service checks it and
// moves it into storage (lib/storage), then the temp file is removed.
const tmpDir = path.join(os.tmpdir(), 'haca-uploads');
fs.mkdirSync(tmpDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, tmpDir);
  },
  // Random name with the server's extension for the matched type, never the uploader's name.
  filename: (_req, file, cb) => {
    try {
      cb(null, storedFileName(file));
    } catch (err) {
      cb(err);
    }
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB max; per-kind limits are checked after upload
  fileFilter: allowedFileFilter(),
});

const router = Router();

// Uploads go straight to the API host (not through the web host's /api proxy), where the login
// cookie is not sent. The browser fetches a 2-minute upload token through the proxy first and sends
// it as X-Upload-Token; it is turned into a normal access token for this request only, so every
// check in authenticate (suspended, read-only, password change...) still applies.
router.use((req, _res, next) => {
  const uploadToken = req.get('x-upload-token');
  if (uploadToken && !req.cookies?.accessToken && !req.headers.authorization) {
    try {
      const userId = verifyDirectToken(uploadToken, 'upload');
      req.headers.authorization = `Bearer ${jwt.sign({ userId }, env.JWT_SECRET, { expiresIn: 120 })}`;
    } catch {
      /* invalid or expired: authenticate answers 401 */
    }
  }
  next();
});
router.use(authenticate);

// Multipart direct local file upload endpoint
router.post(
  '/file',
  requireAnyPermission('work.create', 'work.request', 'work.update.own'),
  upload.single('file'),
  uploadController.localUploadHandler
);

router.post(
  '/',
  requireAnyPermission('work.create', 'work.request', 'work.update.own'),
  upload.single('file'),
  uploadController.localUploadHandler
);

router.post(
  '/metadata',
  requireAnyPermission('work.create', 'work.request', 'work.update.own'),
  uploadController.recordMetadataHandler
);

export default router;

