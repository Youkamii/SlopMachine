/**
 * TIDEGLASS
 *
 * No goal, no score, no failure. Drag and a reef grows toward your finger.
 *
 * This is the quiet tab in the collection. Everything else here is tension,
 * and a shelf of nothing but tension is exhausting — this one is meant to be
 * left open.
 *
 * The garden's genome lives in the URL hash, so sharing a link regrows the
 * exact same organism for whoever opens it.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp, clamp01, lerp, noise2 } from "@/engine/math";
import { RNG } from "@/engine/rng";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const DEEP = "#03121d";
const MID = "#062c40";
const SHALLOW = "#0a5566";
const FLOOR = "#02090f";
const GLOW = "#7df9ff";

/** Segment budget. Past this, the oldest growth calcifies into a static layer. */
const MAX_SEGMENTS = 2600;
const CALCIFY_BATCH = 420;

interface Node {
  x: number;
  y: number;
  px: number;
  py: number;
  /** Index of parent node, -1 for a root. */
  parent: number;
  /** Distance from the root, drives thickness. */
  depth: number;
  /** 0..1 hue offset within the reef's palette. */
  tint: number;
  /** Bioluminescent node. */
  lumen: number;
  /** Rest length to parent. */
  rest: number;
}

interface Strand {
  nodes: Node[];
  /** Last node index — where growth continues from. */
  tipIndex: number;
  seed: number;
  /** Stops extending once it reaches this. */
  maxNodes: number;
  tint: number;
}

class Tideglass implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private floorY = 0;

  private time = 0;
  private strands: Strand[] = [];
  private segments = 0;

  /** Pre-rendered layer for calcified growth — drawn once, blitted forever. */
  private reefLayer: HTMLCanvasElement | null = null;
  private reefCtx: CanvasRenderingContext2D | null = null;

  private rng: RNG;
  private genome: number;

  private hintFade = 1;
  private growTimer = 0;
  private caustics: number[] = [];

  /** Musical drift: the mode rotates slowly so the ambience never settles. */
  private modeIndex = 0;
  private modeTimer = 0;
  private noteTimer = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    // Genome from the URL hash if present, so a shared link regrows the reef.
    let seed = 0;
    if (typeof window !== "undefined" && window.location.hash.length > 1) {
      const parsed = parseInt(window.location.hash.slice(1), 36);
      if (Number.isFinite(parsed) && parsed > 0) seed = parsed >>> 0;
    }
    if (!seed) seed = ctx.rng.int(1, 0xffffff);
    this.genome = seed;
    this.rng = new RNG(seed);
    ctx.report({ status: "playing", score: 0, label: "TIDEGLASS" });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.floorY = h * 0.94;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = this.reefLayer ?? document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    const rctx = canvas.getContext("2d")!;
    rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    rctx.clearRect(0, 0, w, h);
    this.reefLayer = canvas;
    this.reefCtx = rctx;

    this.caustics = [];
    for (let i = 0; i < 26; i++) this.caustics.push(this.rng.range(0, TAU));

    if (this.strands.length === 0) this.seedReef();
  }

  private seedReef() {
    // Enough roots to read as a reef on first paint. Three strands on an
    // empty screen looks like a bug, not a garden.
    const count = this.rng.int(9, 13);
    for (let i = 0; i < count; i++) {
      const x = this.w * ((i + 0.5) / count) + this.rng.spread(this.w * 0.05);
      this.sprout(x, this.floorY);
    }
  }

  private sprout(x: number, y: number) {
    const tint = this.rng.next();
    const root: Node = {
      x, y, px: x, py: y,
      parent: -1, depth: 0, tint,
      lumen: 0, rest: 0,
    };
    this.strands.push({
      nodes: [root],
      tipIndex: 0,
      seed: this.rng.int(1, 1e6),
      maxNodes: this.rng.int(26, 54),
      tint,
    });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;
    if (this.hintFade > 0 && input.pointer.everMoved) {
      this.hintFade = Math.max(0, this.hintFade - dt * 0.8);
    }

    // Grows continuously whether or not you are pointing at anything — this
    // is an aquarium, and an aquarium that only moves when touched is dead.
    this.growTimer += dt;
    if (this.growTimer > 0.028) {
      this.growTimer = 0;
      this.grow();
    }

    this.simulate(dt);
    this.driftMode(dt);
  }

  /** Every active touch is an attractor; growth reaches for the nearest one. */
  private attractors(): Array<{ x: number; y: number }> {
    const { input } = this.c;
    const out: Array<{ x: number; y: number }> = [];
    if (input.touches.size > 0) {
      for (const t of input.touches.values()) out.push({ x: t.x, y: t.y });
    } else if (input.pointer.down || (!input.isTouch && input.pointer.everMoved)) {
      out.push({ x: input.pointer.x, y: input.pointer.y });
    }
    return out;
  }

  private grow() {
    if (this.segments >= MAX_SEGMENTS) this.calcify();

    const targets = this.attractors();
    let grewAny = false;

    for (const s of this.strands) {
      if (s.nodes.length >= s.maxNodes) continue;
      const tip = s.nodes[s.tipIndex];

      let ax = 0;
      let ay = -1;
      if (targets.length > 0) {
        // Reach for the nearest finger, weighted by proximity.
        let bestD = Infinity;
        let bx = 0;
        let by = 0;
        for (const t of targets) {
          const d = Math.hypot(t.x - tip.x, t.y - tip.y);
          if (d < bestD) {
            bestD = d;
            bx = t.x;
            by = t.y;
          }
        }
        const pull = clamp01(1 - bestD / (Math.min(this.w, this.h) * 0.55));
        const dx = bx - tip.x;
        const dy = by - tip.y;
        const len = Math.hypot(dx, dy) || 1;
        ax = lerp(0, dx / len, pull);
        ay = lerp(-1, dy / len, pull);
      }

      // Wander so growth never looks like a straight line to the cursor,
      // but keep a standing upward bias so strands climb the water column.
      const n = noise2(tip.x * 0.004 + s.seed, tip.y * 0.004);
      ax += n * 0.55;
      ay -= 0.7;
      const len = Math.hypot(ax, ay) || 1;
      const step = 7 + this.rng.range(-1.4, 1.4);

      const nx = tip.x + (ax / len) * step;
      const ny = clamp(tip.y + (ay / len) * step, 12, this.floorY);

      const node: Node = {
        x: nx, y: ny, px: nx, py: ny,
        parent: s.tipIndex,
        depth: tip.depth + 1,
        tint: s.tint,
        lumen: this.rng.bool(0.12) ? 1 : 0,
        rest: step,
      };
      s.nodes.push(node);
      s.tipIndex = s.nodes.length - 1;
      this.segments++;
      grewAny = true;

      if (node.lumen > 0) this.pluck(node.y);

      // Branch often enough that the reef fills out rather than staying a
      // handful of lonely stalks.
      if (s.nodes.length > 6 && this.rng.bool(0.2) && this.strands.length < 60) {
        const from = s.nodes[this.rng.int(2, s.nodes.length - 2)];
        this.sprout(from.x, from.y);
      }
    }

    // Nothing left growing anywhere: put down fresh roots so the reef keeps
    // renewing itself instead of freezing once every strand tops out.
    if (!grewAny && this.strands.length < 60) {
      const t = targets[0];
      const x = t ? t.x + this.rng.spread(60) : this.rng.range(0, this.w);
      this.sprout(clamp(x, 10, this.w - 10), this.floorY);
    }
  }

  /**
   * Bake the oldest strands into a static bitmap and drop their nodes. Old
   * growth stops costing anything, so the reef can keep expanding without the
   * frame time creeping up.
   */
  private calcify() {
    const rctx = this.reefCtx;
    if (!rctx) return;
    let moved = 0;
    while (moved < CALCIFY_BATCH && this.strands.length > 4) {
      const s = this.strands.shift()!;
      this.paintStrand(rctx, s, 0.55);
      moved += s.nodes.length;
      this.segments -= s.nodes.length;
    }
  }

  private simulate(dt: number) {
    const sway = Math.sin(this.time * 0.35) * 0.6;
    for (const s of this.strands) {
      for (let i = 1; i < s.nodes.length; i++) {
        const n = s.nodes[i];
        const p = s.nodes[n.parent];

        // Verlet integration with a slow current.
        const vx = (n.x - n.px) * 0.94;
        const vy = (n.y - n.py) * 0.94;
        n.px = n.x;
        n.py = n.y;
        const drift =
          noise2(n.x * 0.003, n.y * 0.003 + this.time * 0.12) * 8 + sway * 4;
        n.x += vx + drift * dt;
        // Slight buoyancy, not gravity. Kelp is held up by the water; with a
        // downward pull the whole reef collapses into a mat on the floor.
        n.y += vy - 6 * dt;

        // Constraint back to the parent.
        const dx = n.x - p.x;
        const dy = n.y - p.y;
        const d = Math.hypot(dx, dy) || 1;
        const diff = (d - n.rest) / d;
        n.x -= dx * diff * 0.7;
        n.y -= dy * diff * 0.7;
        if (n.y > this.floorY) n.y = this.floorY;
      }
    }
  }

  private driftMode(dt: number) {
    this.modeTimer += dt;
    if (this.modeTimer > 40) {
      this.modeTimer = 0;
      this.modeIndex = (this.modeIndex + 1) % 4;
    }
    this.noteTimer += dt;
  }

  /** A plucked string, pitched by height. Rate-limited so it stays ambient. */
  private pluck(y: number) {
    if (this.noteTimer < 0.22) return;
    this.noteTimer = 0;
    const modes = [
      [0, 2, 4, 7, 9],
      [0, 3, 5, 7, 10],
      [0, 2, 5, 7, 10],
      [0, 2, 3, 7, 8],
    ];
    const scale = modes[this.modeIndex];
    const k = clamp01(1 - y / this.h);
    const idx = Math.floor(k * (scale.length * 2 - 1));
    const semis = scale[idx % scale.length] + Math.floor(idx / scale.length) * 12;
    this.c.audio.play({
      wave: "triangle",
      freq: 196 * Math.pow(2, semis / 12),
      vol: 0.055,
      attack: 0.004,
      hold: 0.03,
      release: 1.6,
      filter: 2200,
    });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, SHALLOW);
    g.addColorStop(0.45, MID);
    g.addColorStop(1, DEEP);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    this.drawLightShafts(ctx);
    this.drawCaustics(ctx);

    if (this.reefLayer) ctx.drawImage(this.reefLayer, 0, 0, this.w, this.h);

    for (const s of this.strands) this.paintStrand(ctx, s, 1);

    this.drawFloor(ctx);
    this.drawHud(ctx);
  }

  private drawLightShafts(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (let i = 0; i < 5; i++) {
      const x = this.w * ((i + 0.5) / 5) + Math.sin(this.time * 0.16 + i) * 40;
      const wdt = this.w * 0.09;
      const g = ctx.createLinearGradient(x, 0, x + wdt * 0.6, this.h);
      g.addColorStop(0, "rgba(160,240,255,0.075)");
      g.addColorStop(1, "rgba(160,240,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - wdt / 2, 0);
      ctx.lineTo(x + wdt / 2, 0);
      ctx.lineTo(x + wdt * 1.5, this.h);
      ctx.lineTo(x + wdt * 0.4, this.h);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawCaustics(ctx: CanvasRenderingContext2D) {
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = "rgba(140,230,255,0.05)";
    ctx.lineWidth = 2;
    for (let i = 0; i < this.caustics.length; i++) {
      const p = this.caustics[i];
      const y = this.floorY - 4 - (i % 5) * 7;
      ctx.beginPath();
      for (let x = 0; x <= this.w; x += 18) {
        const yy =
          y + Math.sin(x * 0.02 + p + this.time * 0.7) * 4 +
          Math.sin(x * 0.007 - this.time * 0.4) * 6;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  private paintStrand(
    ctx: CanvasRenderingContext2D,
    s: Strand,
    alpha: number,
  ) {
    const hue = lerp(150, 210, s.tint);
    ctx.save();
    ctx.lineCap = "round";
    for (let i = 1; i < s.nodes.length; i++) {
      const n = s.nodes[i];
      const p = s.nodes[n.parent];
      const taper = 1 - n.depth / (s.maxNodes + 6);
      ctx.lineWidth = Math.max(0.7, 5.2 * taper);
      ctx.strokeStyle = `hsl(${hue} ${lerp(30, 62, taper)}% ${lerp(24, 46, taper)}% / ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
    }
    ctx.restore();

    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const n of s.nodes) {
      if (n.lumen <= 0) continue;
      const pulse = 0.5 + Math.sin(this.time * 1.6 + n.x * 0.05) * 0.5;
      const r = 6 + pulse * 4;
      const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r);
      g.addColorStop(0, `rgba(125,249,255,${0.55 * alpha})`);
      g.addColorStop(1, "rgba(125,249,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(n.x - r, n.y - r, r * 2, r * 2);
      ctx.beginPath();
      ctx.arc(n.x, n.y, 1.5, 0, TAU);
      ctx.fillStyle = GLOW;
      ctx.fill();
    }
    ctx.restore();
  }

  private drawFloor(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = FLOOR;
    ctx.beginPath();
    ctx.moveTo(0, this.h);
    ctx.lineTo(0, this.floorY);
    for (let x = 0; x <= this.w; x += 24) {
      ctx.lineTo(x, this.floorY + Math.sin(x * 0.012) * 5);
    }
    ctx.lineTo(this.w, this.h);
    ctx.closePath();
    ctx.fill();
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    if (this.hintFade > 0.01) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = uiFont(Math.min(this.w * 0.075, 40), 700);
      ctx.fillStyle = `rgba(220,245,255,${0.5 * this.hintFade})`;
      ctx.fillText("TIDEGLASS", this.w / 2, this.h * 0.36);
      ctx.font = monoFont(11.5, 500);
      ctx.fillStyle = `rgba(220,245,255,${0.4 * this.hintFade})`;
      ctx.fillText(
        this.c.isTouch
          ? "DRAG — EVERY FINGER GROWS SOMETHING"
          : "MOVE THE MOUSE. THERE IS NOTHING TO WIN.",
        this.w / 2,
        this.h * 0.36 + 34,
      );
    }

    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.font = monoFont(9.5, 500);
    ctx.fillStyle = "rgba(220,245,255,0.22)";
    ctx.fillText(
      `GENOME ${this.genome.toString(36).toUpperCase()}`,
      this.w - 16,
      this.h - 12,
    );
  }
}

const factory: GameFactory = (ctx) => new Tideglass(ctx);
export default factory;
