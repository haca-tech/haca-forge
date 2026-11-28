/**
 * Live presence for the admin Live Status page: whether this tab is in view, and which
 * section of the portal it is on. Sent on connect (useSocket), when the tab is shown or
 * hidden, and when the page changes (Layout).
 */
type Emitter = { connected: boolean; emit: (event: string, data?: unknown) => unknown };
let target: Emitter | null = null;

export function setPresenceSocket(socket: Emitter | null): void {
  target = socket;
}

export function reportPresence(): void {
  if (!target?.connected || typeof document === 'undefined') return;
  target.emit('presence:state', {
    state: document.visibilityState === 'hidden' ? 'away' : 'active',
    page: window.location.pathname,
  });
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', reportPresence);
