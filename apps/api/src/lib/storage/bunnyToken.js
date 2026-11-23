import crypto from 'crypto';

/**
 * Bunny Pull Zone token authentication, the "Advanced" scheme Bunny recommends (HMAC-SHA256;
 * the older MD5 scheme is deprecated). From bunny.net/docs/cdn/security/token-authentication/advanced:
 *
 *   token = "HS256-" + flags + Base64URL(HMAC-SHA256(security_key, signature_path + expires + user_ip + signing_data))
 *
 * - security_key is the HMAC key (the Pull Zone's Token Authentication key), not part of the message;
 * - signature_path is the URL path (or a token_path override; not used here);
 * - expires is a UNIX time in seconds;
 * - user_ip and signing_data (sorted extra query parameters) are empty here, so flags is empty;
 * - Base64URL: "+" -> "-", "/" -> "_", "=" padding removed.
 * The signed URL is <cdn><path>?token=<token>&expires=<expires> (query-string form).
 */
export function bunnyToken(securityKey, signaturePath, expires) {
  const digest = crypto.createHmac('sha256', securityKey).update(`${signaturePath}${expires}`).digest('base64');
  return `HS256-${digest.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** The path a key is served at on the Pull Zone: "/" + key, each segment URL-encoded. */
export const cdnPathOf = (key) => `/${String(key).split('/').map(encodeURIComponent).join('/')}`;

/** A signed Pull Zone URL for this key, valid until `expires` (seconds). */
export function signBunnyUrl({ cdnUrl, tokenKey, key, expires }) {
  const base = String(cdnUrl).replace(/\/+$/, '');
  const path = cdnPathOf(key);
  return `${base}${path}?token=${encodeURIComponent(bunnyToken(tokenKey, path, expires))}&expires=${expires}`;
}

/** Checks a token the way the Pull Zone does (used by the mock Bunny server in tests). */
export function verifyBunnyToken({ tokenKey, path, token, expires, now = Date.now() }) {
  const exp = Number(expires);
  if (!token || !Number.isFinite(exp)) return false;
  if (exp * 1000 < now) return false;
  const expected = bunnyToken(tokenKey, path, exp);
  return expected.length === token.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}
