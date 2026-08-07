/**
 * A 2D drawing surface for WebGL games.
 *
 * A canvas can only ever hand out one kind of context, so a three.js game can
 * never call getContext("2d") on the canvas it renders into. That normally
 * forces the HUD out into the DOM, which means a bespoke React component per
 * game and a state round-trip every frame.
 *
 * This keeps it in the game instead: an offscreen 2D canvas is drawn with the
 * ordinary Canvas2D API, uploaded as a texture, and blitted over the finished
 * frame as a full-screen quad. Games get real text, gradients and paths in a
 * HUD that is part of the game file rather than part of the shell.
 *
 *     const hud = new Overlay(renderer);
 *     // per frame, after composer.render():
 *     const g = hud.begin();
 *     g.fillStyle = "#fff";
 *     g.fillText("SCORE", 20, 40);
 *     hud.commit(renderer);
 *
 * Drawn in CSS pixels — the device-pixel scaling is applied for you.
 */

import * as THREE from "three";

/** HUD text stays sharp well below the 2× the scene renders at. */
const HUD_DPR_CAP = 1.5;

export class Overlay {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;

  private texture: THREE.CanvasTexture;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;
  private mesh: THREE.Mesh;
  private material: THREE.MeshBasicMaterial;

  private w = 1;
  private h = 1;
  private scale = 1;
  /** Nothing was drawn this frame — skip the upload and the draw call. */
  private touched = false;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1;
    this.canvas.height = 1;
    this.ctx = this.canvas.getContext("2d") as CanvasRenderingContext2D;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this.material = new THREE.MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      // The HUD is composited over an already-tone-mapped frame, so it must
      // not be tone-mapped a second time or every white goes grey.
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;

    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  /** CSS-pixel size of the drawing surface. */
  get width() {
    return this.w;
  }
  get height() {
    return this.h;
  }

  resize(width: number, height: number, dpr: number) {
    const scale = Math.min(dpr, HUD_DPR_CAP);
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));
    if (cw === this.canvas.width && ch === this.canvas.height) return;
    this.canvas.width = cw;
    this.canvas.height = ch;
    this.w = width;
    this.h = height;
    this.scale = scale;
  }

  /**
   * Clears the surface and returns a context already transformed into CSS
   * pixels. Call this every frame you intend to draw a HUD.
   */
  begin(): CanvasRenderingContext2D {
    const g = this.ctx;
    // Assigning width would work too, but resetting the transform explicitly
    // keeps the (expensive) buffer reallocation out of the hot path.
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.scale(this.scale, this.scale);
    g.textBaseline = "alphabetic";
    g.textAlign = "left";
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    this.touched = true;
    return g;
  }

  /**
   * Uploads what was drawn and blits it over the current frame. Must run
   * after the scene (or the composer) has rendered, with the renderer's
   * auto-clear turned off for the duration.
   */
  commit(renderer: THREE.WebGLRenderer) {
    if (!this.touched) return;
    this.touched = false;
    this.texture.needsUpdate = true;

    const prevAutoClear = renderer.autoClear;
    const prevTarget = renderer.getRenderTarget();
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
    renderer.setRenderTarget(prevTarget);
    renderer.autoClear = prevAutoClear;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}

// --- drawing helpers --------------------------------------------------------

/** Rounded rectangle path. `roundRect` exists but not on every target. */
export function roundRectPath(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w * 0.5, h * 0.5);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}

/**
 * Text with a soft glow behind it. Cheaper and more legible than a stroke
 * on the dark, busy backgrounds these games render.
 */
export function glowText(
  g: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
  blur = 14,
) {
  g.save();
  g.shadowColor = color;
  g.shadowBlur = blur;
  g.fillStyle = color;
  g.fillText(text, x, y);
  g.fillText(text, x, y);
  g.restore();
}

/** A horizontal meter with a hard fill and a lagging "damage" ghost. */
export function bar(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  value: number,
  ghost: number,
  fill: string,
  ghostFill = "rgba(255,255,255,0.28)",
  back = "rgba(0,0,0,0.55)",
) {
  g.fillStyle = back;
  g.fillRect(x, y, w, h);
  if (ghost > value) {
    g.fillStyle = ghostFill;
    g.fillRect(x + w * value, y, w * (ghost - value), h);
  }
  g.fillStyle = fill;
  g.fillRect(x, y, w * Math.max(0, value), h);
}
