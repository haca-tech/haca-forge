import crypto from 'crypto';
import { storageKeyOf } from '@mmp/shared';
import { env } from '../../config/env.js';
import { createLocalDriver } from './localDriver.js';
import { createBunnyDriver } from './bunnyDriver.js';

/**
 * One place for uploaded files (docs/STORAGE.md). STORAGE_DRIVER picks the driver:
 *   local (default): apps/api/uploads, served at /uploads (today's behaviour);
 *   bunny: Bunny Storage, served through a Pull Zone with signed, expiring URLs.
 * Records store a storage key ("uploads/2026/11/<random>.mp4"), never a URL. Older records with
 * "/uploads/..." mean the same key.
 */

/** How long a signed URL works: 10 minutes for work files and chat, 7 days for profile photos. */
export const URL_TTL_SECONDS = { file: 10 * 60, avatar: 7 * 24 * 60 * 60 };

function driverFromEnv() {
  if (env.STORAGE_DRIVER === 'bunny') {
    return createBunnyDriver({
      storageZone: env.BUNNY_STORAGE_ZONE,
      storageHost: env.BUNNY_STORAGE_HOST,
      storageKey: env.BUNNY_STORAGE_KEY,
      cdnUrl: env.BUNNY_CDN_URL,
      tokenKey: env.BUNNY_TOKEN_KEY,
    });
  }
  return createLocalDriver();
}

let driver = driverFromEnv();

/** The active driver. Tests swap it with setStorageDriver. */
export const storage = () => driver;
export function setStorageDriver(next) {
  const previous = driver;
  driver = next || driverFromEnv();
  return previous;
}

export { storageKeyOf };

/** A new key: uploads/<yyyy>/<mm>/<prefix><random><ext>. */
export function newFileKey(ext, { prefix = '', now = new Date() } = {}) {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `uploads/${yyyy}/${mm}/${prefix}${crypto.randomUUID()}${ext}`;
}
export const newAvatarKey = (ext) => `uploads/avatars/avatar-${crypto.randomUUID()}${ext}`;

/** The URL a viewer is given for a stored value: local "/uploads/..." or a signed CDN URL. Non-file values pass through. */
export function fileUrl(value, { ttlSeconds = URL_TTL_SECONDS.file } = {}) {
  const key = storageKeyOf(value);
  if (!key) return value;
  return driver.url(key, { ttlSeconds });
}

export const putFile = (key, sourcePath, opts) => driver.put(key, sourcePath, opts);
export const removeFile = (key) => driver.remove(key);
export const statFile = (key) => driver.stat(key);
