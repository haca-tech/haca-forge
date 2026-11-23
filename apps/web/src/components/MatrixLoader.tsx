/**
 * MatrixLoader: a glowing dot-matrix "Tide" loader (a sloshing tank of light that fills and
 * drains, with caustics and bubbles). Adapted from Originkit's MatrixLoader, keeping only the
 * Tide pattern and its preset look, without pointer effects, and sized for inline use.
 *
 * - One cycle every 3.1 s at speed 5. Each dot carries one 0..1 level that sets its diameter
 *   (12 % → 96 % of the pitch) and its colour (idle → lit); well-lit dots get a soft halo over a
 *   faint bloom.
 * - Drawn on a canvas twice the grid's size, so halos are never clipped; the layout box is the
 *   grid itself (`size`), and the canvas overflows it without taking space.
 * - Pauses when off screen or in a hidden tab; under prefers-reduced-motion it draws one still frame.
 *
 * Use DataLoader (./DataLoader) for loading states; this is the animation only.
 */
import React, { useEffect, useRef } from 'react';

const CYCLE_S = 3.1;
/** Colour stays idle until the dot is this lit. */
const COLOR_ONSET = 0.2;
/** The canvas is twice the grid, so halos and swollen edge dots are never clipped. */
const GRID_IN_BOX = 0.5;
/** Peak opacity of one fully lit dot's bloom at glow 5 and bloom 100 %. */
const BLOOM_ALPHA = 0.12;
/** Water level range: never quite empty or full, so a surface is always in view. */
const LEVEL_LOW = 0.04;
const LEVEL_HIGH = 0.9;
/** Phase shown under prefers-reduced-motion. */
const REST_PHASE = 0.3;
const LUT_STEPS = 64;

/** The preset look (Originkit "tide" preset). */
const LOOK = {
  idleSize: 12,
  litSize: 96,
  idleColor: '#000000',
  litColor: '#747474',
  glow: 5,
  colorCurve: 0.5,
  haloReach: 116,
  bloom: 51,
  bloomReach: 0.5,
  waves: 5,
  bubbles: 4,
};

const TAU = Math.PI * 2;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const s = clamp01(x);
  return s * s * (3 - 2 * s);
};
const wrap01 = (x: number) => x - Math.floor(x);
const hash3 = (a: number, b: number, c: number) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

/** Tide: fills E (row-major, n×n) with each dot's level for clock t (in cycles). */
function patTide(E: Float32Array, n: number, t: number) {
  // Level eases up and back down once per cycle.
  const level = LEVEL_LOW + (LEVEL_HIGH - LEVEL_LOW) * (0.5 - 0.5 * Math.cos(TAU * t));
  const A = 0.014 * LOOK.waves; // surface swell, in grid heights
  // The water leans as it rushes in and out (fastest at quarter cycles).
  const lean = 0.024 * LOOK.waves * Math.sin(TAU * t);
  const bubbleShare = (LOOK.bubbles / 10) * 0.75;
  for (let i = 0; i < n; i++) {
    const x = n > 1 ? i / (n - 1) : 0.5;
    const surf = level + A * (0.6 * Math.sin(TAU * (1.1 * x - 2 * t)) + 0.4 * Math.sin(TAU * (1.9 * x + 3 * t + 0.3))) + lean * (x - 0.5);
    // A bubble climbs this column from the floor to the surface, 2 or 3 times a cycle.
    const hb = hash3(i, 5, 11);
    const hasBubble = hb < bubbleShare;
    const bubbleH = wrap01((hb < bubbleShare * 0.5 ? 3 : 2) * t + hash3(i, 6, 11)) * surf;
    for (let j = 0; j < n; j++) {
      const h = (n - 1 - j + 0.5) / n;
      const depth = (surf - h) * n; // dots under the surface
      let e = smooth(depth + 0.5);
      if (e <= 0) {
        E[j * n + i] = 0;
        continue;
      }
      // Below the crest the water dims a little and plays slow caustics.
      const caustic = 0.5 + 0.5 * Math.sin(TAU * (1.3 * x + 0.8 * h - 2 * t)) * Math.cos(TAU * (0.7 * x - 1.1 * h + t));
      e *= 1 - smooth((depth - 0.5) / 1.5) * (0.28 - 0.28 * caustic);
      if (hasBubble && bubbleH < surf - 0.5 / n) e *= 1 - 0.7 * smooth(1 - (Math.abs(h - bubbleH) * n) / 0.8);
      E[j * n + i] = e;
    }
  }
}

/** Any CSS colour → [r, g, b, a]. */
function parseColor(ctx: CanvasRenderingContext2D, css: string): [number, number, number, number] {
  ctx.fillStyle = '#000';
  ctx.fillStyle = css;
  const s = String(ctx.fillStyle);
  if (s[0] === '#') return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 1];
  const p = s.slice(s.indexOf('(') + 1, -1).split(',').map(Number);
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/** The colour ramp and the two glow sprites, built once per canvas. */
function buildLook(ctx: CanvasRenderingContext2D) {
  const a = parseColor(ctx, LOOK.idleColor);
  const b = parseColor(ctx, LOOK.litColor);
  const lut: string[] = [];
  for (let s = 0; s <= LUT_STEPS; s++) {
    const m = Math.pow(clamp01((s / LUT_STEPS - COLOR_ONSET) / (1 - COLOR_ONSET)), LOOK.colorCurve);
    const mix = (k: number) => Math.round(a[k] + (b[k] - a[k]) * m);
    lut.push(`rgba(${mix(0)},${mix(1)},${mix(2)},${(a[3] + (b[3] - a[3]) * m).toFixed(3)})`);
  }
  const sprite = document.createElement('canvas');
  sprite.width = sprite.height = 64;
  const sc = sprite.getContext('2d');
  if (sc) {
    // Halo: the lit colour lifted toward white.
    const g = sc.createRadialGradient(32, 32, 0, 32, 32, 32);
    const rgb = [0, 1, 2].map((k) => Math.round(b[k] + (255 - b[k]) * 0.4)).join(',');
    g.addColorStop(0, `rgba(${rgb},1)`);
    g.addColorStop(0.55, `rgba(${rgb},0.6)`);
    g.addColorStop(0.7, `rgba(${rgb},0.25)`);
    g.addColorStop(0.85, `rgba(${rgb},0.07)`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    sc.fillStyle = g;
    sc.fillRect(0, 0, 64, 64);
  }
  const bloomSprite = document.createElement('canvas');
  bloomSprite.width = bloomSprite.height = 64;
  const bc = bloomSprite.getContext('2d');
  if (bc) {
    // Bloom: a wide, faint Gaussian haze in the lit colour that pools between lit dots.
    const g = bc.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (let q = 0; q <= 8; q++) {
      g.addColorStop(q / 8, `rgba(${b[0]},${b[1]},${b[2]},${(Math.exp(-((q / 8) * (q / 8)) * 4.5) - Math.exp(-4.5)).toFixed(4)})`);
    }
    bc.fillStyle = g;
    bc.fillRect(0, 0, 64, 64);
  }
  return { lut, sprite, bloomSprite };
}

export interface MatrixLoaderProps {
  /** Width of the dot grid in CSS px (the space it takes in the layout). */
  size?: number;
  /** Dots per side. */
  dots?: number;
  /** 0–10; 5 plays one cycle every 3.1 s. */
  speed?: number;
  className?: string;
  style?: React.CSSProperties;
}

export const MatrixLoader: React.FC<MatrixLoaderProps> = ({ size = 48, dots = 15, speed = 5.3, className = '', style }) => {
  const rootRef = useRef<HTMLSpanElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    // jsdom (tests) has no canvas: draw nothing.
    if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const n = Math.max(2, Math.round(dots));
    const E = new Float32Array(n * n);
    const { lut, sprite, bloomSprite } = buildLook(ctx);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const bw = Math.max(1, Math.round((size / GRID_IN_BOX) * dpr));
    canvas.width = bw;
    canvas.height = bw;

    const grid = GRID_IN_BOX * bw;
    const pitch = grid / n;
    const c = (n - 1) / 2;
    const o = bw / 2;
    const r0 = (LOOK.idleSize / 100) * pitch * 0.5;
    const r1 = (LOOK.litSize / 100) * pitch * 0.5;
    const halo = LOOK.haloReach / 100;
    const glow = LOOK.glow / 5;
    const bloomA = glow * (LOOK.bloom / 100) * BLOOM_ALPHA;
    const BR = LOOK.bloomReach * pitch;

    const draw = (t: number) => {
      patTide(E, n, t);
      ctx.clearRect(0, 0, bw, bw);
      // Bloom and halos first (additive), then crisp discs over them.
      ctx.globalCompositeOperation = 'lighter';
      for (let k = 0; k < n * n; k++) {
        const e = E[k];
        const x = o + ((k % n) - c) * pitch;
        const y = o + (Math.floor(k / n) - c) * pitch;
        if (bloomA > 0 && e > 0.02) {
          ctx.globalAlpha = Math.min(1, bloomA * e);
          ctx.drawImage(bloomSprite, x - BR, y - BR, 2 * BR, 2 * BR);
        }
        const g = clamp01((e - 0.3) / 0.7);
        if (glow > 0 && halo > 1 && g > 0) {
          const R = (r0 + (r1 - r0) * e) * halo;
          ctx.globalAlpha = Math.min(1, 0.8 * glow * g * Math.sqrt(g));
          ctx.drawImage(sprite, x - R, y - R, 2 * R, 2 * R);
        }
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      for (let k = 0; k < n * n; k++) {
        const e = E[k];
        const r = r0 + (r1 - r0) * e;
        if (r <= 0) continue;
        ctx.fillStyle = lut[Math.round(e * LUT_STEPS)];
        ctx.beginPath();
        ctx.arc(o + ((k % n) - c) * pitch, o + (Math.floor(k / n) - c) * pitch, r, 0, TAU);
        ctx.fill();
      }
    };

    let clock = REST_PHASE;
    draw(clock); // first paint at once, so the dots never show empty
    if (reduce || speed <= 0) return;

    const rate = speed / 5;
    let raf = 0;
    let last = -1;
    let visible = true;
    const tick = (now: number) => {
      raf = 0;
      const dt = last < 0 ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      clock += (dt * rate) / CYCLE_S;
      draw(clock);
      if (visible && !document.hidden) raf = requestAnimationFrame(tick);
      else last = -1;
    };
    const wake = () => {
      if (!raf && visible && !document.hidden) raf = requestAnimationFrame(tick);
    };
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            visible = entries[entries.length - 1].isIntersecting;
            if (visible) wake();
          })
        : null;
    io?.observe(root);
    const onVisibility = () => !document.hidden && wake();
    document.addEventListener('visibilitychange', onVisibility);
    wake();
    return () => {
      cancelAnimationFrame(raf);
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [size, dots, speed]);

  return (
    <span
      ref={rootRef}
      aria-hidden="true"
      className={`relative inline-block shrink-0 align-middle ${className}`}
      style={{ width: size, height: size, ...style }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: 'absolute',
          left: '50%',
          top: '50%',
          width: size / GRID_IN_BOX,
          height: size / GRID_IN_BOX,
          transform: 'translate(-50%, -50%)',
          pointerEvents: 'none',
        }}
      />
    </span>
  );
};

export default MatrixLoader;
