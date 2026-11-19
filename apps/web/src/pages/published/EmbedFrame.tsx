import React, { useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2 } from 'lucide-react';
import { isTrustedEmbedUrl, type EmbedAspect, type EmbedInfo } from '@mmp/shared';

/** How long an embed may take to load before the link card is shown instead. */
export const EMBED_LOAD_TIMEOUT_MS = 10000;

const ASPECT: Record<EmbedAspect, string> = { '9:16': '9 / 16', '4:5': '4 / 5', '16:9': '16 / 9', '1:1': '1 / 1' };

/** What each player needs, nothing more. Video players also get presentation (fullscreen). */
function sandboxFor(kind: EmbedInfo['kind']): string {
  const base = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';
  return kind === 'youtube' || kind === 'youtube_short' || kind === 'facebook_video' || kind === 'facebook_reel' ? `${base} allow-presentation` : base;
}

/** An https link we can open safely, else null (never a javascript: or http: href). */
export function safeHref(url: string | null | undefined): string | null {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** The fallback: the site and "Open original ↗". */
export const LinkCard: React.FC<{ liveUrl: string; reason?: string }> = ({ liveUrl, reason }) => {
  const href = safeHref(liveUrl);
  return (
    <div className="w-full aspect-[4/3] rounded-ui-card border border-ui-line bg-white/60 flex flex-col items-center justify-center gap-2 p-4 text-center" data-testid="link-card">
      <Link2 className="w-6 h-6 text-ui-muted" aria-hidden="true" />
      <p className="text-sm font-semibold text-ui-ink break-all">{hostOf(liveUrl) || 'Link'}</p>
      {reason && <p className="text-xs text-ui-muted">{reason}</p>}
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="ui-btn ui-btn-secondary h-11 gap-1.5">
          Open original <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : (
        <p className="text-xs text-ui-muted">No link to open.</p>
      )}
    </div>
  );
};

interface Props {
  embed: EmbedInfo;
  liveUrl: string;
  title: string;
  /** Load straight away (the larger view), instead of when scrolled into view. */
  eager?: boolean;
}

/**
 * An official embed, loaded only when scrolled into view, sandboxed, at a fixed aspect ratio.
 * Frames only an embed URL of the exact shape toEmbed produces; anything else, or an embed
 * that has not loaded in time, shows the link card.
 */
export const EmbedFrame: React.FC<Props> = ({ embed, liveUrl, title, eager = false }) => {
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(eager);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const trusted = embed.kind !== 'link' && isTrustedEmbedUrl(embed.embedUrl);

  useEffect(() => {
    if (!trusted || visible) return;
    const el = holder.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '200px' }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [trusted, visible]);

  useEffect(() => {
    if (!visible || loaded || failed || !trusted) return;
    const t = setTimeout(() => setFailed(true), EMBED_LOAD_TIMEOUT_MS);
    return () => clearTimeout(t);
  }, [visible, loaded, failed, trusted]);

  if (!trusted) return <LinkCard liveUrl={liveUrl} />;
  if (failed) return <LinkCard liveUrl={liveUrl} reason="The post could not be shown here." />;

  return (
    <div ref={holder} className="w-full rounded-ui-card overflow-hidden bg-white/40 border border-ui-line" style={{ aspectRatio: ASPECT[embed.aspect || '1:1'] }}>
      {visible ? (
        <iframe
          src={embed.embedUrl}
          title={`${embed.label}: ${title}`}
          loading="lazy"
          sandbox={sandboxFor(embed.kind)}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="encrypted-media; picture-in-picture; fullscreen"
          className="w-full h-full border-0"
          // Browsers fire no error event for a frame; a frame that never loads hits the time limit.
          onLoad={() => setLoaded(true)}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-xs text-ui-muted">{embed.label}</div>
      )}
    </div>
  );
};
