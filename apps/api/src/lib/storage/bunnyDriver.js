import fs from 'fs';
import { signBunnyUrl } from './bunnyToken.js';

function storageError(message, status) {
  const err = new Error(message);
  err.statusCode = 502;
  err.code = 'STORAGE_ERROR';
  err.details = { upstreamStatus: status };
  return err;
}

/**
 * The Bunny driver: Bunny Storage HTTP API through fetch (no SDK), files served by a Pull Zone
 * with token authentication.
 *   upload  PUT    https://<host>/<zone>/<key>   AccessKey header, body streamed from the temp file
 *   delete  DELETE https://<host>/<zone>/<key>
 *   stat    GET    https://<host>/<zone>/<dir>/  (the folder listing: ObjectName, Length)
 *   read    a signed Pull Zone URL (bunnyToken.js)
 * Settings come from the environment and are never logged or put in an error message.
 */
export function createBunnyDriver({ storageZone, storageHost, storageKey, cdnUrl, tokenKey, fetchImpl = fetch, timeoutMs = 15 * 60 * 1000 }) {
  // A bare host ("storage.bunnycdn.com", "uk.storage.bunnycdn.com") means HTTPS. A full URL is
  // used as given (the mock Bunny server in tests and the browser check).
  const origin = /^https?:\/\//.test(String(storageHost)) ? String(storageHost).replace(/\/+$/, '') : `https://${String(storageHost).replace(/\/+$/, '')}`;
  const base = `${origin}/${encodeURIComponent(storageZone)}`;
  const objectUrl = (key) => `${base}/${String(key).split('/').map(encodeURIComponent).join('/')}`;
  const auth = { AccessKey: storageKey };

  return {
    name: 'bunny',
    async put(key, sourcePath, { contentType = 'application/octet-stream' } = {}) {
      const { size } = fs.statSync(sourcePath);
      // Streamed from disk: a large video is never held in memory.
      const res = await fetchImpl(objectUrl(key), {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': contentType, 'Content-Length': String(size) },
        body: fs.createReadStream(sourcePath),
        duplex: 'half',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 201 && res.status !== 200) throw storageError(`File storage refused the upload (HTTP ${res.status}).`, res.status);
    },
    async remove(key) {
      const res = await fetchImpl(objectUrl(key), { method: 'DELETE', headers: auth, signal: AbortSignal.timeout(30000) });
      // 404: already gone, which is what we want.
      if (!res.ok && res.status !== 404) throw storageError(`File storage refused the delete (HTTP ${res.status}).`, res.status);
    },
    async stat(key) {
      const parts = String(key).split('/');
      const name = parts.pop();
      const res = await fetchImpl(`${objectUrl(parts.join('/'))}/`, { headers: { ...auth, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return null;
      if (!res.ok) throw storageError(`File storage could not be read (HTTP ${res.status}).`, res.status);
      const list = await res.json();
      const hit = (Array.isArray(list) ? list : []).find((o) => !o.IsDirectory && o.ObjectName === name);
      return hit ? { size: Number(hit.Length) || 0 } : null;
    },
    url(key, { ttlSeconds = 600, now = Date.now() } = {}) {
      const expires = Math.floor(now / 1000) + ttlSeconds;
      return signBunnyUrl({ cdnUrl, tokenKey, key, expires });
    },
  };
}
