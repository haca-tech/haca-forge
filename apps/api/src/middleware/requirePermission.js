import { can } from '@mmp/shared';

/**
 * Route guards (Phase C2): permission keys from catalog v2, answered by the shared access
 * resolver for the signed-in user's system role. The locked admin role holds every key, so
 * there is no role-name bypass here. Calendar-routed decisions are checked in the services.
 */
function unauthorized(res) {
  return res.status(401).json({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required before checking permissions.',
    },
  });
}

function forbidden(res, keys) {
  return res.status(403).json({
    error: {
      code: 'FORBIDDEN',
      message: `You do not have the required permission (${keys.join(' or ')}) to perform this action.`,
    },
  });
}

/** Each guard carries its keys (read by the end-to-end permission matrix test). */
const tagged = (guard, keys) => Object.assign(guard, { permissionKeys: keys });

export function requirePermission(permissionKey) {
  return tagged((req, res, next) => {
    if (!req.user) return unauthorized(res);
    if (can(req.user, permissionKey)) return next();
    return forbidden(res, [permissionKey]);
  }, [permissionKey]);
}

export function requireAnyPermission(...permissionKeys) {
  const keys = permissionKeys.flat();
  return tagged((req, res, next) => {
    if (!req.user) return unauthorized(res);
    if (keys.some((key) => can(req.user, key))) return next();
    return forbidden(res, keys);
  }, keys);
}
