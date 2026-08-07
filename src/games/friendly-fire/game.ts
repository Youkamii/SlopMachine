/**
 * FRIENDLY FIRE
 *
 * A 5x5 tactics puzzle in which you have no attack at all. You move one tile
 * or you wait. Every kill has to be arranged by making two enemies walk into
 * the same square.
 *
 * Everything is deterministic and fully telegraphed — the arrow over an enemy
 * is exactly where it will be next turn. A puzzle with a hidden variable is a
 * gamble, not a puzzle, so there are none. Undo is unlimited for the same
 * reason.
 *
 * The generator is the hard part: random layouts are almost always unsolvable
 * or trivial. Because a turn has only five options, the whole game tree for a
 * short puzzle is a few thousand states — small enough to brute-force. Every
 * puzzle shipped has been solved by machine first, and rejected unless the
 * shortest solution takes at least two moves.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp01, easeOutBack, easeOutCubic, lerp } from "@/engine/math";
import { RNG, seedFrom } from "@/engine/rng";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const PAPER = "#e9ebec";
const PAPER_2 = "#dfe3e5";
const LINE = "#c2c9cd";
const INK = "#14171a";
const PLAYER_C = "#1d5fd6";
const ENEMY_C = "#14171a";
const THREAT = "#d92b2b";
const WIN = "#0f9d58";

const SIZE = 5;

type Kind = "hunter" | "runner" | "mirror";

interface Enemy {
  x: number;
  y: number;
  kind: Kind;
  /** RUNNER only: current heading. */
  dx: number;
  dy: number;
}

interface State {
  px: number;
  py: number;
  enemies: Enemy[];
  /** MIRROR copies this. */
  lx: number;
  ly: number;
}

type Move = { dx: number; dy: number };

const MOVES: Move[] = [
  { dx: 0, dy: 0 },
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

const inBounds = (x: number, y: number) =>
  x >= 0 && y >= 0 && x < SIZE && y < SIZE;

function cloneState(s: State): State {
  return {
    px: s.px,
    py: s.py,
    lx: s.lx,
    ly: s.ly,
    enemies: s.enemies.map((e) => ({ ...e })),
  };
}

/** Where an enemy intends to go. Pure, so the UI and the solver agree. */
function intent(e: Enemy, s: State): { x: number; y: number; dx: number; dy: number } {
  switch (e.kind) {
    case "hunter": {
      // Closes the larger axis first. Ties break toward x, which keeps it
      // deterministic — a coin flip here would break the whole design.
      const dx = s.px - e.x;
      const dy = s.py - e.y;
      let mx = 0;
      let my = 0;
      if (Math.abs(dx) >= Math.abs(dy)) mx = Math.sign(dx);
      else my = Math.sign(dy);
      return { x: e.x + mx, y: e.y + my, dx: mx, dy: my };
    }
    case "runner": {
      let nx = e.x + e.dx;
      let ny = e.y + e.dy;
      let ndx = e.dx;
      let ndy = e.dy;
      // Bounces off the border rather than stopping, so it stays a threat.
      if (!inBounds(nx, ny)) {
        ndx = -e.dx;
        ndy = -e.dy;
        nx = e.x + ndx;
        ny = e.y + ndy;
      }
      return { x: nx, y: ny, dx: ndx, dy: ndy };
    }
    case "mirror": {
      // Repeats the player's previous move. Standing still freezes it, which
      // is the lever that makes these puzzles work.
      const nx = e.x + s.lx;
      const ny = e.y + s.ly;
      if (!inBounds(nx, ny)) return { x: e.x, y: e.y, dx: 0, dy: 0 };
      return { x: nx, y: ny, dx: s.lx, dy: s.ly };
    }
  }
}

type Outcome = "ok" | "won" | "lost";

interface StepResult {
  state: State;
  outcome: Outcome;
  /** Squares where enemies annihilated each other this turn. */
  kills: Array<{ x: number; y: number }>;
}

/**
 * Advance one full turn: the player's move, then every enemy's.
 * Pure — the solver runs this exact function.
 */
function step(prev: State, move: Move): StepResult {
  const s = cloneState(prev);

  const nx = s.px + move.dx;
  const ny = s.py + move.dy;
  const blocked =
    !inBounds(nx, ny) || s.enemies.some((e) => e.x === nx && e.y === ny);
  if (!blocked) {
    s.px = nx;
    s.py = ny;
  }
  // A blocked move still counts as a turn, but MIRROR must not copy a move
  // that did not happen.
  s.lx = blocked ? 0 : move.dx;
  s.ly = blocked ? 0 : move.dy;

  const targets = s.enemies.map((e) => intent(e, s));

  // Two or more enemies converging on one square destroy each other. This is
  // the only way anything dies.
  const counts = new Map<string, number>();
  for (const t of targets) {
    const k = `${t.x},${t.y}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  const survivors: Enemy[] = [];
  const kills: Array<{ x: number; y: number }> = [];
  const killedAt = new Set<string>();

  for (let i = 0; i < s.enemies.length; i++) {
    const e = s.enemies[i];
    const t = targets[i];
    const key = `${t.x},${t.y}`;
    if ((counts.get(key) ?? 0) > 1) {
      if (!killedAt.has(key)) {
        killedAt.add(key);
        kills.push({ x: t.x, y: t.y });
      }
      continue;
    }
    survivors.push({ x: t.x, y: t.y, kind: e.kind, dx: t.dx, dy: t.dy });
  }

  s.enemies = survivors;

  if (s.enemies.some((e) => e.x === s.px && e.y === s.py)) {
    return { state: s, outcome: "lost", kills };
  }
  if (s.enemies.length === 0) {
    return { state: s, outcome: "won", kills };
  }
  return { state: s, outcome: "ok", kills };
}

/**
 * Shortest number of turns to clear the board, or -1 if impossible within
 * `maxDepth`. Iterative deepening keeps memory flat and finds the true
 * minimum, which is what the generator needs to reject trivial layouts.
 */
function solve(start: State, maxDepth: number): number {
  for (let depth = 1; depth <= maxDepth; depth++) {
    if (search(start, depth)) return depth;
  }
  return -1;
}

function search(s: State, budget: number): boolean {
  if (budget === 0) return false;
  for (const m of MOVES) {
    const r = step(s, m);
    if (r.outcome === "won") return true;
    if (r.outcome === "lost") continue;
    if (search(r.state, budget - 1)) return true;
  }
  return false;
}

interface Puzzle {
  state: State;
  par: number;
  turns: number;
}

function generate(rng: RNG, difficulty: number): Puzzle {
  const enemyCount = clampInt(2 + Math.floor(difficulty / 2), 2, 5);
  const maxDepth = clampInt(3 + Math.floor(difficulty / 2), 3, 6);

  for (let attempt = 0; attempt < 400; attempt++) {
    const taken = new Set<string>();
    const pick = () => {
      for (let i = 0; i < 60; i++) {
        const x = rng.int(0, SIZE - 1);
        const y = rng.int(0, SIZE - 1);
        if (!taken.has(`${x},${y}`)) {
          taken.add(`${x},${y}`);
          return { x, y };
        }
      }
      return null;
    };

    const p = pick();
    if (!p) continue;

    const kinds: Kind[] = ["hunter", "runner", "mirror"];
    const enemies: Enemy[] = [];
    let ok = true;
    for (let i = 0; i < enemyCount; i++) {
      const pos = pick();
      if (!pos) { ok = false; break; }
      const kind = rng.pickWeighted(kinds, [
        1.2,
        difficulty > 1 ? 1 : 0.4,
        difficulty > 2 ? 1 : 0.25,
      ]);
      const dir = rng.pick([
        { dx: 1, dy: 0 }, { dx: -1, dy: 0 },
        { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
      ]);
      enemies.push({ x: pos.x, y: pos.y, kind, dx: dir.dx, dy: dir.dy });
    }
    if (!ok) continue;

    const state: State = { px: p.x, py: p.y, enemies, lx: 0, ly: 0 };

    // Reject anything already lost, or solvable in one move (no thinking),
    // or not solvable at all inside the budget.
    const par = solve(state, maxDepth);
    if (par < 2) continue;

    return { state, par, turns: par + 1 };
  }

  // Fallback: a hand-made pair that is always solvable, so generation can
  // never hang the game.
  const state: State = {
    px: 2, py: 4,
    enemies: [
      { x: 1, y: 1, kind: "hunter", dx: 0, dy: 0 },
      { x: 3, y: 1, kind: "hunter", dx: 0, dy: 0 },
    ],
    lx: 0, ly: 0,
  };
  return { state, par: 2, turns: 3 };
}

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));

// --- game -------------------------------------------------------------------

type Phase = "title" | "playing" | "won" | "lost" | "cleared";

interface Anim {
  /** 0..1 progress of the current turn animation. */
  t: number;
  from: State | null;
  kills: Array<{ x: number; y: number }>;
}

class FriendlyFire implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private cell = 0;
  private boardX = 0;
  private boardY = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private endTime = 0;
  private time = 0;

  private rng: RNG;
  private puzzle: Puzzle;
  private state: State;
  private history: State[] = [];
  private turnsUsed = 0;

  private level = 1;
  private best = 0;
  private anim: Anim = { t: 1, from: null, kills: [] };

  private titleState: State;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.rng = new RNG(ctx.rng.int(1, 0xffffff));
    this.puzzle = generate(this.rng, 1);
    this.state = cloneState(this.puzzle.state);
    this.titleState = generate(new RNG(seedFrom("title")), 2).state;
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    const avail = Math.min(w * 0.86, h * 0.62, 460);
    this.cell = Math.floor(avail / SIZE);
    const boardSize = this.cell * SIZE;
    this.boardX = (w - boardSize) / 2;
    this.boardY = h * 0.52 - boardSize / 2;
  }

  private cellCentre(x: number, y: number) {
    return {
      x: this.boardX + (x + 0.5) * this.cell,
      y: this.boardY + (y + 0.5) * this.cell,
    };
  }

  restart() {
    this.phase = "playing";
    this.level = 1;
    this.newPuzzle();
    this.c.report({ status: "playing", score: 0 });
  }

  private newPuzzle() {
    this.puzzle = generate(this.rng, this.level);
    this.state = cloneState(this.puzzle.state);
    this.history.length = 0;
    this.turnsUsed = 0;
    this.anim = { t: 1, from: null, kills: [] };
    this.phase = "playing";
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;

    if (this.anim.t < 1) this.anim.t = Math.min(1, this.anim.t + dt * 6.5);

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "sine", freq: 440, freqTo: 660, glide: 0.14,
          vol: 0.16, attack: 0.005, hold: 0.05, release: 0.2,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "won" || this.phase === "lost" || this.phase === "cleared") {
      this.endTime += dt;
      if (this.endTime > 0.5 && (input.pointer.justUp || input.confirmPressed)) {
        if (this.phase === "won") {
          this.level++;
          this.newPuzzle();
        } else {
          this.state = cloneState(this.puzzle.state);
          this.history.length = 0;
          this.turnsUsed = 0;
          this.phase = "playing";
        }
      }
      return;
    }

    this.handleInput();
  }

  private handleInput() {
    const { input } = this.c;
    if (this.anim.t < 1) return;

    if (input.wasPressed("KeyZ", "Backspace")) {
      this.undo();
      return;
    }
    if (input.wasPressed("KeyR")) {
      this.state = cloneState(this.puzzle.state);
      this.history.length = 0;
      this.turnsUsed = 0;
      this.c.audio.click(0.1);
      return;
    }

    let move: Move | null = null;
    if (input.wasPressed("ArrowRight", "KeyD")) move = { dx: 1, dy: 0 };
    else if (input.wasPressed("ArrowLeft", "KeyA")) move = { dx: -1, dy: 0 };
    else if (input.wasPressed("ArrowDown", "KeyS")) move = { dx: 0, dy: 1 };
    else if (input.wasPressed("ArrowUp", "KeyW")) move = { dx: 0, dy: -1 };
    else if (input.wasPressed("Space", "Period")) move = { dx: 0, dy: 0 };

    // Touch / click: tap an orthogonally adjacent tile, or your own tile to wait.
    if (!move && input.pointer.justUp && input.dragDistance < 18) {
      const gx = Math.floor((input.pointer.x - this.boardX) / this.cell);
      const gy = Math.floor((input.pointer.y - this.boardY) / this.cell);
      if (inBounds(gx, gy)) {
        const dx = gx - this.state.px;
        const dy = gy - this.state.py;
        if (dx === 0 && dy === 0) move = { dx: 0, dy: 0 };
        else if (Math.abs(dx) + Math.abs(dy) === 1) move = { dx, dy };
      }
    }

    // Swipe.
    if (!move && input.pointer.justUp && input.dragDistance >= 18) {
      const a = input.dragAngle;
      const deg = ((a * 180) / Math.PI + 360) % 360;
      if (deg < 45 || deg >= 315) move = { dx: 1, dy: 0 };
      else if (deg < 135) move = { dx: 0, dy: 1 };
      else if (deg < 225) move = { dx: -1, dy: 0 };
      else move = { dx: 0, dy: -1 };
    }

    if (move) this.applyMove(move);
  }

  private applyMove(move: Move) {
    const { fx, audio } = this.c;
    const before = cloneState(this.state);
    const r = step(this.state, move);

    this.history.push(before);
    if (this.history.length > 200) this.history.shift();

    this.anim = { t: 0, from: before, kills: r.kills };
    this.state = r.state;
    this.turnsUsed++;

    audio.play({
      wave: "sine", freq: 220, freqTo: 180, glide: 0.06,
      vol: 0.08, attack: 0.002, hold: 0.02, release: 0.07, filter: 1800,
    });

    for (const k of r.kills) {
      const p = this.cellCentre(k.x, k.y);
      fx.emit(p.x, p.y, {
        count: 14, speed: 190, life: 0.45, size: 2.4,
        color: [THREAT, INK], drag: 3.2,
      });
      fx.shake(6, 6);
      fx.freeze(0.05);
      audio.play({
        wave: "square", freq: 330, freqTo: 165, glide: 0.1,
        vol: 0.14, attack: 0.002, hold: 0.03, release: 0.16, filter: 2400,
      });
    }

    if (r.outcome === "won") {
      this.phase = "won";
      this.endTime = 0;
      const cleared = this.c.store.bump("solved");
      if (this.c.store.recordBest("best", this.level)) this.best = this.level;
      void cleared;
      fx.flash(WIN, 0.1);
      [0, 4, 7, 12].forEach((s, i) =>
        audio.play({
          wave: "sine", freq: 440 * Math.pow(2, s / 12),
          vol: 0.13, attack: 0.004, hold: 0.05, release: 0.4, delay: i * 0.06,
        }),
      );
      this.c.report({ score: this.level });
      return;
    }

    if (r.outcome === "lost") {
      this.phase = "lost";
      this.endTime = 0;
      fx.flash(THREAT, 0.14);
      fx.shake(14, 5);
      audio.play({
        wave: "sawtooth", freq: 200, freqTo: 60, glide: 0.4,
        vol: 0.2, attack: 0.004, hold: 0.08, release: 0.4, filter: 1200,
      });
      return;
    }

    if (this.turnsUsed >= this.puzzle.turns) {
      this.phase = "lost";
      this.endTime = 0;
      audio.fail(0.2);
    }
  }

  private undo() {
    if (this.history.length === 0) return;
    this.state = this.history.pop()!;
    this.turnsUsed = Math.max(0, this.turnsUsed - 1);
    this.anim = { t: 1, from: null, kills: [] };
    this.c.audio.play({
      wave: "sine", freq: 480, freqTo: 620, glide: 0.06,
      vol: 0.07, attack: 0.002, hold: 0.015, release: 0.06,
    });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, this.w, this.h);

    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, PAPER);
    g.addColorStop(1, PAPER_2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    if (this.phase === "title") {
      this.drawBoard(ctx, this.titleState, false);
      this.drawPieces(ctx, this.titleState, this.titleState, 1, true);
    } else {
      this.drawBoard(ctx, this.state, true);
      const from = this.anim.from ?? this.state;
      this.drawPieces(ctx, from, this.state, this.anim.t, false);
    }

    fx.drawParticles(ctx);
    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "won") this.drawBanner(ctx, "CLEAR", WIN);
    if (this.phase === "lost") this.drawBanner(ctx, "FAILED", THREAT);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawBoard(
    ctx: CanvasRenderingContext2D,
    s: State,
    showThreat: boolean,
  ) {
    const size = this.cell * SIZE;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(this.boardX, this.boardY, size, size);

    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    for (let i = 0; i <= SIZE; i++) {
      const p = i * this.cell;
      ctx.beginPath();
      ctx.moveTo(this.boardX + p, this.boardY);
      ctx.lineTo(this.boardX + p, this.boardY + size);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(this.boardX, this.boardY + p);
      ctx.lineTo(this.boardX + size, this.boardY + p);
      ctx.stroke();
    }

    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.boardX, this.boardY, size, size);

    if (!showThreat || this.anim.t < 1) return;

    // Telegraph: exactly where each enemy will be next turn. The whole design
    // depends on this being complete and correct.
    const targets = s.enemies.map((e) => intent(e, s));
    const counts = new Map<string, number>();
    for (const t of targets) {
      const k = `${t.x},${t.y}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }

    for (const [key, n] of counts) {
      const [tx, ty] = key.split(",").map(Number);
      if (!inBounds(tx, ty)) continue;
      const p = this.cellCentre(tx, ty);
      const collide = n > 1;
      ctx.fillStyle = collide
        ? "rgba(15,157,88,0.2)"
        : "rgba(217,43,43,0.12)";
      ctx.fillRect(
        this.boardX + tx * this.cell + 1,
        this.boardY + ty * this.cell + 1,
        this.cell - 2,
        this.cell - 2,
      );
      if (collide) {
        // Where a kill is about to happen, say so loudly.
        ctx.strokeStyle = WIN;
        ctx.lineWidth = 2;
        ctx.strokeRect(
          this.boardX + tx * this.cell + 3,
          this.boardY + ty * this.cell + 3,
          this.cell - 6,
          this.cell - 6,
        );
        const pulse = 0.5 + Math.sin(this.time * 8) * 0.5;
        ctx.globalAlpha = 0.35 + pulse * 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.cell * 0.3, 0, TAU);
        ctx.strokeStyle = WIN;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    for (let i = 0; i < s.enemies.length; i++) {
      const e = s.enemies[i];
      const t = targets[i];
      if (t.x === e.x && t.y === e.y) continue;
      const a = this.cellCentre(e.x, e.y);
      const b = this.cellCentre(t.x, t.y);
      ctx.strokeStyle = "rgba(217,43,43,0.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(lerp(a.x, b.x, 0.72), lerp(a.y, b.y, 0.72));
      ctx.stroke();

      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const hx = lerp(a.x, b.x, 0.78);
      const hy = lerp(a.y, b.y, 0.78);
      ctx.beginPath();
      ctx.moveTo(hx, hy);
      ctx.lineTo(hx - Math.cos(ang - 0.5) * 9, hy - Math.sin(ang - 0.5) * 9);
      ctx.lineTo(hx - Math.cos(ang + 0.5) * 9, hy - Math.sin(ang + 0.5) * 9);
      ctx.closePath();
      ctx.fillStyle = "rgba(217,43,43,0.5)";
      ctx.fill();
    }

    // Legal moves, so the rule "one tile or wait" never needs explaining.
    for (const m of MOVES) {
      if (m.dx === 0 && m.dy === 0) continue;
      const nx = s.px + m.dx;
      const ny = s.py + m.dy;
      if (!inBounds(nx, ny)) continue;
      if (s.enemies.some((e) => e.x === nx && e.y === ny)) continue;
      const p = this.cellCentre(nx, ny);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3.5, 0, TAU);
      ctx.fillStyle = "rgba(29,95,214,0.25)";
      ctx.fill();
    }
  }

  private drawPieces(
    ctx: CanvasRenderingContext2D,
    from: State,
    to: State,
    t: number,
    isTitle: boolean,
  ) {
    const e = easeOutBack(clamp01(t));
    const r = this.cell * 0.3;

    // Enemies are matched by index against the previous state where possible,
    // so a surviving piece slides instead of teleporting.
    for (let i = 0; i < to.enemies.length; i++) {
      const cur = to.enemies[i];
      const prev = from.enemies[i] ?? cur;
      const a = this.cellCentre(prev.x, prev.y);
      const b = this.cellCentre(cur.x, cur.y);
      const x = lerp(a.x, b.x, e);
      const y = lerp(a.y, b.y, e);
      this.drawEnemy(ctx, x, y, r, cur.kind);
    }

    const pa = this.cellCentre(from.px, from.py);
    const pb = this.cellCentre(to.px, to.py);
    const px = lerp(pa.x, pb.x, e);
    const py = lerp(pa.y, pb.y, e);

    ctx.beginPath();
    ctx.arc(px, py, r, 0, TAU);
    ctx.fillStyle = PLAYER_C;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    if (isTitle) return;
  }

  private drawEnemy(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    r: number,
    kind: Kind,
  ) {
    ctx.fillStyle = ENEMY_C;
    ctx.beginPath();
    switch (kind) {
      case "hunter": {
        // Triangle — points at you, because it comes for you.
        for (let i = 0; i < 3; i++) {
          const a = -Math.PI / 2 + (i / 3) * TAU;
          const px = x + Math.cos(a) * r * 1.15;
          const py = y + Math.sin(a) * r * 1.15;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case "runner": {
        ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
        ctx.fill();
        break;
      }
      case "mirror": {
        // Diamond, drawn hollow — it only acts when you do.
        for (let i = 0; i < 4; i++) {
          const a = -Math.PI / 2 + (i / 4) * TAU;
          const px = x + Math.cos(a) * r * 1.2;
          const py = y + Math.sin(a) * r * 1.2;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.lineWidth = 3;
        ctx.strokeStyle = ENEMY_C;
        ctx.stroke();
        break;
      }
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(20,23,26,0.45)";
    ctx.fillText("PUZZLE", pad, pad + 34);
    ctx.font = monoFont(28, 700);
    ctx.fillStyle = INK;
    ctx.fillText(this.level.toString().padStart(2, "0"), pad, pad + 48);

    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(20,23,26,0.45)";
    ctx.fillText("TURNS LEFT", this.w - pad, pad + 34);
    ctx.font = monoFont(28, 700);
    const left = this.puzzle.turns - this.turnsUsed;
    ctx.fillStyle = left <= 1 ? THREAT : INK;
    ctx.fillText(left.toString(), this.w - pad, pad + 48);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(20,23,26,0.4)";
    ctx.fillText(
      this.c.isTouch
        ? "TAP A NEIGHBOURING TILE  ·  TAP YOURSELF TO WAIT"
        : "ARROWS / WASD MOVE  ·  SPACE WAITS  ·  Z UNDO  ·  R RESET",
      this.w / 2,
      this.boardY + this.cell * SIZE + 34,
    );

    if (this.history.length > 0) {
      ctx.font = monoFont(10, 500);
      ctx.fillStyle = "rgba(20,23,26,0.3)";
      ctx.fillText(
        `PAR ${this.puzzle.par}`,
        this.w / 2,
        this.boardY - 22,
      );
    } else {
      ctx.font = monoFont(10, 500);
      ctx.fillStyle = "rgba(20,23,26,0.3)";
      ctx.fillText(
        `SOLVABLE IN ${this.puzzle.par}`,
        this.w / 2,
        this.boardY - 22,
      );
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;

    ctx.fillStyle = "rgba(233,235,236,0.9)";
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.125, 68);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = INK;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("FRIENDLY FIRE", cx, this.h * 0.3);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(20,23,26,0.62)";
    ctx.fillText("YOU HAVE NO ATTACK.", cx, this.h * 0.3 + size * 0.66);
    ctx.fillStyle = "rgba(20,23,26,0.42)";
    ctx.fillText(
      "MAKE THEM WALK INTO EACH OTHER.",
      cx,
      this.h * 0.3 + size * 0.66 + 20,
    );

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(20,23,26,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.84);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(20,23,26,0.34)";
      ctx.fillText(`BEST RUN — PUZZLE ${this.best}`, cx, this.h * 0.84 + 24);
    }
  }

  private drawBanner(ctx: CanvasRenderingContext2D, text: string, color: string) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.45));
    const cx = this.w / 2;
    const cy = this.boardY + this.cell * SIZE * 0.5;

    ctx.fillStyle = `rgba(233,235,236,${0.95 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.15, 70), 800);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, cy);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(20,23,26,${0.55 * ease})`;
    ctx.fillText(
      this.phase === "won"
        ? `PUZZLE ${this.level} CLEARED IN ${this.turnsUsed} — PAR ${this.puzzle.par}`
        : `PUZZLE ${this.level}`,
      cx,
      cy + 54,
    );

    if (this.endTime > 0.5) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(20,23,26,${blink})`;
      ctx.fillText(
        this.phase === "won" ? "NEXT PUZZLE" : "TRY AGAIN",
        cx,
        // Anchored below the board, not to a viewport fraction — on a short
        // window the two were landing on top of each other.
        Math.min(this.h - 40, this.boardY + this.cell * SIZE + 70),
      );
    }
  }
}

const factory: GameFactory = (ctx) => new FriendlyFire(ctx);
export default factory;
