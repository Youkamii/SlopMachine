/**
 * GRAZEFIELD
 *
 * A bullet-hell with no weapon. The only way to deal damage is to almost be
 * hit: passing within a few pixels of a bullet "grazes" it, which charges a
 * beam and injects colour into a monochrome world.
 *
 * Play safe and the screen stays grey for the whole run. Live on the edge of
 * death and it blooms. The final screenshot is a record of how dangerously
 * you played.
 */

import { monoFont, uiFont } from "@/engine/draw";
import {
  TAU,
  clamp,
  clamp01,
  damp,
  dist2,
  easeOutCubic,
  easeOutQuart,
  lerp,
} from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- tuning -----------------------------------------------------------------

const HITBOX = 3.2;
const GRAZE_RADIUS = 30;
/** Seconds a bullet must wait before it can be grazed again. */
const REGRAZE_DELAY = 0.45;
const CHARGE_PER_GRAZE = 0.055;
const BEAM_DURATION = 0.42;
const BEAM_HALF_WIDTH = 46;
/** Saturation gained per graze and lost per second of playing it safe. */
const SAT_PER_GRAZE = 0.028;
const SAT_DECAY = 0.11;

const MAX_BULLETS = 1400;
const MAX_BLOOMS = 56;

/** Pentatonic scale so chained grazes always land as melody, never noise. */
const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

// --- entities ---------------------------------------------------------------

interface Bullet {
  alive: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  /** Hue this bullet contributes once the world has colour. */
  hue: number;
  /** Seconds until it can be grazed again. */
  cooldown: number;
  /** Grows briefly after a graze — the bullet acknowledges the near miss. */
  flash: number;
  age: number;
  /** Bullets spawned off-screen must not be culled before they arrive. */
  entered: boolean;
}

interface Bloom {
  alive: boolean;
  x: number;
  y: number;
  hue: number;
  life: number;
  maxLife: number;
  radius: number;
}

type Phase = "title" | "playing" | "dead";

// --- patterns ---------------------------------------------------------------

type PatternName = "ring" | "spiral" | "aimed" | "wall" | "spinner" | "rain";

interface Emitter {
  name: PatternName;
  x: number;
  y: number;
  /** Seconds left before this emitter retires. */
  life: number;
  timer: number;
  interval: number;
  angle: number;
  spin: number;
  count: number;
  speed: number;
  hue: number;
}

class Grazefield implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private phase: Phase = "title";
  private time = 0;
  private titleTime = 0;
  private deadTime = 0;

  // player
  private px = 0;
  private py = 0;
  private ptx = 0;
  private pty = 0;
  private trailX: number[] = [];
  private trailY: number[] = [];

  // run state
  private grazes = 0;
  private score = 0;
  private best = 0;
  private saturation = 0;
  private peakSaturation = 0;
  private charge = 0;
  private beamTime = 0;
  private beamCount = 0;
  private combo = 0;
  private comboTimer = 0;

  private bullets: Bullet[] = [];
  private blooms: Bloom[] = [];
  private emitters: Emitter[] = [];
  private spawnTimer = 0;
  private waveIndex = 0;

  /** Rolling "danger" value — drives the vignette and the low drone. */
  private tension = 0;

  private starX: number[] = [];
  private starY: number[] = [];
  private starR: number[] = [];

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;

    for (let i = 0; i < MAX_BULLETS; i++) {
      this.bullets.push({
        alive: false, x: 0, y: 0, vx: 0, vy: 0, r: 4,
        hue: 0, cooldown: 0, flash: 0, age: 0, entered: false,
      });
    }
    for (let i = 0; i < MAX_BLOOMS; i++) {
      this.blooms.push({
        alive: false, x: 0, y: 0, hue: 0, life: 0, maxLife: 1, radius: 100,
      });
    }
    ctx.report({ status: "idle", score: 0, label: "GRAZEFIELD" });
  }

  resize(w: number, h: number) {
    const firstLayout = this.w === 0;
    this.w = w;
    this.h = h;
    if (firstLayout) {
      this.px = this.ptx = w / 2;
      this.py = this.pty = h * 0.72;
      this.seedStars();
    } else {
      this.px = clamp(this.px, 0, w);
      this.py = clamp(this.py, 0, h);
      this.ptx = clamp(this.ptx, 0, w);
      this.pty = clamp(this.pty, 0, h);
      this.seedStars();
    }
  }

  private seedStars() {
    const count = Math.round((this.w * this.h) / 14000);
    this.starX.length = 0;
    this.starY.length = 0;
    this.starR.length = 0;
    const r = this.c.rng;
    for (let i = 0; i < count; i++) {
      this.starX.push(r.range(0, this.w));
      this.starY.push(r.range(0, this.h));
      this.starR.push(r.range(0.4, 1.5));
    }
  }

  // --- lifecycle ------------------------------------------------------------

  restart() {
    this.phase = "playing";
    this.time = 0;
    this.deadTime = 0;
    this.grazes = 0;
    this.score = 0;
    this.saturation = 0;
    this.peakSaturation = 0;
    this.charge = 0;
    this.beamTime = 0;
    this.beamCount = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.tension = 0;
    this.spawnTimer = 0.9;
    this.waveIndex = 0;
    this.emitters.length = 0;
    for (const b of this.bullets) b.alive = false;
    for (const b of this.blooms) b.alive = false;
    this.trailX.length = 0;
    this.trailY.length = 0;
    this.px = this.ptx = this.w / 2;
    this.py = this.pty = this.h * 0.72;
    this.c.report({ status: "playing", score: 0, label: "0" });
  }

  update(dt: number) {
    const { input, fx } = this.c;

    if (this.phase === "title") {
      this.titleTime += dt;
      this.updateBlooms(dt);
      if (
        (input.pointer.justDown || input.confirmPressed) &&
        this.titleTime > 0.25
      ) {
        this.c.audio.play({
          wave: "triangle", freq: 220, freqTo: 660, glide: 0.18,
          vol: 0.22, attack: 0.004, hold: 0.05, release: 0.2,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "dead") {
      this.deadTime += dt;
      this.updateBullets(dt, false);
      this.updateBlooms(dt);
      this.saturation = damp(this.saturation, 0, 0.02, dt);
      if (
        (input.pointer.justDown || input.confirmPressed) &&
        this.deadTime > 0.7
      ) {
        this.restart();
      }
      return;
    }

    // --- playing ---
    this.time += dt;
    this.movePlayer(dt);
    this.runSpawner(dt);
    this.updateEmitters(dt);
    this.updateBullets(dt, true);
    this.updateBlooms(dt);

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 0;
    }

    this.saturation = clamp01(this.saturation - SAT_DECAY * dt);
    this.peakSaturation = Math.max(this.peakSaturation, this.saturation);

    if (this.beamTime > 0) {
      this.beamTime -= dt;
      this.sweepBeam(dt);
    }

    // Tension tracks how many bullets are close, which drives the vignette.
    let near = 0;
    for (const b of this.bullets) {
      if (!b.alive || !b.entered) continue;
      if (dist2(b.x, b.y, this.px, this.py) < 130 * 130) near++;
    }
    this.tension = damp(this.tension, clamp01(near / 14), 0.1, dt);

    this.score = this.grazes * 10 + Math.floor(this.time * 4) + this.beamCount * 5;
    fx.pendingFreeze = Math.min(fx.pendingFreeze, 0.12);
  }

  private movePlayer(dt: number) {
    const { input } = this.c;

    if (input.isTouch) {
      // Relative dragging: the finger never covers the ship.
      if (input.pointer.down) {
        this.ptx += input.pointer.dx * 1.35;
        this.pty += input.pointer.dy * 1.35;
      }
    } else if (input.pointer.everMoved) {
      this.ptx = input.pointer.x;
      this.pty = input.pointer.y;
    }

    // Keyboard works alongside the pointer rather than instead of it.
    const kx = input.axisX;
    const ky = input.axisY;
    if (kx !== 0 || ky !== 0) {
      const slow = input.isDown("ShiftLeft", "ShiftRight") ? 0.4 : 1;
      const speed = 430 * slow;
      const len = Math.hypot(kx, ky) || 1;
      this.ptx += (kx / len) * speed * dt;
      this.pty += (ky / len) * speed * dt;
    }

    const m = 6;
    this.ptx = clamp(this.ptx, m, this.w - m);
    this.pty = clamp(this.pty, m, this.h - m);

    // A touch of lag makes the ship feel like an object rather than a cursor.
    this.px = damp(this.px, this.ptx, 0.55, dt);
    this.py = damp(this.py, this.pty, 0.55, dt);

    this.trailX.unshift(this.px);
    this.trailY.unshift(this.py);
    if (this.trailX.length > 14) {
      this.trailX.pop();
      this.trailY.pop();
    }
  }

  // --- spawning -------------------------------------------------------------

  /** Difficulty ramp: 0 at the start, 1 after ~110 seconds. */
  private get intensity() {
    return clamp01(this.time / 110);
  }

  private runSpawner(dt: number) {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;

    const k = this.intensity;
    const r = this.c.rng;
    this.waveIndex++;

    const pool: PatternName[] = ["ring", "aimed", "rain"];
    if (this.time > 12) pool.push("spiral");
    if (this.time > 22) pool.push("wall");
    if (this.time > 34) pool.push("spinner");

    const name = r.pick(pool);
    this.addEmitter(name, k);

    // A second, overlapping emitter once the player has found their footing.
    if (this.time > 45 && r.bool(0.35)) {
      this.addEmitter(r.pick(pool), k * 0.8);
    }

    this.spawnTimer = lerp(2.6, 1.05, k) * r.range(0.85, 1.2);
  }

  private addEmitter(name: PatternName, k: number) {
    const r = this.c.rng;
    const hue = (this.waveIndex * 47 + r.int(0, 40)) % 360;
    const edge = r.int(0, 3);

    let x = r.range(this.w * 0.15, this.w * 0.85);
    let y = r.range(this.h * 0.08, this.h * 0.3);

    if (name === "wall") {
      x = this.w / 2;
      y = -30;
    } else if (name === "rain") {
      x = r.range(0, this.w);
      y = -30;
    } else if (name === "spinner") {
      // Spinners come from a screen edge so they sweep across the field.
      if (edge === 0) { x = -40; y = r.range(0, this.h); }
      else if (edge === 1) { x = this.w + 40; y = r.range(0, this.h); }
      else { x = r.range(0, this.w); y = -40; }
    }

    const base: Emitter = {
      name, x, y, hue,
      life: lerp(2.2, 3.6, k),
      timer: 0,
      interval: 0.22,
      angle: r.angle(),
      spin: r.sign() * lerp(1.1, 2.4, k),
      count: 10,
      speed: lerp(115, 205, k),
    };

    switch (name) {
      case "ring":
        base.count = Math.round(lerp(11, 24, k));
        base.interval = lerp(0.85, 0.5, k);
        base.life = lerp(1.8, 2.8, k);
        break;
      case "spiral":
        base.count = 3;
        base.interval = lerp(0.09, 0.055, k);
        base.life = lerp(2.4, 3.6, k);
        break;
      case "aimed":
        base.count = Math.round(lerp(3, 6, k));
        base.interval = lerp(0.7, 0.42, k);
        base.speed = lerp(180, 280, k);
        base.life = 2.2;
        break;
      case "wall":
        base.count = Math.round(lerp(16, 26, k));
        base.interval = lerp(0.55, 0.34, k);
        base.speed = lerp(130, 190, k);
        base.life = 2.6;
        break;
      case "spinner":
        base.count = 4;
        base.interval = 0.075;
        base.speed = lerp(120, 180, k);
        base.life = lerp(2.6, 3.8, k);
        break;
      case "rain":
        base.count = 1;
        base.interval = lerp(0.16, 0.07, k);
        base.speed = lerp(150, 240, k);
        base.life = lerp(2.0, 3.2, k);
        break;
    }

    this.emitters.push(base);
    if (this.emitters.length > 5) this.emitters.shift();
  }

  private updateEmitters(dt: number) {
    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.life -= dt;
      e.timer -= dt;
      e.angle += e.spin * dt;

      if (e.name === "spinner") {
        // Drift across the field while firing.
        const toCx = (this.w / 2 - e.x) * 0.2 * dt;
        const toCy = (this.h * 0.4 - e.y) * 0.2 * dt;
        e.x += toCx;
        e.y += toCy;
      }

      if (e.timer <= 0) {
        e.timer = e.interval;
        this.fire(e);
      }
      if (e.life <= 0) this.emitters.splice(i, 1);
    }
  }

  private fire(e: Emitter) {
    const r = this.c.rng;
    switch (e.name) {
      case "ring": {
        const offset = e.angle;
        for (let i = 0; i < e.count; i++) {
          const a = offset + (i / e.count) * TAU;
          this.spawn(e.x, e.y, Math.cos(a) * e.speed, Math.sin(a) * e.speed, 5, e.hue);
        }
        break;
      }
      case "spiral": {
        for (let i = 0; i < e.count; i++) {
          const a = e.angle + (i / e.count) * TAU;
          this.spawn(e.x, e.y, Math.cos(a) * e.speed, Math.sin(a) * e.speed, 4.5, e.hue);
        }
        break;
      }
      case "aimed": {
        const a = Math.atan2(this.py - e.y, this.px - e.x);
        const spread = 0.16;
        for (let i = 0; i < e.count; i++) {
          const off = (i - (e.count - 1) / 2) * spread;
          this.spawn(
            e.x, e.y,
            Math.cos(a + off) * e.speed,
            Math.sin(a + off) * e.speed,
            4, e.hue,
          );
        }
        break;
      }
      case "wall": {
        // One guaranteed gap, so a wall is always survivable.
        const gap = r.int(1, e.count - 2);
        for (let i = 0; i < e.count; i++) {
          if (i === gap || i === gap + 1) continue;
          const x = ((i + 0.5) / e.count) * this.w;
          this.spawn(x, -20, 0, e.speed, 5.5, e.hue);
        }
        break;
      }
      case "spinner": {
        for (let i = 0; i < e.count; i++) {
          const a = e.angle + (i / e.count) * TAU;
          this.spawn(
            e.x + Math.cos(a) * 26,
            e.y + Math.sin(a) * 26,
            Math.cos(a) * e.speed,
            Math.sin(a) * e.speed,
            4.5, e.hue,
          );
        }
        break;
      }
      case "rain": {
        const x = r.range(0, this.w);
        const drift = r.spread(40);
        this.spawn(x, -18, drift, e.speed, 4.5, e.hue);
        break;
      }
    }
  }

  private spawn(
    x: number, y: number, vx: number, vy: number, r: number, hue: number,
  ) {
    for (let i = 0; i < this.bullets.length; i++) {
      const b = this.bullets[i];
      if (b.alive) continue;
      b.alive = true;
      b.x = x; b.y = y; b.vx = vx; b.vy = vy; b.r = r;
      b.hue = hue; b.cooldown = 0; b.flash = 0; b.age = 0;
      b.entered = x > -40 && x < this.w + 40 && y > -40 && y < this.h + 40;
      return;
    }
  }

  // --- simulation -----------------------------------------------------------

  private updateBullets(dt: number, live: boolean) {
    const { fx, audio } = this.c;
    const grazeR2 = (GRAZE_RADIUS + 6) * (GRAZE_RADIUS + 6);
    const margin = 60;

    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.age += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.cooldown > 0) b.cooldown -= dt;
      if (b.flash > 0) b.flash -= dt;

      const inside =
        b.x > -margin && b.x < this.w + margin &&
        b.y > -margin && b.y < this.h + margin;

      if (inside) b.entered = true;
      else if (b.entered) {
        b.alive = false;
        continue;
      } else if (b.age > 6) {
        // Never made it on screen — a spawner edge case, not a real bullet.
        b.alive = false;
        continue;
      }

      if (!live) continue;

      const d2 = dist2(b.x, b.y, this.px, this.py);

      // Death check first: a graze must never save you from a hit.
      const hitR = b.r + HITBOX;
      if (d2 <= hitR * hitR) {
        this.die();
        return;
      }

      if (b.cooldown <= 0 && d2 <= grazeR2) {
        this.onGraze(b);
      }
    }

    void fx;
    void audio;
  }

  private onGraze(b: Bullet) {
    const { fx, audio } = this.c;
    b.cooldown = REGRAZE_DELAY;
    b.flash = 0.18;

    this.grazes++;
    this.combo++;
    this.comboTimer = 1.4;
    this.saturation = clamp01(this.saturation + SAT_PER_GRAZE);
    this.charge = clamp01(this.charge + CHARGE_PER_GRAZE);

    this.addBloom(b.x, b.y, b.hue);

    // Sparks fly along the bullet's path, away from the player.
    const a = Math.atan2(b.vy, b.vx);
    fx.emit((b.x + this.px) / 2, (b.y + this.py) / 2, {
      count: 4,
      angle: a,
      spread: 0.9,
      speed: 90,
      life: 0.3,
      size: 1.6,
      color: this.hueColor(b.hue, 0.7),
      drag: 5,
      shape: "spark",
      additive: true,
      stretch: 1,
    });

    const step = PENTATONIC[Math.min(this.combo - 1, PENTATONIC.length - 1)];
    audio.play({
      wave: "triangle",
      freq: 392 * Math.pow(2, step / 12),
      vol: 0.085,
      attack: 0.002,
      hold: 0.012,
      release: 0.09,
      filter: 4200,
      pan: clamp((b.x / this.w) * 2 - 1, -1, 1) * 0.5,
    });

    this.c.report({ score: this.score, label: `${this.grazes} GRAZE` });

    if (this.charge >= 1) this.fireBeam();
  }

  private fireBeam() {
    const { fx, audio } = this.c;
    this.charge = 0;
    this.beamTime = BEAM_DURATION;
    fx.shake(14, 5);
    fx.freeze(0.055);
    fx.flash(this.hueColor(this.beamHue(), 0.5), 0.1);
    fx.chroma(6);

    audio.play({
      wave: "sawtooth", freq: 180, freqTo: 60, glide: 0.35,
      vol: 0.3, attack: 0.005, hold: 0.12, release: 0.3,
      filter: 2600, filterTo: 400,
    });
    audio.play({
      wave: "noise", freq: 900, freqTo: 200,
      vol: 0.22, attack: 0.004, hold: 0.1, release: 0.32,
      filter: 2200, filterTo: 300,
    });
  }

  private sweepBeam(dt: number) {
    const { fx } = this.c;
    const k = clamp01(this.beamTime / BEAM_DURATION);
    const halfWidth = BEAM_HALF_WIDTH * easeOutQuart(k);

    for (const b of this.bullets) {
      if (!b.alive || !b.entered) continue;
      if (b.y > this.py) continue;
      if (Math.abs(b.x - this.px) > halfWidth + b.r) continue;
      b.alive = false;
      this.beamCount++;
      this.saturation = clamp01(this.saturation + 0.006);
      fx.emit(b.x, b.y, {
        count: 5,
        speed: 130,
        life: 0.34,
        size: 2.2,
        color: this.hueColor(b.hue, 0.85),
        drag: 3.5,
        additive: true,
      });
    }
    void dt;
  }

  private die() {
    const { fx, audio } = this.c;
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.deadTime = 0;

    fx.shake(26, 3.4);
    fx.freeze(0.14);
    fx.flash("#ffffff", 0.18);
    fx.chroma(11);
    fx.emit(this.px, this.py, {
      count: 46,
      speed: 320,
      speedVar: 0.9,
      life: 0.9,
      lifeVar: 0.5,
      size: 3,
      color: ["#ffffff", this.hueColor(this.beamHue(), 0.8)],
      drag: 1.8,
      additive: true,
      stretch: 0.6,
    });

    audio.explode(0.32);
    audio.play({
      wave: "sawtooth", freq: 300, freqTo: 40, glide: 0.7,
      vol: 0.24, attack: 0.006, hold: 0.15, release: 0.6,
      filter: 1800, filterTo: 160,
    });

    const isBest = this.c.store.recordBest("best", this.score);
    if (isBest) this.best = this.score;
    this.c.store.bump("plays");
    this.c.report({ status: "over", score: this.score, best: this.best });
  }

  // --- colour ---------------------------------------------------------------

  private beamHue() {
    return (this.time * 40) % 360;
  }

  /** Bullets are white until the world has been coloured in by grazing. */
  private hueColor(hue: number, light = 0.62, satMul = 1) {
    const s = clamp01(this.saturation * satMul) * 100;
    return `hsl(${hue} ${s}% ${light * 100}%)`;
  }

  private addBloom(x: number, y: number, hue: number) {
    for (const b of this.blooms) {
      if (b.alive) continue;
      b.alive = true;
      b.x = x; b.y = y; b.hue = hue;
      b.maxLife = 1.6;
      b.life = b.maxLife;
      b.radius = 90 + this.c.rng.range(0, 70);
      return;
    }
  }

  private updateBlooms(dt: number) {
    for (const b of this.blooms) {
      if (!b.alive) continue;
      b.life -= dt;
      if (b.life <= 0) b.alive = false;
    }
  }

  // --- rendering ------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    const w = this.w;
    const h = this.h;

    ctx.fillStyle = "#050507";
    ctx.fillRect(0, 0, w, h);

    this.drawStars(ctx);
    this.drawBlooms(ctx);

    fx.pushCamera(ctx, w / 2, h / 2);

    if (this.phase !== "title") {
      if (this.beamTime > 0) this.drawBeam(ctx);
      this.drawBullets(ctx);
      if (this.phase === "playing") this.drawPlayer(ctx);
    }
    fx.drawParticles(ctx);

    fx.popCamera(ctx);

    this.drawVignette(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "dead") this.drawGameOver(ctx);

    fx.drawFlash(ctx, w, h);
  }

  private drawStars(ctx: CanvasRenderingContext2D) {
    const drift = this.phase === "playing" ? this.time * 6 : this.titleTime * 3;
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    for (let i = 0; i < this.starX.length; i++) {
      const y = (this.starY[i] + drift) % this.h;
      ctx.fillRect(this.starX[i], y, this.starR[i], this.starR[i]);
    }
  }

  private drawBlooms(ctx: CanvasRenderingContext2D) {
    if (this.saturation <= 0.001) return;
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.blooms) {
      if (!b.alive) continue;
      const k = b.life / b.maxLife;
      const radius = b.radius * (1.6 - k * 0.6);
      const alpha = easeOutCubic(k) * 0.5 * this.saturation;
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, radius);
      g.addColorStop(0, `hsl(${b.hue} 95% 58% / ${alpha})`);
      g.addColorStop(0.55, `hsl(${b.hue} 90% 45% / ${alpha * 0.35})`);
      g.addColorStop(1, `hsl(${b.hue} 90% 40% / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(b.x - radius, b.y - radius, radius * 2, radius * 2);
    }
    ctx.restore();
  }

  private drawBeam(ctx: CanvasRenderingContext2D) {
    const k = clamp01(this.beamTime / BEAM_DURATION);
    const halfWidth = BEAM_HALF_WIDTH * easeOutQuart(k);
    const hue = this.beamHue();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";

    const g = ctx.createLinearGradient(this.px - halfWidth, 0, this.px + halfWidth, 0);
    g.addColorStop(0, `hsl(${hue} 90% 60% / 0)`);
    g.addColorStop(0.5, `hsl(${hue} ${lerp(0, 95, this.saturation)}% 78% / ${0.75 * k})`);
    g.addColorStop(1, `hsl(${hue} 90% 60% / 0)`);
    ctx.fillStyle = g;
    ctx.fillRect(this.px - halfWidth, 0, halfWidth * 2, this.py);

    ctx.fillStyle = `rgba(255,255,255,${0.85 * k})`;
    ctx.fillRect(this.px - 2.5 * k, 0, 5 * k, this.py);
    ctx.restore();
  }

  private drawBullets(ctx: CanvasRenderingContext2D) {
    const sat = this.saturation;
    ctx.save();

    // Pass 1: additive halos, so dense fields read as light rather than mud.
    ctx.globalCompositeOperation = "lighter";
    for (const b of this.bullets) {
      if (!b.alive || !b.entered) continue;
      const r = b.r * (1 + (b.flash > 0 ? b.flash * 2.2 : 0));
      const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, r * 3.2);
      const glowHue = `hsl(${b.hue} ${sat * 95}% ${lerp(78, 62, sat)}%`;
      g.addColorStop(0, `${glowHue} / 0.5)`);
      g.addColorStop(1, `${glowHue} / 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(b.x - r * 3.2, b.y - r * 3.2, r * 6.4, r * 6.4);
    }

    // Pass 2: hard cores. Bullets must always be readable — that is the
    // difference between a fair bullet hell and an unfair one.
    ctx.globalCompositeOperation = "source-over";
    for (const b of this.bullets) {
      if (!b.alive || !b.entered) continue;
      const flash = b.flash > 0 ? b.flash / 0.18 : 0;
      const r = b.r * (1 + flash * 0.55);
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, TAU);
      ctx.fillStyle = flash > 0.05
        ? "#ffffff"
        : `hsl(${b.hue} ${sat * 88}% ${lerp(97, 72, sat)}%)`;
      ctx.fill();

      if (sat > 0.05) {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = `hsl(${b.hue} ${sat * 100}% 45% / ${sat * 0.8})`;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D) {
    const hue = this.beamHue();

    // Trail
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = this.trailX.length - 1; i > 0; i--) {
      const k = 1 - i / this.trailX.length;
      ctx.beginPath();
      ctx.arc(this.trailX[i], this.trailY[i], HITBOX * (0.4 + k * 0.9), 0, TAU);
      ctx.fillStyle = `hsl(${hue} ${this.saturation * 90}% 70% / ${k * 0.22})`;
      ctx.fill();
    }
    ctx.restore();

    // Graze ring — always visible so the player can see the rule they're playing.
    const pulse = 1 + Math.sin(this.time * 7) * 0.018;
    ctx.beginPath();
    ctx.arc(this.px, this.py, GRAZE_RADIUS * pulse, 0, TAU);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(255,255,255,${0.14 + this.charge * 0.1})`;
    ctx.stroke();

    // Charge arc around the ring.
    if (this.charge > 0.001) {
      ctx.beginPath();
      ctx.arc(
        this.px, this.py, GRAZE_RADIUS * pulse,
        -Math.PI / 2, -Math.PI / 2 + this.charge * TAU,
      );
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = `hsl(${hue} ${lerp(0, 95, Math.max(0.25, this.saturation))}% 65%)`;
      ctx.stroke();
    }

    // Hitbox: the only thing that can kill you, drawn at its true size.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(this.px, this.py, 0, this.px, this.py, 16);
    g.addColorStop(0, "rgba(255,255,255,0.75)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(this.px - 16, this.py - 16, 32, 32);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(this.px, this.py, HITBOX, 0, TAU);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }

  private drawVignette(ctx: CanvasRenderingContext2D) {
    const strength = 0.35 + this.tension * 0.3;
    const g = ctx.createRadialGradient(
      this.w / 2, this.h / 2, Math.min(this.w, this.h) * 0.3,
      this.w / 2, this.h / 2, Math.max(this.w, this.h) * 0.75,
    );
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, `rgba(0,0,0,${strength})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
  }

  // --- interface ------------------------------------------------------------

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 18;
    const bottom = this.h - pad;

    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.fillText("GRAZES", pad, bottom - 26);

    ctx.font = monoFont(30, 700);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(this.grazes.toString().padStart(3, "0"), pad, bottom);

    // Saturation meter — how much colour you have earned, right now.
    const meterW = Math.min(150, this.w * 0.3);
    const meterX = this.w - pad - meterW;
    ctx.font = monoFont(11, 500);
    ctx.textAlign = "right";
    ctx.fillStyle = "rgba(255,255,255,0.42)";
    ctx.fillText("COLOUR", this.w - pad, bottom - 26);

    ctx.fillStyle = "rgba(255,255,255,0.1)";
    ctx.fillRect(meterX, bottom - 14, meterW, 5);
    const hue = this.beamHue();
    ctx.fillStyle = `hsl(${hue} ${this.saturation * 100}% 60%)`;
    ctx.fillRect(meterX, bottom - 14, meterW * this.saturation, 5);

    if (this.combo > 2) {
      ctx.textAlign = "center";
      ctx.font = monoFont(13, 700);
      const a = clamp01(this.comboTimer / 1.4);
      ctx.fillStyle = `hsl(${hue} ${this.saturation * 100}% 70% / ${a})`;
      ctx.fillText(`×${this.combo}`, this.px, this.py - GRAZE_RADIUS - 14);
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const w = this.w;
    const h = this.h;
    const t = this.titleTime;
    const cx = w / 2;

    // Demo bullets drifting behind the title, so the page is never static.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * TAU + t * 0.32;
      const rad = 120 + Math.sin(t * 0.9 + i) * 46;
      const x = cx + Math.cos(a) * rad * 1.5;
      const y = h * 0.42 + Math.sin(a) * rad * 0.55;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 14);
      g.addColorStop(0, "rgba(255,255,255,0.4)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - 14, y - 14, 28, 28);
      ctx.beginPath();
      ctx.arc(x, y, 3.4, 0, TAU);
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fill();
    }
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const titleSize = Math.min(w * 0.135, 78);
    ctx.font = uiFont(titleSize, 800);
    ctx.fillStyle = "#ffffff";
    ctx.letterSpacing = "-0.02em";
    ctx.fillText("GRAZEFIELD", cx, h * 0.4);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, w * 0.032), 500);
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.fillText("YOU HAVE NO WEAPON.", cx, h * 0.4 + titleSize * 0.72);
    ctx.fillStyle = "rgba(255,255,255,0.38)";
    ctx.fillText(
      "PASS CLOSE TO A BULLET TO BRING BACK COLOUR.",
      cx,
      h * 0.4 + titleSize * 0.72 + 20,
    );

    const blink = 0.55 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(255,255,255,${blink})`;
    ctx.fillText(
      this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN",
      cx,
      h * 0.68,
    );

    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.fillText(
      this.c.isTouch ? "DRAG ANYWHERE TO MOVE" : "MOUSE OR WASD  ·  SHIFT TO SLOW",
      cx,
      h * 0.68 + 24,
    );

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.fillText(`BEST ${this.best}`, cx, h * 0.68 + 46);
    }
  }

  private drawGameOver(ctx: CanvasRenderingContext2D) {
    const k = clamp01(this.deadTime / 0.55);
    const ease = easeOutCubic(k);
    const cx = this.w / 2;
    const cy = this.h * 0.44;

    ctx.fillStyle = `rgba(5,5,7,${0.72 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const isBest = this.score >= this.best && this.score > 0;
    const hue = this.beamHue();

    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(255,255,255,${0.45 * ease})`;
    ctx.fillText(isBest ? "NEW BEST" : "RUN ENDED", cx, cy - 58 * ease);

    // Score counts up rather than snapping — a number that pops reads as a
    // reward; a number that appears reads as a log line.
    const shown = Math.round(this.score * clamp01(this.deadTime / 0.5));
    ctx.font = monoFont(Math.min(this.w * 0.15, 72), 700);
    ctx.fillStyle = isBest
      ? `hsl(${hue} ${Math.max(60, this.peakSaturation * 100)}% 65%)`
      : "#ffffff";
    ctx.fillText(shown.toString(), cx, cy);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(255,255,255,${0.5 * ease})`;
    ctx.fillText(
      `${this.grazes} GRAZES   ·   ${this.time.toFixed(1)}s   ·   ${Math.round(
        this.peakSaturation * 100,
      )}% COLOUR`,
      cx,
      cy + 52,
    );

    if (!isBest && this.best > 0) {
      ctx.fillStyle = `rgba(255,255,255,${0.32 * ease})`;
      ctx.fillText(`BEST ${this.best}`, cx, cy + 76);
    }

    if (this.deadTime > 0.7) {
      const blink = 0.5 + Math.sin(this.deadTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(255,255,255,${blink})`;
      ctx.fillText(
        this.c.isTouch ? "TAP TO RUN AGAIN" : "CLICK OR SPACE TO RUN AGAIN",
        cx,
        this.h * 0.76,
      );
    }
  }
}

const factory: GameFactory = (ctx) => new Grazefield(ctx);
export default factory;
