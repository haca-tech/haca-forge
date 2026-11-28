import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Short-lived, single-purpose tokens for the two requests the browser sends straight to the API
 * server instead of through the web host's /api proxy: the live socket and file uploads.
 *
 * Why: in production the web app calls the API through its own domain (vercel.json rewrites
 * /api/* to the API), so the login cookie is first-party and browsers that block third-party
 * cookies (Safari, Brave, incognito) keep the session. Sockets and large uploads go to the API
 * host directly, where that cookie is not sent; they authenticate with one of these instead.
 *
 * Each purpose has its own signing key derived from JWT_SECRET, so a direct token is never
 * accepted as a login token by the rest of the API (and a socket token cannot upload).
 */
export const DIRECT_PURPOSES = ['socket', 'upload'];
const TTL_SECONDS = { socket: 60, upload: 120 };

const keyFor = (purpose) => crypto.createHmac('sha256', String(env.JWT_SECRET || '')).update(`direct-token:${purpose}`).digest('hex');

export function issueDirectToken(userId, purpose) {
  if (!DIRECT_PURPOSES.includes(purpose)) throw Object.assign(new Error('Unknown token purpose.'), { statusCode: 400, code: 'INVALID_PURPOSE' });
  return {
    token: jwt.sign({ userId: String(userId), purpose }, keyFor(purpose), { expiresIn: TTL_SECONDS[purpose] }),
    expiresIn: TTL_SECONDS[purpose],
  };
}

/** The user id in a valid token for this purpose; throws when it is invalid, expired or for another purpose. */
export function verifyDirectToken(token, purpose) {
  const decoded = jwt.verify(String(token || ''), keyFor(purpose));
  if (decoded.purpose !== purpose || !decoded.userId) throw new Error('Wrong token purpose.');
  return decoded.userId;
}
