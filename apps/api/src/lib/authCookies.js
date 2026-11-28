import { env } from '../config/env.js';

/**
 * Cookie options for access and refresh tokens.
 * In production (cross-site deployment):
 *   sameSite: "none", secure: true, httpOnly: true
 * In development/test (local HTTP):
 *   sameSite: "lax", secure: false, httpOnly: true
 * Domain: undefined when COOKIE_DOMAIN is empty or not set (host-only cookie).
 */
/**
 * COOKIE_DOMAIN only when the browser is on that domain. Through the web host's /api proxy the
 * browser is on the web domain, and a cookie for the API's domain would be rejected (login loop).
 */
function cookieDomainFor(req) {
  const configured = (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN.trim()) || '';
  if (!configured) return undefined;
  if (!req) return configured;
  const domain = configured.replace(/^\./, '');
  let site = '';
  try {
    site = new URL(req.get?.('origin') || '').hostname;
  } catch {
    site = req.hostname || '';
  }
  if (!site) site = req.hostname || '';
  return site === domain || site.endsWith(`.${domain}`) ? configured : undefined;
}

export function getCookieOptions(maxAgeMs, req) {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain: cookieDomainFor(req),
    maxAge: maxAgeMs,
    path: '/',
  };
}

/**
 * Cookie clearing options for res.clearCookie.
 * Attributes (path, domain, secure, sameSite) must match creation attributes
 * so browsers reliably clear cookies across both same-site and cross-site contexts.
 */
export function getClearCookieOptions(req) {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain: cookieDomainFor(req),
    path: '/',
  };
}
