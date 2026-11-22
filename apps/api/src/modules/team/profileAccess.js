import { hasPermission } from '../../lib/roleAccess.js';

// Middleware: allow access if user has 'team.profile.view' OR is accessing their own profile (:id === req.user._id)
// If a executive (worker) tries to access someone else's ID, return 404 (strictly anti-harvesting).
export function requireProfileAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  }

  if (hasPermission(req.user, 'team.profile.view')) {
    return next();
  }

  const userIdStr = (req.user._id || req.user.id || req.user.userId)?.toString();
  const targetIdStr = req.params.id?.toString();

  if (userIdStr && targetIdStr && userIdStr === targetIdStr) {
    return next();
  }

  // Worker attempting to access another profile -> 404 Not Found
  return res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Profile not found',
    },
  });
}
