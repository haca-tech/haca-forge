import { storageKeyOf } from '@mmp/shared';
import { fileUrl, URL_TTL_SECONDS } from './index.js';

/**
 * Stored file keys -> URLs a browser can open, on the way out of the API (REST responses and
 * socket payloads). Only fields that hold a file (names ending in "url"/"Url"/"Link") are touched,
 * and only when the value is an app file key, so text a user typed is never turned into a link.
 * A record reaches a response only after its own access rules (participants, Viewer, Published,
 * chat membership), so a URL is signed only for someone already allowed to see that record.
 * A revoked chat share card loses its file URLs.
 */
const FILE_FIELD = /(url|Url|Link)$/;
const SHARE_CARD_FILES = ['thumbnailUrl', 'previewUrl', 'downloadUrl'];

function ttlFor(field, key) {
  const photo = key.startsWith('uploads/avatars/') || /^uploads\/avatar-[^/]+$/.test(key);
  return field === 'avatarUrl' || photo ? URL_TTL_SECONDS.avatar : URL_TTL_SECONDS.file;
}

export function signFileRefs(value) {
  if (Array.isArray(value)) return value.map(signFileRefs);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  const revoked = value.isRevoked === true;
  for (const [field, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && FILE_FIELD.test(field)) {
      if (revoked && SHARE_CARD_FILES.includes(field)) {
        result[field] = '';
        continue;
      }
      const key = storageKeyOf(entry);
      result[field] = key ? fileUrl(key, { ttlSeconds: ttlFor(field, key) }) : entry;
    } else {
      result[field] = signFileRefs(entry);
    }
  }
  return result;
}

/** Express middleware: every JSON response goes through signFileRefs. */
export function signFileUrls(_req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(signFileRefs(JSON.parse(JSON.stringify(body ?? null))));
  next();
}
