import { fileUrlExpiresAt, storageKeyOf } from '@mmp/shared';
import { apiFetch } from './api';

/**
 * File URLs come from the API, never built here. With Bunny storage they are signed and expire
 * (10 minutes for work files and chat, 7 days for profile photos). When an image, video or
 * download uses an expired one, it asks the API once for a fresh URL (POST /api/files/refresh,
 * which checks access again) and retries; a second failure is left as it is. Local /uploads
 * URLs never expire, so nothing here touches them.
 */

/** A signed app file URL (it has an expiry). */
export const isSignedFileUrl = (url: string | null | undefined): url is string =>
  Boolean(url) && fileUrlExpiresAt(url) !== null && storageKeyOf(url) !== null;

/** True when a signed URL has expired, or will within `marginMs`. */
export const isExpiredFileUrl = (url: string, marginMs = 5000, now = Date.now()) => {
  const at = fileUrlExpiresAt(url);
  return at !== null && at - marginMs <= now;
};

/** A fresh URL for this file from the API (access is checked there); null when refused. */
export async function refreshFileUrl(url: string): Promise<string | null> {
  try {
    const res = await apiFetch<{ data: { url: string } }>('/api/files/refresh', { method: 'POST', body: JSON.stringify({ url }) });
    return res?.data?.url || null;
  } catch {
    return null;
  }
}

const RETRIED = 'fileUrlRetried';

/** An <img>, <video>, <audio> or <source> whose signed file URL failed: refresh it once. */
async function onMediaError(event: Event) {
  const el = event.target as HTMLElement | null;
  if (!el || !('src' in el)) return;
  const media = el as HTMLImageElement | HTMLVideoElement | HTMLSourceElement;
  const src = (media as HTMLVideoElement).currentSrc || media.src;
  if (!isSignedFileUrl(src) || media.dataset[RETRIED] === '1') return;
  media.dataset[RETRIED] = '1';
  const fresh = await refreshFileUrl(src);
  if (!fresh) return;
  if (el instanceof HTMLSourceElement) {
    el.src = fresh;
    const parent = el.parentElement as HTMLVideoElement | null;
    parent?.load?.();
    return;
  }
  if (el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
    // Keep the viewer's place: seeking after a refresh continues from the same time.
    const at = el.currentTime;
    const playing = !el.paused;
    el.src = fresh;
    el.addEventListener('loadedmetadata', () => {
      if (at) el.currentTime = at;
      if (playing) void el.play().catch(() => {});
    }, { once: true });
    return;
  }
  (el as HTMLImageElement).src = fresh;
}

/** A link to a signed file URL that has expired: get a fresh one first, then open it. */
async function onLinkClick(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0) return;
  const link = (event.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
  if (!link || !isSignedFileUrl(link.href) || !isExpiredFileUrl(link.href)) return;
  event.preventDefault();
  const newTab = link.target === '_blank' || event.ctrlKey || event.metaKey;
  // Opened now, inside the click, so the browser does not block it; filled once the URL is back.
  const tab = newTab ? window.open('', '_blank') : null;
  const fresh = await refreshFileUrl(link.href);
  if (!fresh) {
    tab?.close();
    return;
  }
  link.href = fresh;
  if (tab) tab.location.href = fresh;
  else window.location.assign(fresh);
}

let installed = false;
/** Installs the listeners once (main.tsx). Capture phase: media "error" events do not bubble. */
export function installFileUrlRefresh(root: Document = document) {
  if (installed) return;
  installed = true;
  root.addEventListener('error', (e) => void onMediaError(e), true);
  root.addEventListener('click', (e) => void onLinkClick(e as MouseEvent), true);
}

/** For tests. */
export const __test = { onMediaError, onLinkClick, reset: () => (installed = false) };
