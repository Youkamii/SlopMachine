/**
 * LODESTONE
 *
 * You cannot touch the particles. You paint attractor and repulsor fields
 * onto the canvas and tens of thousands of particles flow through the vector
 * field you sculpted.
 *
 * You are shaping physics, not objects — erase one stroke and the whole river
 * re-routes.
 *
 * Performance is the design here. Sampling every magnet per particle would
 * cap out around a thousand; instead the field is baked into a coarse grid
 * whenever you paint, and each particle costs two bilinear lookups and an
 * add. That is what buys thirty thousand of them.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp, clamp01, easeOutCubic, lerp } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const VOID = "#04060b";
const VOID_2 = "#080d18";
const ATTRACT = "#4cc9f0";
const REPEL = "#f72585";
const GOAL_C = "#b8ff6b";
const TEXT = "#dbe6f5";

// --- field ------------------------------------------------------------------

const GRID = 48;
const MAX_PARTICLES = 30000;

interface Magnet {
  x: number;
  y: number;
  r: number;
  /** Positive attracts, negative repels. */
  strength: number;
}

interface Level {
  /** Emitter position, in 0..1 screen space. */
  from: { x: number; y: number };
  goal: { x: number; y: number; r: number };
  /** Fraction of throughput required to clear. */
  target: number;
  /** Field strength the player may spend. */
  budget: number;
  sinks: Array<{ x: number; y: number; r: number }>;
}

const LEVELS: Level[] = [
  {
    from: { x: 0.08, y: 0.5 },
    goal: { x: 0.9, y: 0.5, r: 0.07 },
    target: 0.35,
    budget: 3,
    sinks: [],
  },
  {
    from: { x: 0.08, y: 0.25 },
    goal: { x: 0.9, y: 0.75, r: 0.07 },
    target: 0.3,
    budget: 4,
    sinks: [{ x: 0.5, y: 0.5, r: 0.1 }],
  },
  {
    from: { x: 0.5, y: 0.08 },
    goal: { x: 0.5, y: 0.9, r: 0.065 },
    target: 0.3,
    budget: 5,
    sinks: [
      { x: 0.32, y: 0.5, r: 0.09 },
      { x: 0.68, y: 0.5, r: 0.09 },
    ],
  },
  {
    from: { x: 0.08, y: 0.85 },
    goal: { x: 0.9, y: 0.15, r: 0.06 },
    target: 0.28,
    budget: 6,
    sinks: [
      { x: 0.35, y: 0.3, r: 0.085 },
      { x: 0.62, y: 0.66, r: 0.085 },
    ],
  },
];

type Phase = "title" | "playing" | "cleared" | "complete";

class Lodestone implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private endTime = 0;
  private time = 0;

  private levelIndex = 0;
  private level: Level = LEVELS[0];

  private magnets: Magnet[] = [];
  private brush: 1 | -1 = 1;
  private brushR = 0;

  // Structure-of-arrays: typed arrays and no per-particle objects, so the GC
  // never sees this loop.
  private px = new Float32Array(MAX_PARTICLES);
  private py = new Float32Array(MAX_PARTICLES);
  private pvx = new Float32Array(MAX_PARTICLES);
  private pvy = new Float32Array(MAX_PARTICLES);
  private plife = new Float32Array(MAX_PARTICLES);
  private count = 0;
  private budgetParticles = 12000;

  /** Baked vector field, rebuilt only when magnets change. */
  private fx = new Float32Array(GRID * GRID);
  private fy = new Float32Array(GRID * GRID);
  private fieldDirty = true;

  private captured = 0;
  private emitted = 0;
  private rate = 0;
  private best = 0;

  private frameBudgetAcc = 0;
  private frameSamples = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.brushR = Math.min(w, h) * 0.11;
    this.fieldDirty = true;
  }

  restart() {
    this.phase = "playing";
    this.levelIndex = 0;
    this.loadLevel(0);
    this.c.report({ status: "playing", score: 0 });
  }

  private loadLevel(i: number) {
    this.levelIndex = i % LEVELS.length;
    this.level = LEVELS[this.levelIndex];
    this.magnets = [];
    this.count = 0;
    this.captured = 0;
    this.emitted = 0;
    this.rate = 0;
    this.fieldDirty = true;
    this.phase = "playing";
  }

  // --- field ----------------------------------------------------------------

  private bakeField() {
    const cw = this.w / GRID;
    const ch = this.h / GRID;
    this.fx.fill(0);
    this.fy.fill(0);

    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const wx = (gx + 0.5) * cw;
        const wy = (gy + 0.5) * ch;
        let ax = 0;
        let ay = 0;
        for (const m of this.magnets) {
          const dx = m.x - wx;
          const dy = m.y - wy;
          const d2 = dx * dx + dy * dy;
          const d = Math.sqrt(d2) || 1;
          if (d > m.r * 2.4) continue;
          // Soft falloff — 1/r^2 makes the centre explode and reads as a bug.
          const falloff = clamp01(1 - d / (m.r * 2.4));
          const force = m.strength * falloff * falloff * 2600;
          ax += (dx / d) * force;
          ay += (dy / d) * force;
        }
        // Baseline current toward the goal. This has to be strong enough to
        // actually carry a particle across the screen against drag — the
        // first pass used 34 and the stream simply stalled in a cloud at the
        // emitter, which is not a river, it is a bug.
        const gxw = this.level.goal.x * this.w - wx;
        const gyw = this.level.goal.y * this.h - wy;
        const gd = Math.hypot(gxw, gyw) || 1;
        ax += (gxw / gd) * 620;
        ay += (gyw / gd) * 620;

        const idx = gy * GRID + gx;
        this.fx[idx] = ax;
        this.fy[idx] = ay;
      }
    }
    this.fieldDirty = false;
  }

  /** Bilinear sample of the baked field. Two lookups, no branching. */
  private sample(x: number, y: number, out: { x: number; y: number }) {
    const gx = clamp((x / this.w) * GRID - 0.5, 0, GRID - 1.001);
    const gy = clamp((y / this.h) * GRID - 0.5, 0, GRID - 1.001);
    const x0 = gx | 0;
    const y0 = gy | 0;
    const tx = gx - x0;
    const ty = gy - y0;
    const i00 = y0 * GRID + x0;
    const i10 = i00 + 1;
    const i01 = i00 + GRID;
    const i11 = i01 + 1;
    out.x =
      lerp(lerp(this.fx[i00], this.fx[i10], tx), lerp(this.fx[i01], this.fx[i11], tx), ty);
    out.y =
      lerp(lerp(this.fy[i00], this.fy[i10], tx), lerp(this.fy[i01], this.fy[i11], tx), ty);
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "sine", freq: 70, freqTo: 140, glide: 0.4,
          vol: 0.15, attack: 0.02, hold: 0.1, release: 0.4,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "cleared" || this.phase === "complete") {
      this.endTime += dt;
      this.step(dt);
      if (this.endTime > 0.7 && (input.pointer.justUp || input.confirmPressed)) {
        if (this.phase === "complete") this.restart();
        else if (this.levelIndex + 1 >= LEVELS.length) {
          this.phase = "complete";
          this.endTime = 0;
        } else {
          this.loadLevel(this.levelIndex + 1);
        }
      }
      return;
    }

    this.handlePaint();
    if (this.fieldDirty) this.bakeField();
    this.step(dt);
    this.adaptBudget(dt);

    if (this.emitted > 500 && this.rate >= this.level.target) this.clearLevel();
  }

  private handlePaint() {
    const { input, audio } = this.c;

    if (input.wasPressed("KeyQ") || input.wasPressed("Digit1")) this.brush = 1;
    if (input.wasPressed("KeyE") || input.wasPressed("Digit2")) this.brush = -1;
    if (input.wasPressed("KeyZ", "Backspace") && this.magnets.length) {
      this.magnets.pop();
      this.fieldDirty = true;
      audio.click(0.08);
    }
    if (input.wasPressed("KeyR")) {
      this.magnets = [];
      this.fieldDirty = true;
      audio.click(0.1);
    }

    if (!input.pointer.justDown) return;
    if (this.magnets.length >= this.level.budget) {
      // Out of budget: recycle the oldest rather than silently ignoring input.
      this.magnets.shift();
    }
    // Right-click / two-finger flips polarity without a mode switch.
    const strength = this.brush;
    this.magnets.push({
      x: input.pointer.x,
      y: input.pointer.y,
      r: this.brushR,
      strength,
    });
    this.fieldDirty = true;

    audio.play({
      wave: "sine",
      freq: strength > 0 ? 96 : 132,
      freqTo: strength > 0 ? 92 : 128,
      glide: 0.5,
      vol: 0.1, attack: 0.01, hold: 0.1, release: 0.35, filter: 700,
    });
    // Two sines four hertz apart give the magnetic beating.
    audio.play({
      wave: "sine",
      freq: (strength > 0 ? 96 : 132) + 4,
      vol: 0.07, attack: 0.02, hold: 0.1, release: 0.35,
    });
  }

  private step(dt: number) {
    const f = { x: 0, y: 0 };
    const goalX = this.level.goal.x * this.w;
    const goalY = this.level.goal.y * this.h;
    const goalR = this.level.goal.r * Math.min(this.w, this.h);

    // Emit.
    const emitPerSec = 2600;
    let toEmit = Math.min(
      Math.floor(emitPerSec * dt),
      this.budgetParticles - this.count,
    );
    const ex = this.level.from.x * this.w;
    const ey = this.level.from.y * this.h;
    while (toEmit-- > 0 && this.count < MAX_PARTICLES) {
      const i = this.count++;
      const a = this.c.rng.angle();
      const spread = this.c.rng.range(0, 14);
      this.px[i] = ex + Math.cos(a) * spread;
      this.py[i] = ey + Math.sin(a) * spread;
      this.pvx[i] = this.c.rng.range(20, 70);
      this.pvy[i] = this.c.rng.spread(30);
      this.plife[i] = this.c.rng.range(3.5, 6.5);
      this.emitted++;
    }

    let captured = 0;
    for (let i = 0; i < this.count; i++) {
      this.plife[i] -= dt;

      this.sample(this.px[i], this.py[i], f);
      // Light drag only. 0.985 per frame compounds to a near-total stop in
      // about a second, which is what killed the stream.
      this.pvx[i] = (this.pvx[i] + f.x * dt) * 0.997;
      this.pvy[i] = (this.pvy[i] + f.y * dt) * 0.997;
      this.px[i] += this.pvx[i] * dt;
      this.py[i] += this.pvy[i] * dt;

      let dead = this.plife[i] <= 0;

      const dx = this.px[i] - goalX;
      const dy = this.py[i] - goalY;
      if (dx * dx + dy * dy < goalR * goalR) {
        captured++;
        this.captured++;
        dead = true;
      }
      if (!dead) {
        for (const s of this.level.sinks) {
          const sx = s.x * this.w;
          const sy = s.y * this.h;
          const sr = s.r * Math.min(this.w, this.h);
          const ddx = this.px[i] - sx;
          const ddy = this.py[i] - sy;
          if (ddx * ddx + ddy * ddy < sr * sr) {
            dead = true;
            break;
          }
        }
      }
      if (!dead && (this.px[i] < -40 || this.px[i] > this.w + 40 ||
        this.py[i] < -40 || this.py[i] > this.h + 40)) {
        dead = true;
      }

      if (dead) {
        // Swap-remove: O(1), no allocation, no splice.
        const j = --this.count;
        this.px[i] = this.px[j];
        this.py[i] = this.py[j];
        this.pvx[i] = this.pvx[j];
        this.pvy[i] = this.pvy[j];
        this.plife[i] = this.plife[j];
        i--;
      }
    }

    // Throughput as a percentage, so the win condition survives a device
    // that can only run a third of the particles.
    if (this.emitted > 0) {
      const inst = captured / Math.max(1, emitPerSec * dt);
      this.rate = lerp(this.rate, clamp01(inst), 0.04);
    }
  }

  /** Scale the particle count to whatever the device can actually sustain. */
  private adaptBudget(dt: number) {
    this.frameBudgetAcc += dt;
    this.frameSamples++;
    if (this.frameSamples < 45) return;
    const avg = this.frameBudgetAcc / this.frameSamples;
    this.frameBudgetAcc = 0;
    this.frameSamples = 0;
    if (avg > 0.021 && this.budgetParticles > 3000) {
      this.budgetParticles = Math.floor(this.budgetParticles * 0.85);
    } else if (avg < 0.0165 && this.budgetParticles < MAX_PARTICLES) {
      this.budgetParticles = Math.min(
        MAX_PARTICLES,
        Math.floor(this.budgetParticles * 1.08),
      );
    }
  }

  private clearLevel() {
    const { fx, audio } = this.c;
    this.phase = "cleared";
    this.endTime = 0;
    fx.flash(GOAL_C, 0.1);
    [0, 7, 12, 16].forEach((s, i) =>
      audio.play({
        wave: "sine", freq: 220 * Math.pow(2, s / 12),
        vol: 0.12, attack: 0.006, hold: 0.07, release: 0.7, delay: i * 0.07,
      }),
    );
    const solved = this.levelIndex + 1;
    if (this.c.store.recordBest("best", solved)) this.best = solved;
    this.c.report({ score: solved });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    // Persistence rather than a clear: old positions decay, which draws the
    // streamlines for free.
    ctx.fillStyle = "rgba(4,6,11,0.22)";
    ctx.fillRect(0, 0, this.w, this.h);

    if (this.phase === "title") {
      ctx.fillStyle = VOID;
      ctx.fillRect(0, 0, this.w, this.h);
    }

    this.drawMagnets(ctx);
    this.drawSinks(ctx);
    this.drawGoal(ctx);
    this.drawParticles(ctx);

    if (this.phase === "playing" || this.phase === "cleared") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "cleared") this.drawBanner(ctx);
    if (this.phase === "complete") this.drawComplete(ctx);

    this.c.fx.drawFlash(ctx, this.w, this.h);
  }

  private drawParticles(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = "rgba(150,220,255,0.5)";
    for (let i = 0; i < this.count; i++) {
      ctx.fillRect(this.px[i], this.py[i], 1.35, 1.35);
    }
    ctx.restore();
  }

  private drawMagnets(ctx: CanvasRenderingContext2D) {
    for (const m of this.magnets) {
      const col = m.strength > 0 ? ATTRACT : REPEL;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, m.r * 2.4);
      g.addColorStop(0, `${col}30`);
      g.addColorStop(1, `${col}00`);
      ctx.fillStyle = g;
      ctx.fillRect(m.x - m.r * 2.4, m.y - m.r * 2.4, m.r * 4.8, m.r * 4.8);
      ctx.restore();

      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r * 0.28, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(m.x - 6, m.y);
      ctx.lineTo(m.x + 6, m.y);
      if (m.strength > 0) {
        ctx.moveTo(m.x, m.y - 6);
        ctx.lineTo(m.x, m.y + 6);
      }
      ctx.stroke();
    }
  }

  private drawSinks(ctx: CanvasRenderingContext2D) {
    const s = Math.min(this.w, this.h);
    for (const k of this.level.sinks) {
      const x = k.x * this.w;
      const y = k.y * this.h;
      const r = k.r * s;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = "rgba(0,0,0,0.85)";
      ctx.fill();
      ctx.setLineDash([4, 6]);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(247,37,133,0.5)";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  private drawGoal(ctx: CanvasRenderingContext2D) {
    const x = this.level.goal.x * this.w;
    const y = this.level.goal.y * this.h;
    const r = this.level.goal.r * Math.min(this.w, this.h);
    const pulse = 0.5 + Math.sin(this.time * 2.2) * 0.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(184,255,107,${0.4 + pulse * 0.35})`;
    ctx.stroke();
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(219,230,245,0.42)";
    ctx.fillText("FIELD", pad, pad + 34);
    ctx.font = monoFont(26, 700);
    ctx.fillStyle = TEXT;
    ctx.fillText(`${this.levelIndex + 1}/${LEVELS.length}`, pad, pad + 48);

    const barW = Math.min(200, this.w * 0.3);
    const barX = this.w - pad - barW;
    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(219,230,245,0.42)";
    ctx.fillText("THROUGHPUT", this.w - pad, pad + 34);
    ctx.fillStyle = "rgba(219,230,245,0.14)";
    ctx.fillRect(barX, pad + 52, barW, 6);
    ctx.fillStyle = GOAL_C;
    ctx.fillRect(barX, pad + 52, barW * clamp01(this.rate / this.level.target), 6);
    // The required line, marked on the bar itself.
    ctx.fillStyle = "rgba(219,230,245,0.55)";
    ctx.fillRect(barX + barW - 2, pad + 48, 2, 14);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(219,230,245,0.42)";
    ctx.fillText(
      this.c.isTouch
        ? `TAP TO PLACE  ·  ${this.magnets.length}/${this.level.budget} MAGNETS`
        : `CLICK TO PLACE  ·  Q PULL  ·  E PUSH  ·  Z UNDO  ·  ${this.magnets.length}/${this.level.budget}`,
      this.w / 2,
      this.h - 30,
    );

    // Current brush, shown as a ring under the cursor on desktop.
    const p = this.c.input.pointer;
    if (!this.c.isTouch && p.everMoved) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, this.brushR * 0.28, 0, TAU);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = this.brush > 0 ? `${ATTRACT}88` : `${REPEL}88`;
      ctx.stroke();
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;

    // A demo field, running live behind the title.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 340; i++) {
      const a = (i / 340) * TAU + t * 0.2;
      const rr = 90 + Math.sin(a * 5 + t) * 60;
      const x = cx + Math.cos(a) * rr * 1.7;
      const y = this.h * 0.5 + Math.sin(a) * rr * 0.7;
      ctx.fillStyle = "rgba(150,220,255,0.35)";
      ctx.fillRect(x, y, 1.4, 1.4);
    }
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(this.w * 0.14, 78);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = TEXT;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("LODESTONE", cx, this.h * 0.26);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(219,230,245,0.6)";
    ctx.fillText("YOU CANNOT TOUCH THE PARTICLES.", cx, this.h * 0.26 + size * 0.6);
    ctx.fillStyle = "rgba(76,201,240,0.7)";
    ctx.fillText("SCULPT THE FIELD THEY FLOW THROUGH.", cx, this.h * 0.26 + size * 0.6 + 20);

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(219,230,245,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.84);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(219,230,245,0.34)";
      ctx.fillText(`FIELDS SOLVED — ${this.best}`, cx, this.h * 0.84 + 24);
    }
  }

  private drawBanner(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.5));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.11, 52), 800);
    ctx.fillStyle = GOAL_C;
    ctx.globalAlpha = ease;
    ctx.fillText("FLOWING", this.w / 2, this.h * 0.22);
    ctx.font = monoFont(11.5, 500);
    ctx.fillStyle = TEXT;
    ctx.fillText(
      `${Math.round(this.rate * 100)}% THROUGHPUT  ·  ${this.magnets.length} MAGNETS`,
      this.w / 2,
      this.h * 0.22 + 38,
    );
    ctx.globalAlpha = 1;
    if (this.endTime > 0.7) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(219,230,245,${blink})`;
      ctx.fillText("NEXT FIELD", this.w / 2, this.h * 0.86);
    }
  }

  private drawComplete(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.6));
    ctx.fillStyle = `rgba(4,6,11,${0.72 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 60), 800);
    ctx.fillStyle = GOAL_C;
    ctx.fillText("ALL FIELDS", this.w / 2, this.h * 0.42);
    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(219,230,245,${0.6 * ease})`;
    ctx.fillText(`${LEVELS.length} RIVERS RE-ROUTED`, this.w / 2, this.h * 0.42 + 44);
    if (this.endTime > 0.7) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(219,230,245,${blink})`;
      ctx.fillText("AGAIN", this.w / 2, this.h * 0.8);
    }
  }
}

const factory: GameFactory = (ctx) => new Lodestone(ctx);
export default factory;
