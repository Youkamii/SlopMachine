/**
 * Canvas drawing helpers.
 *
 * Deliberately avoids `ctx.shadowBlur` and `ctx.filter` — both are 10-100x
 * the cost of a normal fill and are the usual reason a browser game drops
 * frames on a phone. Glow here is done with additive overdraw instead.
 */

import { TAU } from "./math";

/** Additive glow: three stacked passes read as light without shadowBlur. */
export function glowCircle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  intensity = 1,
) {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.14 * intensity;
  ctx.beginPath();
  ctx.arc(x, y, radius * 2.4, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 0.22 * intensity;
  ctx.beginPath();
  ctx.arc(x, y, radius * 1.5, 0, TAU);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = prev;
}

export function glowLine(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: string,
  intensity = 1,
) {
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "lighter";
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.16 * intensity;
  ctx.lineWidth = width * 3.5;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.globalAlpha = 0.3 * intensity;
  ctx.lineWidth = width * 1.8;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = prev;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

export function circle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.fill();
}

export function ring(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  width: number,
) {
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
  ctx.stroke();
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rr);
}

/** Regular polygon. `rotation` in radians; 0 puts a vertex straight up. */
export function polygon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  sides: number,
  rotation = 0,
) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const a = rotation - Math.PI / 2 + (i / sides) * TAU;
    const px = x + Math.cos(a) * radius;
    const py = y + Math.sin(a) * radius;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

export function star(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  outer: number,
  inner: number,
  points = 5,
  rotation = 0,
) {
  ctx.beginPath();
  const steps = points * 2;
  for (let i = 0; i < steps; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = rotation - Math.PI / 2 + (i / steps) * TAU;
    const px = x + Math.cos(a) * r;
    const py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

/** Capsule / thick line with rounded caps as a fillable path. */
export function capsule(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radius: number,
) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.arc(x0, y0, radius, a + Math.PI / 2, a - Math.PI / 2);
  ctx.arc(x1, y1, radius, a - Math.PI / 2, a + Math.PI / 2);
  ctx.closePath();
}

export function arrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  headSize = 8,
) {
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(
    x1 - Math.cos(a - 0.4) * headSize,
    y1 - Math.sin(a - 0.4) * headSize,
  );
  ctx.lineTo(
    x1 - Math.cos(a + 0.4) * headSize,
    y1 - Math.sin(a + 0.4) * headSize,
  );
  ctx.closePath();
  ctx.fill();
}

/** Text with a knocked-out outline — readable over any background. */
export function outlinedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  opts: {
    font?: string;
    fill?: string;
    stroke?: string;
    lineWidth?: number;
    align?: CanvasTextAlign;
    baseline?: CanvasTextBaseline;
  } = {},
) {
  const {
    font = "700 16px system-ui, sans-serif",
    fill = "#fff",
    stroke = "rgba(0,0,0,0.8)",
    lineWidth = 4,
    align = "center",
    baseline = "middle",
  } = opts;
  ctx.font = font;
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;
  ctx.strokeStyle = stroke;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** Radial darkening at the edges. Pre-render this once, not per frame. */
export function vignette(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  strength = 0.55,
  color = "0,0,0",
) {
  const g = ctx.createRadialGradient(
    w / 2,
    h / 2,
    Math.min(w, h) * 0.32,
    w / 2,
    h / 2,
    Math.max(w, h) * 0.78,
  );
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(1, `rgba(${color},${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** Horizontal CRT scanlines. Cheap: one fillRect per two rows. */
export function scanlines(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  alpha = 0.06,
  gap = 3,
) {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  for (let y = 0; y < h; y += gap) ctx.fillRect(0, y, w, 1);
}

let grainCache: HTMLCanvasElement | null = null;
let grainSeedSize = 0;

/**
 * Film grain. The noise tile is generated once and tiled — regenerating
 * per frame would cost more than the rest of the render combined.
 */
export function grain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  alpha = 0.035,
  tile = 128,
) {
  if (!grainCache || grainSeedSize !== tile) {
    const c = document.createElement("canvas");
    c.width = c.height = tile;
    const g = c.getContext("2d")!;
    const img = g.createImageData(tile, tile);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainCache = c;
    grainSeedSize = tile;
  }
  const prev = ctx.globalCompositeOperation;
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "overlay";
  const pattern = ctx.createPattern(grainCache, "repeat");
  if (pattern) {
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = prev;
}

/** Dotted or lined grid — instant "designed" background for abstract games. */
export function grid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  spacing: number,
  color: string,
  opts: { dots?: boolean; offsetX?: number; offsetY?: number; width?: number } = {},
) {
  const { dots = false, offsetX = 0, offsetY = 0, width = 1 } = opts;
  const ox = ((offsetX % spacing) + spacing) % spacing;
  const oy = ((offsetY % spacing) + spacing) % spacing;

  if (dots) {
    ctx.fillStyle = color;
    for (let x = ox; x < w + spacing; x += spacing) {
      for (let y = oy; y < h + spacing; y += spacing) {
        ctx.fillRect(x - width / 2, y - width / 2, width, width);
      }
    }
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (let x = ox; x < w + spacing; x += spacing) {
    ctx.moveTo(Math.round(x) + 0.5, 0);
    ctx.lineTo(Math.round(x) + 0.5, h);
  }
  for (let y = oy; y < h + spacing; y += spacing) {
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(w, Math.round(y) + 0.5);
  }
  ctx.stroke();
}

/**
 * Draw the same content three times with tiny RGB offsets. Use it for a
 * frame or two after an impact — permanent chromatic aberration just looks
 * like a rendering bug.
 */
export function chromaticSplit(
  ctx: CanvasRenderingContext2D,
  amount: number,
  drawFn: () => void,
) {
  if (amount <= 0.1) {
    drawFn();
    return;
  }
  const prev = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "lighter";

  ctx.save();
  ctx.translate(-amount, 0);
  ctx.globalAlpha = 0.5;
  ctx.filter = "none";
  drawFn();
  ctx.restore();

  ctx.save();
  ctx.translate(amount, 0);
  ctx.globalAlpha = 0.5;
  drawFn();
  ctx.restore();

  ctx.globalCompositeOperation = prev;
  ctx.globalAlpha = 1;
  drawFn();
}

/** Sets a fixed-width font stack tuned for HUD numbers. */
export const monoFont = (size: number, weight = 700) =>
  `${weight} ${size}px ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`;

export const uiFont = (size: number, weight = 600) =>
  `${weight} ${size}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`;
