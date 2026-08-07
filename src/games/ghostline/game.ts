/**
 * GHOSTLINE
 *
 * A time trial on one fixed track. Every lap you finish is recorded and comes
 * back as a *solid* ghost, so the better you get the more crowded the course
 * becomes. Your own history is the difficulty curve.
 *
 * The track seed is fixed for the whole session — that is what makes ghosts
 * mean anything. A fresh track every run would turn them into noise.
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
import { RNG } from "@/engine/rng";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const VOID = "#010806";
const VOID_2 = "#03100f";
const WALL = "#0f3d3d";
const WALL_EDGE = "#2c9c95";
const MINT = "#5eead4";
const HOT = "#ffb648";
const FAIL = "#ff4d6d";

// --- tuning -----------------------------------------------------------------

/** Track length in world units. One lap is this far. */
const LAP_LENGTH = 5200;
const SPEED = 315;
/**
 * How much of the track is visible ahead of the car. This is reaction time:
 * at 315 u/s a 780-unit view is 2.5 seconds of warning, which is what makes
 * the corridor readable rather than a reflex test.
 */
const VIEW_AHEAD = 780;
const VIEW_BEHIND = 150;

const CAR_R = 7;
const GHOST_R = 6.5;
/** Ghosts sampled every this many world units. */
const SAMPLE_STEP = 12;
const SAMPLES = Math.ceil(LAP_LENGTH / SAMPLE_STEP) + 2;

/** Above this, the oldest ghost stops colliding and becomes scenery. */
const SOLID_GHOSTS = 7;
const KEPT_GHOSTS = 14;
/**
 * Ghosts do not collide for the first stretch of a lap.
 *
 * Every lap starts from the same place, so without this the previous lap's
 * ghost is standing exactly where you spawn and the next run ends at 0%.
 * It is the racing equivalent of a starting grid.
 */
const GHOST_GRACE = 520;

type Phase = "title" | "racing" | "crashed" | "finished";

interface Ghost {
  /** Lateral position (-1..1) sampled every SAMPLE_STEP units. */
  xs: Float32Array;
  lapTime: number;
  /** Index in creation order — drives the colour ramp. */
  age: number;
}

class Ghostline implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private endTime = 0;

  /** Fixed for the session. Ghosts are meaningless without this. */
  private readonly seed: number;
  private readonly trackRng: RNG;
  private wobble: Array<{ amp: number; freq: number; phase: number }> = [];
  private widthWave: Array<{ amp: number; freq: number; phase: number }> = [];

  // car
  private dist = 0;
  private lateral = 0;
  private lateralTarget = 0;
  private lapTime = 0;
  /**
   * Steering is ignored for a moment after a restart. Without it, the click
   * that restarts the run is also a steering input, so the car snaps to
   * wherever the pointer happened to be and drives straight into a wall.
   */
  private steerLock = 0;

  // recording
  private recording = new Float32Array(SAMPLES);
  private ghosts: Ghost[] = [];
  private laps = 0;
  private bestLap = 0;
  private lastLap = 0;
  private crashDist = 0;

  private trail: Array<{ d: number; x: number }> = [];

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.seed = ctx.rng.int(1, 0xffffff);
    this.trackRng = new RNG(this.seed);
    this.bestLap = ctx.store.get<number>("bestLap", 0);
    this.buildTrack();
    ctx.report({ status: "idle", score: 0 });
  }

  private buildTrack() {
    const r = this.trackRng;
    // Three summed sines: enough to feel designed, few enough to stay readable.
    //
    // The amplitudes are bounded against the corridor width on purpose. The
    // first pass had the centre swinging +-0.72 while the corridor was as
    // narrow as +-0.14, which pushed the drivable lane clean off screen and
    // killed the car four percent into the lap.
    //
    // Hard rule: max |centre| + min halfWidth must stay inside the drivable
    // band, or there are stretches where no steering input can save you.
    // 0.22+0.10+0.04 = 0.36 against a floor width of 0.24 clears it.
    this.wobble = [
      { amp: 0.22, freq: 1 / 1250, phase: r.range(0, TAU) },
      { amp: 0.1, freq: 1 / 540, phase: r.range(0, TAU) },
      { amp: 0.04, freq: 1 / 240, phase: r.range(0, TAU) },
    ];
    this.widthWave = [
      { amp: 0.22, freq: 1 / 820, phase: r.range(0, TAU) },
      { amp: 0.1, freq: 1 / 360, phase: r.range(0, TAU) },
    ];
  }

  /** Track centre at a distance, in -1..1 track space. */
  private centreAt(d: number): number {
    let v = 0;
    for (const s of this.wobble) v += Math.sin(d * s.freq * TAU + s.phase) * s.amp;
    // Taper to centre at the start and finish so both ends are always fair.
    const ends = Math.min(clamp01(d / 420), clamp01((LAP_LENGTH - d) / 420));
    return clamp(v, -0.36, 0.36) * ends;
  }

  /** Half-width of the corridor at a distance, in track space. */
  private halfWidthAt(d: number): number {
    let v = 0;
    for (const s of this.widthWave) v += Math.sin(d * s.freq * TAU + s.phase) * s.amp;
    // Narrows as the lap progresses — the finish should be the hard part.
    const squeeze = lerp(1, 0.78, clamp01(d / LAP_LENGTH));
    // The opening stretch is wide enough to find the car before it matters.
    const opening = lerp(1.5, 1, clamp01(d / 1100));
    return clamp((0.33 + v * 0.3) * squeeze * opening, 0.24, 0.46);
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  /** Track space (-1..1) to screen x. */
  private tx(x: number) {
    return this.w / 2 + x * this.w * 0.42;
  }

  /** Distance to screen y. The car sits low; the track flows toward it. */
  private ty(d: number) {
    const carY = this.h * 0.76;
    return carY - (d - this.dist) * ((this.h * 0.76) / VIEW_AHEAD);
  }

  restart() {
    this.phase = "racing";
    this.dist = 0;
    this.lateral = this.centreAt(0);
    this.lateralTarget = this.lateral;
    this.lapTime = 0;
    this.steerLock = 0.3;
    this.recording = new Float32Array(SAMPLES);
    this.trail.length = 0;
    this.c.report({ status: "playing", score: this.laps });
  }

  private fullReset() {
    this.ghosts.length = 0;
    this.laps = 0;
    this.lastLap = 0;
    this.restart();
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "sawtooth", freq: 110, freqTo: 330, glide: 0.22,
          vol: 0.16, attack: 0.006, hold: 0.06, release: 0.25, filter: 1600,
        });
        this.fullReset();
      }
      return;
    }

    if (this.phase === "crashed" || this.phase === "finished") {
      this.endTime += dt;
      if (this.endTime > 0.55 && (input.pointer.justUp || input.confirmPressed)) {
        this.restart();
      }
      return;
    }

    this.lapTime += dt;
    this.steer(dt);
    this.advance(dt);
  }

  private steer(dt: number) {
    const { input } = this.c;

    if (this.steerLock > 0) {
      this.steerLock -= dt;
      return;
    }

    if (input.isTouch) {
      // Relative drag: the thumb stays out of the corridor it is steering.
      if (input.pointer.down) {
        this.lateralTarget += (input.pointer.dx / (this.w * 0.42)) * 1.5;
      }
    } else if (input.pointer.everMoved) {
      // Absolute, and deliberately not gated on the button being held —
      // requiring a held button to steer a car is friction with no upside.
      this.lateralTarget = (input.pointer.x - this.w / 2) / (this.w * 0.42);
    }

    const kx = input.axisX;
    if (kx !== 0) this.lateralTarget += kx * 1.5 * dt;

    this.lateralTarget = clamp(this.lateralTarget, -1, 1);
    // Steering has weight, but not much — heavy steering plus a narrow
    // corridor is just unfairness with extra steps.
    this.lateral = damp(this.lateral, this.lateralTarget, 0.45, dt);
  }

  private advance(dt: number) {
    const { fx } = this.c;
    const prevDist = this.dist;
    this.dist += SPEED * dt;

    // Record between the previous and current distance so a frame drop cannot
    // leave holes in the ghost line.
    const from = Math.floor(prevDist / SAMPLE_STEP);
    const to = Math.floor(this.dist / SAMPLE_STEP);
    for (let i = from; i <= to && i < SAMPLES; i++) {
      if (i >= 0) this.recording[i] = this.lateral;
    }

    this.trail.push({ d: this.dist, x: this.lateral });
    if (this.trail.length > 90) this.trail.shift();

    if (this.dist >= LAP_LENGTH) {
      this.finishLap();
      return;
    }

    const centre = this.centreAt(this.dist);
    const half = this.halfWidthAt(this.dist);
    const carHalf = CAR_R / (this.w * 0.42);

    if (Math.abs(this.lateral - centre) + carHalf > half) {
      this.crash("WALL");
      return;
    }

    if (this.dist < GHOST_GRACE) return;

    const idx = Math.floor(this.dist / SAMPLE_STEP);
    const hitR = (CAR_R + GHOST_R) / (this.w * 0.42);
    const solidFrom = Math.max(0, this.ghosts.length - SOLID_GHOSTS);
    for (let g = solidFrom; g < this.ghosts.length; g++) {
      const gx = this.ghosts[g].xs[clamp(idx, 0, SAMPLES - 1)];
      if (Math.abs(this.lateral - gx) < hitR) {
        this.crash("GHOST");
        return;
      }
    }

    // Engine note rises with how close you are to a wall — an audible sense of
    // margin, so the player can feel the corridor without staring at it.
    void fx;
  }

  private crash(kind: "WALL" | "GHOST") {
    const { fx, audio } = this.c;
    this.phase = "crashed";
    this.endTime = 0;
    this.crashDist = this.dist;

    fx.shake(20, 3.6);
    fx.freeze(0.11);
    fx.flash(kind === "GHOST" ? MINT : FAIL, 0.13);
    const sx = this.tx(this.lateral);
    const sy = this.ty(this.dist);
    fx.emit(sx, sy, {
      count: 34, speed: 300, speedVar: 0.8, life: 0.8, lifeVar: 0.5,
      size: 2.8, color: [kind === "GHOST" ? MINT : FAIL, "#ffffff"],
      drag: 2.2, additive: true, stretch: 0.7,
    });

    audio.play({
      wave: "noise", freq: 600, freqTo: 90, vol: 0.28,
      attack: 0.002, hold: 0.07, release: 0.4, filter: 1800, filterTo: 200,
    });
    audio.play({
      wave: "sawtooth", freq: 220, freqTo: 45, glide: 0.5,
      vol: 0.2, attack: 0.004, hold: 0.1, release: 0.42, filter: 1200, filterTo: 180,
    });

    this.c.report({ status: "over", score: this.laps });
  }

  private finishLap() {
    const { fx, audio } = this.c;
    this.phase = "finished";
    this.endTime = 0;
    this.laps++;
    this.lastLap = this.lapTime;

    // Fill any trailing samples so the ghost is complete to the finish line.
    const lastIdx = Math.min(SAMPLES - 1, Math.floor(LAP_LENGTH / SAMPLE_STEP));
    for (let i = lastIdx; i < SAMPLES; i++) this.recording[i] = this.lateral;

    this.ghosts.push({
      xs: this.recording,
      lapTime: this.lapTime,
      age: this.laps,
    });
    // Older ghosts stop colliding but stay on screen — the history remains
    // visible without eventually making the track impossible.
    if (this.ghosts.length > KEPT_GHOSTS) this.ghosts.shift();

    if (this.bestLap === 0 || this.lapTime < this.bestLap) {
      this.bestLap = this.lapTime;
      this.c.store.set("bestLap", this.lapTime);
    }
    this.c.store.recordBest("bestLaps", this.laps);

    fx.flash(HOT, 0.12);
    fx.shake(7, 6);
    const sx = this.tx(this.lateral);
    fx.emit(sx, this.h * 0.76, {
      count: 26, angle: -Math.PI / 2, spread: 1.1, speed: 260,
      life: 0.7, size: 2.6, color: [HOT, MINT, "#ffffff"], drag: 2.4, additive: true,
    });

    [0, 4, 7, 12].forEach((s, i) =>
      audio.play({
        wave: "square", freq: 392 * Math.pow(2, s / 12),
        vol: 0.13, attack: 0.003, hold: 0.05, release: 0.24, delay: i * 0.055,
      }),
    );

    this.c.report({ status: "playing", score: this.laps });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, this.w, this.h);

    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, VOID);
    g.addColorStop(1, VOID_2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    if (this.phase !== "title") {
      this.drawTrack(ctx);
      this.drawGhosts(ctx);
      this.drawFinishLine(ctx);
      this.drawTrail(ctx);
      if (this.phase !== "crashed") this.drawCar(ctx);
    }
    fx.drawParticles(ctx);

    fx.popCamera(ctx);

    if (this.phase === "racing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "crashed") this.drawCrash(ctx);
    if (this.phase === "finished") this.drawFinished(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawTrack(ctx: CanvasRenderingContext2D) {
    const start = Math.max(0, this.dist - VIEW_BEHIND);
    const end = Math.min(LAP_LENGTH + 200, this.dist + VIEW_AHEAD);
    const step = 14;

    // The corridor as a filled band, so "inside" is unambiguous at a glance.
    ctx.beginPath();
    let first = true;
    for (let d = start; d <= end; d += step) {
      const x = this.tx(this.centreAt(d) - this.halfWidthAt(d));
      const y = this.ty(d);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    for (let d = end; d >= start; d -= step) {
      ctx.lineTo(this.tx(this.centreAt(d) + this.halfWidthAt(d)), this.ty(d));
    }
    ctx.closePath();
    ctx.fillStyle = WALL;
    ctx.fill();

    // Edges
    ctx.strokeStyle = WALL_EDGE;
    ctx.lineWidth = 2;
    for (const side of [-1, 1]) {
      ctx.beginPath();
      let f = true;
      for (let d = start; d <= end; d += step) {
        const x = this.tx(this.centreAt(d) + side * this.halfWidthAt(d));
        const y = this.ty(d);
        if (f) { ctx.moveTo(x, y); f = false; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Distance ticks every 400 units — a sense of progress without a bar.
    ctx.strokeStyle = "rgba(94,234,212,0.1)";
    ctx.lineWidth = 1;
    const firstTick = Math.ceil(start / 400) * 400;
    for (let d = firstTick; d <= end; d += 400) {
      const y = this.ty(d);
      const c = this.centreAt(d);
      const hw = this.halfWidthAt(d);
      ctx.beginPath();
      ctx.moveTo(this.tx(c - hw), y);
      ctx.lineTo(this.tx(c + hw), y);
      ctx.stroke();
    }
  }

  private drawGhosts(ctx: CanvasRenderingContext2D) {
    const start = Math.max(0, this.dist - VIEW_BEHIND);
    const end = Math.min(LAP_LENGTH, this.dist + VIEW_AHEAD);
    const i0 = Math.floor(start / SAMPLE_STEP);
    const i1 = Math.ceil(end / SAMPLE_STEP);
    const solidFrom = Math.max(0, this.ghosts.length - SOLID_GHOSTS);

    for (let g = 0; g < this.ghosts.length; g++) {
      const ghost = this.ghosts[g];
      const solid = g >= solidFrom;
      // Newest ghosts are hot and bright; retired ones fade to background.
      const recency = this.ghosts.length === 1 ? 1 : g / (this.ghosts.length - 1);
      const color = solid
        ? `rgba(${lerp(94, 255, recency) | 0},${lerp(234, 182, recency) | 0},${lerp(212, 72, recency) | 0},${0.45 + recency * 0.5})`
        : "rgba(94,234,212,0.13)";

      ctx.beginPath();
      let f = true;
      for (let i = i0; i <= i1 && i < SAMPLES; i++) {
        if (i < 0) continue;
        const x = this.tx(ghost.xs[i]);
        const y = this.ty(i * SAMPLE_STEP);
        if (f) { ctx.moveTo(x, y); f = false; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = solid ? 3 : 1.4;
      ctx.lineCap = "round";
      ctx.stroke();

      // Solid ghosts also render a body at the player's current distance, so
      // the thing you are about to hit is visible as an object, not a line.
      if (!solid) continue;
      const idx = clamp(Math.floor(this.dist / SAMPLE_STEP), 0, SAMPLES - 1);
      const bx = this.tx(ghost.xs[idx]);
      const by = this.ty(this.dist);
      // During the grace stretch the body is drawn hollow, so it is obvious
      // that it is not yet solid rather than looking like a missed collision.
      const inGrace = this.dist < GHOST_GRACE;
      ctx.beginPath();
      ctx.arc(bx, by, GHOST_R, 0, TAU);
      if (inGrace) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
  }

  private drawFinishLine(ctx: CanvasRenderingContext2D) {
    if (LAP_LENGTH > this.dist + VIEW_AHEAD) return;
    const y = this.ty(LAP_LENGTH);
    const c = this.centreAt(LAP_LENGTH);
    const hw = this.halfWidthAt(LAP_LENGTH);
    const x0 = this.tx(c - hw);
    const x1 = this.tx(c + hw);
    const cells = 10;
    for (let i = 0; i < cells; i++) {
      ctx.fillStyle = i % 2 === 0 ? HOT : "rgba(255,255,255,0.9)";
      ctx.fillRect(
        x0 + ((x1 - x0) / cells) * i,
        y - 5,
        (x1 - x0) / cells,
        10,
      );
    }
  }

  private drawTrail(ctx: CanvasRenderingContext2D) {
    if (this.trail.length < 2) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.beginPath();
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const x = this.tx(t.x);
      const y = this.ty(t.d);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(94,234,212,0.35)";
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.stroke();
    ctx.restore();
  }

  private drawCar(ctx: CanvasRenderingContext2D) {
    const x = this.tx(this.lateral);
    const y = this.ty(this.dist);

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(x, y, 0, x, y, CAR_R * 4);
    g.addColorStop(0, "rgba(94,234,212,0.5)");
    g.addColorStop(1, "rgba(94,234,212,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - CAR_R * 4, y - CAR_R * 4, CAR_R * 8, CAR_R * 8);
    ctx.restore();

    // Leans into the turn — a static dot reads as a cursor, not a vehicle.
    const lean = clamp((this.lateralTarget - this.lateral) * 2.6, -0.5, 0.5);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(lean);
    ctx.beginPath();
    ctx.moveTo(0, -CAR_R * 1.5);
    ctx.lineTo(CAR_R, CAR_R);
    ctx.lineTo(0, CAR_R * 0.45);
    ctx.lineTo(-CAR_R, CAR_R);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.restore();
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(94,234,212,0.45)";
    ctx.fillText("LAP", pad, pad + 34);
    ctx.font = monoFont(30, 700);
    ctx.fillStyle = MINT;
    ctx.fillText(this.lapTime.toFixed(2), pad, pad + 48);

    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(94,234,212,0.45)";
    ctx.fillText("GHOSTS", this.w - pad, pad + 34);
    ctx.font = monoFont(30, 700);
    const solid = Math.min(this.ghosts.length, SOLID_GHOSTS);
    ctx.fillStyle = solid >= SOLID_GHOSTS ? HOT : MINT;
    ctx.fillText(`${solid}`, this.w - pad, pad + 48);

    // Progress along the lap, drawn as a thin rail down the right edge.
    const barH = this.h * 0.4;
    const barY = this.h * 0.3;
    const barX = this.w - 10;
    ctx.fillStyle = "rgba(94,234,212,0.12)";
    ctx.fillRect(barX, barY, 2, barH);
    ctx.fillStyle = MINT;
    const p = clamp01(this.dist / LAP_LENGTH);
    ctx.fillRect(barX, barY + barH * (1 - p), 2, barH * p);

    if (this.bestLap > 0) {
      ctx.textAlign = "left";
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(94,234,212,0.35)";
      ctx.fillText(`BEST ${this.bestLap.toFixed(2)}`, pad, pad + 84);
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;

    // A few demo lines converging, so the premise is visible before it's read.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let g = 0; g < 6; g++) {
      ctx.beginPath();
      for (let i = 0; i <= 70; i++) {
        const p = i / 70;
        const y = this.h * 0.16 + p * this.h * 0.34;
        const spread = (1 - p) * 0.9 + 0.06;
        const x =
          cx +
          Math.sin(p * 5.4 + g * 1.1 + t * 0.5) * this.w * 0.16 * spread;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      const k = g / 5;
      ctx.strokeStyle = `rgba(${lerp(94, 255, k) | 0},${lerp(234, 182, k) | 0},${lerp(212, 72, k) | 0},${0.16 + k * 0.3})`;
      ctx.lineWidth = 1 + k * 2;
      ctx.stroke();
    }
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.14, 78);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = MINT;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("GHOSTLINE", cx, this.h * 0.6);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.031), 500);
    ctx.fillStyle = "rgba(94,234,212,0.6)";
    ctx.fillText("EVERY LAP YOU FINISH COMES BACK.", cx, this.h * 0.6 + size * 0.64);
    ctx.fillStyle = "rgba(255,182,72,0.55)";
    ctx.fillText(
      "AS A WALL.",
      cx,
      this.h * 0.6 + size * 0.64 + 20,
    );

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(94,234,212,${blink})`;
    ctx.fillText(
      this.c.isTouch ? "TAP TO START  ·  DRAG TO STEER" : "CLICK TO START  ·  MOUSE OR A/D",
      cx,
      this.h * 0.84,
    );

    if (this.bestLap > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(94,234,212,0.32)";
      ctx.fillText(`BEST LAP ${this.bestLap.toFixed(2)}s`, cx, this.h * 0.84 + 24);
    }
  }

  private drawCrash(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.5));
    const cx = this.w / 2;
    const cy = this.h * 0.4;

    ctx.fillStyle = `rgba(2,16,14,${0.82 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(255,77,109,${0.65 * ease})`;
    ctx.fillText("RUN ENDED", cx, cy - 54);

    ctx.font = monoFont(Math.min(this.w * 0.14, 66), 700);
    ctx.fillStyle = MINT;
    const pct = Math.round((this.crashDist / LAP_LENGTH) * 100);
    ctx.fillText(`${Math.round(pct * clamp01(this.endTime / 0.45))}%`, cx, cy);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(94,234,212,${0.5 * ease})`;
    ctx.fillText(
      `${this.laps} LAPS BANKED   ·   ${Math.min(this.ghosts.length, SOLID_GHOSTS)} GHOSTS SOLID`,
      cx,
      cy + 48,
    );

    if (this.endTime > 0.55) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(94,234,212,${blink})`;
      ctx.fillText("GO AGAIN — THE GHOSTS STAY", cx, this.h * 0.78);
    }
  }

  private drawFinished(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.5));
    const cx = this.w / 2;
    const cy = this.h * 0.4;

    ctx.fillStyle = `rgba(2,16,14,${0.8 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const isBest = this.lastLap <= this.bestLap;
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(255,182,72,${0.7 * ease})`;
    ctx.fillText(isBest ? "FASTEST LAP YET" : "LAP COMPLETE", cx, cy - 54);

    ctx.font = monoFont(Math.min(this.w * 0.14, 66), 700);
    ctx.fillStyle = isBest ? HOT : MINT;
    ctx.fillText(`${this.lastLap.toFixed(2)}s`, cx, cy);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(94,234,212,${0.55 * ease})`;
    ctx.fillText(
      `LAP ${this.laps}   ·   THAT RUN IS NOW A WALL`,
      cx,
      cy + 48,
    );

    if (this.endTime > 0.55) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(94,234,212,${blink})`;
      ctx.fillText("NEXT LAP", cx, this.h * 0.78);
    }
  }
}

const factory: GameFactory = (ctx) => new Ghostline(ctx);
export default factory;
