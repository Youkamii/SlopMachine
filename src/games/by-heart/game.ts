/**
 * BY HEART
 *
 * A procedurally generated glyph is drawn for you, then taken away. You
 * redraw it from memory in one continuous stroke and get scored on how close
 * you came.
 *
 * The scoring is the whole game: it normalises position and size (neither is
 * what you were asked to remember) but deliberately does NOT normalise
 * rotation, because the tilt of a shape is part of the shape. It also accepts
 * strokes drawn backwards, because people do that.
 */

import { monoFont, uiFont } from "@/engine/draw";
import {
  TAU,
  clamp,
  clamp01,
  dist,
  easeOutCubic,
  easeOutQuart,
  lerp,
} from "@/engine/math";
import type { RNG } from "@/engine/rng";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const BG = "#17110c";
const BG_LIFT = "#241a12";
const CREAM = "#f2e7d0";
const CREAM_DIM = "rgba(242,231,208,0.28)";
const GOLD = "#e8a33d";
const MISS = "#e0532f";

// --- tuning -----------------------------------------------------------------

const ROUNDS = 5;
const SAMPLES = 64;
/** Seconds the glyph is drawn for, then held, then hidden. */
const DRAW_IN = 1.05;
const HOLD = 1.15;
const GRADE_TIME = 2.6;
/** Normalised distance at which a stroke scores zero. */
const MISS_DISTANCE = 0.62;

interface Pt {
  x: number;
  y: number;
}

type Phase = "title" | "show" | "draw" | "grade" | "summary";

// --- glyph generation -------------------------------------------------------

/**
 * A constrained random walk on a 5x5 lattice, smoothed into a curve.
 * Constraints exist so the result reads as a *character* rather than a
 * scribble: no immediate backtracking, no repeated node, and a bias against
 * repeating the same direction twice in a row.
 */
function generateGlyph(rng: RNG, segments: number): Pt[] {
  const GRID = 5;
  const nodes: Pt[] = [];
  const visited = new Set<string>();

  let cx = rng.int(0, GRID - 1);
  let cy = rng.int(0, GRID - 1);
  nodes.push({ x: cx, y: cy });
  visited.add(`${cx},${cy}`);

  let lastDx = 0;
  let lastDy = 0;

  for (let i = 0; i < segments; i++) {
    const options: Array<{ x: number; y: number; dx: number; dy: number }> = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        if (dx === 0 && dy === 0) continue;
        // Only straight or 45-degree moves — arbitrary angles look like noise.
        if (dx !== 0 && dy !== 0 && Math.abs(dx) !== Math.abs(dy)) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= GRID || ny >= GRID) continue;
        if (visited.has(`${nx},${ny}`)) continue;
        // No immediate reversal: it would draw over the line just made.
        if (dx === -lastDx && dy === -lastDy) continue;
        options.push({ x: nx, y: ny, dx, dy });
      }
    }
    if (options.length === 0) break;

    const weights = options.map((o) => {
      let w = 1;
      // Prefer a change of direction so the glyph has corners to remember.
      if (o.dx === lastDx && o.dy === lastDy) w *= 0.35;
      // Prefer shorter hops; long jumps make the shape sparse.
      const len = Math.max(Math.abs(o.dx), Math.abs(o.dy));
      w *= len === 1 ? 1.6 : 0.7;
      return w;
    });

    const chosen = rng.pickWeighted(options, weights);
    cx = chosen.x;
    cy = chosen.y;
    lastDx = chosen.dx;
    lastDy = chosen.dy;
    nodes.push({ x: cx, y: cy });
    visited.add(`${cx},${cy}`);
  }

  // Normalise the lattice coordinates into a -0.5..0.5 box.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const span = Math.max(spanX, spanY);
  const unit: Pt[] = nodes.map((n) => ({
    x: (n.x - (minX + maxX) / 2) / span,
    y: (n.y - (minY + maxY) / 2) / span,
  }));

  return smooth(unit);
}

/** Catmull-Rom through the lattice points, so corners round off naturally. */
function smooth(pts: Pt[], perSegment = 12): Pt[] {
  if (pts.length < 3) return pts.slice();
  const out: Pt[] = [];
  const get = (i: number) => pts[clamp(i, 0, pts.length - 1)];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = get(i - 1);
    const p1 = get(i);
    const p2 = get(i + 1);
    const p3 = get(i + 2);
    for (let s = 0; s < perSegment; s++) {
      const t = s / perSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
        y: 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// --- shape comparison -------------------------------------------------------

function pathLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y);
  return len;
}

/** Even arc-length resampling — the basis of every stroke comparison. */
function resample(pts: Pt[], n: number): Pt[] {
  if (pts.length < 2) return new Array(n).fill(null).map(() => ({ ...pts[0] }));
  const total = pathLength(pts);
  if (total === 0) return new Array(n).fill(null).map(() => ({ ...pts[0] }));
  const step = total / (n - 1);
  const out: Pt[] = [{ ...pts[0] }];
  let acc = 0;
  let prev = pts[0];

  for (let i = 1; i < pts.length; ) {
    const d = dist(prev.x, prev.y, pts[i].x, pts[i].y);
    if (acc + d >= step) {
      const t = (step - acc) / d;
      const next = {
        x: lerp(prev.x, pts[i].x, t),
        y: lerp(prev.y, pts[i].y, t),
      };
      out.push(next);
      prev = next;
      acc = 0;
      if (out.length === n) break;
    } else {
      acc += d;
      prev = pts[i];
      i++;
    }
  }
  while (out.length < n) out.push({ ...pts[pts.length - 1] });
  return out;
}

/** Translate to centroid and scale to unit RMS radius. Rotation untouched. */
function normalise(pts: Pt[]): Pt[] {
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= pts.length;
  my /= pts.length;

  let rms = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    rms += dx * dx + dy * dy;
  }
  rms = Math.sqrt(rms / pts.length) || 1;

  return pts.map((p) => ({ x: (p.x - mx) / rms, y: (p.y - my) / rms }));
}

interface Grade {
  score: number;
  /** Per-sample error, 0..1, for painting where the points were lost. */
  errors: number[];
  /** True when the player's stroke matched better read backwards. */
  reversed: boolean;
}

function grade(target: Pt[], attempt: Pt[]): Grade {
  const a = normalise(resample(target, SAMPLES));
  const bFwd = normalise(resample(attempt, SAMPLES));
  const bRev = bFwd.slice().reverse();

  const measure = (b: Pt[]) => {
    const errors: number[] = [];
    let sum = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const d = dist(a[i].x, a[i].y, b[i].x, b[i].y);
      errors.push(d);
      sum += d;
    }
    return { mean: sum / SAMPLES, errors };
  };

  const fwd = measure(bFwd);
  const rev = measure(bRev);
  const best = rev.mean < fwd.mean ? rev : fwd;

  const score = Math.round(
    clamp01(1 - best.mean / MISS_DISTANCE) * 100,
  );
  return {
    score,
    errors: best.errors.map((e) => clamp01(e / MISS_DISTANCE)),
    reversed: best === rev,
  };
}

// --- game -------------------------------------------------------------------

class ByHeart implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private phase: Phase = "title";
  private t = 0;
  private titleTime = 0;

  private round = 0;
  private glyph: Pt[] = [];
  private stroke: Pt[] = [];
  private drawing = false;
  private result: Grade | null = null;
  private scores: number[] = [];
  private total = 0;
  private best = 0;

  /** Screen-space transform for the glyph box. */
  private boxX = 0;
  private boxY = 0;
  private boxSize = 0;

  private titleGlyph: Pt[] = [];

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.titleGlyph = generateGlyph(ctx.rng, 5);
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.boxSize = Math.min(w * 0.62, h * 0.5, 420);
    this.boxX = w / 2;
    this.boxY = h * 0.46;
  }

  private toScreen(p: Pt): Pt {
    return {
      x: this.boxX + p.x * this.boxSize,
      y: this.boxY + p.y * this.boxSize,
    };
  }

  restart() {
    this.phase = "show";
    this.t = 0;
    this.round = 0;
    this.scores.length = 0;
    this.total = 0;
    this.result = null;
    this.stroke.length = 0;
    this.drawing = false;
    this.nextGlyph();
    this.c.report({ status: "playing", score: 0 });
  }

  private nextGlyph() {
    const complexity = 3 + this.round;
    this.glyph = generateGlyph(this.c.rng, complexity);
    this.stroke.length = 0;
    this.result = null;
    this.t = 0;
    this.phase = "show";
    this.c.audio.play({
      wave: "sine", freq: 523, vol: 0.12,
      attack: 0.006, hold: 0.06, release: 0.7, filter: 2400,
    });
    this.c.audio.play({
      wave: "sine", freq: 784, vol: 0.07,
      attack: 0.01, hold: 0.05, release: 0.9, delay: 0.03,
    });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.t += dt;

    switch (this.phase) {
      case "title": {
        this.titleTime += dt;
        if (input.pointer.justUp && this.titleTime > 0.3) {
          this.c.audio.play({
            wave: "triangle", freq: 330, freqTo: 660, glide: 0.2,
            vol: 0.18, attack: 0.005, hold: 0.05, release: 0.25,
          });
          this.restart();
        }
        break;
      }

      case "show": {
        if (this.t > DRAW_IN + HOLD) {
          this.phase = "draw";
          this.t = 0;
          this.c.audio.play({
            wave: "square", freq: 880, vol: 0.08,
            attack: 0.002, hold: 0.02, release: 0.08,
          });
        }
        break;
      }

      case "draw": {
        this.updateDrawing(dt);
        break;
      }

      case "grade": {
        if (this.t > GRADE_TIME || input.pointer.justUp) {
          this.round++;
          if (this.round >= ROUNDS) {
            this.finish();
          } else {
            this.nextGlyph();
          }
        }
        break;
      }

      case "summary": {
        if (input.pointer.justUp && this.t > 0.8) this.restart();
        break;
      }
    }
  }

  private updateDrawing(dt: number) {
    const { input, audio } = this.c;
    const p = input.pointer;

    if (p.justDown) {
      this.drawing = true;
      this.stroke.length = 0;
      this.stroke.push({ x: p.startX, y: p.startY });
    }

    if (this.drawing && p.down) {
      const last = this.stroke[this.stroke.length - 1];
      const d = dist(last.x, last.y, p.x, p.y);
      // Only record meaningful movement — dense duplicates skew resampling.
      if (d > 3) {
        this.stroke.push({ x: p.x, y: p.y });
        // Brush sound is emitted per distance travelled, not per frame, so
        // it tracks the hand rather than the frame rate.
        if (this.stroke.length % 4 === 0) {
          audio.play({
            wave: "noise",
            freq: 700 + Math.min(d, 30) * 26,
            vol: 0.035,
            attack: 0.002,
            hold: 0.008,
            release: 0.05,
            filter: 1400,
            filterType: "bandpass",
            q: 1.4,
          });
        }
      }
    }

    if (this.drawing && !p.down) {
      this.drawing = false;
      if (pathLength(this.stroke) > this.boxSize * 0.25) {
        this.submit();
      } else {
        // Too short to be an attempt — let them try again rather than
        // scoring a stray tap as a failure.
        this.stroke.length = 0;
      }
    }
    void dt;
  }

  private submit() {
    const { fx, audio } = this.c;
    const targetScreen = this.glyph.map((p) => this.toScreen(p));
    const g = grade(targetScreen, this.stroke);
    this.result = g;
    this.scores.push(g.score);
    this.total += g.score;
    this.phase = "grade";
    this.t = 0;

    const great = g.score >= 80;
    const ok = g.score >= 55;

    if (great) {
      fx.flash(GOLD, 0.1);
      fx.shake(4, 7);
      const mid = this.toScreen(this.glyph[Math.floor(this.glyph.length / 2)]);
      fx.emit(mid.x, mid.y, {
        count: 22, speed: 190, life: 0.7, size: 2.2,
        color: [GOLD, CREAM], drag: 2.6, additive: true,
      });
      [0, 4, 7, 12].forEach((s, i) =>
        audio.play({
          wave: "sine", freq: 440 * Math.pow(2, s / 12),
          vol: 0.13, attack: 0.005, hold: 0.06, release: 0.5, delay: i * 0.06,
        }),
      );
    } else if (ok) {
      [0, 5].forEach((s, i) =>
        audio.play({
          wave: "sine", freq: 392 * Math.pow(2, s / 12),
          vol: 0.11, attack: 0.006, hold: 0.05, release: 0.4, delay: i * 0.07,
        }),
      );
    } else {
      audio.play({
        wave: "sine", freq: 294, freqTo: 233, glide: 0.4,
        vol: 0.12, attack: 0.008, hold: 0.08, release: 0.5, filter: 1200,
      });
    }

    this.c.report({ score: this.total });
  }

  private finish() {
    this.phase = "summary";
    this.t = 0;
    const avg = Math.round(this.total / ROUNDS);
    if (this.c.store.recordBest("best", avg)) this.best = avg;
    this.c.store.bump("plays");
    this.c.audio.powerUp(0.18);
    this.c.report({ status: "over", score: avg, best: this.best });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, this.w, this.h);

    const g = ctx.createRadialGradient(
      this.boxX, this.boxY, 0,
      this.boxX, this.boxY, Math.max(this.w, this.h) * 0.62,
    );
    g.addColorStop(0, BG_LIFT);
    g.addColorStop(1, BG);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    switch (this.phase) {
      case "title": this.drawTitle(ctx); break;
      case "show": this.drawShow(ctx); break;
      case "draw": this.drawInput(ctx); break;
      case "grade": this.drawGrade(ctx); break;
      case "summary": this.drawSummary(ctx); break;
    }

    fx.drawParticles(ctx);
    fx.popCamera(ctx);

    if (this.phase !== "title" && this.phase !== "summary") this.drawHud(ctx);
    fx.drawFlash(ctx, this.w, this.h);
  }

  /** Variable-width brush: fast movement thins the line, like a real brush. */
  private strokePath(
    ctx: CanvasRenderingContext2D,
    pts: Pt[],
    upTo: number,
    baseWidth: number,
    color: string,
    alpha = 1,
  ) {
    if (pts.length < 2) return;
    const end = Math.max(1, Math.floor(pts.length * clamp01(upTo)));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < end; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const speed = dist(a.x, a.y, b.x, b.y);
      const taper = clamp(1 - speed / 60, 0.45, 1);
      // Ends taper, like lifting a brush.
      const edge = Math.min(i, end - i) / Math.max(1, end * 0.14);
      ctx.lineWidth = baseWidth * taper * clamp(edge, 0.35, 1);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Flat single-path stroke. The variable-width brush draws one path per
   * segment, which at low alpha leaves visible seams where they overlap —
   * fine for an opaque stroke, wrong for a translucent ghost.
   */
  private ghostPath(
    ctx: CanvasRenderingContext2D,
    pts: Pt[],
    width: number,
    color: string,
  ) {
    if (pts.length < 2) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.stroke();
    ctx.restore();
  }

  private drawGuideBox(ctx: CanvasRenderingContext2D, alpha = 1) {
    const s = this.boxSize * 0.62;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = "rgba(242,231,208,0.09)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 7]);
    ctx.strokeRect(this.boxX - s, this.boxY - s, s * 2, s * 2);
    ctx.restore();
  }

  private drawShow(ctx: CanvasRenderingContext2D) {
    const pts = this.glyph.map((p) => this.toScreen(p));
    const progress = clamp01(this.t / DRAW_IN);
    this.drawGuideBox(ctx, 1);
    this.strokePath(ctx, pts, easeOutCubic(progress), 9, CREAM);

    // A dot rides the tip while it draws — the eye follows motion, and this
    // is what makes the stroke order stick in memory.
    if (progress < 1) {
      const i = Math.floor((pts.length - 1) * easeOutCubic(progress));
      const p = pts[clamp(i, 0, pts.length - 1)];
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, TAU);
      ctx.fillStyle = GOLD;
      ctx.fill();
    }

    const fade = clamp01((this.t - DRAW_IN) / HOLD);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(242,231,208,${0.4 * (1 - fade * 0.5)})`;
    ctx.fillText("MEMORISE", this.boxX, this.boxY - this.boxSize * 0.78);
  }

  private drawInput(ctx: CanvasRenderingContext2D) {
    this.drawGuideBox(ctx, 1);

    if (this.stroke.length > 1) {
      this.strokePath(ctx, this.stroke, 1, 9, CREAM);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = "rgba(242,231,208,0.45)";
    ctx.fillText("DRAW IT", this.boxX, this.boxY - this.boxSize * 0.78);

    if (this.stroke.length === 0) {
      const blink = 0.35 + Math.sin(this.t * 3.4) * 0.22;
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = `rgba(242,231,208,${blink})`;
      ctx.fillText(
        this.c.isTouch ? "ONE STROKE, WITHOUT LIFTING" : "ONE STROKE, HOLD THE BUTTON",
        this.boxX,
        this.boxY + this.boxSize * 0.82,
      );
    }
  }

  private drawGrade(ctx: CanvasRenderingContext2D) {
    const r = this.result;
    if (!r) return;
    const k = clamp01(this.t / 0.6);
    const target = this.glyph.map((p) => this.toScreen(p));

    this.drawGuideBox(ctx, 0.6);

    // The attempt morphs toward the answer. Watching the correction is the
    // moment the shape actually gets learned.
    const from = normaliseToBox(resample(this.stroke, SAMPLES), target);
    const to = resample(target, SAMPLES);
    const morph = easeOutQuart(k);
    const blended: Pt[] = from.map((p, i) => ({
      x: lerp(p.x, to[i].x, morph * 0.72),
      y: lerp(p.y, to[i].y, morph * 0.72),
    }));

    // Ghost of the correct glyph underneath.
    this.ghostPath(ctx, target, 8, CREAM_DIM);

    // The attempt, coloured by where it went wrong.
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 1; i < blended.length; i++) {
      const err = r.errors[i] ?? 0;
      ctx.strokeStyle = err > 0.45 ? MISS : err > 0.22 ? GOLD : CREAM;
      ctx.globalAlpha = 0.92;
      ctx.lineWidth = lerp(8, 5, err);
      ctx.beginPath();
      ctx.moveTo(blended[i - 1].x, blended[i - 1].y);
      ctx.lineTo(blended[i].x, blended[i].y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Anchored to the viewport, not to the glyph box. Hanging it off the top
    // of the box put it at y = -12 on a wide window — off screen entirely.
    const scoreY = Math.min(this.h * 0.82, this.boxY + this.boxSize * 0.72);
    const shown = Math.round(r.score * clamp01(this.t / 0.5));
    ctx.font = monoFont(Math.min(this.w * 0.13, 58), 700);
    ctx.fillStyle = r.score >= 80 ? GOLD : r.score >= 55 ? CREAM : MISS;
    ctx.fillText(`${shown}`, this.boxX, scoreY);

    ctx.font = monoFont(11, 600);
    ctx.fillStyle = "rgba(242,231,208,0.42)";
    const verdict =
      r.score >= 92 ? "BY HEART" :
      r.score >= 80 ? "CLOSE" :
      r.score >= 55 ? "ROUGHLY" : "NOT QUITE";
    ctx.fillText(
      r.reversed ? `${verdict}  ·  DRAWN BACKWARDS` : verdict,
      this.boxX,
      scoreY + 40,
    );
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(242,231,208,0.35)";
    ctx.fillText(`GLYPH ${this.round + 1} / ${ROUNDS}`, pad, pad + 34);

    // Completed rounds as a row of filled marks — a progress bar you can read
    // at a glance without a number.
    const y = pad + 54;
    for (let i = 0; i < ROUNDS; i++) {
      const s = this.scores[i];
      ctx.beginPath();
      ctx.arc(pad + 5 + i * 16, y + 5, 4.5, 0, TAU);
      if (s === undefined) {
        ctx.strokeStyle = "rgba(242,231,208,0.2)";
        ctx.lineWidth = 1.2;
        ctx.stroke();
      } else {
        ctx.fillStyle = s >= 80 ? GOLD : s >= 55 ? CREAM : MISS;
        ctx.fill();
      }
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;

    // The title glyph draws itself, erases, and redraws — the whole loop
    // demonstrated before a word is read.
    const cycle = 4.2;
    const p = (t % cycle) / cycle;
    const pts = this.titleGlyph.map((g) => ({
      x: cx + g.x * this.boxSize * 0.62,
      y: this.h * 0.34 + g.y * this.boxSize * 0.62,
    }));
    const show = p < 0.45 ? easeOutCubic(p / 0.45) : p < 0.6 ? 1 : 0;
    if (show > 0) this.strokePath(ctx, pts, show, 8, CREAM, 0.75);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.13, 74);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = CREAM;
    ctx.letterSpacing = "-0.02em";
    ctx.fillText("BY HEART", cx, this.h * 0.58);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.031), 500);
    ctx.fillStyle = "rgba(242,231,208,0.55)";
    ctx.fillText("A SHAPE APPEARS, THEN LEAVES.", cx, this.h * 0.58 + size * 0.62);
    ctx.fillStyle = "rgba(242,231,208,0.36)";
    ctx.fillText(
      "DRAW IT BACK IN ONE STROKE.",
      cx,
      this.h * 0.58 + size * 0.62 + 20,
    );

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(242,231,208,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.8);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(242,231,208,0.32)";
      ctx.fillText(`BEST AVERAGE ${this.best}`, cx, this.h * 0.8 + 24);
    }
  }

  private drawSummary(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.t / 0.6));
    const cx = this.w / 2;
    const cy = this.h * 0.42;
    const avg = Math.round(this.total / ROUNDS);
    const isBest = avg >= this.best && avg > 0;

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    ctx.font = monoFont(11, 600);
    ctx.fillStyle = `rgba(242,231,208,${0.45 * ease})`;
    ctx.fillText(isBest ? "NEW BEST" : "FIVE GLYPHS", cx, cy - 64);

    const shown = Math.round(avg * clamp01(this.t / 0.55));
    ctx.font = monoFont(Math.min(this.w * 0.16, 78), 700);
    ctx.fillStyle = isBest ? GOLD : CREAM;
    ctx.fillText(`${shown}`, cx, cy);

    ctx.font = monoFont(11, 500);
    ctx.fillStyle = `rgba(242,231,208,${0.4 * ease})`;
    ctx.fillText("AVERAGE", cx, cy + 46);

    // Every round's score, so the run reads as a shape of its own.
    const spacing = 46;
    const startX = cx - (spacing * (ROUNDS - 1)) / 2;
    for (let i = 0; i < ROUNDS; i++) {
      const s = this.scores[i] ?? 0;
      const x = startX + i * spacing;
      const appear = clamp01((this.t - 0.5 - i * 0.09) / 0.3);
      ctx.globalAlpha = appear;
      ctx.font = monoFont(15, 700);
      ctx.fillStyle = s >= 80 ? GOLD : s >= 55 ? CREAM : MISS;
      ctx.fillText(`${s}`, x, cy + 92);
      ctx.globalAlpha = 1;
    }

    if (this.t > 0.9) {
      const blink = 0.5 + Math.sin(this.t * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(242,231,208,${blink})`;
      ctx.fillText(
        this.c.isTouch ? "TAP FOR FIVE MORE" : "CLICK FOR FIVE MORE",
        cx,
        this.h * 0.78,
      );
    }
  }
}

/**
 * Put the attempt into the same normalised frame as the target, then map it
 * back into the target's screen box — so the morph animation compares like
 * with like instead of sliding across the screen.
 */
function normaliseToBox(attempt: Pt[], target: Pt[]): Pt[] {
  const na = normalise(attempt);
  const nt = normalise(resample(target, attempt.length));

  let mx = 0, my = 0;
  for (const p of target) { mx += p.x; my += p.y; }
  mx /= target.length;
  my /= target.length;

  let rms = 0;
  for (const p of target) {
    const dx = p.x - mx;
    const dy = p.y - my;
    rms += dx * dx + dy * dy;
  }
  rms = Math.sqrt(rms / target.length) || 1;

  void nt;
  return na.map((p) => ({ x: p.x * rms + mx, y: p.y * rms + my }));
}

const factory: GameFactory = (ctx) => new ByHeart(ctx);
export default factory;
