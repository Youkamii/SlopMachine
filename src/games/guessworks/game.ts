/**
 * GUESSWORKS
 *
 * A machine transforms a row of tokens by a hidden rule. You feed it inputs,
 * watch what comes out, and name the rule. The scientific method as a
 * three-minute game.
 *
 * The interesting skill is not guessing — it is choosing experiments that
 * cut the candidate space fastest, and the end screen tells you exactly how
 * efficiently you did that.
 *
 * Every machine is verified at generation: the true rule must be uniquely
 * identifiable inside the experiment budget, or it is discarded.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp01, easeOutCubic, lerp } from "@/engine/math";
import { RNG } from "@/engine/rng";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const BLUEPRINT = "#0d2a3f";
const BLUEPRINT_2 = "#08202f";
const GRID_LINE = "rgba(160,215,245,0.09)";
const DRAFT = "#c9e4f5";
const DRAFT_DIM = "rgba(201,228,245,0.4)";
const GOOD = "#7ee08a";
const WRONG = "#ff7a8a";

/** Token colours. Four is enough to reason about and few enough to read. */
const TOKENS = ["#ff6b6b", "#ffd166", "#4ecdc4", "#c792ea"] as const;
const TOKEN_NAMES = ["RED", "AMBER", "TEAL", "VIOLET"] as const;

type Row = number[];

// --- rules ------------------------------------------------------------------

interface Rule {
  label: string;
  apply: (row: Row) => Row;
}

function buildRules(): Rule[] {
  const rules: Rule[] = [
    { label: "REVERSE THE ROW", apply: (r) => [...r].reverse() },
    {
      label: "MOVE THE FIRST TO THE END",
      apply: (r) => (r.length ? [...r.slice(1), r[0]] : r),
    },
    {
      label: "MOVE THE LAST TO THE FRONT",
      apply: (r) => (r.length ? [r[r.length - 1], ...r.slice(0, -1)] : r),
    },
    { label: "DROP THE FIRST", apply: (r) => r.slice(1) },
    { label: "DROP THE LAST", apply: (r) => r.slice(0, -1) },
    { label: "DUPLICATE THE FIRST", apply: (r) => (r.length ? [r[0], ...r] : r) },
    { label: "DUPLICATE THE LAST", apply: (r) => (r.length ? [...r, r[r.length - 1]] : r) },
    {
      label: "SORT BY COLOUR",
      apply: (r) => [...r].sort((a, b) => a - b),
    },
    {
      label: "KEEP ONLY THE MOST COMMON COLOUR",
      apply: (r) => {
        const counts = new Map<number, number>();
        for (const v of r) counts.set(v, (counts.get(v) ?? 0) + 1);
        let best = -1;
        let bestN = -1;
        for (const [v, n] of counts) {
          if (n > bestN || (n === bestN && v < best)) {
            best = v;
            bestN = n;
          }
        }
        return r.filter((v) => v === best);
      },
    },
    {
      label: "REMOVE ADJACENT DUPLICATES",
      apply: (r) => r.filter((v, i) => i === 0 || v !== r[i - 1]),
    },
    {
      label: "REVERSE ONLY IF THE ROW IS EVEN-LENGTH",
      apply: (r) => (r.length % 2 === 0 ? [...r].reverse() : r),
    },
  ];

  for (let i = 0; i < TOKENS.length; i++) {
    rules.push({
      label: `REMOVE EVERY ${TOKEN_NAMES[i]}`,
      apply: (r) => r.filter((v) => v !== i),
    });
    const to = (i + 1) % TOKENS.length;
    rules.push({
      label: `TURN ${TOKEN_NAMES[i]} INTO ${TOKEN_NAMES[to]}`,
      apply: (r) => r.map((v) => (v === i ? to : v)),
    });
  }

  return rules;
}

const ALL_RULES = buildRules();

const rowKey = (r: Row) => r.join(",");

/** Rules that are indistinguishable on every probe are merged away. */
function candidatesAfter(
  pool: number[],
  probes: Array<{ input: Row; output: Row }>,
): number[] {
  return pool.filter((ri) =>
    probes.every(
      (p) => rowKey(ALL_RULES[ri].apply([...p.input])) === rowKey(p.output),
    ),
  );
}

interface Machine {
  /** Index into ALL_RULES. */
  truth: number;
  /** Multiple-choice options, including the truth. */
  options: number[];
  budget: number;
}

function randomRow(rng: RNG): Row {
  const len = rng.int(3, 5);
  const out: Row = [];
  for (let i = 0; i < len; i++) out.push(rng.int(0, TOKENS.length - 1));
  return out;
}

/**
 * Build a machine whose rule can actually be pinned down. A puzzle where two
 * options behave identically on every reachable input is unwinnable, and the
 * player would rightly call it broken.
 */
function makeMachine(rng: RNG, difficulty: number): Machine {
  const optionCount = Math.min(4 + difficulty, 7);
  const budget = Math.max(3, 6 - Math.floor(difficulty / 2));

  for (let attempt = 0; attempt < 200; attempt++) {
    const pool = rng.shuffle([...ALL_RULES.keys()]).slice(0, optionCount);
    const truth = rng.pick(pool);

    // Every other option must be separable from the truth by SOME row.
    let separable = true;
    for (const other of pool) {
      if (other === truth) continue;
      let found = false;
      for (let t = 0; t < 40; t++) {
        const row = randomRow(rng);
        if (
          rowKey(ALL_RULES[truth].apply([...row])) !==
          rowKey(ALL_RULES[other].apply([...row]))
        ) {
          found = true;
          break;
        }
      }
      if (!found) {
        separable = false;
        break;
      }
    }
    if (!separable) continue;

    return { truth, options: rng.shuffle(pool), budget };
  }

  // Fallback that is always separable.
  return {
    truth: 0,
    options: [0, 1, 2, 3],
    budget: 5,
  };
}

// --- game -------------------------------------------------------------------

type Phase = "title" | "playing" | "verdict" | "runOver";

class Guessworks implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private verdictTime = 0;
  private time = 0;

  private rng: RNG;
  private machine: Machine;
  private level = 1;
  private best = 0;

  private input: Row = [];
  private probes: Array<{ input: Row; output: Row }> = [];
  private used = 0;
  /** Candidate count after each probe, for the efficiency readout. */
  private narrowing: number[] = [];

  private running = 0;
  private lastOutput: Row | null = null;
  private choice = -1;
  private correct = false;

  private slotRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private paletteRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private optionRects: Array<{ x: number; y: number; w: number; h: number }> = [];
  private runRect = { x: 0, y: 0, w: 0, h: 0 };

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.rng = new RNG(ctx.rng.int(1, 0xffffff));
    this.best = ctx.store.best("best") ?? 0;
    this.machine = makeMachine(this.rng, 1);
    this.resetInput();
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  private resetInput() {
    this.input = [0, 1, 2];
  }

  restart() {
    this.phase = "playing";
    this.level = 1;
    this.newMachine();
    this.c.report({ status: "playing", score: 0 });
  }

  private newMachine() {
    this.machine = makeMachine(this.rng, this.level);
    this.probes = [];
    this.narrowing = [];
    this.used = 0;
    this.lastOutput = null;
    this.choice = -1;
    this.resetInput();
    this.phase = "playing";
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;
    if (this.running > 0) this.running = Math.max(0, this.running - dt);

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.click(0.12);
        this.restart();
      }
      return;
    }

    if (this.phase === "verdict") {
      this.verdictTime += dt;
      if (this.verdictTime > 0.8 && (input.pointer.justUp || input.confirmPressed)) {
        if (this.correct) {
          this.level++;
          if (this.level > 6) {
            this.phase = "runOver";
            this.verdictTime = 0;
          } else {
            this.newMachine();
          }
        } else {
          this.phase = "playing";
        }
      }
      return;
    }

    if (this.phase === "runOver") {
      this.verdictTime += dt;
      if (this.verdictTime > 0.8 && (input.pointer.justUp || input.confirmPressed)) {
        this.restart();
      }
      return;
    }

    if (this.running > 0) return;
    this.handleTaps();
  }

  private handleTaps() {
    const { input } = this.c;
    if (!input.pointer.justUp || input.dragDistance > 16) return;
    const px = input.pointer.x;
    const py = input.pointer.y;

    const hit = (r: { x: number; y: number; w: number; h: number }) =>
      px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;

    // Cycle a slot's colour.
    for (let i = 0; i < this.slotRects.length; i++) {
      if (!hit(this.slotRects[i])) continue;
      if (i < this.input.length) {
        this.input[i] = (this.input[i] + 1) % TOKENS.length;
        this.c.audio.play({
          wave: "square", freq: 520 + this.input[i] * 90, vol: 0.07,
          attack: 0.001, hold: 0.01, release: 0.05,
        });
      }
      return;
    }

    // Palette: add / remove a slot.
    for (let i = 0; i < this.paletteRects.length; i++) {
      if (!hit(this.paletteRects[i])) continue;
      if (i === 0 && this.input.length < 6) {
        this.input.push(this.rng.int(0, TOKENS.length - 1));
        this.c.audio.click(0.08);
      } else if (i === 1 && this.input.length > 2) {
        this.input.pop();
        this.c.audio.click(0.08);
      }
      return;
    }

    if (hit(this.runRect) && this.used < this.machine.budget) {
      this.runExperiment();
      return;
    }

    for (let i = 0; i < this.optionRects.length; i++) {
      if (!hit(this.optionRects[i])) continue;
      this.commit(this.machine.options[i]);
      return;
    }
  }

  private runExperiment() {
    const { audio, fx } = this.c;
    const inputCopy = [...this.input];
    const out = ALL_RULES[this.machine.truth].apply(inputCopy);
    this.lastOutput = out;
    this.probes.push({ input: [...this.input], output: out });
    this.used++;
    this.running = 0.6;

    const remaining = candidatesAfter(this.machine.options, this.probes).length;
    this.narrowing.push(remaining);

    // Clockwork: one blip per stage, so identical rules always sound identical.
    for (let i = 0; i < 3; i++) {
      audio.play({
        wave: "square", freq: 300 + i * 140, vol: 0.06,
        attack: 0.001, hold: 0.012, release: 0.05, delay: i * 0.09,
        filter: 2200,
      });
    }
    fx.shake(3, 8);
  }

  private commit(ruleIndex: number) {
    const { audio, fx } = this.c;
    this.choice = ruleIndex;
    this.correct = ruleIndex === this.machine.truth;
    this.phase = "verdict";
    this.verdictTime = 0;

    if (this.correct) {
      fx.flash(GOOD, 0.09);
      [0, 4, 7, 12].forEach((s, i) =>
        audio.play({
          wave: "triangle", freq: 330 * Math.pow(2, s / 12),
          vol: 0.12, attack: 0.004, hold: 0.05, release: 0.4, delay: i * 0.055,
        }),
      );
      if (this.c.store.recordBest("best", this.level)) this.best = this.level;
      this.c.report({ score: this.level });
    } else {
      fx.shake(8, 6);
      audio.play({
        wave: "sawtooth", freq: 200, freqTo: 120, glide: 0.25,
        vol: 0.14, attack: 0.004, hold: 0.05, release: 0.3, filter: 1000,
      });
      // A wrong answer costs an experiment rather than ending the run.
      this.used = Math.min(this.machine.budget, this.used + 1);
    }
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;

    ctx.fillStyle = BLUEPRINT;
    ctx.fillRect(0, 0, this.w, this.h);
    const g = ctx.createRadialGradient(
      this.w / 2, this.h * 0.4, 0,
      this.w / 2, this.h * 0.4, Math.max(this.w, this.h) * 0.8,
    );
    g.addColorStop(0, BLUEPRINT);
    g.addColorStop(1, BLUEPRINT_2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawGrid(ctx);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);
    if (this.phase !== "title") this.drawMachine(ctx);
    fx.drawParticles(ctx);
    fx.popCamera(ctx);

    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "verdict") this.drawVerdict(ctx);
    if (this.phase === "runOver") this.drawRunOver(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawGrid(ctx: CanvasRenderingContext2D) {
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    const step = 28;
    ctx.beginPath();
    for (let x = 0; x < this.w; x += step) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, this.h);
    }
    for (let y = 0; y < this.h; y += step) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.w, Math.round(y) + 0.5);
    }
    ctx.stroke();
  }

  private drawToken(
    ctx: CanvasRenderingContext2D,
    x: number, y: number, size: number, value: number,
    dim = false,
  ) {
    ctx.save();
    ctx.globalAlpha = dim ? 0.4 : 1;
    ctx.fillStyle = TOKENS[value];
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, 5);
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "rgba(8,32,47,0.55)";
    ctx.stroke();
    ctx.restore();
  }

  private drawMachine(ctx: CanvasRenderingContext2D) {
    const cx = this.w / 2;
    const size = Math.min(34, this.w * 0.06);
    const gap = 8;
    const topY = this.h * 0.16;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // --- header
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = DRAFT_DIM;
    ctx.fillText(`MACHINE ${this.level} / 6`, cx, topY - 34);
    ctx.fillStyle =
      this.used >= this.machine.budget ? WRONG : DRAFT_DIM;
    ctx.fillText(
      `EXPERIMENTS ${this.used} / ${this.machine.budget}`,
      cx,
      topY - 16,
    );

    // --- input row
    this.slotRects = [];
    const rowW = this.input.length * size + (this.input.length - 1) * gap;
    let x = cx - rowW / 2;
    for (let i = 0; i < this.input.length; i++) {
      this.drawToken(ctx, x, topY, size, this.input[i]);
      this.slotRects.push({ x, y: topY, w: size, h: size });
      x += size + gap;
    }

    ctx.font = monoFont(9.5, 500);
    ctx.fillStyle = DRAFT_DIM;
    ctx.fillText("TAP A TOKEN TO CHANGE IT", cx, topY + size + 16);

    // --- add / remove
    this.paletteRects = [];
    const pw = 30;
    const py = topY + size + 30;
    const labels = ["+", "−"];
    for (let i = 0; i < 2; i++) {
      const px = cx + (i === 0 ? -pw - 6 : 6);
      ctx.strokeStyle = DRAFT_DIM;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(px, py, pw, 26, 4);
      ctx.stroke();
      ctx.font = monoFont(15, 700);
      ctx.fillStyle = DRAFT;
      ctx.fillText(labels[i], px + pw / 2, py + 14);
      this.paletteRects.push({ x: px, y: py, w: pw, h: 26 });
    }

    // --- machine body
    const bodyY = py + 46;
    const bodyH = 62;
    const bodyW = Math.min(this.w * 0.62, 380);
    const bodyX = cx - bodyW / 2;

    ctx.strokeStyle = DRAFT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(bodyX, bodyY, bodyW, bodyH, 6);
    ctx.stroke();

    // Stage lights animate while running, without revealing the rule.
    const stages = 3;
    for (let i = 0; i < stages; i++) {
      const sx = bodyX + bodyW * ((i + 0.5) / stages);
      const active =
        this.running > 0 && this.running < 0.6 - i * 0.12 && this.running > 0.6 - (i + 1) * 0.16;
      ctx.beginPath();
      ctx.arc(sx, bodyY + bodyH / 2, 9, 0, TAU);
      ctx.fillStyle = active ? DRAFT : "rgba(201,228,245,0.12)";
      ctx.fill();
      ctx.strokeStyle = DRAFT_DIM;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (i < stages - 1) {
        ctx.beginPath();
        ctx.moveTo(sx + 12, bodyY + bodyH / 2);
        ctx.lineTo(bodyX + bodyW * ((i + 1.5) / stages) - 12, bodyY + bodyH / 2);
        ctx.strokeStyle = DRAFT_DIM;
        ctx.stroke();
      }
    }

    ctx.font = monoFont(10, 600);
    ctx.fillStyle = DRAFT_DIM;
    ctx.fillText("UNKNOWN TRANSFORM", cx, bodyY + bodyH + 14);

    // --- run button
    const rw = Math.min(150, this.w * 0.34);
    const rx = cx - rw / 2;
    const ry = bodyY + bodyH + 28;
    const canRun = this.used < this.machine.budget;
    ctx.beginPath();
    ctx.roundRect(rx, ry, rw, 30, 5);
    ctx.fillStyle = canRun ? DRAFT : "rgba(201,228,245,0.12)";
    ctx.fill();
    ctx.font = monoFont(11.5, 700);
    ctx.fillStyle = canRun ? BLUEPRINT : DRAFT_DIM;
    ctx.fillText(canRun ? "RUN" : "NO BUDGET LEFT", cx, ry + 15);
    this.runRect = { x: rx, y: ry, w: rw, h: 30 };

    // --- last output
    const outY = ry + 46;
    if (this.lastOutput) {
      const ow = this.lastOutput.length * size + Math.max(0, this.lastOutput.length - 1) * gap;
      let ox = cx - ow / 2;
      for (const v of this.lastOutput) {
        this.drawToken(ctx, ox, outY, size, v);
        ox += size + gap;
      }
      if (this.lastOutput.length === 0) {
        ctx.font = monoFont(11, 600);
        ctx.fillStyle = DRAFT_DIM;
        ctx.fillText("( EMPTY )", cx, outY + size / 2);
      }
    } else {
      ctx.font = monoFont(10, 500);
      ctx.fillStyle = DRAFT_DIM;
      ctx.fillText("RUN IT TO SEE WHAT COMES OUT", cx, outY + size / 2);
    }

    // --- log of previous probes
    let logY = outY + size + 22;
    ctx.font = monoFont(9, 500);
    ctx.textAlign = "center";
    for (let i = Math.max(0, this.probes.length - 4); i < this.probes.length; i++) {
      const p = this.probes[i];
      ctx.fillStyle = "rgba(201,228,245,0.42)";
      ctx.fillText(
        `${p.input.map((v) => TOKEN_NAMES[v][0]).join("")}  →  ${
          p.output.length ? p.output.map((v) => TOKEN_NAMES[v][0]).join("") : "∅"
        }   ·   ${this.narrowing[i]} LEFT`,
        cx,
        logY,
      );
      logY += 13;
    }

    // --- options
    this.optionRects = [];
    const optY = Math.max(logY + 12, this.h * 0.7);
    const optW = Math.min(this.w * 0.86, 520);
    const optH = 24;
    for (let i = 0; i < this.machine.options.length; i++) {
      const oy = optY + i * (optH + 5);
      if (oy + optH > this.h - 8) break;
      const ox = cx - optW / 2;
      ctx.beginPath();
      ctx.roundRect(ox, oy, optW, optH, 4);
      ctx.strokeStyle = DRAFT_DIM;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.font = monoFont(10.5, 600);
      ctx.fillStyle = DRAFT;
      ctx.textAlign = "left";
      ctx.fillText(ALL_RULES[this.machine.options[i]].label, ox + 12, oy + optH / 2);
      ctx.textAlign = "center";
      this.optionRects.push({ x: ox, y: oy, w: optW, h: optH });
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;
    ctx.fillStyle = "rgba(8,32,47,0.86)";
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(this.w * 0.13, 74);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = DRAFT;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("GUESSWORKS", cx, this.h * 0.28);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(201,228,245,0.65)";
    ctx.fillText("A MACHINE WITH A HIDDEN RULE.", cx, this.h * 0.28 + size * 0.6);
    ctx.fillStyle = "rgba(201,228,245,0.42)";
    ctx.fillText("FEED IT. WATCH. NAME THE RULE.", cx, this.h * 0.28 + size * 0.6 + 20);

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(201,228,245,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.82);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(201,228,245,0.34)";
      ctx.fillText(`MACHINES CRACKED — ${this.best}`, cx, this.h * 0.82 + 24);
    }
  }

  private drawVerdict(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.verdictTime / 0.5));
    const cx = this.w / 2;
    ctx.fillStyle = `rgba(8,32,47,${0.88 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 56), 800);
    ctx.fillStyle = this.correct ? GOOD : WRONG;
    ctx.fillText(this.correct ? "SOLVED" : "NOT IT", cx, this.h * 0.3);

    ctx.font = monoFont(11, 600);
    ctx.fillStyle = DRAFT;
    ctx.fillText(
      this.correct
        ? ALL_RULES[this.machine.truth].label
        : `YOU SAID: ${ALL_RULES[this.choice].label}`,
      cx,
      this.h * 0.3 + 44,
    );

    if (this.correct) {
      const total = this.machine.options.length;
      const finalLeft = this.narrowing.length
        ? this.narrowing[this.narrowing.length - 1]
        : total;
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = DRAFT_DIM;
      ctx.fillText(
        `${this.used} EXPERIMENTS  ·  ${total} CANDIDATES NARROWED TO ${finalLeft}`,
        cx,
        this.h * 0.3 + 70,
      );
      // Show the narrowing curve — the actual skill being measured.
      const bw = Math.min(this.w * 0.6, 320);
      const bx = cx - bw / 2;
      const by = this.h * 0.3 + 92;
      for (let i = 0; i < this.narrowing.length; i++) {
        const k = this.narrowing[i] / total;
        const segW = bw / Math.max(1, this.narrowing.length);
        ctx.fillStyle = lerp(0, 1, 1 - k) > 0.6 ? GOOD : DRAFT_DIM;
        ctx.fillRect(bx + i * segW + 1, by, segW - 2, Math.max(2, 18 * k));
      }
    } else {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = DRAFT_DIM;
      ctx.fillText("THAT COST YOU AN EXPERIMENT", cx, this.h * 0.3 + 70);
    }

    if (this.verdictTime > 0.8) {
      const blink = 0.5 + Math.sin(this.verdictTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(201,228,245,${blink})`;
      ctx.fillText(
        this.correct ? "NEXT MACHINE" : "KEEP TESTING",
        cx,
        this.h * 0.8,
      );
    }
  }

  private drawRunOver(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.verdictTime / 0.6));
    const cx = this.w / 2;
    ctx.fillStyle = `rgba(8,32,47,${0.92 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 60), 800);
    ctx.fillStyle = GOOD;
    ctx.fillText("ALL SIX CRACKED", cx, this.h * 0.4);
    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(201,228,245,${0.6 * ease})`;
    ctx.fillText("THE WHOLE WORKSHOP IS YOURS", cx, this.h * 0.4 + 44);
    if (this.verdictTime > 0.8) {
      const blink = 0.5 + Math.sin(this.verdictTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(201,228,245,${blink})`;
      ctx.fillText("AGAIN", cx, this.h * 0.78);
    }
  }
}

const factory: GameFactory = (ctx) => new Guessworks(ctx);
export default factory;
