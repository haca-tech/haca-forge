import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { PermissionKey, PermissionKeyV2 } from '@mmp/shared';
import { useAccess } from '../lib/access';

import { DataLoader } from './DataLoader';
interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredPermission?: PermissionKey | PermissionKeyV2;
  /** Read-only users are sent here instead of shown this page (e.g. My Work → /dashboard). */
  readOnlyRedirect?: string;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredPermission,
  readOnlyRedirect,
}) => {
  const { user, isAuthenticated, isLoading, hasPermission } = useAuth();
  const access = useAccess();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <DataLoader variant="page" label="Verifying security credentials..." />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (user.mustChangePassword && location.pathname !== '/settings') {
    return <Navigate to="/settings?tab=security" replace />;
  }

  if (readOnlyRedirect && access.isReadOnly) {
    return <Navigate to={readOnlyRedirect} replace />;
  }

  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
