/**
 * Color helpers. Games define their own palettes — this file only supplies
 * the manipulation primitives and a few starting points that are known to
 * look good together, so nothing here ever ships a default purple gradient.
 */

export const hsl = (h: number, s: number, l: number, a = 1) =>
  a >= 1 ? `hsl(${h} ${s}% ${l}%)` : `hsl(${h} ${s}% ${l}% / ${a})`;

/** Perceptually even lightness ramps. Wide browser support since 2023. */
export const oklch = (l: number, c: number, h: number, a = 1) =>
  a >= 1 ? `oklch(${l} ${c} ${h})` : `oklch(${l} ${c} ${h} / ${a})`;

export const rgba = (r: number, g: number, b: number, a = 1) =>
  `rgba(${r | 0} ${g | 0} ${b | 0} / ${a})`;

const hexToRgb = (hex: string): [number, number, number] => {
  let h = hex.replace("#", "");
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const toHex = (n: number) =>
  Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

/** "#ff6b35" + 0.4 -> "rgba(255 107 53 / 0.4)". Cheap enough for per-frame use. */
export function withAlpha(hex: string, alpha: number): string {
  if (hex.startsWith("rgba") || hex.startsWith("hsl") || hex.startsWith("oklch")) {
    return hex;
  }
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r} ${g} ${b} / ${alpha})`;
}

export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  return `#${toHex(ar + (br - ar) * t)}${toHex(ag + (bg - ag) * t)}${toHex(
    ab + (bb - ab) * t,
  )}`;
}

export function lighten(hex: string, amount: number): string {
  return mix(hex, "#ffffff", amount);
}

export function darken(hex: string, amount: number): string {
  return mix(hex, "#000000", amount);
}

/** Rotate a hex color's hue. Useful for procedural enemy/level variation. */
export function shiftHue(hex: string, degrees: number): string {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  h = (h * 360 + degrees + 360) % 360;
  return hsl(h, s * 100, l * 100);
}

/**
 * Vertical gradient helper — two lines instead of five, and it keeps games
 * from re-creating gradient objects inside hot loops by mistake.
 */
export function vgrad(
  ctx: CanvasRenderingContext2D,
  x: number,
  y0: number,
  y1: number,
  stops: Array<[number, string]>,
): CanvasGradient {
  const g = ctx.createLinearGradient(x, y0, x, y1);
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

export function rgrad(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r0: number,
  r1: number,
  stops: Array<[number, string]>,
): CanvasGradient {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  for (const [at, color] of stops) g.addColorStop(at, color);
  return g;
}

/**
 * Curated palettes. Deliberately not the framework defaults — these are
 * built around one dominant hue plus a single hot accent, which is what
 * makes a small game read as designed rather than generated.
 */
export const PALETTES = {
  /** Cold industrial blue with a sodium-lamp accent. */
  vault: {
    bg: "#0a0e14",
    deep: "#050810",
    surface: "#141c26",
    line: "#243447",
    dim: "#4a6076",
    text: "#dce7f0",
    accent: "#ffb347",
    hot: "#ff5a3c",
    cool: "#4fc3f7",
  },
  /** Warm paper with ink — good for puzzle and word games. */
  paper: {
    bg: "#f4f1e8",
    deep: "#e8e3d5",
    surface: "#ffffff",
    line: "#d6cfbc",
    dim: "#9a917c",
    text: "#1f1c17",
    accent: "#e2452e",
    hot: "#f0a202",
    cool: "#2d6a6f",
  },
  /** Phosphor terminal. */
  phosphor: {
    bg: "#03130a",
    deep: "#000804",
    surface: "#0a2416",
    line: "#124a3a",
    dim: "#2f6b45",
    text: "#7dffb0",
    accent: "#c6f24e",
    hot: "#ff4d6d",
    cool: "#38d9d9",
  },
  /** Deep magenta night with electric cyan. */
  neon: {
    bg: "#0d0618",
    deep: "#060310",
    surface: "#1b0f2e",
    line: "#33205c",
    dim: "#6b4fa0",
    text: "#f0e6ff",
    accent: "#00f5d4",
    hot: "#ff2e88",
    cool: "#7b61ff",
  },
  /** Desert / clay — earthy, low contrast, calm. */
  clay: {
    bg: "#1a1210",
    deep: "#0d0908",
    surface: "#2b1e19",
    line: "#453029",
    dim: "#7a5c4d",
    text: "#f0e0d0",
    accent: "#e07a5f",
    hot: "#f2cc8f",
    cool: "#81b29a",
  },
} as const;

export type PaletteName = keyof typeof PALETTES;
export type Palette = (typeof PALETTES)[PaletteName];
