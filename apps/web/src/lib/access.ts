import { useMemo } from 'react';
import type { AccessUser } from '@mmp/shared';
import { useAuth } from '../context/AuthContext';
import { accessFromUser, makeAccess, type Access, type AccessInfo } from './accessCore';

export * from './accessCore';

/** The signed-in user's access. */
export function useAccess(): Access {
  const auth = useAuth() as ReturnType<typeof useAuth> & { access?: AccessInfo | null };
  const user = auth?.user as AccessUser | null | undefined;
  const fromServer = auth?.access ?? null;
  return useMemo(() => makeAccess(fromServer || accessFromUser(user), user), [fromServer, user]);
}

