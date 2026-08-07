/**
 * Canvas sizing that stays crisp on retina displays without letting a 4K
 * monitor melt the GPU. All game code works in CSS pixels; the transform
 * handles the device pixel ratio.
 */

export interface CanvasSize {
  /** CSS pixels — what game logic uses. */
  width: number;
  height: number;
  dpr: number;
}

export interface FitOptions {
  /** Upper bound on devicePixelRatio. 2 is plenty; 3 costs 2.25x the fill rate. */
  maxDpr?: number;
  /** Force integer scaling for pixel-art games. */
  pixelated?: boolean;
}

export function fitCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
  opts: FitOptions = {},
): CanvasSize {
  const maxDpr = opts.maxDpr ?? 2;
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);

  const w = Math.max(1, Math.round(cssWidth));
  const h = Math.max(1, Math.round(cssHeight));
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));

  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  if (opts.pixelated) {
    canvas.style.imageRendering = "pixelated";
  }

  return { width: w, height: h, dpr };
}

/**
 * Reset the transform so 1 unit == 1 CSS pixel. Call at the top of every
 * frame — cheaper and more reliable than balancing save/restore pairs.
 */
export function resetTransform(
  ctx: CanvasRenderingContext2D,
  dpr: number,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

export type ResizeCallback = (size: CanvasSize) => void;

/**
 * Watches the canvas's parent box and refits. Returns a disposer.
 * Uses ResizeObserver, with a window-resize fallback for ancient browsers.
 */
export function observeSize(
  element: HTMLElement,
  onResize: (w: number, h: number) => void,
): () => void {
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const box = e.contentRect;
        onResize(box.width, box.height);
      }
    });
    ro.observe(element);
    return () => ro.disconnect();
  }
  const handler = () => {
    const r = element.getBoundingClientRect();
    onResize(r.width, r.height);
  };
  window.addEventListener("resize", handler);
  handler();
  return () => window.removeEventListener("resize", handler);
}

/**
 * An offscreen canvas for pre-rendering static art (backgrounds, sprites,
 * text that never changes). Drawing a cached bitmap beats re-running a
 * hundred path ops every frame.
 */
export function createLayer(
  width: number,
  height: number,
  dpr = 1,
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx };
}
