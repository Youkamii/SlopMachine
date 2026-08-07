/**
 * METRONAUT
 *
 * An endless runner with no jump. The only control is a tempo dial that
 * speeds up and slows down the entire world — and because the soundtrack is
 * synthesised rather than sampled, the dial bends the music's pitch with it.
 *
 * Slowing down is safe and scores nothing; the multiplier is the square of
 * tempo, and some gates only open at speed. So the game is a negotiation
 * between "survive" and "score", conducted with one axis.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp, clamp01, damp, easeOutCubic, lerp } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const VOID = "#0a0a12";
const VOID_2 = "#12101f";
const NEON = "#00e5ff";
const HOT = "#ff2e88";
const FAST = "#ffe14d";
const TEXT = "#e6ecf5";

// --- tuning -----------------------------------------------------------------

const BASE_SPEED = 300;
const MIN_TEMPO = 0.4;
const MAX_TEMPO = 2.2;
/** Above this the fast-only gates are open. */
const FAST_GATE = 1.35;
/** Slow-motion fuel drains below 1.0x and refills above it. */
const FUEL_MAX = 3.4;

type Kind = "block" | "gap" | "fastGate" | "slowGate";

interface Obstacle {
  /** World distance at which it sits. */
  d: number;
  kind: Kind;
  /** Lane offset -1..1 for blocks. */
  lane: number;
  hit: boolean;
}

type Phase = "title" | "playing" | "dead";

class Metronaut implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private deadTime = 0;
  private time = 0;

  private tempo = 1;
  private tempoTarget = 1;
  private fuel = FUEL_MAX;

  private dist = 0;
  private score = 0;
  private best = 0;
  private bestDist = 0;

  private obstacles: Obstacle[] = [];
  private nextSpawn = 400;

  private runnerY = 0;
  private runnerBob = 0;

  // Music: a step sequencer whose rate is the tempo dial.
  private musicAcc = 0;
  private step = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.bestDist = ctx.store.get<number>("bestDist", 0);
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.runnerY = h * 0.62;
  }

  restart() {
    this.phase = "playing";
    this.dist = 0;
    this.score = 0;
    this.tempo = 1;
    this.tempoTarget = 1;
    this.fuel = FUEL_MAX;
    this.obstacles = [];
    this.nextSpawn = 420;
    this.step = 0;
    this.musicAcc = 0;
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "sawtooth", freq: 110, freqTo: 330, glide: 0.2,
          vol: 0.14, attack: 0.005, hold: 0.05, release: 0.25, filter: 1800,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "dead") {
      this.deadTime += dt;
      if (this.deadTime > 0.6 && (input.pointer.justUp || input.confirmPressed)) {
        this.restart();
      }
      return;
    }

    this.readDial(dt);

    // Everything downstream runs on scaled time. This single multiplication
    // is the entire game.
    const sdt = dt * this.tempo;

    this.dist += BASE_SPEED * sdt;
    this.runnerBob += sdt * 9;

    this.spawn();
    this.collide();
    this.music(sdt);

    // Score rewards speed quadratically, so crawling is survivable but worthless.
    this.score += BASE_SPEED * sdt * 0.05 * this.tempo * this.tempo;
    this.c.report({ score: Math.floor(this.score) });
  }

  private readDial(dt: number) {
    const { input } = this.c;

    if (input.isTouch) {
      if (input.pointer.down) {
        this.tempoTarget -= input.pointer.dy / (this.h * 0.5);
      }
    } else if (input.pointer.everMoved) {
      // Up is fast. Mapping it the other way feels wrong in every playtest.
      this.tempoTarget = lerp(MAX_TEMPO, MIN_TEMPO, clamp01(input.pointer.y / this.h));
    }
    const ky = input.axisY;
    if (ky !== 0) this.tempoTarget -= ky * 1.8 * dt;

    this.tempoTarget = clamp(this.tempoTarget, MIN_TEMPO, MAX_TEMPO);

    // Slow motion is fuelled. Without this the optimal play is to crawl the
    // entire run, and the dial stops being a decision.
    if (this.tempoTarget < 1) {
      this.fuel -= dt * (1 - this.tempoTarget) * 2.2;
      if (this.fuel <= 0) {
        this.fuel = 0;
        this.tempoTarget = Math.max(this.tempoTarget, 1);
      }
    } else {
      this.fuel = Math.min(FUEL_MAX, this.fuel + dt * (this.tempoTarget - 1) * 1.5);
    }

    this.tempo = damp(this.tempo, this.tempoTarget, 0.35, dt);
  }

  private spawn() {
    while (this.nextSpawn < this.dist + 1400) {
      const r = this.c.rng;
      const k = clamp01(this.dist / 22000);
      const kind: Kind = r.pickWeighted<Kind>(
        ["block", "gap", "fastGate", "slowGate"],
        [1, 0.7 + k * 0.4, 0.35 + k * 0.4, 0.4 + k * 0.3],
      );
      this.obstacles.push({
        d: this.nextSpawn,
        kind,
        lane: r.range(-0.72, 0.72),
        hit: false,
      });
      this.nextSpawn += lerp(400, 250, k) * r.range(0.85, 1.2);
    }
    // Cull behind.
    while (this.obstacles.length && this.obstacles[0].d < this.dist - 300) {
      this.obstacles.shift();
    }
  }

  private collide() {
    const { fx, audio } = this.c;
    for (const o of this.obstacles) {
      if (o.hit) continue;
      const rel = o.d - this.dist;
      if (rel > 18 || rel < -18) continue;

      switch (o.kind) {
        case "block":
          // A block occupies a lane; the runner is always centre, so a block
          // near the middle is what kills.
          if (Math.abs(o.lane) < 0.24) {
            this.die();
            return;
          }
          break;
        case "gap":
          // A gap must be crossed fast enough to carry over it.
          if (this.tempo < 0.85) {
            this.die();
            return;
          }
          break;
        case "fastGate":
          if (this.tempo < FAST_GATE) {
            this.die();
            return;
          }
          break;
        case "slowGate":
          if (this.tempo > 0.95) {
            this.die();
            return;
          }
          break;
      }

      o.hit = true;
      fx.emit(this.w * 0.28, this.runnerY, {
        count: 5, speed: 150, life: 0.28, size: 1.8,
        color: [NEON, FAST], drag: 4, additive: true, stretch: 0.8,
      });
      audio.play({
        wave: "square", freq: 660 + this.tempo * 300, vol: 0.06,
        attack: 0.001, hold: 0.01, release: 0.05,
      });
    }
  }

  /**
   * Four-layer sequencer. Its rate is the tempo dial, and because the notes
   * are oscillators rather than samples the pitch bends cleanly — slowing
   * down literally detunes the track downward.
   */
  private music(sdt: number) {
    const { audio } = this.c;
    const stepLen = 0.14;
    this.musicAcc += sdt;
    while (this.musicAcc >= stepLen) {
      this.musicAcc -= stepLen;
      const s = this.step++ % 16;
      const bend = this.tempo;

      if (s % 4 === 0) {
        audio.play({
          wave: "triangle", freq: 55 * bend, freqTo: 44 * bend, glide: 0.08,
          vol: 0.16, attack: 0.002, hold: 0.04, release: 0.1, filter: 700,
        });
      }
      if (s % 8 === 4) {
        audio.play({
          wave: "noise", freq: 2600 * bend, vol: 0.05,
          attack: 0.001, hold: 0.006, release: 0.04,
          filter: 5000, filterType: "highpass",
        });
      }
      if (s % 2 === 1) {
        const arp = [0, 7, 12, 15, 12, 7][Math.floor(this.step / 2) % 6];
        audio.play({
          wave: "square", freq: 220 * bend * Math.pow(2, arp / 12),
          vol: 0.05, attack: 0.001, hold: 0.012, release: 0.06,
          filter: 3000, filterTo: 1200,
        });
      }
    }
  }

  private die() {
    const { fx, audio } = this.c;
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.deadTime = 0;

    fx.shake(20, 4);
    fx.freeze(0.12);
    fx.flash(HOT, 0.14);
    fx.chroma(10);
    fx.emit(this.w * 0.28, this.runnerY, {
      count: 36, speed: 320, speedVar: 0.8, life: 0.8, lifeVar: 0.5,
      size: 2.8, color: [HOT, NEON, TEXT], drag: 2, additive: true, stretch: 0.7,
    });

    audio.play({
      wave: "sawtooth", freq: 220 * this.tempo, freqTo: 40, glide: 0.6,
      vol: 0.24, attack: 0.004, hold: 0.1, release: 0.5, filter: 1400, filterTo: 160,
    });
    audio.explode(0.24);

    const s = Math.floor(this.score);
    if (this.c.store.recordBest("best", s)) this.best = s;
    if (this.dist > this.bestDist) {
      this.bestDist = this.dist;
      this.c.store.set("bestDist", Math.floor(this.dist));
    }
    this.c.report({ status: "over", score: s, best: this.best });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    const speedK = clamp01((this.tempo - MIN_TEMPO) / (MAX_TEMPO - MIN_TEMPO));

    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, this.w, this.h);
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, VOID_2);
    g.addColorStop(1, VOID);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    if (this.phase !== "title") {
      this.drawTrack(ctx, speedK);
      this.drawObstacles(ctx);
      if (this.phase === "playing") this.drawRunner(ctx, speedK);
    } else {
      this.drawTitleScene(ctx);
    }
    fx.drawParticles(ctx);
    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx, speedK);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "dead") this.drawDead(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private worldX(d: number) {
    return this.w * 0.28 + (d - this.dist) * 0.62;
  }

  private drawTrack(ctx: CanvasRenderingContext2D, speedK: number) {
    const y = this.runnerY + 26;
    ctx.strokeStyle = `rgba(0,229,255,${0.2 + speedK * 0.2})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(this.w, y);
    ctx.stroke();

    // Ticks stream past — the visible measure of world speed.
    ctx.strokeStyle = `rgba(0,229,255,${0.12 + speedK * 0.18})`;
    ctx.lineWidth = 1;
    const spacing = 60;
    const off = (this.dist * 0.62) % spacing;
    ctx.beginPath();
    for (let x = -off; x < this.w; x += spacing) {
      ctx.moveTo(x, y);
      ctx.lineTo(x, y + 12 + speedK * 10);
    }
    ctx.stroke();
  }

  private drawObstacles(ctx: CanvasRenderingContext2D) {
    const y = this.runnerY;
    for (const o of this.obstacles) {
      const x = this.worldX(o.d);
      if (x < -80 || x > this.w + 80) continue;

      switch (o.kind) {
        case "block": {
          const oy = y + o.lane * 44;
          ctx.fillStyle = Math.abs(o.lane) < 0.24 ? HOT : "rgba(255,46,136,0.35)";
          ctx.fillRect(x - 7, oy - 20, 14, 40);
          break;
        }
        case "gap": {
          ctx.fillStyle = "rgba(0,0,0,0.9)";
          ctx.fillRect(x - 22, y + 26, 44, 40);
          ctx.strokeStyle = "rgba(255,46,136,0.55)";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x - 22, y + 26, 44, 3);
          break;
        }
        case "fastGate": {
          const open = this.tempo >= FAST_GATE;
          ctx.strokeStyle = open ? `${FAST}` : "rgba(255,225,77,0.35)";
          ctx.lineWidth = open ? 1.5 : 4;
          ctx.beginPath();
          ctx.moveTo(x, y - 46);
          ctx.lineTo(x, y + 26);
          ctx.stroke();
          ctx.font = monoFont(9, 700);
          ctx.fillStyle = open ? FAST : "rgba(255,225,77,0.5)";
          ctx.textAlign = "center";
          ctx.fillText("FAST", x, y - 56);
          break;
        }
        case "slowGate": {
          const open = this.tempo <= 0.95;
          ctx.strokeStyle = open ? NEON : "rgba(0,229,255,0.35)";
          ctx.lineWidth = open ? 1.5 : 4;
          ctx.beginPath();
          ctx.moveTo(x, y - 46);
          ctx.lineTo(x, y + 26);
          ctx.stroke();
          ctx.font = monoFont(9, 700);
          ctx.fillStyle = open ? NEON : "rgba(0,229,255,0.5)";
          ctx.textAlign = "center";
          ctx.fillText("SLOW", x, y - 56);
          break;
        }
      }
    }
  }

  private drawRunner(ctx: CanvasRenderingContext2D, speedK: number) {
    const x = this.w * 0.28;
    const y = this.runnerY + Math.sin(this.runnerBob) * 3;

    // Motion trail length tracks tempo, so speed is legible without a number.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const streak = 10 + speedK * 70;
    const g = ctx.createLinearGradient(x - streak, y, x, y);
    g.addColorStop(0, "rgba(0,229,255,0)");
    g.addColorStop(1, `rgba(0,229,255,${0.3 + speedK * 0.35})`);
    ctx.fillStyle = g;
    ctx.fillRect(x - streak, y - 8, streak, 16);
    ctx.restore();

    ctx.beginPath();
    ctx.moveTo(x + 12, y);
    ctx.lineTo(x - 9, y - 11);
    ctx.lineTo(x - 4, y);
    ctx.lineTo(x - 9, y + 11);
    ctx.closePath();
    ctx.fillStyle = TEXT;
    ctx.fill();
  }

  private drawTitleScene(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const y = this.h * 0.62;
    ctx.strokeStyle = "rgba(0,229,255,0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y + 26);
    ctx.lineTo(this.w, y + 26);
    ctx.stroke();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 24; i++) {
      const p = ((t * 0.35 + i / 24) % 1);
      const x = p * this.w;
      const a = 0.12 + Math.sin(t * 2 + i) * 0.08;
      ctx.fillStyle = `rgba(0,229,255,${a})`;
      ctx.fillRect(x, y - 30, 2, 56);
    }
    ctx.restore();
  }

  private drawHud(ctx: CanvasRenderingContext2D, speedK: number) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(230,236,245,0.42)";
    ctx.fillText("SCORE", pad, pad + 34);
    ctx.font = monoFont(30, 700);
    ctx.fillStyle = TEXT;
    ctx.fillText(Math.floor(this.score).toString(), pad, pad + 48);

    // The dial itself, drawn down the right edge where the mouse controls it.
    const dialX = this.w - 42;
    const dialTop = this.h * 0.22;
    const dialH = this.h * 0.56;
    ctx.fillStyle = "rgba(230,236,245,0.1)";
    ctx.fillRect(dialX, dialTop, 4, dialH);

    // The 1.0x reference line, and the fast-gate threshold.
    const at = (tempo: number) =>
      dialTop + dialH * (1 - (tempo - MIN_TEMPO) / (MAX_TEMPO - MIN_TEMPO));
    ctx.fillStyle = "rgba(230,236,245,0.3)";
    ctx.fillRect(dialX - 6, at(1) - 1, 16, 2);
    ctx.fillStyle = "rgba(255,225,77,0.45)";
    ctx.fillRect(dialX - 6, at(FAST_GATE) - 1, 16, 2);

    const ky = at(this.tempo);
    ctx.beginPath();
    ctx.arc(dialX + 2, ky, 7, 0, TAU);
    ctx.fillStyle = this.tempo >= FAST_GATE ? FAST : this.tempo < 0.95 ? NEON : TEXT;
    ctx.fill();

    ctx.textAlign = "right";
    ctx.font = monoFont(13, 700);
    ctx.fillStyle = TEXT;
    ctx.fillText(`${this.tempo.toFixed(2)}×`, dialX - 12, ky - 8);

    // Slow-motion fuel.
    const fuelH = dialH * (this.fuel / FUEL_MAX);
    ctx.fillStyle = this.fuel < 0.6 ? HOT : "rgba(0,229,255,0.45)";
    ctx.fillRect(dialX + 12, dialTop + dialH - fuelH, 3, fuelH);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(230,236,245,0.4)";
    ctx.fillText(
      this.c.isTouch
        ? "DRAG UP TO SPEED THE WORLD UP"
        : "MOVE THE MOUSE UP AND DOWN — THAT IS THE WHOLE GAME",
      this.w / 2,
      this.h - 28,
    );
    void speedK;
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(this.w * 0.14, 78);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = TEXT;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("METRONAUT", cx, this.h * 0.3);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(230,236,245,0.6)";
    ctx.fillText("THERE IS NO JUMP.", cx, this.h * 0.3 + size * 0.6);
    ctx.fillStyle = "rgba(0,229,255,0.75)";
    ctx.fillText("YOU CHANGE HOW FAST THE WORLD RUNS.", cx, this.h * 0.3 + size * 0.6 + 20);

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(230,236,245,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.84);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(230,236,245,0.34)";
      ctx.fillText(`BEST ${this.best}`, cx, this.h * 0.84 + 24);
    }
  }

  private drawDead(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.deadTime / 0.5));
    const cx = this.w / 2;
    ctx.fillStyle = `rgba(10,10,18,${0.8 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const s = Math.floor(this.score);
    const isBest = s >= this.best && s > 0;
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(255,46,136,${0.7 * ease})`;
    ctx.fillText(isBest ? "NEW BEST" : "OFF TEMPO", cx, this.h * 0.34 - 52);

    ctx.font = monoFont(Math.min(this.w * 0.15, 72), 700);
    ctx.fillStyle = isBest ? FAST : TEXT;
    ctx.fillText(
      Math.round(s * clamp01(this.deadTime / 0.5)).toString(),
      cx,
      this.h * 0.34,
    );

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(230,236,245,${0.55 * ease})`;
    ctx.fillText(
      `${Math.floor(this.dist)}m  ·  FINAL TEMPO ${this.tempo.toFixed(2)}×`,
      cx,
      this.h * 0.34 + 46,
    );

    if (this.deadTime > 0.6) {
      const blink = 0.5 + Math.sin(this.deadTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(230,236,245,${blink})`;
      ctx.fillText("AGAIN", cx, this.h * 0.8);
    }
  }
}

const factory: GameFactory = (ctx) => new Metronaut(ctx);
export default factory;
