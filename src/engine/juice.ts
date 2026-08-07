/**
 * "Juice" — the layer that separates a polished game from a tech demo.
 * Screen shake, hit-stop, particles, floating numbers, full-screen flashes.
 *
 * Everything here is pooled: no allocation during play, so the GC never
 * causes a frame spike mid-action.
 */

import { clamp01, easeOutCubic, TAU } from "./math";
import { rng } from "./rng";

export type ParticleShape = "circle" | "square" | "spark" | "ring" | "triangle";

interface Particle {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  endSize: number;
  color: string;
  gravity: number;
  drag: number;
  rot: number;
  spin: number;
  shape: ParticleShape;
  /** Additive blending reads as light — use for sparks and explosions. */
  additive: boolean;
  /** Stretch along the velocity vector. 0 = round, 1 = full streak. */
  stretch: number;
}

export interface EmitOptions {
  count?: number;
  /** Base direction in radians. Omit for a full 360° burst. */
  angle?: number;
  /** Half-width of the angular cone, radians. */
  spread?: number;
  speed?: number;
  speedVar?: number;
  life?: number;
  lifeVar?: number;
  size?: number;
  sizeVar?: number;
  endSize?: number;
  /** A single color, or a set to pick from per particle. */
  color?: string | string[];
  gravity?: number;
  drag?: number;
  shape?: ParticleShape;
  spin?: number;
  additive?: boolean;
  stretch?: number;
}

interface FloatingText {
  alive: boolean;
  x: number;
  y: number;
  vy: number;
  life: number;
  maxLife: number;
  text: string;
  color: string;
  size: number;
  outline: boolean;
}

interface ShakeSource {
  amount: number;
  decay: number;
}

const MAX_PARTICLES = 900;
const MAX_TEXTS = 48;

export class Juice {
  private particles: Particle[] = [];
  private texts: FloatingText[] = [];
  private shakes: ShakeSource[] = [];

  /** Applied by `pushCamera` — read it if you need to compensate elsewhere. */
  shakeX = 0;
  shakeY = 0;
  shakeRot = 0;

  private flashColor = "";
  private flashLife = 0;
  private flashMax = 0;

  private chromaAmount = 0;

  /** Time in seconds to stall gameplay. The Loop drains this. */
  pendingFreeze = 0;

  private time = 0;

  constructor() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        alive: false,
        x: 0, y: 0, vx: 0, vy: 0,
        life: 0, maxLife: 1,
        size: 2, endSize: 0,
        color: "#fff",
        gravity: 0, drag: 0,
        rot: 0, spin: 0,
        shape: "circle",
        additive: false,
        stretch: 0,
      });
    }
    for (let i = 0; i < MAX_TEXTS; i++) {
      this.texts.push({
        alive: false, x: 0, y: 0, vy: 0,
        life: 0, maxLife: 1, text: "", color: "#fff", size: 16, outline: true,
      });
    }
  }

  reset() {
    for (const p of this.particles) p.alive = false;
    for (const t of this.texts) t.alive = false;
    this.shakes.length = 0;
    this.shakeX = this.shakeY = this.shakeRot = 0;
    this.flashLife = 0;
    this.chromaAmount = 0;
    this.pendingFreeze = 0;
  }

  // --- screen shake --------------------------------------------------------

  /**
   * `amount` is peak offset in pixels. Shakes stack, which makes a chain of
   * small hits feel like one big one.
   */
  shake(amount: number, decay = 6) {
    this.shakes.push({ amount, decay });
    if (this.shakes.length > 12) this.shakes.shift();
  }

  /** Stall the simulation briefly. The single best-value juice trick there is. */
  freeze(seconds: number) {
    this.pendingFreeze = Math.max(this.pendingFreeze, seconds);
  }

  flash(color: string, seconds = 0.12) {
    this.flashColor = color;
    this.flashLife = seconds;
    this.flashMax = seconds;
  }

  /** Momentary RGB split. Cheap on Canvas2D if used sparingly. */
  chroma(amount: number) {
    this.chromaAmount = Math.max(this.chromaAmount, amount);
  }

  // --- emitters ------------------------------------------------------------

  emit(x: number, y: number, opts: EmitOptions = {}) {
    const {
      count = 12,
      angle,
      spread = Math.PI,
      speed = 140,
      speedVar = 0.6,
      life = 0.5,
      lifeVar = 0.4,
      size = 3,
      sizeVar = 0.5,
      endSize = 0,
      color = "#ffffff",
      gravity = 0,
      drag = 2.2,
      shape = "circle",
      spin = 0,
      additive = false,
      stretch = 0,
    } = opts;

    for (let i = 0; i < count; i++) {
      const p = this.take();
      if (!p) return;
      const a = angle === undefined ? rng.angle() : angle + rng.spread(spread);
      const sp = speed * (1 + rng.spread(speedVar));
      p.alive = true;
      p.x = x;
      p.y = y;
      p.vx = Math.cos(a) * sp;
      p.vy = Math.sin(a) * sp;
      p.maxLife = Math.max(0.05, life * (1 + rng.spread(lifeVar)));
      p.life = p.maxLife;
      p.size = Math.max(0.5, size * (1 + rng.spread(sizeVar)));
      p.endSize = endSize;
      p.color = typeof color === "string" ? color : rng.pick(color);
      p.gravity = gravity;
      p.drag = drag;
      p.rot = rng.angle();
      p.spin = spin ? rng.spread(spin) : 0;
      p.shape = shape;
      p.additive = additive;
      p.stretch = stretch;
    }
  }

  /** Ring of particles flying outward — impacts, pickups, level-ups. */
  burst(x: number, y: number, color: string | string[], scale = 1) {
    this.emit(x, y, {
      count: Math.round(14 * scale),
      speed: 180 * scale,
      life: 0.45,
      size: 3.2 * scale,
      color,
      drag: 3,
      additive: true,
    });
  }

  /** Directional spray — bullets hitting a wall, dust off a landing. */
  spray(
    x: number,
    y: number,
    angle: number,
    color: string | string[],
    scale = 1,
  ) {
    this.emit(x, y, {
      count: Math.round(10 * scale),
      angle,
      spread: 0.6,
      speed: 220 * scale,
      life: 0.35,
      size: 2.4 * scale,
      color,
      drag: 4,
      stretch: 0.7,
      additive: true,
    });
  }

  /** Chunky debris that falls — destruction. */
  debris(x: number, y: number, color: string | string[], scale = 1) {
    this.emit(x, y, {
      count: Math.round(10 * scale),
      speed: 150 * scale,
      life: 0.9,
      lifeVar: 0.5,
      size: 4 * scale,
      color,
      gravity: 900,
      drag: 0.6,
      shape: "square",
      spin: 14,
    });
  }

  text(
    x: number,
    y: number,
    text: string,
    color = "#ffffff",
    size = 16,
    outline = true,
  ) {
    const t = this.texts.find((v) => !v.alive);
    if (!t) return;
    t.alive = true;
    t.x = x;
    t.y = y;
    t.vy = -58;
    t.maxLife = 0.85;
    t.life = t.maxLife;
    t.text = text;
    t.color = color;
    t.size = size;
    t.outline = outline;
  }

  private take(): Particle | null {
    for (let i = 0; i < this.particles.length; i++) {
      if (!this.particles[i].alive) return this.particles[i];
    }
    return null;
  }

  // --- simulation ----------------------------------------------------------

  update(dt: number) {
    this.time += dt;

    for (const p of this.particles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        continue;
      }
      p.vy += p.gravity * dt;
      const d = Math.max(0, 1 - p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
    }

    for (const t of this.texts) {
      if (!t.alive) continue;
      t.life -= dt;
      if (t.life <= 0) {
        t.alive = false;
        continue;
      }
      t.y += t.vy * dt;
      t.vy *= Math.max(0, 1 - 2.6 * dt);
    }

    let total = 0;
    for (let i = this.shakes.length - 1; i >= 0; i--) {
      const s = this.shakes[i];
      s.amount *= Math.max(0, 1 - s.decay * dt);
      if (s.amount < 0.05) {
        this.shakes.splice(i, 1);
        continue;
      }
      total += s.amount;
    }
    if (total > 0) {
      // Noise-driven rather than pure random: reads as motion, not static.
      const t = this.time * 47;
      this.shakeX = Math.sin(t * 1.7) * total * (rng.next() * 0.5 + 0.5);
      this.shakeY = Math.cos(t * 2.3) * total * (rng.next() * 0.5 + 0.5);
      this.shakeRot = Math.sin(t * 1.1) * total * 0.0016;
    } else {
      this.shakeX = this.shakeY = this.shakeRot = 0;
    }

    if (this.flashLife > 0) this.flashLife -= dt;
    if (this.chromaAmount > 0) {
      this.chromaAmount = Math.max(0, this.chromaAmount - dt * 14);
    }
  }

  // --- rendering -----------------------------------------------------------

  /** Wrap world rendering in these two so shake affects the world, not the HUD. */
  pushCamera(ctx: CanvasRenderingContext2D, cx = 0, cy = 0) {
    ctx.save();
    if (this.shakeRot !== 0) {
      ctx.translate(cx, cy);
      ctx.rotate(this.shakeRot);
      ctx.translate(-cx, -cy);
    }
    ctx.translate(this.shakeX, this.shakeY);
  }

  popCamera(ctx: CanvasRenderingContext2D) {
    ctx.restore();
  }

  drawParticles(ctx: CanvasRenderingContext2D) {
    let usedAdditive = false;
    ctx.save();
    for (const p of this.particles) {
      if (!p.alive) continue;
      const t = clamp01(p.life / p.maxLife);
      const alpha = t > 0.75 ? 1 : easeOutCubic(t / 0.75);
      const size = p.endSize + (p.size - p.endSize) * t;
      if (size <= 0.1) continue;

      if (p.additive !== usedAdditive) {
        ctx.globalCompositeOperation = p.additive ? "lighter" : "source-over";
        usedAdditive = p.additive;
      }
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;

      switch (p.shape) {
        case "circle": {
          if (p.stretch > 0) {
            const sp = Math.hypot(p.vx, p.vy);
            const len = 1 + (sp / 400) * p.stretch * 3;
            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate(Math.atan2(p.vy, p.vx));
            ctx.scale(len, 1);
            ctx.beginPath();
            ctx.arc(0, 0, size, 0, TAU);
            ctx.fill();
            ctx.restore();
          } else {
            ctx.beginPath();
            ctx.arc(p.x, p.y, size, 0, TAU);
            ctx.fill();
          }
          break;
        }
        case "square": {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.fillRect(-size, -size, size * 2, size * 2);
          ctx.restore();
          break;
        }
        case "triangle": {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.rot);
          ctx.beginPath();
          ctx.moveTo(0, -size);
          ctx.lineTo(size * 0.87, size * 0.5);
          ctx.lineTo(-size * 0.87, size * 0.5);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
          break;
        }
        case "spark": {
          const sp = Math.hypot(p.vx, p.vy);
          const len = Math.max(size, sp * 0.035);
          const a = Math.atan2(p.vy, p.vx);
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, size * 0.7);
          ctx.lineCap = "round";
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x - Math.cos(a) * len, p.y - Math.sin(a) * len);
          ctx.stroke();
          break;
        }
        case "ring": {
          ctx.strokeStyle = p.color;
          ctx.lineWidth = Math.max(1, size * 0.35);
          ctx.beginPath();
          ctx.arc(p.x, p.y, size * (2 - t), 0, TAU);
          ctx.stroke();
          break;
        }
      }
    }
    ctx.restore();
  }

  drawTexts(ctx: CanvasRenderingContext2D, fontFamily = "system-ui, sans-serif") {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const t of this.texts) {
      if (!t.alive) continue;
      const k = clamp01(t.life / t.maxLife);
      // Pop in, then fade out.
      const scale = k > 0.85 ? 1 + (1 - (1 - k) / 0.15) * 0 + (k - 0.85) * 2 : 1;
      ctx.globalAlpha = k > 0.6 ? 1 : k / 0.6;
      ctx.font = `700 ${t.size * scale}px ${fontFamily}`;
      if (t.outline) {
        ctx.lineWidth = Math.max(2, t.size * 0.22);
        ctx.strokeStyle = "rgba(0,0,0,0.75)";
        ctx.lineJoin = "round";
        ctx.strokeText(t.text, t.x, t.y);
      }
      ctx.fillStyle = t.color;
      ctx.fillText(t.text, t.x, t.y);
    }
    ctx.restore();
  }

  /** Full-screen flash. Draw last, in screen space. */
  drawFlash(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (this.flashLife <= 0) return;
    const k = clamp01(this.flashLife / this.flashMax);
    ctx.save();
    ctx.globalAlpha = k * k;
    ctx.fillStyle = this.flashColor;
    ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }

  get chromaOffset() {
    return this.chromaAmount;
  }
}
