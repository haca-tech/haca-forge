import jwt from 'jsonwebtoken';
import { isKnownRole, isReadOnlyViewer, normalizeRole } from '@mmp/shared';
import { env } from '../config/env.js';
import { User } from '../modules/people/model.js';
import { defineAbilityForUser } from '../lib/permissions.js';
import { isReadOnly } from '../lib/roleAccess.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Writes the read-only heads may still make: their own account only. */
export function isOwnAccountWrite(req) {
  const path = `${req.baseUrl || ''}${req.path || ''}`;
  return (
    path.startsWith('/api/auth/') ||
    path === '/api/me' ||
    path.startsWith('/api/me/') ||
    path.startsWith('/api/notifications/') ||
    // Not a write: a fresh URL for a file the user may already see (POST only to carry the URL).
    path === '/api/files/refresh' ||
    /^\/api\/chat\/channels\/[^/]+\/(read|mute)$/.test(path)
  );
}

export async function authenticate(req, res, next) {
  try {
    const token =
      req.cookies?.accessToken ||
      req.cookies?.token ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.split(' ')[1]
        : null);

    if (!token) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication token is missing. Please sign in.',
        },
      });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, env.JWT_SECRET);
      if (decoded.role) {
        decoded.role = normalizeRole(decoded.role);
      }
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          error: {
            code: 'TOKEN_EXPIRED',
            message: 'Session has expired. Please refresh your token or log in again.',
          },
        });
      }
      return res.status(401).json({
        error: {
          code: 'INVALID_TOKEN',
          message: 'Session token is invalid.',
        },
      });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'User account associated with this token does not exist.',
        },
      });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({
        error: {
          code: 'ACCOUNT_SUSPENDED',
          message: 'Your account has been suspended. Please contact the administrator.',
        },
      });
    }

    if (user.role) {
      user.role = normalizeRole(user.role);
    }

    // An account still on a role from before Phase 12b waits for the
    // migration: no access with a role the app no longer knows.
    if (!isKnownRole(user.role)) {
      return res.status(403).json({
        error: {
          code: 'ROLE_MIGRATION_PENDING',
          message: 'Your account is being moved to the new roles. Ask an admin to finish the move.',
        },
      });
    }

    // creative_head and production_head are read-only: every write is refused, except on
    // their own account (sign-out, password, own profile and settings, notification and
    // chat read markers).
    if (isReadOnly(user) && !SAFE_METHODS.has(req.method) && !isOwnAccountWrite(req)) {
      return res.status(403).json({
        error: {
          code: 'READ_ONLY_ROLE',
          message: 'Your role can view everything but cannot make changes.',
        },
      });
    }

    req.user = user;
    req.user.userId = user._id.toString();
    req.ability = defineAbilityForUser(user);
    next();
  } catch (error) {
    next(error);
  }
}
