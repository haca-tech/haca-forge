import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { PermissionKey, PermissionKeyV2 } from '@mmp/shared';
import { useAccess } from '../lib/access';

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
        <div className="glass-modal p-8 shadow-modal-glass flex flex-col items-center gap-4 border border-white">
          <div className="w-10 h-10 border-4 border-ui-ink border-t-transparent rounded-full animate-spin"></div>
          <p className="text-xs font-bold text-slate-700">Verifying security credentials...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (readOnlyRedirect && access.isReadOnly) {
    return <Navigate to={readOnlyRedirect} replace />;
  }

  if (requiredPermission && !hasPermission(requiredPermission)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <>{children}</>;
};
