import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { apiFetch, clearLegacyTokens } from '../lib/api';
import type { UserRole, PermissionKey } from '@mmp/shared';
import { accessFromUser, type AccessInfo } from '../lib/accessCore';

export interface User {
  id: string;
  _id?: string;
  userId?: string;
  name: string;
  email: string;
  role: UserRole;
  department?: string;
  departmentId?: string;
  teamId?: string;
  team?: string;
  skills: string[];
  capacity: number;
  attendance: string;
  jobRole?: string;
  workPreferences?: string[];
  avatarUrl?: string | null;
  avatarStorageId?: string | null;
  preferredName?: string;
  phone?: string;
  whatsappNumber?: string;
  languages?: string[];
  about?: string;
  preferences?: {
    startPage?: 'Home' | 'My Work' | 'Calendar';
    dateFormat?: 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYY-MM-DD';
    timeFormat?: '12h' | '24h';
    weekStart?: 'Monday' | 'Sunday';
  };
  notificationPrefs?: Record<string, { inApp: boolean; email: boolean }>;
  profileCompletedAt?: string | null;
  lastLoginAt?: string | null;
  createdAt?: string;
}

interface AuthContextType {
  user: User | null;
  /** Catalog-v2 permission keys (from the access block). */
  permissions: PermissionKey[];
  /** The user's access (permissions, calendars per routed permission, role attributes); null until loaded. */
  access?: AccessInfo | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (credentials: { email: string; password: string }) => Promise<User>;
  logout: () => Promise<void>;
  hasPermission: (permission: PermissionKey) => boolean;
  refreshUser: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [permissions, setPermissions] = useState<PermissionKey[]>([]);
  const [access, setAccess] = useState<AccessInfo | null>(null);
  const applyAccess = (data: { permissions?: PermissionKey[]; access?: AccessInfo | null }) => {
    setAccess(data.access || null);
    setPermissions(((data.access?.permissions as PermissionKey[]) || data.permissions || []) as PermissionKey[]);
  };
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const refreshUser = useCallback(async () => {
    try {
      const data = await apiFetch<{ user: User; role: UserRole; permissions: PermissionKey[]; access?: AccessInfo }>('/auth/me');
      setUser(data.user);
      applyAccess(data);
    } catch {
      setUser(null);
      setPermissions([]);
      setAccess(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    clearLegacyTokens();
    refreshUser();
  }, [refreshUser]);

  const login = async (credentials: { email: string; password: string }) => {
    setIsLoading(true);
    try {
      // The API sets httpOnly login cookies; nothing is kept in browser storage.
      const data = await apiFetch<{ user: User; permissions: PermissionKey[]; access?: AccessInfo }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      });
      setUser(data.user);
      applyAccess(data);
      return data.user;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      clearLegacyTokens();
      setUser(null);
      setPermissions([]);
      setAccess(null);
    }
  };

  const hasPermission = (permission: PermissionKey): boolean => {
    if (!user) return false;
    // The access block's keys; without one (older responses), the keys the role holds.
    const keys = access?.permissions ?? (permissions.length ? permissions : accessFromUser(user)?.permissions ?? []);
    return keys.includes(permission);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        permissions,
        access,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        hasPermission,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function usePermission(permission: PermissionKey) {
  const { hasPermission } = useAuth();
  return hasPermission(permission);
}
