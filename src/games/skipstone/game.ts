/**
 * SKIPSTONE
 *
 * You are the bullet. Pull back and release to fling yourself; you only get
 * one dash, and the only way to get it back is to hit something. There is no
 * safe ground — the floor kills — so a run is one unbroken chain and the
 * failure state is stopping.
 *
 * Every dash smears ink across the page and it never fades, so the end of a
 * run is a drawing of how you solved it.
 */

import { monoFont, uiFont } from "@/engine/draw";
import {
  TAU,
  clamp,
  clamp01,
  damp,
  dist,
  easeOutCubic,
  easeOutQuart,
  lerp,
} from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const PAPER = "#efe9dc";
const PAPER_DEEP = "#e2dac9";
const INK = "#17150f";
const INK_SOFT = "rgba(23,21,15,0.30)";
const ACCENT = "#d64000";

// --- tuning -----------------------------------------------------------------

const GRAVITY = 1400;
const AIR_DRAG = 0.5;
const PLAYER_R = 11;

const PULL_MAX = 155;
const LAUNCH_MIN = 320;
const LAUNCH_MAX = 1080;
/** Time dilation while aiming. Not a full stop — a full stop kills momentum. */
const AIM_TIME_SCALE = 0.22;

const FLOOR_MARGIN = 78;
const WARN_HEIGHT = 150;

const MIN_TARGETS = 3;
const MAX_TARGETS = 7;

type Kind = "still" | "drift" | "heavy";

interface Target {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  kind: Kind;
  hp: number;
  rot: number;
  spin: number;
  sides: number;
  /** Non-zero right after being struck — drives the crack/flash. */
  hurt: number;
  /** Grows on spawn so targets pop in rather than blink in. */
  born: number;
}

interface InkStroke {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w0: number;
  w1: number;
}

type Phase = "title" | "playing" | "dead";

class Skipstone implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private floorY = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private deadTime = 0;
  private time = 0;

  // player
  private px = 0;
  private py = 0;
  private vx = 0;
  private vy = 0;
  private dashes = 1;
  /**
   * Gravity is suspended until the first launch. Without this the drop from
   * the spawn point to the floor is under a second, which is not enough time
   * to aim — the run would be over before the player had acted once.
   */
  private launched = false;
  private lastX = 0;
  private lastY = 0;
  /** Seconds since the last launch — drives the trail thickness falloff. */
  private sinceLaunch = 99;

  // aiming
  private aiming = false;
  private aimX = 0;
  private aimY = 0;
  private aimStartX = 0;
  private aimStartY = 0;

  // run
  private targets: Target[] = [];
  private score = 0;
  private best = 0;
  private chain = 0;
  private bestChain = 0;
  private kills = 0;
  private launches = 0;
  private warn = 0;

  // ink layer — strokes accumulate here and are never re-drawn per frame
  private inkCanvas: HTMLCanvasElement | null = null;
  private inkCtx: CanvasRenderingContext2D | null = null;
  private pendingStrokes: InkStroke[] = [];

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.bestChain = ctx.store.get<number>("bestChain", 0);
    for (let i = 0; i < MAX_TARGETS + 4; i++) {
      this.targets.push({
        alive: false, x: 0, y: 0, vx: 0, vy: 0, r: 16,
        kind: "still", hp: 1, rot: 0, spin: 0, sides: 5, hurt: 0, born: 1,
      });
    }
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    const first = this.w === 0;
    this.w = w;
    this.h = h;
    this.floorY = h - FLOOR_MARGIN;

    // The ink layer is device-pixel sized so strokes stay crisp, and it is
    // rebuilt on resize (losing the drawing is better than stretching it).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = this.inkCanvas ?? document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const ictx = canvas.getContext("2d")!;
    ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ictx.clearRect(0, 0, w, h);
    this.inkCanvas = canvas;
    this.inkCtx = ictx;

    if (first) {
      this.px = w / 2;
      this.py = h * 0.42;
      this.lastX = this.px;
      this.lastY = this.py;
    } else {
      this.px = clamp(this.px, PLAYER_R, w - PLAYER_R);
      this.py = clamp(this.py, PLAYER_R, this.floorY - PLAYER_R);
    }
  }

  restart() {
    this.phase = "playing";
    this.time = 0;
    this.deadTime = 0;
    this.score = 0;
    this.chain = 0;
    this.kills = 0;
    this.launches = 0;
    this.warn = 0;
    this.dashes = 1;
    this.launched = false;
    this.aiming = false;
    this.px = this.w / 2;
    this.py = this.h * 0.4;
    this.lastX = this.px;
    this.lastY = this.py;
    this.vx = 0;
    this.vy = 0;
    this.sinceLaunch = 99;
    for (const t of this.targets) t.alive = false;
    this.inkCtx?.clearRect(0, 0, this.w, this.h);
    this.pendingStrokes.length = 0;
    for (let i = 0; i < MIN_TARGETS + 1; i++) this.spawnTarget();
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;

    if (this.phase === "title") {
      this.titleTime += dt;
      if (input.pointer.justUp && this.titleTime > 0.25) {
        this.c.audio.play({
          wave: "triangle", freq: 180, freqTo: 520, glide: 0.16,
          vol: 0.2, attack: 0.004, hold: 0.04, release: 0.18,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "dead") {
      this.deadTime += dt;
      // The floor warning is no longer being recomputed, so fade it out by
      // hand or the game-over card sits under a stuck orange wash.
      this.warn = damp(this.warn, 0, 0.12, dt);
      this.stepTargets(dt);
      if (input.pointer.justUp && this.deadTime > 0.7) this.restart();
      return;
    }

    this.time += dt;
    this.handleAim();
    this.stepPlayer(dt);
    this.stepTargets(dt);
    this.maintainTargets();
    this.checkHits();
    this.checkFloor(dt);
  }

  private handleAim() {
    const { input, fx } = this.c;
    const p = input.pointer;

    if (p.justDown && this.dashes > 0) {
      this.aiming = true;
      // Use the press origin recorded by Input, NOT p.x/p.y. Several pointer
      // events can land between two fixed updates, so by the time this runs
      // p.x has already moved — reading it here made a fast flick register as
      // a zero-length pull and silently swallow the launch.
      this.aimStartX = p.startX;
      this.aimStartY = p.startY;
      this.aimX = p.x;
      this.aimY = p.y;
    }

    if (this.aiming) {
      this.aimX = p.x;
      this.aimY = p.y;
      if (!p.down) {
        this.aiming = false;
        this.launch();
      }
    }

    // Aiming slows the world instead of pausing it. A hard pause makes the
    // launch feel disconnected from the motion that preceded it.
    void fx;
  }

  /** Pull vector: drag backwards, fly forwards. Same as every slingshot ever. */
  private get pull() {
    const dx = this.aimStartX - this.aimX;
    const dy = this.aimStartY - this.aimY;
    const len = Math.hypot(dx, dy);
    if (len < 1) return { dx: 0, dy: 0, len: 0, power: 0 };
    const clamped = Math.min(len, PULL_MAX);
    return {
      dx: dx / len,
      dy: dy / len,
      len: clamped,
      power: clamped / PULL_MAX,
    };
  }

  private launch() {
    const { audio, fx } = this.c;
    const pull = this.pull;
    // A flick too small to read as intent should not burn the only dash.
    if (pull.power < 0.12) return;

    const speed = lerp(LAUNCH_MIN, LAUNCH_MAX, pull.power);
    this.vx = pull.dx * speed;
    this.vy = pull.dy * speed;
    this.dashes--;
    this.launches++;
    this.launched = true;
    this.sinceLaunch = 0;

    fx.emit(this.px, this.py, {
      count: 10,
      angle: Math.atan2(-pull.dy, -pull.dx),
      spread: 0.7,
      speed: 190,
      life: 0.32,
      size: 2.4,
      color: [INK, "#4a4436"],
      drag: 4,
      shape: "spark",
      stretch: 0.8,
    });
    audio.play({
      wave: "noise", freq: 380, freqTo: 1500,
      vol: 0.13 + pull.power * 0.08,
      attack: 0.006, hold: 0.02, release: 0.12,
      filter: 700, filterTo: 3200, filterType: "bandpass", q: 1.6,
    });
  }

  private stepPlayer(dt: number) {
    // Time dilation while aiming, applied to the player only so the world
    // does not desync from the ink trail.
    const scale = this.aiming ? AIM_TIME_SCALE : 1;
    const step = dt * scale;

    this.lastX = this.px;
    this.lastY = this.py;

    if (!this.launched) {
      // Hovering. Bob gently so it reads as "waiting for you", not "frozen".
      this.py += Math.sin(this.time * 2.4) * 12 * dt;
      return;
    }

    this.vy += GRAVITY * step;
    const d = Math.max(0, 1 - AIR_DRAG * step);
    this.vx *= d;
    this.vy *= d;
    this.px += this.vx * step;
    this.py += this.vy * step;
    this.sinceLaunch += step;

    // Walls bounce; only the floor kills.
    if (this.px < PLAYER_R) {
      this.px = PLAYER_R;
      this.vx = Math.abs(this.vx) * 0.72;
      this.onWall();
    } else if (this.px > this.w - PLAYER_R) {
      this.px = this.w - PLAYER_R;
      this.vx = -Math.abs(this.vx) * 0.72;
      this.onWall();
    }
    if (this.py < PLAYER_R) {
      this.py = PLAYER_R;
      this.vy = Math.abs(this.vy) * 0.72;
      this.onWall();
    }

    this.recordStroke();
  }

  private onWall() {
    const { fx, audio } = this.c;
    const speed = Math.hypot(this.vx, this.vy);
    if (speed < 120) return;
    fx.shake(clamp(speed / 130, 1.5, 6), 8);
    audio.play({
      wave: "noise", freq: 500, freqTo: 180,
      vol: 0.09, attack: 0.001, hold: 0.012, release: 0.06,
      filter: 1800, filterTo: 500,
    });
  }

  /** Lay down ink proportional to speed — fast passes read as heavy strokes. */
  private recordStroke() {
    const speed = Math.hypot(this.vx, this.vy);
    if (speed < 40) return;
    const width = clamp(speed / 145, 1.4, 9);
    this.pendingStrokes.push({
      x0: this.lastX, y0: this.lastY,
      x1: this.px, y1: this.py,
      w0: width, w1: width,
    });
  }

  private flushStrokes() {
    const ictx = this.inkCtx;
    if (!ictx || this.pendingStrokes.length === 0) return;
    ictx.strokeStyle = INK;
    ictx.lineCap = "round";
    ictx.lineJoin = "round";
    for (const s of this.pendingStrokes) {
      ictx.globalAlpha = 0.5;
      ictx.lineWidth = s.w0;
      ictx.beginPath();
      ictx.moveTo(s.x0, s.y0);
      ictx.lineTo(s.x1, s.y1);
      ictx.stroke();
    }
    ictx.globalAlpha = 1;
    this.pendingStrokes.length = 0;
  }

  // --- targets --------------------------------------------------------------

  private spawnTarget() {
    const r = this.c.rng;
    const slot = this.targets.find((t) => !t.alive);
    if (!slot) return;

    const k = clamp01(this.time / 90);
    const kind: Kind = r.pickWeighted<Kind>(
      ["still", "drift", "heavy"],
      [1, 0.55 + k * 0.6, k * 0.5],
    );

    // Keep spawns in the upper reaches — the lower third is where you die,
    // and a target down there would bait the player into the floor.
    const yMin = this.h * 0.1;
    const yMax = this.floorY - 170;

    slot.alive = true;
    slot.kind = kind;
    slot.x = r.range(60, this.w - 60);
    slot.y = r.range(yMin, Math.max(yMin + 40, yMax));
    slot.rot = r.angle();
    slot.spin = r.spread(1.4);
    slot.hurt = 0;
    slot.born = 0;

    if (kind === "heavy") {
      slot.r = r.range(26, 34);
      slot.hp = 2;
      slot.sides = 6;
      slot.vx = r.spread(20);
      slot.vy = 0;
    } else if (kind === "drift") {
      slot.r = r.range(15, 20);
      slot.hp = 1;
      slot.sides = 4;
      slot.vx = r.sign() * r.range(45, 40 + k * 90);
      slot.vy = r.spread(18);
    } else {
      slot.r = r.range(16, 22);
      slot.hp = 1;
      slot.sides = r.int(3, 5);
      slot.vx = 0;
      slot.vy = 0;
    }
  }

  private stepTargets(dt: number) {
    for (const t of this.targets) {
      if (!t.alive) continue;
      if (t.born < 1) t.born = Math.min(1, t.born + dt * 4.5);
      t.rot += t.spin * dt;
      if (t.hurt > 0) t.hurt -= dt;
      t.x += t.vx * dt;
      t.y += t.vy * dt;

      if (t.x < t.r) { t.x = t.r; t.vx = Math.abs(t.vx); }
      if (t.x > this.w - t.r) { t.x = this.w - t.r; t.vx = -Math.abs(t.vx); }
      const top = this.h * 0.08;
      const bottom = this.floorY - 150;
      if (t.y < top) { t.y = top; t.vy = Math.abs(t.vy); }
      if (t.y > bottom) { t.y = bottom; t.vy = -Math.abs(t.vy); }
    }
  }

  private maintainTargets() {
    let count = 0;
    for (const t of this.targets) if (t.alive) count++;
    const want = Math.min(
      MAX_TARGETS,
      MIN_TARGETS + Math.floor(this.time / 22),
    );
    // Running out of things to hit is a death with no counterplay, so the
    // field is topped up immediately rather than on a timer.
    while (count < want) {
      this.spawnTarget();
      count++;
    }
  }

  private checkHits() {
    const { fx, audio } = this.c;
    for (const t of this.targets) {
      if (!t.alive || t.born < 0.35) continue;
      if (dist(this.px, this.py, t.x, t.y) > t.r + PLAYER_R) continue;

      t.hp--;
      t.hurt = 0.18;

      const speed = Math.hypot(this.vx, this.vy);
      const angle = Math.atan2(this.py - t.y, this.px - t.x);

      if (t.hp > 0) {
        // A heavy shrugs off the first hit and shoves you away — no dash back.
        this.vx = Math.cos(angle) * Math.max(speed * 0.55, 260);
        this.vy = Math.sin(angle) * Math.max(speed * 0.55, 260) - 90;
        fx.shake(7, 6);
        fx.freeze(0.045);
        fx.spray(t.x, t.y, angle, [INK, "#5a5140"], 0.9);
        audio.play({
          wave: "noise", freq: 320, freqTo: 90,
          vol: 0.2, attack: 0.001, hold: 0.03, release: 0.14,
          filter: 1400, filterTo: 280,
        });
        continue;
      }

      t.alive = false;
      this.kills++;
      this.chain++;
      this.bestChain = Math.max(this.bestChain, this.chain);
      this.dashes = 1;

      const mult = 1 + (this.chain - 1) * 0.5;
      const gained = Math.round(10 * mult);
      this.score += gained;

      // Keep the momentum you arrived with, nudged away from the impact.
      const outSpeed = clamp(speed * 0.82, 260, 900);
      this.vx = Math.cos(angle) * outSpeed * 0.35 + this.vx * 0.5;
      this.vy = Math.sin(angle) * outSpeed * 0.35 + this.vy * 0.5 - 60;

      fx.shake(clamp(4 + this.chain * 0.8, 4, 13), 5.5);
      // Hit-stop scaled to the chain: later hits in a run land harder.
      fx.freeze(clamp(0.045 + this.chain * 0.006, 0.045, 0.1));
      fx.flash(ACCENT, 0.07);
      fx.debris(t.x, t.y, [INK, "#3d3729", ACCENT], 1 + this.chain * 0.05);
      fx.emit(t.x, t.y, {
        count: 16,
        speed: 300,
        life: 0.4,
        size: 2.6,
        color: [INK, "#5a5140"],
        drag: 3.4,
        shape: "spark",
        stretch: 0.9,
      });
      fx.text(t.x, t.y - t.r - 8, `+${gained}`, ACCENT, 15, false);

      // Impact splatter is permanent — the page remembers every kill.
      this.splat(t.x, t.y, t.r);

      audio.thud(0.26);
      // Chain climbs a semitone at a time, so a long run is an ascending line.
      const semis = Math.min(this.chain - 1, 22);
      audio.play({
        wave: "square",
        freq: 330 * Math.pow(2, semis / 12),
        vol: 0.16,
        attack: 0.002,
        hold: 0.03,
        release: 0.14,
        filter: 3200,
      });

      this.c.report({ score: this.score });
      this.maintainTargets();
    }
  }

  private splat(x: number, y: number, radius: number) {
    const ictx = this.inkCtx;
    if (!ictx) return;
    const r = this.c.rng;
    ictx.fillStyle = INK;
    ictx.globalAlpha = 0.24;
    const blobs = r.int(5, 9);
    for (let i = 0; i < blobs; i++) {
      const a = r.angle();
      const d = r.range(0, radius * 1.5);
      const rr = r.range(1.5, radius * 0.42);
      ictx.beginPath();
      ictx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, rr, 0, TAU);
      ictx.fill();
    }
    ictx.globalAlpha = 1;
  }

  // --- floor ----------------------------------------------------------------

  private checkFloor(dt: number) {
    const { audio } = this.c;
    const distToFloor = this.floorY - (this.py + PLAYER_R);

    if (distToFloor < WARN_HEIGHT && this.vy > 0) {
      const prev = this.warn;
      this.warn = clamp01(1 - distToFloor / WARN_HEIGHT);
      // One tick per threshold crossing, accelerating as it closes.
      const stepSize = 0.2;
      if (Math.floor(this.warn / stepSize) > Math.floor(prev / stepSize)) {
        audio.play({
          wave: "square", freq: lerp(500, 900, this.warn),
          vol: 0.09, attack: 0.001, hold: 0.006, release: 0.03,
        });
      }
    } else {
      this.warn = damp(this.warn, 0, 0.2, dt);
    }

    if (this.py + PLAYER_R >= this.floorY) this.die();
  }

  private die() {
    const { fx, audio } = this.c;
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.deadTime = 0;
    this.py = this.floorY - PLAYER_R;

    fx.shake(20, 3.6);
    fx.freeze(0.13);
    fx.flash(INK, 0.14);
    fx.emit(this.px, this.floorY, {
      count: 40,
      angle: -Math.PI / 2,
      spread: 1.25,
      speed: 340,
      speedVar: 0.8,
      life: 0.8,
      lifeVar: 0.5,
      size: 3.2,
      color: [INK, "#3d3729"],
      gravity: 1400,
      drag: 1.2,
    });
    this.splat(this.px, this.floorY - 6, 34);

    audio.play({
      wave: "noise", freq: 420, freqTo: 60,
      vol: 0.3, attack: 0.002, hold: 0.09, release: 0.5,
      filter: 1500, filterTo: 120,
    });
    audio.play({
      wave: "sawtooth", freq: 190, freqTo: 44, glide: 0.55,
      vol: 0.22, attack: 0.005, hold: 0.1, release: 0.45,
      filter: 1200, filterTo: 200,
    });

    if (this.c.store.recordBest("best", this.score)) this.best = this.score;
    this.c.store.set("bestChain", this.bestChain);
    this.c.store.bump("plays");
    this.c.report({ status: "over", score: this.score, best: this.best });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    const w = this.w;
    const h = this.h;

    this.flushStrokes();

    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, w, h);
    this.drawPaperTexture(ctx);

    if (this.inkCanvas) {
      ctx.drawImage(this.inkCanvas, 0, 0, w, h);
    }

    fx.pushCamera(ctx, w / 2, h / 2);

    this.drawFloor(ctx);
    if (this.phase !== "title") {
      this.drawTargets(ctx);
      if (this.aiming) this.drawAim(ctx);
      this.drawPlayer(ctx);
    }
    fx.drawParticles(ctx);
    fx.drawTexts(ctx, "ui-monospace, monospace");

    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "dead") this.drawGameOver(ctx);

    fx.drawFlash(ctx, w, h);
  }

  private drawPaperTexture(ctx: CanvasRenderingContext2D) {
    // Two soft washes rather than a noise pass: cheaper, and it keeps the
    // page feeling like stock rather than a filtered photo.
    const g = ctx.createRadialGradient(
      this.w * 0.3, this.h * 0.2, 0,
      this.w * 0.3, this.h * 0.2, Math.max(this.w, this.h) * 0.9,
    );
    g.addColorStop(0, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    const v = ctx.createRadialGradient(
      this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.35,
      this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.78,
    );
    v.addColorStop(0, "rgba(120,108,86,0)");
    v.addColorStop(1, "rgba(120,108,86,0.2)");
    ctx.fillStyle = v;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  private drawFloor(ctx: CanvasRenderingContext2D) {
    const y = this.floorY;
    const h = this.h - y;

    // The floor is a pool of ink that gets restless as you approach.
    const wobble = this.warn * 6;
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.moveTo(0, this.h);
    ctx.lineTo(0, y);
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = t * this.w;
      const dy =
        Math.sin(t * 9 + this.time * 3.1) * (2 + wobble) +
        Math.sin(t * 21 + this.time * 5.4) * (1 + wobble * 0.5);
      ctx.lineTo(x, y + dy);
    }
    ctx.lineTo(this.w, this.h);
    ctx.closePath();
    ctx.fill();

    if (this.warn > 0.02) {
      ctx.save();
      ctx.globalAlpha = this.warn * 0.5;
      const g = ctx.createLinearGradient(0, y - WARN_HEIGHT, 0, y);
      g.addColorStop(0, "rgba(214,64,0,0)");
      g.addColorStop(1, "rgba(214,64,0,0.45)");
      ctx.fillStyle = g;
      ctx.fillRect(0, y - WARN_HEIGHT, this.w, WARN_HEIGHT);
      ctx.restore();
    }
    void h;
  }

  private drawTargets(ctx: CanvasRenderingContext2D) {
    for (const t of this.targets) {
      if (!t.alive) continue;
      const pop = easeOutQuart(clamp01(t.born));
      const hurt = t.hurt > 0 ? t.hurt / 0.18 : 0;
      const r = t.r * pop * (1 + hurt * 0.16);

      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate(t.rot);

      ctx.beginPath();
      for (let i = 0; i < t.sides; i++) {
        const a = (i / t.sides) * TAU - Math.PI / 2;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();

      if (hurt > 0.05) {
        ctx.fillStyle = ACCENT;
      } else if (t.kind === "heavy") {
        ctx.fillStyle = PAPER_DEEP;
        ctx.fill();
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = INK;
        ctx.stroke();
        // Second ring marks the extra hit point without needing a health bar.
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.45, 0, TAU);
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.restore();
        continue;
      } else {
        ctx.fillStyle = INK;
      }
      ctx.fill();

      if (t.kind === "drift") {
        ctx.beginPath();
        ctx.arc(0, 0, r * 0.34, 0, TAU);
        ctx.fillStyle = PAPER;
        ctx.fill();
      }
      ctx.restore();
    }
  }

  private drawAim(ctx: CanvasRenderingContext2D) {
    const pull = this.pull;
    if (pull.power < 0.05) return;

    const speed = lerp(LAUNCH_MIN, LAUNCH_MAX, pull.power);
    const vx = pull.dx * speed;
    const vy = pull.dy * speed;

    // Predicted arc, integrated with the same constants the sim uses.
    ctx.save();
    ctx.setLineDash([2, 9]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = INK_SOFT;
    ctx.beginPath();
    let sx = this.px;
    let sy = this.py;
    let svx = vx;
    let svy = vy;
    ctx.moveTo(sx, sy);
    const stepDt = 1 / 60;
    for (let i = 0; i < 55; i++) {
      svy += GRAVITY * stepDt;
      const d = 1 - AIR_DRAG * stepDt;
      svx *= d;
      svy *= d;
      sx += svx * stepDt;
      sy += svy * stepDt;
      if (sy > this.floorY || sx < 0 || sx > this.w) break;
      ctx.lineTo(sx, sy);
    }
    ctx.stroke();
    ctx.restore();

    // Power arc drawn on the body itself, not a bar somewhere else on screen.
    ctx.beginPath();
    ctx.arc(
      this.px, this.py, PLAYER_R + 9,
      -Math.PI / 2, -Math.PI / 2 + pull.power * TAU,
    );
    ctx.lineWidth = 3;
    ctx.strokeStyle = ACCENT;
    ctx.lineCap = "round";
    ctx.stroke();

    // The rubber band.
    ctx.beginPath();
    ctx.moveTo(this.px, this.py);
    ctx.lineTo(
      this.px - pull.dx * pull.len * 0.55,
      this.py - pull.dy * pull.len * 0.55,
    );
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = INK_SOFT;
    ctx.stroke();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D) {
    const speed = Math.hypot(this.vx, this.vy);
    const stretch = clamp(speed / 900, 0, 0.45);
    const a = Math.atan2(this.vy, this.vx);

    ctx.save();
    ctx.translate(this.px, this.py);
    if (speed > 90) {
      ctx.rotate(a);
      ctx.scale(1 + stretch, 1 - stretch * 0.55);
    }
    ctx.beginPath();
    ctx.arc(0, 0, PLAYER_R, 0, TAU);
    ctx.fillStyle = this.dashes > 0 ? INK : ACCENT;
    ctx.fill();
    ctx.restore();

    // A ring means "you still have a shot". Its absence is the warning.
    if (this.dashes > 0) {
      ctx.beginPath();
      ctx.arc(this.px, this.py, PLAYER_R + 5.5, 0, TAU);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = "rgba(23,21,15,0.35)";
      ctx.stroke();
    } else {
      const pulse = 0.5 + Math.sin(this.time * 14) * 0.5;
      ctx.beginPath();
      ctx.arc(this.px, this.py, PLAYER_R + 4 + pulse * 3, 0, TAU);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = `rgba(214,64,0,${0.25 + pulse * 0.4})`;
      ctx.stroke();
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(23,21,15,0.45)";
    ctx.fillText("SCORE", pad, pad + 32);

    ctx.font = monoFont(30, 700);
    ctx.fillStyle = INK;
    ctx.fillText(this.score.toString(), pad, pad + 46);

    if (!this.launched) {
      const blink = 0.5 + Math.sin(this.time * 3.2) * 0.35;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(23,21,15,${blink})`;
      ctx.fillText("PULL BACK AND RELEASE", this.w / 2, this.py + 58);
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
    }

    if (this.chain > 1) {
      ctx.textAlign = "right";
      ctx.font = monoFont(11, 500);
      ctx.fillStyle = "rgba(23,21,15,0.45)";
      ctx.fillText("CHAIN", this.w - pad, pad + 32);
      ctx.font = monoFont(30, 700);
      ctx.fillStyle = ACCENT;
      ctx.fillText(`×${this.chain}`, this.w - pad, pad + 46);
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;
    const cy = this.h * 0.4;

    // A stone skipping across the page. Its baseline sits below the whole
    // text block so the arc frames the words rather than crossing them.
    const skipBase = cy + 190;
    const skipHeight = 78;
    ctx.save();
    ctx.strokeStyle = INK_SOFT;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    const span = Math.min(this.w * 0.7, 620);
    const x0 = cx - span / 2;
    for (let i = 0; i <= 90; i++) {
      const p = i / 90;
      const x = x0 + p * span;
      const hop = Math.abs(Math.sin(p * Math.PI * 3.2)) * (1 - p * 0.72);
      const y = skipBase - hop * skipHeight;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const p = (t * 0.28) % 1;
    const sx = x0 + p * span;
    const hop = Math.abs(Math.sin(p * Math.PI * 3.2)) * (1 - p * 0.72);
    const sy = skipBase - hop * skipHeight;
    ctx.beginPath();
    ctx.arc(sx, sy, 8, 0, TAU);
    ctx.fillStyle = INK;
    ctx.fill();
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.14, 82);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = INK;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("SKIPSTONE", cx, cy);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.031), 500);
    ctx.fillStyle = "rgba(23,21,15,0.6)";
    ctx.fillText("YOU ARE THE BULLET.", cx, cy + size * 0.7);
    ctx.fillStyle = "rgba(23,21,15,0.42)";
    ctx.fillText(
      "ONE DASH. HIT SOMETHING TO GET IT BACK.",
      cx,
      cy + size * 0.7 + 20,
    );

    const blink = 0.55 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(23,21,15,${blink})`;
    ctx.fillText(
      this.c.isTouch ? "DRAG AND LET GO" : "DRAG WITH THE MOUSE AND LET GO",
      cx,
      this.h * 0.7,
    );

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(23,21,15,0.36)";
      ctx.fillText(
        `BEST ${this.best}   ·   LONGEST CHAIN ×${this.bestChain}`,
        cx,
        this.h * 0.7 + 26,
      );
    }
  }

  private drawGameOver(ctx: CanvasRenderingContext2D) {
    const k = clamp01(this.deadTime / 0.55);
    const ease = easeOutCubic(k);
    const cx = this.w / 2;
    const cy = this.h * 0.4;

    ctx.fillStyle = `rgba(239,233,220,${0.9 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const isBest = this.score >= this.best && this.score > 0;

    // Position is fixed and only opacity animates. Sliding the label into
    // place makes it cross the score during the first few frames.
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(23,21,15,${0.5 * ease})`;
    ctx.fillText(isBest ? "NEW BEST" : "YOU STOPPED", cx, cy - 58);

    const shown = Math.round(this.score * clamp01(this.deadTime / 0.5));
    ctx.font = monoFont(Math.min(this.w * 0.15, 74), 700);
    ctx.fillStyle = isBest ? ACCENT : INK;
    ctx.fillText(shown.toString(), cx, cy);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(23,21,15,${0.55 * ease})`;
    ctx.fillText(
      `${this.kills} HITS   ·   LONGEST CHAIN ×${this.bestChain}   ·   ${this.launches} DASHES`,
      cx,
      cy + 52,
    );

    if (this.deadTime > 0.7) {
      const blink = 0.5 + Math.sin(this.deadTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(23,21,15,${blink})`;
      ctx.fillText(
        this.c.isTouch ? "DRAG TO GO AGAIN" : "DRAG TO GO AGAIN",
        cx,
        this.h * 0.74,
      );
    }
  }
}

const factory: GameFactory = (ctx) => new Skipstone(ctx);
export default factory;
