/** Small math toolbox shared by every game. Keep it allocation-free. */

export const TAU = Math.PI * 2;
export const HALF_PI = Math.PI / 2;

export const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number) =>
  a === b ? 0 : (v - a) / (b - a);

export const remap = (
  v: number,
  inA: number,
  inB: number,
  outA: number,
  outB: number,
) => lerp(outA, outB, invLerp(inA, inB, v));

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is roughly "how much of the gap is closed per second" (0..1 exclusive).
 */
export const damp = (a: number, b: number, rate: number, dt: number) =>
  lerp(a, b, 1 - Math.pow(1 - rate, dt * 60));

export const approach = (a: number, b: number, maxDelta: number) => {
  const d = b - a;
  if (Math.abs(d) <= maxDelta) return b;
  return a + Math.sign(d) * maxDelta;
};

export const sign = (v: number) => (v < 0 ? -1 : v > 0 ? 1 : 0);

/** Angle difference wrapped to [-PI, PI]. */
export const angleDelta = (a: number, b: number) => {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

export const lerpAngle = (a: number, b: number, t: number) =>
  a + angleDelta(a, b) * t;

export const dist = (ax: number, ay: number, bx: number, by: number) =>
  Math.hypot(bx - ax, by - ay);

export const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
};

export const wrap = (v: number, lo: number, hi: number) => {
  const span = hi - lo;
  return ((((v - lo) % span) + span) % span) + lo;
};

// ---------------------------------------------------------------------------
// Easing. Signature is always (t: 0..1) => 0..1.
// ---------------------------------------------------------------------------

export const easeInQuad = (t: number) => t * t;
export const easeOutQuad = (t: number) => t * (2 - t);
export const easeInOutQuad = (t: number) =>
  t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

export const easeInCubic = (t: number) => t * t * t;
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);
export const easeInQuart = (t: number) => t * t * t * t;

export const easeOutExpo = (t: number) =>
  t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
export const easeInExpo = (t: number) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10));

export const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export const easeInBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return c3 * t * t * t - c1 * t * t;
};

export const easeOutElastic = (t: number) => {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const c4 = TAU / 3;
  return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1;
};

export const easeOutBounce = (t: number) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

/** Rises 0 -> 1 -> 0. Useful for one-shot pops. */
export const pulse = (t: number) => Math.sin(clamp01(t) * Math.PI);

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export const circleHit = (
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
) => dist2(ax, ay, bx, by) <= (ar + br) * (ar + br);

export const rectHit = (
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
) => ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

export const pointInRect = (
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
) => px >= x && px <= x + w && py >= y && py <= y + h;

/** Shortest distance from a point to a line segment. */
export const distToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) => {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return dist(px, py, ax, ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = clamp01(t);
  return dist(px, py, ax + t * dx, ay + t * dy);
};

// ---------------------------------------------------------------------------
// Value noise — cheap, deterministic, good enough for terrain/wobble.
// ---------------------------------------------------------------------------

const hash1 = (n: number) => {
  const s = Math.sin(n) * 43758.5453123;
  return s - Math.floor(s);
};

export const noise1 = (x: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return lerp(hash1(i), hash1(i + 1), u) * 2 - 1;
};

export const noise2 = (x: number, y: number) => {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash1(ix + iy * 57);
  const b = hash1(ix + 1 + iy * 57);
  const c = hash1(ix + (iy + 1) * 57);
  const d = hash1(ix + 1 + (iy + 1) * 57);
  return (lerp(lerp(a, b, ux), lerp(c, d, ux), uy) * 2 - 1);
};

/** Fractal brownian motion over noise2. */
export const fbm2 = (x: number, y: number, octaves = 4) => {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
};
