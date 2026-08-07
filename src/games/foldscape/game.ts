/**
 * FOLDSCAPE
 *
 * You do not walk to the goal. You fold the map until the goal is where you
 * already are.
 *
 * A fold reflects one side of a crease onto the other, so two tiles at
 * opposite ends of the level physically become one tile. Floors merge; a
 * floor landing on a wall does not, and that fold is refused. Get the player
 * and the goal to occupy the same square and the level is solved.
 *
 * The whole design rests on the fold being legible before you commit: while
 * dragging, every pair of tiles that is about to merge is drawn in green, and
 * every pair that would collide is drawn in red.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { clamp, clamp01, easeOutCubic, easeOutQuart, lerp } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const PAPER = "#f2e2ce";
const PAPER_DEEP = "#e2cdb2";
const BACKSIDE = "#d3b795";
const INK = "#1f2a44";
const INK_SOFT = "rgba(31,42,68,0.28)";
const GOAL_C = "#e0563b";
const OK = "#2f8f5b";
const BAD = "#c8402f";

// --- level model ------------------------------------------------------------
//
//   .  floor      #  wall      P  player      G  goal
//
// Hand-authored: a fold puzzle's difficulty lives entirely in the shape, and
// a generator that does not understand that produces noise.

interface LevelDef {
  rows: string[];
  par: number;
}

const LEVELS: LevelDef[] = [
  { rows: ["P....G"], par: 1 },
  { rows: ["P..#..G"], par: 2 },
  {
    rows: [
      "P.....",
      "......",
      ".....G",
    ],
    par: 2,
  },
  {
    rows: [
      "P..#..",
      "......",
      "..#..G",
    ],
    par: 3,
  },
  {
    rows: [
      "P...#..",
      ".#.....",
      "....#..",
      "......G",
    ],
    par: 3,
  },
  {
    rows: [
      "P..#...#",
      "..#....#",
      "#....#..",
      "...#...G",
    ],
    par: 4,
  },
];

type Cell = "." | "#" | "P" | "G" | "B"; // B = player and goal together

interface Board {
  w: number;
  h: number;
  cells: Cell[];
}

function parse(def: LevelDef): Board {
  const h = def.rows.length;
  const w = def.rows[0].length;
  const cells: Cell[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) cells.push(def.rows[y][x] as Cell);
  }
  return { w, h, cells };
}

const at = (b: Board, x: number, y: number): Cell => b.cells[y * b.w + x];

/**
 * Merge two cells. Returns null when the fold is illegal.
 * Walls never merge with anything — that is the entire constraint system.
 */
function merge(a: Cell, b: Cell): Cell | null {
  if (a === "#" || b === "#") {
    // A wall may only land on nothing at all, which cannot happen inside the
    // board, so any overlap involving a wall is refused.
    return null;
  }
  if (a === ".") return b;
  if (b === ".") return a;
  // Player onto goal (or vice versa) is the win condition.
  if ((a === "P" && b === "G") || (a === "G" && b === "P")) return "B";
  if (a === b) return a;
  if (a === "B" || b === "B") return "B";
  return null;
}

type Axis = "v" | "h";

interface Fold {
  axis: Axis;
  /** Crease index: for 'v' it sits between columns crease-1 and crease. */
  crease: number;
  /** true = the low side folds onto the high side. */
  lowOntoHigh: boolean;
}

/** Which cell does (x,y) land on after this fold? null = it is discarded. */
function mapCell(f: Fold, x: number, y: number, b: Board): { x: number; y: number } | null {
  if (f.axis === "v") {
    if (f.lowOntoHigh) {
      if (x >= f.crease) return { x, y };
      const nx = 2 * f.crease - 1 - x;
      return nx < b.w ? { x: nx, y } : null;
    }
    if (x < f.crease) return { x, y };
    const nx = 2 * f.crease - 1 - x;
    return nx >= 0 ? { x: nx, y } : null;
  }
  if (f.lowOntoHigh) {
    if (y >= f.crease) return { x, y };
    const ny = 2 * f.crease - 1 - y;
    return ny < b.h ? { x, y: ny } : null;
  }
  if (y < f.crease) return { x, y };
  const ny = 2 * f.crease - 1 - y;
  return ny >= 0 ? { x, y: ny } : null;
}

interface FoldResult {
  board: Board | null;
  /** Pairs that merge, for the preview. */
  pairs: Array<{ ax: number; ay: number; bx: number; by: number; ok: boolean }>;
  legal: boolean;
}

function applyFold(b: Board, f: Fold): FoldResult {
  const pairs: FoldResult["pairs"] = [];

  // Destination extent after folding away the reflected half.
  let nx0 = 0;
  let nx1 = b.w;
  let ny0 = 0;
  let ny1 = b.h;
  if (f.axis === "v") {
    if (f.lowOntoHigh) nx0 = f.crease;
    else nx1 = f.crease;
  } else {
    if (f.lowOntoHigh) ny0 = f.crease;
    else ny1 = f.crease;
  }

  const nw = nx1 - nx0;
  const nh = ny1 - ny0;
  if (nw <= 0 || nh <= 0) return { board: null, pairs, legal: false };

  const out: Cell[] = new Array(nw * nh).fill(".");
  let legal = true;

  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      const src = at(b, x, y);
      const dst = mapCell(f, x, y, b);
      if (!dst) {
        // Reflected off the board entirely. Only empty floor may vanish.
        if (src !== ".") legal = false;
        continue;
      }
      const ox = dst.x - nx0;
      const oy = dst.y - ny0;
      if (ox < 0 || oy < 0 || ox >= nw || oy >= nh) {
        if (src !== ".") legal = false;
        continue;
      }
      const idx = oy * nw + ox;
      const existing = out[idx];

      if (existing === ".") {
        out[idx] = src;
        continue;
      }

      const m = merge(existing, src);
      pairs.push({ ax: x, ay: y, bx: dst.x, by: dst.y, ok: m !== null });
      if (m === null) {
        legal = false;
        out[idx] = existing;
      } else {
        out[idx] = m;
      }
    }
  }

  return {
    board: legal ? { w: nw, h: nh, cells: out } : null,
    pairs,
    legal,
  };
}

function findCell(b: Board, want: Cell): { x: number; y: number } | null {
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (at(b, x, y) === want) return { x, y };
    }
  }
  return null;
}

// --- solver -----------------------------------------------------------------

const boardKey = (b: Board) => `${b.w}x${b.h}:${b.cells.join("")}`;

function allFolds(b: Board): Fold[] {
  const out: Fold[] = [];
  for (let c = 1; c < b.w; c++) {
    out.push({ axis: "v", crease: c, lowOntoHigh: true });
    out.push({ axis: "v", crease: c, lowOntoHigh: false });
  }
  for (let c = 1; c < b.h; c++) {
    out.push({ axis: "h", crease: c, lowOntoHigh: true });
    out.push({ axis: "h", crease: c, lowOntoHigh: false });
  }
  return out;
}

/**
 * Breadth-first search for the shortest solution, or -1 if there isn't one.
 *
 * Folding only ever shrinks the sheet, so the reachable state space is tiny
 * and BFS settles in milliseconds. Every level is checked at load: a
 * hand-authored fold puzzle looks solvable far more often than it is, and
 * shipping an impossible sheet is worse than shipping no sheet.
 */
function solveLevel(start: Board, maxDepth = 6): number {
  if (findCell(start, "B")) return 0;
  let frontier: Board[] = [start];
  const seen = new Set<string>([boardKey(start)]);

  for (let depth = 1; depth <= maxDepth; depth++) {
    const next: Board[] = [];
    for (const b of frontier) {
      for (const f of allFolds(b)) {
        const r = applyFold(b, f);
        if (!r.legal || !r.board) continue;
        if (findCell(r.board, "B")) return depth;
        const key = boardKey(r.board);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(r.board);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }
  return -1;
}

/** Levels that survive verification, with their true par. */
interface VerifiedLevel {
  board: Board;
  par: number;
}

function verifyLevels(): VerifiedLevel[] {
  const out: VerifiedLevel[] = [];
  for (const def of LEVELS) {
    const board = parse(def);
    const par = solveLevel(board);
    if (par > 0) out.push({ board, par });
  }
  return out;
}

/** Verified once at module load; impossible sheets never reach the player. */
const SHEETS = verifyLevels();

const cloneBoard = (b: Board): Board => ({
  w: b.w,
  h: b.h,
  cells: b.cells.slice(),
});

// --- game -------------------------------------------------------------------

type Phase = "title" | "playing" | "solved" | "complete";

class Foldscape implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private cell = 0;
  private bx = 0;
  private by = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private solvedTime = 0;
  private time = 0;

  private levelIndex = 0;
  private board: Board;
  private history: Board[] = [];
  private folds = 0;
  private best = 0;

  private dragging = false;
  private preview: FoldResult | null = null;
  private previewFold: Fold | null = null;
  /** Animates the fold when it lands. */
  private foldAnim = 1;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.board = cloneBoard(SHEETS[0].board);
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.layout();
  }

  private layout() {
    if (!this.board || !this.w) return;
    const availW = this.w * 0.82;
    const availH = this.h * 0.44;
    this.cell = Math.floor(
      Math.min(availW / this.board.w, availH / this.board.h, 92),
    );
    this.bx = (this.w - this.cell * this.board.w) / 2;
    this.by = this.h * 0.5 - (this.cell * this.board.h) / 2;
  }

  private loadLevel(i: number) {
    this.levelIndex = i % SHEETS.length;
    this.board = cloneBoard(SHEETS[this.levelIndex].board);
    this.history = [];
    this.folds = 0;
    this.preview = null;
    this.previewFold = null;
    this.dragging = false;
    this.foldAnim = 1;
    this.layout();
  }

  restart() {
    this.phase = "playing";
    this.loadLevel(0);
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;
    if (this.foldAnim < 1) this.foldAnim = Math.min(1, this.foldAnim + dt * 4.2);

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "noise", freq: 700, freqTo: 1800, vol: 0.1,
          attack: 0.006, hold: 0.02, release: 0.12,
          filter: 900, filterTo: 3000, filterType: "bandpass", q: 1.4,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "solved") {
      this.solvedTime += dt;
      if (this.solvedTime > 0.9 && (input.pointer.justUp || input.confirmPressed)) {
        if (this.levelIndex + 1 >= SHEETS.length) {
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

    if (input.wasPressed("KeyZ", "Backspace")) {
      this.undo();
      return;
    }
    if (input.wasPressed("KeyR")) {
      this.loadLevel(this.levelIndex);
      return;
    }

    this.handleDrag();
  }

  private handleDrag() {
    const { input } = this.c;
    const p = input.pointer;

    if (p.justDown) {
      this.dragging = true;
      this.preview = null;
      this.previewFold = null;
    }

    if (!this.dragging) return;

    const dx = p.x - p.startX;
    const dy = p.y - p.startY;
    const dist = Math.hypot(dx, dy);

    if (dist > 14) {
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const axis: Axis = horizontal ? "v" : "h";
      // The crease is the boundary nearest where the drag began.
      const gx = (p.startX - this.bx) / this.cell;
      const gy = (p.startY - this.by) / this.cell;
      const raw = horizontal ? gx : gy;
      const limit = horizontal ? this.board.w : this.board.h;
      const crease = clamp(Math.round(raw), 1, limit - 1);
      const lowOntoHigh = horizontal ? dx > 0 : dy > 0;
      const fold: Fold = { axis, crease, lowOntoHigh };

      if (
        !this.previewFold ||
        this.previewFold.axis !== fold.axis ||
        this.previewFold.crease !== fold.crease ||
        this.previewFold.lowOntoHigh !== fold.lowOntoHigh
      ) {
        this.previewFold = fold;
        this.preview = applyFold(this.board, fold);
      }
    } else {
      this.previewFold = null;
      this.preview = null;
    }

    if (!p.down) {
      this.dragging = false;
      if (this.previewFold && this.preview) this.commit();
      this.previewFold = null;
      this.preview = null;
    }
  }

  private commit() {
    const { fx, audio } = this.c;
    const result = this.preview!;

    if (!result.legal || !result.board) {
      // Refused. Say so with a dead, damped sound — nothing resonant.
      fx.shake(3, 9);
      audio.play({
        wave: "noise", freq: 220, freqTo: 120, vol: 0.1,
        attack: 0.002, hold: 0.02, release: 0.05, filter: 380,
      });
      return;
    }

    this.history.push(this.board);
    this.board = result.board;
    this.folds++;
    this.foldAnim = 0;
    this.layout();

    const crease = this.previewFold!;
    audio.play({
      wave: "noise",
      freq: 600 + crease.crease * 90,
      freqTo: 240,
      vol: 0.13,
      attack: 0.004,
      hold: 0.02,
      release: 0.13,
      filter: 1600,
      filterTo: 500,
      filterType: "bandpass",
      q: 1.2,
    });
    audio.play({
      wave: "sine", freq: 150, freqTo: 92, glide: 0.1,
      vol: 0.11, attack: 0.002, hold: 0.02, release: 0.1,
    });
    fx.shake(4, 8);

    if (findCell(this.board, "B")) this.solve();
  }

  private undo() {
    if (this.history.length === 0) return;
    this.board = this.history.pop()!;
    this.folds = Math.max(0, this.folds - 1);
    this.layout();
    this.c.audio.play({
      wave: "sine", freq: 420, freqTo: 560, glide: 0.06,
      vol: 0.07, attack: 0.002, hold: 0.014, release: 0.06,
    });
  }

  private solve() {
    const { fx, audio } = this.c;
    this.phase = "solved";
    this.solvedTime = 0;

    const b = findCell(this.board, "B");
    if (b) {
      const c = this.cellCentre(b.x, b.y);
      fx.emit(c.x, c.y, {
        count: 22, speed: 190, life: 0.7, size: 2.6,
        color: [GOAL_C, INK], drag: 2.8,
      });
    }
    fx.flash(GOAL_C, 0.08);

    [0, 5, 9, 12].forEach((s, i) =>
      audio.play({
        wave: "triangle", freq: 330 * Math.pow(2, s / 12),
        vol: 0.13, attack: 0.004, hold: 0.05, release: 0.5, delay: i * 0.06,
      }),
    );

    const solved = this.levelIndex + 1;
    if (this.c.store.recordBest("best", solved)) this.best = solved;
    this.c.report({ score: solved });
  }

  // --- render ---------------------------------------------------------------

  private cellCentre(x: number, y: number) {
    return {
      x: this.bx + (x + 0.5) * this.cell,
      y: this.by + (y + 0.5) * this.cell,
    };
  }

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;

    ctx.fillStyle = PAPER_DEEP;
    ctx.fillRect(0, 0, this.w, this.h);
    const g = ctx.createRadialGradient(
      this.w / 2, this.h * 0.42, 0,
      this.w / 2, this.h * 0.42, Math.max(this.w, this.h) * 0.8,
    );
    g.addColorStop(0, PAPER);
    g.addColorStop(1, PAPER_DEEP);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    if (this.phase !== "title") {
      this.drawBoard(ctx);
      if (this.preview && this.previewFold) this.drawPreview(ctx);
    }
    fx.drawParticles(ctx);

    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "solved") this.drawSolved(ctx);
    if (this.phase === "complete") this.drawComplete(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawBoard(ctx: CanvasRenderingContext2D) {
    const pop = easeOutQuart(clamp01(this.foldAnim));
    const b = this.board;

    ctx.save();
    // A freshly folded board settles into place rather than snapping.
    const scale = lerp(1.06, 1, pop);
    ctx.translate(this.w / 2, this.by + (this.cell * b.h) / 2);
    ctx.scale(scale, scale);
    ctx.translate(-this.w / 2, -(this.by + (this.cell * b.h) / 2));

    // Sheet shadow.
    ctx.fillStyle = "rgba(80,60,40,0.16)";
    ctx.fillRect(this.bx + 5, this.by + 7, this.cell * b.w, this.cell * b.h);

    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const px = this.bx + x * this.cell;
        const py = this.by + y * this.cell;
        const cellv = at(b, x, y);

        ctx.fillStyle = cellv === "#" ? INK : "#fdf4e6";
        ctx.fillRect(px, py, this.cell, this.cell);

        ctx.strokeStyle = cellv === "#" ? INK : "rgba(31,42,68,0.16)";
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, this.cell - 1, this.cell - 1);

        const c = this.cellCentre(x, y);
        if (cellv === "P" || cellv === "B") {
          ctx.beginPath();
          ctx.arc(c.x, c.y, this.cell * 0.24, 0, Math.PI * 2);
          ctx.fillStyle = INK;
          ctx.fill();
        }
        if (cellv === "G" || cellv === "B") {
          ctx.beginPath();
          ctx.arc(c.x, c.y, this.cell * (cellv === "B" ? 0.34 : 0.26), 0, Math.PI * 2);
          ctx.lineWidth = 3;
          ctx.strokeStyle = GOAL_C;
          ctx.stroke();
        }
      }
    }

    ctx.lineWidth = 2;
    ctx.strokeStyle = INK;
    ctx.strokeRect(this.bx, this.by, this.cell * b.w, this.cell * b.h);
    ctx.restore();
  }

  /**
   * The preview is the game. Every pair about to merge is drawn as a link:
   * green if it is legal, red if it kills the fold.
   */
  private drawPreview(ctx: CanvasRenderingContext2D) {
    const f = this.previewFold!;
    const res = this.preview!;
    const b = this.board;

    // Crease line.
    ctx.save();
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = res.legal ? OK : BAD;
    ctx.beginPath();
    if (f.axis === "v") {
      const x = this.bx + f.crease * this.cell;
      ctx.moveTo(x, this.by - 10);
      ctx.lineTo(x, this.by + b.h * this.cell + 10);
    } else {
      const y = this.by + f.crease * this.cell;
      ctx.moveTo(this.bx - 10, y);
      ctx.lineTo(this.bx + b.w * this.cell + 10, y);
    }
    ctx.stroke();
    ctx.restore();

    // Shade the half that is about to be lifted.
    ctx.save();
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = BACKSIDE;
    if (f.axis === "v") {
      if (f.lowOntoHigh) {
        ctx.fillRect(this.bx, this.by, f.crease * this.cell, b.h * this.cell);
      } else {
        ctx.fillRect(
          this.bx + f.crease * this.cell, this.by,
          (b.w - f.crease) * this.cell, b.h * this.cell,
        );
      }
    } else {
      if (f.lowOntoHigh) {
        ctx.fillRect(this.bx, this.by, b.w * this.cell, f.crease * this.cell);
      } else {
        ctx.fillRect(
          this.bx, this.by + f.crease * this.cell,
          b.w * this.cell, (b.h - f.crease) * this.cell,
        );
      }
    }
    ctx.restore();

    for (const pair of res.pairs) {
      const a = this.cellCentre(pair.ax, pair.ay);
      const d = this.cellCentre(pair.bx, pair.by);
      ctx.strokeStyle = pair.ok ? OK : BAD;
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(d.x, d.y);
      ctx.stroke();

      for (const p of [a, d]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, this.cell * 0.16, 0, Math.PI * 2);
        ctx.fillStyle = pair.ok ? OK : BAD;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    const def = SHEETS[this.levelIndex];
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(31,42,68,0.45)";
    ctx.fillText("SHEET", pad, pad + 34);
    ctx.font = monoFont(28, 700);
    ctx.fillStyle = INK;
    ctx.fillText(`${this.levelIndex + 1}/${SHEETS.length}`, pad, pad + 48);

    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(31,42,68,0.45)";
    ctx.fillText("FOLDS", this.w - pad, pad + 34);
    ctx.font = monoFont(28, 700);
    ctx.fillStyle = this.folds > def.par ? GOAL_C : INK;
    ctx.fillText(`${this.folds}/${def.par}`, this.w - pad, pad + 48);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(31,42,68,0.45)";
    const bottom = this.by + this.board.h * this.cell + 40;
    ctx.fillText(
      this.c.isTouch
        ? "DRAG ACROSS A CREASE TO FOLD  ·  Z UNDO"
        : "DRAG ACROSS A CREASE TO FOLD  ·  Z UNDO  ·  R RESET",
      this.w / 2,
      bottom,
    );
    ctx.fillStyle = "rgba(31,42,68,0.32)";
    ctx.fillText(
      "GREEN LINKS MERGE — RED ONES REFUSE",
      this.w / 2,
      bottom + 20,
    );
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;
    const cy = this.h * 0.44;

    // A sheet folding and unfolding, on loop.
    const cycle = (t * 0.5) % 2;
    const k = cycle < 1 ? easeOutCubic(cycle) : easeOutCubic(2 - cycle);
    const sw = Math.min(this.w * 0.36, 260);
    const sh = sw * 0.44;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "rgba(80,60,40,0.14)";
    ctx.fillRect(-sw / 2 + 5, -sh / 2 + 7, sw, sh);

    ctx.fillStyle = "#fdf4e6";
    ctx.fillRect(-sw / 2, -sh / 2, sw * (1 - k * 0.5), sh);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.strokeRect(-sw / 2, -sh / 2, sw * (1 - k * 0.5), sh);

    // The lifted flap, showing its back.
    ctx.fillStyle = BACKSIDE;
    ctx.beginPath();
    ctx.moveTo(sw / 2 - k * sw, -sh / 2);
    ctx.lineTo(sw / 2 - k * sw * 0.5, -sh / 2 - k * 18);
    ctx.lineTo(sw / 2 - k * sw * 0.5, sh / 2 - k * 18);
    ctx.lineTo(sw / 2 - k * sw, sh / 2);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = INK_SOFT;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(this.w * 0.13, 74);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = INK;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("FOLDSCAPE", cx, this.h * 0.2);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(31,42,68,0.6)";
    ctx.fillText("DO NOT WALK TO THE GOAL.", cx, this.h * 0.2 + size * 0.62);
    ctx.fillStyle = "rgba(224,86,59,0.75)";
    ctx.fillText("FOLD THE MAP UNTIL IT IS HERE.", cx, this.h * 0.2 + size * 0.62 + 20);

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(31,42,68,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.84);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(31,42,68,0.34)";
      ctx.fillText(`SHEETS SOLVED — ${this.best}`, cx, this.h * 0.84 + 24);
    }
  }

  private drawSolved(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.solvedTime / 0.5));
    const cx = this.w / 2;
    const def = SHEETS[this.levelIndex];
    const above = Math.max(70, this.by - 64);
    const below = Math.min(this.h - 34, this.by + this.board.h * this.cell + 84);

    ctx.fillStyle = `rgba(242,226,206,${0.5 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 54), 800);
    ctx.fillStyle = GOAL_C;
    ctx.fillText("FOLDED", cx, above);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(31,42,68,${0.6 * ease})`;
    ctx.fillText(
      this.folds <= def.par
        ? `${this.folds} FOLDS  ·  PAR ${def.par}`
        : `${this.folds} FOLDS  ·  PAR ${def.par}  ·  TRY IT TIGHTER`,
      cx,
      above + 34,
    );

    if (this.solvedTime > 0.9) {
      const blink = 0.5 + Math.sin(this.solvedTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(31,42,68,${blink})`;
      ctx.fillText("NEXT SHEET", cx, below);
    }
  }

  private drawComplete(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.solvedTime / 0.6));
    const cx = this.w / 2;
    ctx.fillStyle = `rgba(242,226,206,${0.92 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 60), 800);
    ctx.fillStyle = INK;
    ctx.fillText("ALL SHEETS", cx, this.h * 0.4);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(31,42,68,${0.6 * ease})`;
    ctx.fillText(`${SHEETS.length} SHEETS FOLDED FLAT`, cx, this.h * 0.4 + 42);

    if (this.solvedTime > 0.8) {
      const blink = 0.5 + Math.sin(this.solvedTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(31,42,68,${blink})`;
      ctx.fillText("FOLD AGAIN", cx, this.h * 0.78);
    }
  }
}

const factory: GameFactory = (ctx) => new Foldscape(ctx);
export default factory;
