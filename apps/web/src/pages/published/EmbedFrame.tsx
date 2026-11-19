import React, { useEffect, useRef, useState } from 'react';
import { Link2 } from 'lucide-react';
import { isTrustedEmbedUrl, type EmbedAspect, type EmbedInfo } from '@mmp/shared';

/** How long an embed may take to load before the link card is shown instead. */
export const EMBED_LOAD_TIMEOUT_MS = 10000;

/**
 * The media box: the same fixed height on every card, whatever it holds (an embed, a Drive or
 * final-asset preview, or a link card): 480px on a phone, 520px on a tablet, 560px on a desktop.
 * The larger view uses a taller box. Rounded, clipped, and its own stacking context, so a frame
 * never paints outside it (or over the page header).
 */
export const MEDIA_BOX_HEIGHT = { card: 'h-[480px] sm:h-[520px] xl:h-[560px]', large: 'h-[min(78vh,720px)]' } as const;
export type MediaSize = keyof typeof MEDIA_BOX_HEIGHT;

/** Width over height for each aspect. */
const RATIO: Record<EmbedAspect, number> = { '9:16': 9 / 16, '4:5': 4 / 5, '16:9': 16 / 9, '1:1': 1 };

/** Instagram's embed is at most 540px wide; its full height is the header, the 4:5 media and the footer. */
const IG_MAX_WIDTH = 540;
export function instagramEmbedHeight(width: number): number {
  const w = Math.max(240, Math.min(IG_MAX_WIDTH, Math.round(width)));
  return Math.round(54 + w * 1.25 + 212);
}

/** What each player needs, nothing more. Video players also get presentation (fullscreen). */
function sandboxFor(kind: EmbedInfo['kind']): string {
  const base = 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox';
  return kind === 'youtube' || kind === 'youtube_short' || kind === 'facebook_video' || kind === 'facebook_reel' || kind === 'drive' ? `${base} allow-presentation` : base;
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

/** The fixed-height box every preview fills. */
export const MediaBox: React.FC<{ size?: MediaSize; children: React.ReactNode; boxRef?: React.Ref<HTMLDivElement> }> = ({ size = 'card', children, boxRef }) => (
  <div
    ref={boxRef}
    data-testid="media-box"
    className={`relative isolate w-full overflow-hidden rounded-ui-card border border-ui-line bg-white/40 ${MEDIA_BOX_HEIGHT[size]}`}
    style={{ containerType: 'size' }}
  >
    {children}
  </div>
);

/** The fallback: the site's name, centred in the box. The card footer has "Open original". */
export const LinkCard: React.FC<{ liveUrl: string; reason?: string }> = ({ liveUrl, reason }) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center bg-white/60" data-testid="link-card">
    <Link2 className="w-7 h-7 text-ui-muted" aria-hidden="true" />
    <p className="text-sm font-semibold text-ui-ink break-all">{hostOf(liveUrl) || 'Link'}</p>
    {reason && <p className="text-xs text-ui-muted">{reason}</p>}
    {!safeHref(liveUrl) && <p className="text-xs text-ui-muted">No link to open.</p>}
  </div>
);

interface Props {
  embed: EmbedInfo;
  liveUrl: string;
  title: string;
  /** Load straight away (the larger view), instead of when scrolled into view. */
  eager?: boolean;
  /** Shown under the box, e.g. "Final video" when the card falls back to the approved output. */
  caption?: string;
  size?: MediaSize;
}

/** Drive files play only for people the file is shared with. */
export const DRIVE_NOTE = 'Plays only if the file is shared with you.';

/**
 * An official embed in the fixed media box, loaded only when scrolled into view, sandboxed,
 * never scrolling inside. Instagram is sized to its full embed height for the box width, centred,
 * with anything taller clipped at the bottom; the other players are centred at their aspect
 * ratio. Frames only an embed URL of the exact shape toEmbed produces; anything else, or an
 * embed that has not loaded in time, shows the link card.
 */
export const EmbedFrame: React.FC<Props> = ({ embed, liveUrl, title, eager = false, caption, size = 'card' }) => {
  const holder = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(eager);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [boxWidth, setBoxWidth] = useState(360);
  const [igHeight, setIgHeight] = useState<number | null>(null);
  const trusted = embed.kind !== 'link' && isTrustedEmbedUrl(embed.embedUrl);
  const isInstagram = embed.kind === 'instagram_reel' || embed.kind === 'instagram_post';

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

  // Instagram: follow the box width, and take the height Instagram reports for its own frame.
  useEffect(() => {
    if (!isInstagram) return;
    const el = holder.current;
    if (!el) return;
    setBoxWidth(el.clientWidth || 360);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth || 360));
    ro.observe(el);
    return () => ro.disconnect();
  }, [isInstagram]);
  useEffect(() => {
    if (!isInstagram) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== 'https://www.instagram.com' || e.source !== frameRef.current?.contentWindow) return;
      try {
        const data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
        const h = Number(data?.details?.height);
        if (data?.type === 'MEASURE' && h > 200 && h < 4000) setIgHeight(Math.round(h));
      } catch {
        // Not a measure message.
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [isInstagram]);

  const below = (
    <>
      {caption && <p className="text-[11px] font-semibold uppercase tracking-wide text-ui-muted" data-testid="preview-caption">{caption}</p>}
      {trusted && !failed && embed.kind === 'drive' && <p className="text-xs text-ui-muted" data-testid="drive-note">{DRIVE_NOTE}</p>}
    </>
  );

  if (!trusted || failed) {
    return (
      <>
        <MediaBox size={size}>
          <LinkCard liveUrl={liveUrl} reason={failed ? 'The post could not be shown here.' : undefined} />
        </MediaBox>
        {below}
      </>
    );
  }

  const frameProps = {
    ref: frameRef,
    src: embed.embedUrl,
    title: `${embed.label}: ${title}`,
    loading: 'lazy' as const,
    sandbox: sandboxFor(embed.kind),
    referrerPolicy: 'strict-origin-when-cross-origin' as const,
    allow: 'encrypted-media; picture-in-picture; fullscreen',
    scrolling: 'no',
    // Browsers fire no error event for a frame; a frame that never loads hits the time limit.
    onLoad: () => setLoaded(true),
  };
  const ratio = RATIO[embed.aspect || '1:1'];

  return (
    <>
      <MediaBox size={size} boxRef={holder}>
        {/* "safe center": centred when it fits, top-aligned (clipped at the bottom) when taller. */}
        <div className="absolute inset-0 flex justify-center" style={{ alignItems: 'safe center' }} data-testid="media-stage">
          {!visible ? (
            <div className="self-center text-xs text-ui-muted">{embed.label}</div>
          ) : isInstagram ? (
            <iframe
              {...frameProps}
              className="block shrink-0 border-0 bg-white"
              style={{ width: `${Math.min(IG_MAX_WIDTH, boxWidth)}px`, height: `${igHeight ?? instagramEmbedHeight(boxWidth)}px` }}
            />
          ) : (
            <div
              className="shrink-0"
              data-testid="media-aspect"
              style={{ aspectRatio: String(ratio), width: `min(100cqw, calc(100cqh * ${ratio}))` }}
            >
              <iframe {...frameProps} className="block w-full h-full border-0" />
            </div>
          )}
        </div>
      </MediaBox>
      {below}
    </>
  );
};
