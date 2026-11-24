import { env } from '../config/env.js';

/**
 * Cookie options for access and refresh tokens.
 * In production (cross-site deployment):
 *   sameSite: "none", secure: true, httpOnly: true
 * In development/test (local HTTP):
 *   sameSite: "lax", secure: false, httpOnly: true
 * Domain: undefined when COOKIE_DOMAIN is empty or not set (host-only cookie).
 */
export function getCookieOptions(maxAgeMs) {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain: (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN.trim()) || undefined,
    maxAge: maxAgeMs,
    path: '/',
  };
}

/**
 * Cookie clearing options for res.clearCookie.
 * Attributes (path, domain, secure, sameSite) must match creation attributes
 * so browsers reliably clear cookies across both same-site and cross-site contexts.
 */
export function getClearCookieOptions() {
  const isProd = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    domain: (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN.trim()) || undefined,
    path: '/',
  };
}
