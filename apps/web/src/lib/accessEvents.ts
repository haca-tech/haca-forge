/**
 * "Your access changed" (Phase C4). The server sends `access:changed` to a person's sockets when
 * their role, status or calendar limit changes, or when a calendar's reviewers / approvers /
 * posters that include them change. The socket hook forwards it here; AuthContext listens and
 * reloads /auth/me, so menus and buttons follow without signing out. Reconnects and the tab
 * regaining focus request the same refresh.
 */
type Listener = (reason: string) => void;
const listeners = new Set<Listener>();

export function onAccessChanged(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitAccessChanged(reason = 'access:changed'): void {
  listeners.forEach((l) => l(reason));
}

/** Wires a socket's events to the refresh: `access:changed`, and every connect after the first. */
export function wireAccessEvents(socket: { on: (event: string, fn: (...args: any[]) => void) => unknown }): void {
  let connectedBefore = false;
  socket.on('access:changed', () => emitAccessChanged('access:changed'));
  socket.on('connect', () => {
    if (connectedBefore) emitAccessChanged('reconnect');
    connectedBefore = true;
  });
}
