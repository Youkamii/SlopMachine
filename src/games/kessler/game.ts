/**
 * KESSLER
 *
 * Put satellites into orbit. Satellites that collide leave debris, debris
 * stays in orbit forever, and debris shreds satellites. Push for a big
 * constellation and you eventually trigger the real thing: one collision
 * tears a ring, that ring's debris tears the next, and the whole network
 * unzips in about eight seconds while you watch, unable to stop it.
 *
 * The failure state is the spectacle. That is the entire design.
 */

import { monoFont, uiFont } from "@/engine/draw";
import {
  TAU,
  clamp,
  clamp01,
  damp,
  easeOutCubic,
  lerp,
} from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const SPACE = "#0a0410";
const SPACE_2 = "#140718";
const PLANET = "#8fa3b8";
const PLANET_DARK = "#2b3a4d";
const SAT = "#ffffff";
const ORBIT = "rgba(255,255,255,0.16)";
const DEBRIS = "#ff7a45";
const WARN = "#ff3355";

// --- physics ----------------------------------------------------------------

/** Gravitational parameter. Tuned so a 170px orbit runs at a readable speed. */
const MU = 2_600_000;
const PLANET_R = 46;
/** Anything inside this burns up — the only way debris ever leaves. */
const REENTRY_R = PLANET_R + 6;
const ESCAPE_R = 1400;

const MAX_BODIES = 700;
const DEBRIS_PER_HIT = 5;

const SAT_R = 3.2;
const DEB_R = 2.0;

type Kind = "sat" | "debris";

interface Body {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: Kind;
  /** Seconds since spawn — new bodies are briefly intangible. */
  age: number;
  /** Cached orbital elements for drawing; recomputed lazily. */
  a: number;
  e: number;
  omega: number;
  valid: boolean;
}

type Phase = "title" | "playing" | "over";

class Kessler implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private cx = 0;
  private cy = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private overTime = 0;
  private time = 0;

  private bodies: Body[] = [];
  private sats = 0;
  private debris = 0;
  private peak = 0;
  private best = 0;
  private launched = 0;
  private collisions = 0;
  /** Seconds since the first collision — the "survived the cascade" clock. */
  private sinceFirstHit = -1;

  private aiming = false;
  private aimFromX = 0;
  private aimFromY = 0;
  private aimToX = 0;
  private aimToY = 0;

  private starX: number[] = [];
  private starY: number[] = [];
  private starA: number[] = [];

  /** Rate limiter so a cascade does not fire 200 explosions in one frame. */
  private hitSoundBudget = 0;
  private shakeBudget = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    for (let i = 0; i < MAX_BODIES; i++) {
      this.bodies.push({
        alive: false, x: 0, y: 0, vx: 0, vy: 0,
        kind: "debris", age: 0, a: 0, e: 0, omega: 0, valid: false,
      });
    }
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.cx = w / 2;
    this.cy = h / 2;
    const count = Math.round((w * h) / 9000);
    this.starX.length = 0;
    this.starY.length = 0;
    this.starA.length = 0;
    for (let i = 0; i < count; i++) {
      this.starX.push(this.c.rng.range(0, w));
      this.starY.push(this.c.rng.range(0, h));
      this.starA.push(this.c.rng.range(0.06, 0.5));
    }
  }

  restart() {
    this.phase = "playing";
    this.time = 0;
    this.overTime = 0;
    this.sats = 0;
    this.debris = 0;
    this.peak = 0;
    this.launched = 0;
    this.collisions = 0;
    this.sinceFirstHit = -1;
    this.aiming = false;
    for (const b of this.bodies) b.alive = false;
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;
    this.hitSoundBudget = Math.min(3, this.hitSoundBudget + dt * 14);
    this.shakeBudget = Math.min(2, this.shakeBudget + dt * 8);

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "sine", freq: 90, freqTo: 180, glide: 0.3,
          vol: 0.16, attack: 0.01, hold: 0.08, release: 0.3,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "over") {
      this.overTime += dt;
      this.integrate(dt);
      this.collide();
      if (this.overTime > 0.8 && (input.pointer.justUp || input.confirmPressed)) {
        this.restart();
      }
      return;
    }

    this.handleAim();
    this.integrate(dt);
    this.collide();
    this.tally();

    if (this.sinceFirstHit >= 0) this.sinceFirstHit += dt;

    if (this.sats === 0 && this.launched > 0) this.end();
  }

  private handleAim() {
    const { input, audio } = this.c;
    const p = input.pointer;

    if (p.justDown) {
      this.aiming = true;
      this.aimFromX = p.startX;
      this.aimFromY = p.startY;
      this.aimToX = p.x;
      this.aimToY = p.y;
    }
    if (this.aiming) {
      this.aimToX = p.x;
      this.aimToY = p.y;
      if (!p.down) {
        this.aiming = false;
        const dx = this.aimToX - this.aimFromX;
        const dy = this.aimToY - this.aimFromY;
        if (Math.hypot(dx, dy) < 12) return;
        const rx = this.aimFromX - this.cx;
        const ry = this.aimFromY - this.cy;
        const r = Math.hypot(rx, ry);
        // Launching from inside the planet, or from the far edge, produces
        // nothing but an instant loss — refuse rather than waste the shot.
        if (r < PLANET_R + 24 || r > ESCAPE_R * 0.6) return;
        this.spawn(this.aimFromX, this.aimFromY, dx * 2.2, dy * 2.2, "sat");
        this.launched++;
        audio.play({
          wave: "noise", freq: 420, freqTo: 1500,
          vol: 0.12, attack: 0.008, hold: 0.03, release: 0.16,
          filter: 600, filterTo: 2800, filterType: "bandpass", q: 1.5,
        });
      }
    }
  }

  private spawn(x: number, y: number, vx: number, vy: number, kind: Kind) {
    for (const b of this.bodies) {
      if (b.alive) continue;
      b.alive = true;
      b.x = x - this.cx;
      b.y = y - this.cy;
      b.vx = vx;
      b.vy = vy;
      b.kind = kind;
      b.age = 0;
      b.valid = false;
      return;
    }
  }

  /**
   * Symplectic Euler: velocity from the current position, then position from
   * the new velocity. It conserves orbital energy far better than the naive
   * order, which is what keeps a ring stable for minutes instead of visibly
   * spiralling.
   */
  private integrate(dt: number) {
    for (const b of this.bodies) {
      if (!b.alive) continue;
      b.age += dt;

      const r2 = b.x * b.x + b.y * b.y;
      const r = Math.sqrt(r2);
      if (r < REENTRY_R) {
        b.alive = false;
        this.burnUp(b);
        continue;
      }
      if (r > ESCAPE_R) {
        b.alive = false;
        continue;
      }

      const acc = -MU / (r2 * r);
      b.vx += b.x * acc * dt;
      b.vy += b.y * acc * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.valid = false;
    }
  }

  private burnUp(b: Body) {
    const { fx } = this.c;
    const sx = this.cx + b.x;
    const sy = this.cy + b.y;
    fx.emit(sx, sy, {
      count: 6, speed: 70, life: 0.5, size: 1.8,
      color: [DEBRIS, "#ffd6a0"], drag: 3, additive: true,
    });
  }

  /**
   * Uniform grid broad-phase. With hundreds of bodies an all-pairs test is
   * ~100k checks a frame; binning makes it linear.
   */
  private collide() {
    const cell = 22;
    const grid = new Map<number, number[]>();

    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (!b.alive || b.age < 0.25) continue;
      const gx = Math.floor(b.x / cell);
      const gy = Math.floor(b.y / cell);
      const key = gx * 73856093 + gy * 19349663;
      let bucket = grid.get(key);
      if (!bucket) {
        bucket = [];
        grid.set(key, bucket);
      }
      bucket.push(i);
    }

    const hits: Array<[number, number]> = [];
    for (const bucket of grid.values()) {
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const a = this.bodies[bucket[i]];
          const b = this.bodies[bucket[j]];
          if (!a.alive || !b.alive) continue;
          const rr = (a.kind === "sat" ? SAT_R : DEB_R) +
            (b.kind === "sat" ? SAT_R : DEB_R) + 1.5;
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          if (dx * dx + dy * dy <= rr * rr) hits.push([bucket[i], bucket[j]]);
        }
      }
    }

    for (const [i, j] of hits) {
      const a = this.bodies[i];
      const b = this.bodies[j];
      if (!a.alive || !b.alive) continue;
      this.shatter(a, b);
    }
  }

  private shatter(a: Body, b: Body) {
    const { fx, audio, rng } = this.c;
    a.alive = false;
    b.alive = false;
    this.collisions++;
    if (this.sinceFirstHit < 0) this.sinceFirstHit = 0;

    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const mvx = (a.vx + b.vx) / 2;
    const mvy = (a.vy + b.vy) / 2;
    const sx = this.cx + mx;
    const sy = this.cy + my;

    // Debris inherits the average orbit plus scatter, which is exactly why a
    // cascade spreads: fragments end up on crossing orbits.
    for (let k = 0; k < DEBRIS_PER_HIT; k++) {
      const ang = rng.angle();
      // Modest scatter relative to orbital velocity (~125 at mid altitude).
      // A larger kick sends most fragments straight into re-entry, which
      // quietly deletes the debris field and undoes the whole premise.
      const spread = rng.range(10, 38);
      this.spawn(
        sx + Math.cos(ang) * 3,
        sy + Math.sin(ang) * 3,
        mvx + Math.cos(ang) * spread,
        mvy + Math.sin(ang) * spread,
        "debris",
      );
    }

    fx.emit(sx, sy, {
      count: 12, speed: 150, life: 0.5, size: 2,
      color: [DEBRIS, "#ffffff"], drag: 2.6, additive: true,
    });

    if (this.shakeBudget >= 1) {
      this.shakeBudget -= 1;
      fx.shake(6, 7);
    }
    if (this.hitSoundBudget >= 1) {
      this.hitSoundBudget -= 1;
      audio.play({
        wave: "noise", freq: 900, freqTo: 180,
        vol: 0.13, attack: 0.001, hold: 0.02, release: 0.16,
        filter: 2600, filterTo: 400,
      });
      audio.play({
        wave: "sine", freq: 180, freqTo: 60, glide: 0.16,
        vol: 0.1, attack: 0.002, hold: 0.02, release: 0.14,
      });
    }
  }

  private tally() {
    let s = 0;
    let d = 0;
    for (const b of this.bodies) {
      if (!b.alive) continue;
      if (b.kind === "sat") s++;
      else d++;
    }
    this.sats = s;
    this.debris = d;
    if (s > this.peak) {
      this.peak = s;
      this.c.report({ score: this.peak });
    }
  }

  private end() {
    const { fx, audio } = this.c;
    this.phase = "over";
    this.overTime = 0;
    fx.flash(WARN, 0.14);
    fx.shake(14, 4);
    audio.play({
      wave: "sawtooth", freq: 160, freqTo: 38, glide: 0.8,
      vol: 0.2, attack: 0.01, hold: 0.15, release: 0.7,
      filter: 1100, filterTo: 140,
    });
    if (this.c.store.recordBest("best", this.peak)) this.best = this.peak;
    this.c.store.bump("plays");
    this.c.report({ status: "over", score: this.peak, best: this.best });
  }

  // --- orbital elements (for drawing) ---------------------------------------

  private elements(b: Body) {
    if (b.valid) return;
    const r = Math.hypot(b.x, b.y);
    const v2 = b.vx * b.vx + b.vy * b.vy;
    const energy = v2 / 2 - MU / r;
    b.a = energy < 0 ? -MU / (2 * energy) : 0;
    const rv = b.x * b.vx + b.y * b.vy;
    const ex = ((v2 - MU / r) * b.x - rv * b.vx) / MU;
    const ey = ((v2 - MU / r) * b.y - rv * b.vy) / MU;
    b.e = Math.hypot(ex, ey);
    b.omega = Math.atan2(ey, ex);
    b.valid = true;
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    ctx.fillStyle = SPACE;
    ctx.fillRect(0, 0, this.w, this.h);

    const g = ctx.createRadialGradient(
      this.cx, this.cy, PLANET_R,
      this.cx, this.cy, Math.max(this.w, this.h) * 0.7,
    );
    g.addColorStop(0, SPACE_2);
    g.addColorStop(1, SPACE);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    this.drawStars(ctx);

    fx.pushCamera(ctx, this.cx, this.cy);

    if (this.phase !== "title") {
      this.drawOrbits(ctx);
      this.drawPlanet(ctx);
      this.drawBodies(ctx);
      if (this.aiming) this.drawAim(ctx);
    } else {
      this.drawPlanet(ctx);
      this.drawTitleOrbits(ctx);
    }
    fx.drawParticles(ctx);

    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "over") this.drawOver(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawStars(ctx: CanvasRenderingContext2D) {
    for (let i = 0; i < this.starX.length; i++) {
      ctx.fillStyle = `rgba(255,255,255,${this.starA[i]})`;
      ctx.fillRect(this.starX[i], this.starY[i], 1, 1);
    }
  }

  private drawPlanet(ctx: CanvasRenderingContext2D) {
    const g = ctx.createRadialGradient(
      this.cx - PLANET_R * 0.35, this.cy - PLANET_R * 0.35, PLANET_R * 0.1,
      this.cx, this.cy, PLANET_R,
    );
    g.addColorStop(0, PLANET);
    g.addColorStop(1, PLANET_DARK);
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, PLANET_R, 0, TAU);
    ctx.fillStyle = g;
    ctx.fill();

    // Atmospheric rim, drawn as a ring rather than a shadow blur.
    ctx.beginPath();
    ctx.arc(this.cx, this.cy, PLANET_R + 3, 0, TAU);
    ctx.lineWidth = 5;
    ctx.strokeStyle = "rgba(143,163,184,0.12)";
    ctx.stroke();
  }

  /** Draw each satellite's actual ellipse — the orbit is the information. */
  private drawOrbits(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = ORBIT;
    ctx.lineWidth = 1;
    for (const b of this.bodies) {
      if (!b.alive || b.kind !== "sat") continue;
      this.elements(b);
      if (b.a <= 0 || b.e >= 0.98) continue;
      const bAxis = b.a * Math.sqrt(1 - b.e * b.e);
      const focus = b.a * b.e;
      ctx.save();
      ctx.translate(this.cx, this.cy);
      ctx.rotate(b.omega);
      ctx.beginPath();
      ctx.ellipse(-focus, 0, b.a, bAxis, 0, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawBodies(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.bodies) {
      if (!b.alive) continue;
      const x = this.cx + b.x;
      const y = this.cy + b.y;
      if (b.kind === "sat") {
        ctx.beginPath();
        ctx.arc(x, y, SAT_R * 2.6, 0, TAU);
        ctx.fillStyle = "rgba(255,255,255,0.13)";
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, DEB_R * 2.2, 0, TAU);
        ctx.fillStyle = "rgba(255,122,69,0.12)";
        ctx.fill();
      }
    }
    ctx.restore();

    for (const b of this.bodies) {
      if (!b.alive) continue;
      const x = this.cx + b.x;
      const y = this.cy + b.y;
      ctx.beginPath();
      if (b.kind === "sat") {
        ctx.arc(x, y, SAT_R, 0, TAU);
        ctx.fillStyle = SAT;
      } else {
        ctx.arc(x, y, DEB_R, 0, TAU);
        ctx.fillStyle = DEBRIS;
      }
      ctx.fill();
    }
  }

  private drawAim(ctx: CanvasRenderingContext2D) {
    const dx = (this.aimToX - this.aimFromX) * 2.2;
    const dy = (this.aimToY - this.aimFromY) * 2.2;
    if (Math.hypot(dx, dy) < 8) return;

    // Forward-integrate the exact same equations the simulation uses, so the
    // preview cannot disagree with what actually happens.
    let px = this.aimFromX - this.cx;
    let py = this.aimFromY - this.cy;
    let vx = dx;
    let vy = dy;
    const step = 1 / 60;
    let crosses = false;

    ctx.beginPath();
    ctx.moveTo(this.cx + px, this.cy + py);
    for (let i = 0; i < 900; i++) {
      const r2 = px * px + py * py;
      const r = Math.sqrt(r2);
      if (r < REENTRY_R) { crosses = true; break; }
      if (r > ESCAPE_R) break;
      const acc = -MU / (r2 * r);
      vx += px * acc * step;
      vy += py * acc * step;
      px += vx * step;
      py += vy * step;
      if (i % 2 === 0) ctx.lineTo(this.cx + px, this.cy + py);
    }
    ctx.strokeStyle = crosses ? "rgba(255,51,85,0.65)" : "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 5]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(this.aimFromX, this.aimFromY);
    ctx.lineTo(this.aimToX, this.aimToY);
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(this.aimFromX, this.aimFromY, 4, 0, TAU);
    ctx.fillStyle = crosses ? WARN : SAT;
    ctx.fill();
  }

  private drawTitleOrbits(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    for (let i = 0; i < 4; i++) {
      const a = 110 + i * 42;
      const e = 0.12 + i * 0.06;
      const om = i * 0.9 + t * 0.05;
      const b = a * Math.sqrt(1 - e * e);
      ctx.save();
      ctx.translate(this.cx, this.cy);
      ctx.rotate(om);
      ctx.beginPath();
      ctx.ellipse(-a * e, 0, a, b, 0, 0, TAU);
      ctx.strokeStyle = "rgba(255,255,255,0.13)";
      ctx.lineWidth = 1;
      ctx.stroke();

      const ang = t * (0.9 - i * 0.13) + i * 2;
      const px = Math.cos(ang) * a - a * e;
      const py = Math.sin(ang) * b;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, TAU);
      ctx.fillStyle = SAT;
      ctx.fill();
      ctx.restore();
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText("SATELLITES", pad, pad + 34);
    ctx.font = monoFont(30, 700);
    ctx.fillStyle = SAT;
    ctx.fillText(this.sats.toString(), pad, pad + 48);

    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(255,122,69,0.5)";
    ctx.fillText("DEBRIS", this.w - pad, pad + 34);
    ctx.font = monoFont(30, 700);
    ctx.fillStyle = this.debris > 60 ? WARN : DEBRIS;
    ctx.fillText(this.debris.toString(), this.w - pad, pad + 48);

    ctx.textAlign = "left";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillText(`PEAK ${this.peak}`, pad, pad + 84);

    if (this.sinceFirstHit >= 0) {
      ctx.textAlign = "right";
      ctx.fillStyle = "rgba(255,122,69,0.5)";
      ctx.fillText(
        `CASCADE +${this.sinceFirstHit.toFixed(1)}s`,
        this.w - pad,
        pad + 84,
      );
    }

    if (this.launched === 0) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const blink = 0.4 + Math.sin(this.time * 3) * 0.25;
      ctx.font = monoFont(11.5, 600);
      ctx.fillStyle = `rgba(255,255,255,${blink})`;
      ctx.fillText(
        this.c.isTouch
          ? "DRAG NEAR THE PLANET TO LAUNCH"
          : "DRAG NEAR THE PLANET TO LAUNCH — SIDEWAYS FOR A CIRCLE",
        this.cx,
        this.h - 46,
      );
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.14, 76);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = SAT;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("KESSLER", this.cx, this.h * 0.2);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.031), 500);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("BUILD THE CONSTELLATION.", this.cx, this.h * 0.2 + size * 0.62);
    ctx.fillStyle = "rgba(255,122,69,0.6)";
    ctx.fillText(
      "EVERY COLLISION LEAVES DEBRIS, AND DEBRIS NEVER LEAVES.",
      this.cx,
      this.h * 0.2 + size * 0.62 + 20,
    );

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(255,255,255,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", this.cx, this.h * 0.86);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(255,255,255,0.32)";
      ctx.fillText(`BEST CONSTELLATION ${this.best}`, this.cx, this.h * 0.86 + 24);
    }
  }

  private drawOver(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.overTime / 0.6));
    ctx.fillStyle = `rgba(10,4,16,${0.78 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const isBest = this.peak >= this.best && this.peak > 0;
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(255,51,85,${0.7 * ease})`;
    ctx.fillText(isBest ? "NEW BEST" : "ORBIT LOST", this.cx, this.cy - 58);

    const shown = Math.round(this.peak * clamp01(this.overTime / 0.5));
    ctx.font = monoFont(Math.min(this.w * 0.15, 72), 700);
    ctx.fillStyle = isBest ? DEBRIS : SAT;
    ctx.fillText(shown.toString(), this.cx, this.cy);

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = `rgba(255,255,255,${0.4 * ease})`;
    ctx.fillText("PEAK SATELLITES", this.cx, this.cy + 44);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(255,255,255,${0.5 * ease})`;
    ctx.fillText(
      `${this.launched} LAUNCHED   ·   ${this.collisions} COLLISIONS` +
        (this.sinceFirstHit > 0
          ? `   ·   HELD ${this.sinceFirstHit.toFixed(1)}s AFTER THE FIRST`
          : ""),
      this.cx,
      this.cy + 74,
    );

    if (this.overTime > 0.8) {
      const blink = 0.5 + Math.sin(this.overTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(255,255,255,${blink})`;
      ctx.fillText("CLEAR THE SKY AND TRY AGAIN", this.cx, this.h * 0.84);
    }
  }
}

const factory: GameFactory = (ctx) => new Kessler(ctx);
export default factory;
