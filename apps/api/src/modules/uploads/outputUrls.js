import { isDriveLink, OUTPUT_URL_ERROR, storageKeyOf } from '@mmp/shared';
import { statFile } from '../../lib/storage/index.js';

/** Does this app file (key, /uploads/... or a signed file URL) exist in storage? */
async function uploadExists(value) {
  const key = storageKeyOf(value);
  return Boolean(key && (await statFile(key)));
}

function invalid(field) {
  const err = new Error(`${field}: ${OUTPUT_URL_ERROR}`);
  err.statusCode = 400;
  err.code = 'INVALID_OUTPUT_URL';
  err.details = { field };
  return err;
}

/**
 * A clip or submission URL being saved must be a file uploaded through the app, or an
 * https Google Drive / Docs link. Empty means "not set" and is allowed. `uploadsOnly`
 * is for thumbnails, which must be real images.
 */
export async function assertOutputUrl(url, field = 'url', { uploadsOnly = false } = {}) {
  if (url === undefined || url === null || url === '') return;
  const value = String(url).trim();
  if (!uploadsOnly && isDriveLink(value)) return;
  if (await uploadExists(value)) return;
  throw invalid(field);
}

/** Every file entry in a submission. */
export async function assertOutputFiles(files, field = 'files') {
  const list = Array.isArray(files) ? files : [];
  for (let i = 0; i < list.length; i += 1) await assertOutputUrl(list[i]?.url, `${field}[${i}].url`);
}

/**
 * For fields that may still hold a value saved before Phase 5: only a new value is checked,
 * so re-sending the existing one never fails.
 */
export async function assertChangedOutputUrl(url, current, field) {
  if (url === undefined || url === null || url === '') return;
  if (String(url).trim() === String(current || '').trim()) return;
  // The same file sent back as a URL (signed, or /uploads/...) is not a change.
  const key = storageKeyOf(url);
  if (key && key === storageKeyOf(current)) return;
  await assertOutputUrl(url, field);
}

export { isDriveLink };
