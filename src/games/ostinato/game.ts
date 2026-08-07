/**
 * OSTINATO
 *
 * Everything you do inside a four-bar loop is recorded. On the next loop a
 * ghost of your past self repeats it — and that ghost is solid, so it holds
 * plates and blocks doors. Rooms are solved by layering three or four selves.
 *
 * Each ghost also plays one instrument, so the arrangement completes at the
 * exact moment the puzzle does. A wrong attempt sounds wrong before it looks
 * wrong.
 *
 * The whole thing hangs on determinism: input is recorded against a BEAT
 * INDEX, never wall-clock time, and every loop re-simulates the ghosts from
 * scratch rather than storing their state. Two ghosts that drift by one step
 * would desync the entire puzzle.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp01, easeOutBack, easeOutCubic, lerp } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const BG = "#242932";
const BG_2 = "#1b1f26";
const TILE = "#2f3540";
const TILE_EDGE = "#3c434f";
const WALL = "#171a20";
const PLATE = "#4a5260";
const PLATE_ON = "#f2c14e";
const TEXT = "#dfe4ec";

/** One colour per voice. Also the ghost's colour, so you can hear who is who. */
const VOICES = ["#5ad2e0", "#ff8f6b", "#f2c14e", "#a6e05a", "#c79bff"];

// --- timing -----------------------------------------------------------------

const BPM = 108;
const STEPS_PER_BEAT = 4;
const BARS = 4;
const STEPS = BARS * 4 * STEPS_PER_BEAT; // 64 sixteenths
const STEP_SECONDS = 60 / BPM / STEPS_PER_BEAT;

const MAX_GHOSTS = 4;

// --- levels -----------------------------------------------------------------
//
// Hand-authored. Procedural generation makes no musical sense here — the
// shape of a room is the shape of its melody.
//
//   #  wall      .  floor      P  start      o  plate

const LEVELS: string[][] = [
  [
    ".........",
    "..o...o..",
    ".........",
    "....P....",
    ".........",
  ],
  [
    ".........",
    ".o.....o.",
    ".........",
    "...#P#...",
    "....o....",
  ],
  [
    "..o...o..",
    ".........",
    "..#...#..",
    "....P....",
    "..o...o..",
  ],
  [
    "o.......o",
    ".........",
    "..##.##..",
    "....P....",
    "....o....",
  ],
  [
    ".o.....o.",
    ".........",
    "o...#...o",
    ".........",
    "....P....",
  ],
  [
    "o...o...o",
    ".........",
    "..#...#..",
    ".........",
    "o...P...o",
  ],
];

interface Vec {
  x: number;
  y: number;
}

/** A recorded performance: one move per entry, stamped with its step index. */
interface Take {
  moves: Array<{ step: number; dx: number; dy: number }>;
  voice: number;
}

type Phase = "title" | "playing" | "solved" | "complete";

class Ostinato implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private cell = 0;
  private boardX = 0;
  private boardY = 0;
  private cols = 0;
  private rows = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private solvedTime = 0;
  private time = 0;

  private levelIndex = 0;
  private grid: string[][] = [];
  private start: Vec = { x: 0, y: 0 };
  private plates: Vec[] = [];

  /** Loop position in seconds and the derived step. */
  private loopTime = 0;
  private step = 0;
  private lastStep = -1;
  private loopCount = 0;

  private takes: Take[] = [];
  private current: Take = { moves: [], voice: 0 };

  /** Live positions, recomputed from step 0 every loop. */
  private ghostPos: Vec[] = [];
  private ghostPrev: Vec[] = [];
  private playerPos: Vec = { x: 0, y: 0 };
  private playerPrev: Vec = { x: 0, y: 0 };

  /** Queued input, applied on the next step boundary. */
  private queued: Vec | null = null;

  private best = 0;
  private plateFlash: number[] = [];

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.loadLevel(0);
    ctx.report({ status: "idle", score: 0 });
  }

  private loadLevel(i: number) {
    this.levelIndex = i % LEVELS.length;
    const rows = LEVELS[this.levelIndex];
    this.rows = rows.length;
    this.cols = rows[0].length;
    this.grid = rows.map((r) => r.split(""));
    this.plates = [];
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const ch = this.grid[y][x];
        if (ch === "P") this.start = { x, y };
        if (ch === "o") this.plates.push({ x, y });
      }
    }
    this.plateFlash = this.plates.map(() => 0);
    this.resetLoops();
    this.layout();
  }

  private resetLoops() {
    this.takes = [];
    this.current = { moves: [], voice: 0 };
    this.loopTime = 0;
    this.step = 0;
    this.lastStep = -1;
    this.loopCount = 0;
    this.queued = null;
    this.playerPos = { ...this.start };
    this.playerPrev = { ...this.start };
    this.ghostPos = [];
    this.ghostPrev = [];
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.layout();
  }

  private layout() {
    if (!this.cols || !this.w) return;
    const availW = this.w * 0.86;
    const availH = this.h * 0.5;
    this.cell = Math.floor(Math.min(availW / this.cols, availH / this.rows, 78));
    const bw = this.cell * this.cols;
    const bh = this.cell * this.rows;
    this.boardX = (this.w - bw) / 2;
    this.boardY = this.h * 0.52 - bh / 2;
  }

  private tileAt(x: number, y: number) {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return "#";
    return this.grid[y][x];
  }

  private walkable(x: number, y: number) {
    return this.tileAt(x, y) !== "#";
  }

  // --- simulation -----------------------------------------------------------

  /**
   * Replay a take up to (and including) a step. Pure: same inputs, same
   * result, every loop. Ghost state is never carried across loops.
   */
  private positionAt(take: Take, step: number): Vec {
    const p = { ...this.start };
    for (const m of take.moves) {
      if (m.step > step) break;
      const nx = p.x + m.dx;
      const ny = p.y + m.dy;
      if (this.walkable(nx, ny)) {
        p.x = nx;
        p.y = ny;
      }
    }
    return p;
  }

  private refreshPositions() {
    this.ghostPrev = this.ghostPos.map((g) => ({ ...g }));
    this.ghostPos = this.takes.map((t) => this.positionAt(t, this.step));
    this.playerPrev = { ...this.playerPos };
    this.playerPos = this.positionAt(this.current, this.step);
  }

  /** True when every plate has somebody standing on it right now. */
  private allPlatesHeld(): boolean {
    for (const plate of this.plates) {
      const held =
        (this.playerPos.x === plate.x && this.playerPos.y === plate.y) ||
        this.ghostPos.some((g) => g.x === plate.x && g.y === plate.y);
      if (!held) return false;
    }
    return this.plates.length > 0;
  }

  restart() {
    this.phase = "playing";
    this.levelIndex = 0;
    this.loadLevel(0);
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;

    for (let i = 0; i < this.plateFlash.length; i++) {
      if (this.plateFlash[i] > 0) this.plateFlash[i] -= dt;
    }

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "triangle", freq: 220, freqTo: 440, glide: 0.2,
          vol: 0.16, attack: 0.006, hold: 0.06, release: 0.3,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "solved") {
      this.solvedTime += dt;
      if (this.solvedTime > 1.3 && (input.pointer.justUp || input.confirmPressed)) {
        if (this.levelIndex + 1 >= LEVELS.length) {
          this.phase = "complete";
          this.solvedTime = 0;
        } else {
          this.loadLevel(this.levelIndex + 1);
          this.phase = "playing";
        }
      }
      return;
    }

    if (this.phase === "complete") {
      this.solvedTime += dt;
      if (this.solvedTime > 0.8 && (input.pointer.justUp || input.confirmPressed)) {
        this.restart();
      }
      return;
    }

    this.handleInput();
    this.advanceClock(dt);
  }

  private handleInput() {
    const { input } = this.c;

    if (input.wasPressed("KeyR")) {
      this.resetLoops();
      this.c.audio.play({
        wave: "sine", freq: 300, freqTo: 200, glide: 0.12,
        vol: 0.1, attack: 0.003, hold: 0.03, release: 0.12,
      });
      return;
    }

    let v: Vec | null = null;
    if (input.wasPressed("ArrowRight", "KeyD")) v = { x: 1, y: 0 };
    else if (input.wasPressed("ArrowLeft", "KeyA")) v = { x: -1, y: 0 };
    else if (input.wasPressed("ArrowDown", "KeyS")) v = { x: 0, y: 1 };
    else if (input.wasPressed("ArrowUp", "KeyW")) v = { x: 0, y: -1 };

    if (!v && input.pointer.justUp) {
      if (input.dragDistance >= 20) {
        const deg = ((input.dragAngle * 180) / Math.PI + 360) % 360;
        if (deg < 45 || deg >= 315) v = { x: 1, y: 0 };
        else if (deg < 135) v = { x: 0, y: 1 };
        else if (deg < 225) v = { x: -1, y: 0 };
        else v = { x: 0, y: -1 };
      } else {
        const gx = Math.floor((input.pointer.x - this.boardX) / this.cell);
        const gy = Math.floor((input.pointer.y - this.boardY) / this.cell);
        const dx = gx - this.playerPos.x;
        const dy = gy - this.playerPos.y;
        if (Math.abs(dx) + Math.abs(dy) === 1) v = { x: dx, y: dy };
      }
    }

    // Input is queued to the next sixteenth rather than applied immediately.
    // This is the key decision: quantising makes every action land on the
    // grid, which is what turns play into music and makes latency forgiving.
    if (v) this.queued = v;
  }

  private advanceClock(dt: number) {
    this.loopTime += dt;
    const loopLength = STEPS * STEP_SECONDS;

    const newStep = Math.floor(this.loopTime / STEP_SECONDS);
    if (newStep !== this.lastStep) {
      this.lastStep = newStep;
      this.step = Math.min(newStep, STEPS - 1);
      this.onStep();
    }

    if (this.loopTime >= loopLength) {
      this.loopTime -= loopLength;
      this.lastStep = -1;
      this.step = 0;
      this.endLoop();
    }
  }

  private onStep() {
    const { audio } = this.c;

    if (this.queued) {
      const nx = this.playerPos.x + this.queued.x;
      const ny = this.playerPos.y + this.queued.y;
      if (this.walkable(nx, ny)) {
        this.current.moves.push({
          step: this.step,
          dx: this.queued.x,
          dy: this.queued.y,
        });
      }
      this.queued = null;
    }

    this.refreshPositions();

    // Voices. Pitch comes from column, so the room's geometry is the scale.
    const moved = (a: Vec, b: Vec) => a.x !== b.x || a.y !== b.y;
    if (moved(this.playerPos, this.playerPrev)) {
      this.playNote(this.takes.length, this.playerPos.x);
    }
    for (let i = 0; i < this.ghostPos.length; i++) {
      if (moved(this.ghostPos[i], this.ghostPrev[i] ?? this.ghostPos[i])) {
        this.playNote(i, this.ghostPos[i].x);
      }
    }

    // Metronome: a quiet tick on every beat keeps the loop legible.
    if (this.step % STEPS_PER_BEAT === 0) {
      const downbeat = this.step % (STEPS_PER_BEAT * 4) === 0;
      audio.play({
        wave: "noise",
        freq: downbeat ? 2400 : 1700,
        vol: downbeat ? 0.05 : 0.028,
        attack: 0.001,
        hold: 0.004,
        release: 0.02,
        filter: 5000,
        filterType: "highpass",
      });
    }

    if (this.allPlatesHeld()) this.solve();
  }

  /** One instrument per voice — that is what makes ghosts read as parts. */
  private playNote(voice: number, column: number) {
    const { audio } = this.c;
    // Minor pentatonic across the columns.
    const scale = [0, 3, 5, 7, 10, 12, 15, 17, 19];
    const semis = scale[Math.min(column, scale.length - 1)];

    switch (voice % 4) {
      case 0: // bass
        audio.play({
          wave: "triangle", freq: 110 * Math.pow(2, semis / 12),
          vol: 0.2, attack: 0.004, hold: 0.06, release: 0.16,
          filter: 900,
        });
        break;
      case 1: // plucked arp
        audio.play({
          wave: "square", freq: 440 * Math.pow(2, semis / 12),
          vol: 0.1, attack: 0.002, hold: 0.02, release: 0.14,
          filter: 2600, filterTo: 800,
        });
        break;
      case 2: // bell
        audio.play({
          wave: "sine", freq: 880 * Math.pow(2, semis / 12),
          vol: 0.11, attack: 0.002, hold: 0.02, release: 0.4,
        });
        audio.play({
          wave: "sine", freq: 880 * Math.pow(2, semis / 12) * 2.76,
          vol: 0.04, attack: 0.002, hold: 0.02, release: 0.3,
        });
        break;
      default: // hat
        audio.play({
          wave: "noise", freq: 3000 + semis * 90,
          vol: 0.05, attack: 0.001, hold: 0.006, release: 0.04,
          filter: 6000, filterType: "highpass",
        });
        break;
    }
  }

  private endLoop() {
    const { audio } = this.c;
    this.loopCount++;

    // Promote the take that just finished into a ghost, if it did anything.
    if (this.current.moves.length > 0) {
      this.takes.push({ ...this.current, voice: this.takes.length });
      if (this.takes.length > MAX_GHOSTS) this.takes.shift();
      audio.play({
        wave: "sine", freq: 660, freqTo: 990, glide: 0.12,
        vol: 0.08, attack: 0.004, hold: 0.03, release: 0.2,
      });
    }
    this.current = { moves: [], voice: this.takes.length };
    this.refreshPositions();
  }

  private solve() {
    const { fx, audio } = this.c;
    if (this.phase !== "playing") return;
    this.phase = "solved";
    this.solvedTime = 0;

    for (let i = 0; i < this.plateFlash.length; i++) this.plateFlash[i] = 0.6;

    fx.flash(PLATE_ON, 0.12);
    fx.shake(5, 6);
    for (const p of this.plates) {
      const c = this.cellCentre(p.x, p.y);
      fx.emit(c.x, c.y, {
        count: 16, speed: 170, life: 0.6, size: 2.4,
        color: [PLATE_ON, TEXT], drag: 3, additive: true,
      });
    }

    // Resolve the arrangement: the chord the whole room was building toward.
    [0, 4, 7, 11, 14].forEach((s, i) =>
      audio.play({
        wave: "sine", freq: 220 * Math.pow(2, s / 12),
        vol: 0.13, attack: 0.006, hold: 0.08, release: 0.9, delay: i * 0.07,
      }),
    );

    const solved = this.levelIndex + 1;
    if (this.c.store.recordBest("best", solved)) this.best = solved;
    this.c.report({ score: solved });
  }

  // --- render ---------------------------------------------------------------

  private cellCentre(x: number, y: number) {
    return {
      x: this.boardX + (x + 0.5) * this.cell,
      y: this.boardY + (y + 0.5) * this.cell,
    };
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;

    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.w, this.h);
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, BG);
    g.addColorStop(1, BG_2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    this.drawBoard(ctx);
    if (this.phase !== "title") {
      this.drawActors(ctx);
    }
    fx.drawParticles(ctx);

    fx.popCamera(ctx);

    if (this.phase !== "title") this.drawDial(ctx);
    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "solved") this.drawSolved(ctx);
    if (this.phase === "complete") this.drawComplete(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawBoard(ctx: CanvasRenderingContext2D) {
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const ch = this.grid[y][x];
        const px = this.boardX + x * this.cell;
        const py = this.boardY + y * this.cell;

        if (ch === "#") {
          ctx.fillStyle = WALL;
          ctx.fillRect(px, py, this.cell, this.cell);
          continue;
        }

        ctx.fillStyle = TILE;
        ctx.fillRect(px + 1, py + 1, this.cell - 2, this.cell - 2);
        ctx.strokeStyle = TILE_EDGE;
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 1.5, py + 1.5, this.cell - 3, this.cell - 3);
      }
    }

    for (let i = 0; i < this.plates.length; i++) {
      const p = this.plates[i];
      const c = this.cellCentre(p.x, p.y);
      const held =
        this.phase !== "title" &&
        ((this.playerPos.x === p.x && this.playerPos.y === p.y) ||
          this.ghostPos.some((gg) => gg.x === p.x && gg.y === p.y));
      const flash = Math.max(0, this.plateFlash[i]) / 0.6;

      ctx.beginPath();
      ctx.arc(c.x, c.y, this.cell * 0.3, 0, TAU);
      ctx.lineWidth = 3;
      ctx.strokeStyle = held || flash > 0 ? PLATE_ON : PLATE;
      ctx.stroke();

      if (held) {
        ctx.beginPath();
        ctx.arc(c.x, c.y, this.cell * 0.16, 0, TAU);
        ctx.fillStyle = PLATE_ON;
        ctx.fill();
      }
    }
  }

  private drawActors(ctx: CanvasRenderingContext2D) {
    // Interpolate between steps so movement reads as motion, not teleporting.
    const within = clamp01((this.loopTime % STEP_SECONDS) / STEP_SECONDS);
    const e = easeOutBack(within);
    const r = this.cell * 0.26;

    for (let i = 0; i < this.ghostPos.length; i++) {
      const cur = this.ghostPos[i];
      const prev = this.ghostPrev[i] ?? cur;
      const a = this.cellCentre(prev.x, prev.y);
      const b = this.cellCentre(cur.x, cur.y);
      const x = lerp(a.x, b.x, e);
      const y = lerp(a.y, b.y, e);
      const col = VOICES[i % VOICES.length];

      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.fillStyle = col;
      ctx.fill();
      ctx.restore();

      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.lineWidth = 2;
      ctx.strokeStyle = col;
      ctx.stroke();
    }

    const a = this.cellCentre(this.playerPrev.x, this.playerPrev.y);
    const b = this.cellCentre(this.playerPos.x, this.playerPos.y);
    const x = lerp(a.x, b.x, e);
    const y = lerp(a.y, b.y, e);
    const col = VOICES[this.takes.length % VOICES.length];

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const gr = ctx.createRadialGradient(x, y, 0, x, y, r * 3);
    gr.addColorStop(0, `${col}66`);
    gr.addColorStop(1, `${col}00`);
    ctx.fillStyle = gr;
    ctx.fillRect(x - r * 3, y - r * 3, r * 6, r * 6);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
  }

  /** Bar position as a ring — the loop is the clock, so it gets a clock. */
  private drawDial(ctx: CanvasRenderingContext2D) {
    const cx = this.w / 2;
    const cy = this.boardY - this.cell * 0.62 - 26;
    const radius = 17;
    const p = clamp01(this.loopTime / (STEPS * STEP_SECONDS));

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(223,228,236,0.16)";
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, radius, -Math.PI / 2, -Math.PI / 2 + p * TAU);
    ctx.strokeStyle = VOICES[this.takes.length % VOICES.length];
    ctx.stroke();

    // Bar ticks.
    for (let i = 0; i < BARS; i++) {
      const a = -Math.PI / 2 + (i / BARS) * TAU;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * (radius - 5), cy + Math.sin(a) * (radius - 5));
      ctx.lineTo(cx + Math.cos(a) * (radius + 5), cy + Math.sin(a) * (radius + 5));
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(223,228,236,0.3)";
      ctx.stroke();
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10, 700);
    ctx.fillStyle = "rgba(223,228,236,0.55)";
    ctx.fillText(
      `${Math.floor(this.step / (STEPS_PER_BEAT * 4)) + 1}`,
      cx,
      cy + 0.5,
    );
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(223,228,236,0.4)";
    ctx.fillText("ROOM", pad, pad + 34);
    ctx.font = monoFont(28, 700);
    ctx.fillStyle = TEXT;
    ctx.fillText(
      `${this.levelIndex + 1}/${LEVELS.length}`,
      pad,
      pad + 48,
    );

    // One dot per voice, filled as the arrangement builds.
    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(223,228,236,0.4)";
    ctx.fillText("VOICES", this.w - pad, pad + 34);
    for (let i = 0; i < MAX_GHOSTS + 1; i++) {
      const x = this.w - pad - 8 - (MAX_GHOSTS - i) * 16;
      const y = pad + 58;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, TAU);
      if (i < this.takes.length) {
        ctx.fillStyle = VOICES[i % VOICES.length];
        ctx.fill();
      } else {
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = "rgba(223,228,236,0.25)";
        ctx.stroke();
      }
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(223,228,236,0.38)";
    ctx.fillText(
      this.c.isTouch
        ? "SWIPE TO MOVE  ·  MOVES SNAP TO THE BEAT"
        : "ARROWS / WASD MOVE  ·  MOVES SNAP TO THE BEAT  ·  R RESETS THE LOOP",
      this.w / 2,
      this.boardY + this.cell * this.rows + 34,
    );

    const held = this.plates.filter((p) =>
      this.playerPos.x === p.x && this.playerPos.y === p.y
        ? true
        : this.ghostPos.some((g) => g.x === p.x && g.y === p.y),
    ).length;
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = "rgba(242,193,78,0.8)";
    ctx.fillText(
      `${held} / ${this.plates.length} HELD`,
      this.w / 2,
      this.boardY + this.cell * this.rows + 58,
    );
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;

    ctx.fillStyle = "rgba(27,31,38,0.86)";
    ctx.fillRect(0, 0, this.w, this.h);

    // Four voices pulsing in turn — the premise, animated.
    for (let i = 0; i < 4; i++) {
      const beat = (t * 1.6 + i * 0.25) % 1;
      const r = 8 + (1 - beat) * 12;
      const x = cx + (i - 1.5) * 46;
      const y = this.h * 0.42;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, TAU);
      ctx.globalAlpha = 0.25 + (1 - beat) * 0.55;
      ctx.fillStyle = VOICES[i];
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(this.w * 0.13, 72);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = TEXT;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("OSTINATO", cx, this.h * 0.24);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(223,228,236,0.6)";
    ctx.fillText("EVERYTHING YOU DO REPEATS.", cx, this.h * 0.24 + size * 0.64);
    ctx.fillStyle = "rgba(242,193,78,0.7)";
    ctx.fillText(
      "EACH PAST SELF PLAYS ONE INSTRUMENT.",
      cx,
      this.h * 0.24 + size * 0.64 + 20,
    );

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(223,228,236,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.82);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(223,228,236,0.32)";
      ctx.fillText(`ROOMS SOLVED — ${this.best}`, cx, this.h * 0.82 + 24);
    }
  }

  private drawSolved(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.solvedTime / 0.6));
    const cx = this.w / 2;

    // Only a light wash — the solved board is the reward, so it stays visible.
    // The text sits clear of it rather than on top of it.
    ctx.fillStyle = `rgba(27,31,38,${0.45 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    const above = Math.max(70, this.boardY - 76);
    const below = Math.min(this.h - 34, this.boardY + this.cell * this.rows + 96);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 54), 800);
    ctx.fillStyle = PLATE_ON;
    ctx.fillText("IN TUNE", cx, above);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(223,228,236,${0.6 * ease})`;
    ctx.fillText(
      `ROOM ${this.levelIndex + 1}  ·  ${this.takes.length + 1} VOICES  ·  ${this.loopCount} LOOPS`,
      cx,
      above + 38,
    );

    if (this.solvedTime > 1.3) {
      const blink = 0.5 + Math.sin(this.solvedTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(223,228,236,${blink})`;
      ctx.fillText("NEXT ROOM", cx, below);
    }
  }

  private drawComplete(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.solvedTime / 0.6));
    const cx = this.w / 2;
    ctx.fillStyle = `rgba(27,31,38,${0.9 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 62), 800);
    ctx.fillStyle = TEXT;
    ctx.fillText("ALL ROOMS", cx, this.h * 0.38);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(223,228,236,${0.55 * ease})`;
    ctx.fillText(`${LEVELS.length} ARRANGEMENTS COMPLETED`, cx, this.h * 0.38 + 46);

    if (this.solvedTime > 0.8) {
      const blink = 0.5 + Math.sin(this.solvedTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(223,228,236,${blink})`;
      ctx.fillText("PLAY AGAIN", cx, this.h * 0.78);
    }
  }
}

const factory: GameFactory = (ctx) => new Ostinato(ctx);
export default factory;
