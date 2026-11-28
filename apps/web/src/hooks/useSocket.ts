import { useEffect, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from '../context/AuthContext';
import { directApiOrigin, getDirectToken, refreshSession } from '../lib/api';
import { wireAccessEvents } from '../lib/accessEvents';

let socketInstance: Socket | null = null;

/**
 * The server closes a user's sockets when their session or access changes (logout elsewhere,
 * revoked sessions, a new role). Then: reload the signed-in user from /auth/me, so the role,
 * permissions and navigation match the server, and try to reconnect once.
 */
export async function handleServerDisconnect(
  reason: string,
  { refreshUser, reconnect }: { refreshUser?: () => Promise<void>; reconnect: () => void }
): Promise<boolean> {
  if (reason !== 'io server disconnect') return false;
  try {
    await refreshUser?.();
  } finally {
    reconnect();
  }
  return true;
}

export function useSocket() {
  let user: any = null;
  let refreshUser: (() => Promise<void>) | undefined;
  try {
    const auth = useAuth();
    user = auth?.user;
    refreshUser = auth?.refreshUser;
  } catch {
    user = null;
  }
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    // If not authenticated, disconnect existing socket
    if (!user) {
      if (socketInstance) {
        socketInstance.disconnect();
        socketInstance = null;
        setIsConnected(false);
      }
      return;
    }

    // In test environments, skip opening real socket connections
    if (process.env.NODE_ENV === 'test' || Boolean((import.meta as any)?.env?.VITEST)) {
      return;
    }

    // Connect socket if not already connected
    if (!socketInstance) {
      const socketUrl =
        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SOCKET_URL
          ? String(import.meta.env.VITE_SOCKET_URL).trim().replace(/\/+$/, '')
          : '') ||
        directApiOrigin() ||
        (typeof window !== 'undefined' ? window.location.origin : '');

      // The API host is not the web app's domain, so the login cookie is not sent with the
      // handshake: each (re)connect fetches a 60-second socket token through the same-site /api.
      const socket = io(socketUrl, {
        withCredentials: true,
        auth: (cb: (data: Record<string, unknown>) => void) => {
          getDirectToken('socket').then((socketToken) => cb(socketToken ? { socketToken } : {}));
        },
        transports: ['websocket', 'polling'],
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
      });
      socketInstance = socket;
      // access:changed and reconnects reload /auth/me (AuthContext listens).
      wireAccessEvents(socket);
      let renewedSinceLastConnect = false;

      socket.on('connect', () => {
        renewedSinceLastConnect = false;
        setIsConnected(true);
      });

      // The server closes a user's sockets when their session or access changes (logout
      // elsewhere, revoked sessions, a new role). Socket.IO does not reconnect after that:
      // reload the user (/auth/me) and try once; the handshake decides whether this browser
      // may still connect, and joins the new role's room.
      socket.on('disconnect', (reason) => {
        setIsConnected(false);
        void handleServerDisconnect(reason, {
          refreshUser,
          reconnect: () => {
            if (socketInstance === socket) socket.connect();
          },
        });
      });

      // A refused handshake is not retried by Socket.IO. If the access cookie had expired,
      // renew it once and reconnect; a second refusal in a row means the session is over.
      socket.on('connect_error', async (err) => {
        if (!err.message || !err.message.toLowerCase().includes('authentication')) return;
        setIsConnected(false);
        if (renewedSinceLastConnect) return;
        renewedSinceLastConnect = true;
        if (await refreshSession() && socketInstance === socket) socket.connect();
      });
    } else if (socketInstance.connected) {
      setIsConnected(true);
    }

    return () => {
      // Keep socket alive across component renders, disconnect only when user logs out
    };
  }, [user]);

  // Chat Socket Operations
  const joinChannel = useCallback((channelId: string) => {
    if (socketInstance && channelId) {
      socketInstance.emit('chat:join', { channelId });
    }
  }, []);

  const leaveChannel = useCallback((channelId: string) => {
    if (socketInstance && channelId) {
      socketInstance.emit('chat:leave', { channelId });
    }
  }, []);

  const emitTyping = useCallback((channelId: string, isTyping: boolean) => {
    if (socketInstance && channelId) {
      socketInstance.emit(isTyping ? 'chat:typing:start' : 'chat:typing:stop', { channelId });
    }
  }, []);

  const emitRead = useCallback((channelId: string, messageId?: string) => {
    if (socketInstance && channelId) {
      socketInstance.emit('chat:read', { channelId, messageId });
    }
  }, []);

  const on = useCallback((eventName: string, handler: Function) => {
    if (!socketInstance) return () => {};

    socketInstance.on(eventName, handler as any);
    return () => {
      if (socketInstance) {
        socketInstance.off(eventName, handler as any);
      }
    };
  }, []);

  const emit = useCallback((eventName: string, data?: any) => {
    if (socketInstance) {
      socketInstance.emit(eventName, data);
    }
  }, []);

  return {
    socket: socketInstance,
    isConnected,
    joinChannel,
    leaveChannel,
    emitTyping,
    emitRead,
    on,
    emit,
  };
}
