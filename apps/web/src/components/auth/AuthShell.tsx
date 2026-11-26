import React, { useRef } from 'react';
import { CalendarDays, CheckCircle2, Send } from 'lucide-react';
import { LightStreaks } from './LightStreaks';

const FEATURES = [
  { icon: CalendarDays, text: 'Plan the content calendar together' },
  { icon: CheckCircle2, text: 'Create, review and approve work in one flow' },
  { icon: Send, text: 'Track every post from idea to published' },
];

/**
 * Layout for the signed-out screens, in the app's light theme. The light-streak
 * animation fills the page (rendered inverted, see `.auth-streaks` in index.css) and a
 * card sits on top: its left half is a clear window onto the animation with the
 * product summary, its right half is frosted glass holding the form. A soft blue
 * light follows the pointer along the card's edge. Below `md` only the form shows.
 */
export const AuthShell: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const cardRef = useRef<HTMLDivElement>(null);

  // Pointer position as CSS variables: no React state, so moving the mouse never re-renders.
  const trackPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - rect.left}px`);
    el.style.setProperty('--my', `${e.clientY - rect.top}px`);
  };

  return (
    <div className="auth-light relative min-h-screen overflow-x-hidden bg-ui-canvas text-ui-text">
      {/* #221D14 is the inverse of --ui-canvas (#DDE2EB): after the invert filter the field is the app canvas. */}
      {/* Kept faint (low brightness, 55% opacity over the canvas) so the dense centre of the
          streaks stays a soft tint instead of a dark patch. */}
      <LightStreaks
        className="auth-streaks !fixed inset-0 opacity-[0.55]"
        background="#221D14"
        tint="#9DB8E6"
        brightness={45}
        hover={50}
      />
      {/* Softens the middle so the card always reads clearly. */}
      <div
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_center,rgba(221,226,235,0.55),rgba(221,226,235,0)_70%)]"
        aria-hidden="true"
      />

      <main className="relative z-10 flex min-h-screen items-center justify-center px-4 py-8 sm:py-12">
        <div ref={cardRef} onPointerMove={trackPointer} className="auth-card w-full max-w-[1020px]">
          <div className="grid grid-cols-1 overflow-hidden rounded-[31px] md:grid-cols-[1fr_1fr]">
            {/* Clear window onto the animation */}
            <aside className="relative hidden min-h-[580px] flex-col justify-between bg-white/10 p-9 md:flex">
              <img src="/haca-forge-logo.png" alt="HACA Marketing OS" className="h-8 w-auto self-start object-contain" />
              <div className="rounded-[24px] border border-white/80 bg-white/60 p-6 shadow-ui-card backdrop-blur-md">
                <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-ui-muted">Marketing workspace</p>
                <h2 className="mt-3 text-[26px] font-semibold leading-tight tracking-tight text-ui-ink">
                  Where your team's content gets made.
                </h2>
                <ul className="mt-5 space-y-3">
                  {FEATURES.map(({ icon: Icon, text }) => (
                    <li key={text} className="flex items-center gap-3 text-[13px] text-ui-text">
                      <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-ui-ink text-white">
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      {text}
                    </li>
                  ))}
                </ul>
              </div>
            </aside>

            {/* Frosted form panel */}
            <div className="flex flex-col bg-white/80 px-6 py-8 backdrop-blur-2xl sm:px-11 sm:py-10">
              <img src="/haca-forge-logo.png" alt="HACA Marketing OS" className="mb-8 h-7 w-auto self-start object-contain md:hidden" />
              {children}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};
