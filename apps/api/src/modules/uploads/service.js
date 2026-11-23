import fs from 'fs';
import { allowedFileType, fileTypeError } from './fileTypes.js';
import { UPLOAD_LIMITS_BYTES } from '@mmp/shared';
import { newFileKey, putFile } from '../../lib/storage/index.js';

/**
 * Record metadata after upload has completed in browser. It describes the file only;
 * it never attaches the file to a submission (that happens through the submission's own
 * routes, which check the step owner).
 */
export async function recordUploadMetadata({
  url,
  size,
  duration,
  width,
  height,
  mime,
  name,
}) {
  if (!url) {
    const err = new Error('File URL is required');
    err.statusCode = 400;
    err.code = 'INVALID_METADATA';
    throw err;
  }

  const metadata = {
    url,
    size: Number(size) || 0,
    duration: Number(duration) || 0,
    width: Number(width) || 0,
    height: Number(height) || 0,
    mime: mime || '',
    name: name || '',
    recordedAt: new Date(),
  };

  return metadata;
}

function removeFile(file) {
  if (file?.path && fs.existsSync(file.path)) {
    try { fs.unlinkSync(file.path); } catch {}
  }
}

/**
 * Validates an uploaded file (multer wrote it to a temp file) and moves it into storage
 */
export async function processLocalUploadedFile(file) {
  if (!file) {
    const err = new Error('No file provided');
    err.statusCode = 400;
    err.code = 'NO_FILE_PROVIDED';
    throw err;
  }

  // The route's file filter has already matched the file to an allowed type.
  const allowed = file.allowedType || allowedFileType(file.originalname, file.mimetype);
  if (!allowed) {
    removeFile(file);
    throw fileTypeError();
  }
  const resolvedKind = allowed.kind;

  // Validate size limit
  const maxAllowedBytes = UPLOAD_LIMITS_BYTES[resolvedKind];
  if (file.size > maxAllowedBytes) {
    removeFile(file);
    const err = new Error(
      `File size (${Math.round(file.size / (1024 * 1024))} MB) exceeds maximum allowed limit of ${Math.round(
        maxAllowedBytes / (1024 * 1024)
      )} MB for ${resolvedKind} uploads.`
    );
    err.statusCode = 400;
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }

  // Into storage under a new key (local folder or Bunny), streamed from the temp file.
  const key = newFileKey(allowed.ext);
  try {
    await putFile(key, file.path, { contentType: allowed.mimes[0] });
  } finally {
    removeFile(file);
  }

  return {
    // A storage key; responses turn `url` into a URL the browser can open (signFileUrls).
    url: key,
    storageId: key,
    fileName: file.originalname,
    sizeBytes: file.size,
    mimeType: allowed.mimes[0],
    kind: resolvedKind,
  };
}

