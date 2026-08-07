/**
 * UMBRA
 *
 * You never touch the creature. It walks on its own and burns in sunlight.
 * The only thing you control is the sun — drag it across the sky and every
 * shadow in the level is redrawn at once, which is how you build a path.
 *
 * One axis of input, and the negative space is the level.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { clamp, clamp01, damp, easeOutCubic, lerp } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const SKY_HIGH = "#f8d38a";
const SKY_LOW = "#e2703b";
const SAND = "#d9834a";
const SAND_DARK = "#b45f33";
const SHADE = "#2b1a24";
const BLOCK = "#4a2c33";
const CREATURE = "#f7ecd8";
const BURN = "#ff4d3d";

// --- level model ------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Level {
  /** Occluders, in level units (0..100 wide, 0..56 tall). */
  boxes: Box[];
  /** Ground platforms the creature can stand on. */
  ground: Box[];
  startX: number;
  goalX: number;
  /** Seconds of exposure before death. Higher = more forgiving. */
  stamina: number;
}

const LEVELS: Level[] = [
  {
    ground: [{ x: 0, y: 46, w: 100, h: 10 }],
    boxes: [
      { x: 22, y: 20, w: 9, h: 9 },
      { x: 48, y: 16, w: 9, h: 9 },
      { x: 72, y: 22, w: 9, h: 9 },
    ],
    startX: 6,
    goalX: 94,
    stamina: 2.6,
  },
  {
    ground: [{ x: 0, y: 46, w: 100, h: 10 }],
    boxes: [
      { x: 16, y: 26, w: 7, h: 7 },
      { x: 33, y: 14, w: 7, h: 7 },
      { x: 50, y: 26, w: 7, h: 7 },
      { x: 67, y: 14, w: 7, h: 7 },
      { x: 84, y: 26, w: 7, h: 7 },
    ],
    startX: 5,
    goalX: 95,
    stamina: 2.2,
  },
  {
    ground: [
      { x: 0, y: 46, w: 44, h: 10 },
      { x: 56, y: 46, w: 44, h: 10 },
    ],
    boxes: [
      { x: 20, y: 24, w: 8, h: 12 },
      { x: 44, y: 10, w: 12, h: 6 },
      { x: 70, y: 24, w: 8, h: 12 },
    ],
    startX: 5,
    goalX: 95,
    stamina: 2.0,
  },
  {
    ground: [{ x: 0, y: 46, w: 100, h: 10 }],
    boxes: [
      { x: 12, y: 30, w: 6, h: 6 },
      { x: 26, y: 20, w: 6, h: 6 },
      { x: 40, y: 30, w: 6, h: 6 },
      { x: 54, y: 20, w: 6, h: 6 },
      { x: 68, y: 30, w: 6, h: 6 },
      { x: 82, y: 20, w: 6, h: 6 },
    ],
    startX: 4,
    goalX: 96,
    stamina: 1.8,
  },
];

const LEVEL_W = 100;
const LEVEL_H = 56;

type Phase = "title" | "playing" | "dead" | "won" | "complete";

class Umbra implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private scale = 1;
  private offX = 0;
  private offY = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private endTime = 0;
  private time = 0;

  private levelIndex = 0;
  private level: Level;

  /** Sun angle, 0 = left horizon, 1 = right horizon. */
  private sunT = 0.5;
  private sunTarget = 0.5;

  private cx = 0;
  private cy = 0;
  private vy = 0;
  private exposure = 0;
  private lit = false;
  private grounded = false;

  private best = 0;
  private warnTick = 0;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.level = LEVELS[0];
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    // Width-first, and anchored so the ground sits near the bottom of the
    // viewport. Centring the level box left the ground floating mid-screen
    // with dead space under it.
    this.scale = Math.min(w / LEVEL_W, (h * 0.9) / LEVEL_H);
    this.offX = (w - LEVEL_W * this.scale) / 2;
    this.offY = h - LEVEL_H * this.scale - h * 0.04;
  }

  private sx(x: number) {
    return this.offX + x * this.scale;
  }
  private sy(y: number) {
    return this.offY + y * this.scale;
  }

  /** Sun position in level units — an arc well above the play area. */
  private get sun() {
    const a = lerp(Math.PI * 1.08, Math.PI * 1.92, this.sunT);
    return {
      x: LEVEL_W / 2 + Math.cos(a) * LEVEL_W * 0.85,
      y: LEVEL_H * 0.52 + Math.sin(a) * LEVEL_H * 1.5,
    };
  }

  restart() {
    this.phase = "playing";
    this.levelIndex = 0;
    this.loadLevel(0);
    this.c.report({ status: "playing", score: 0 });
  }

  private loadLevel(i: number) {
    this.levelIndex = i % LEVELS.length;
    this.level = LEVELS[this.levelIndex];
    this.cx = this.level.startX;
    this.cy = this.level.ground[0].y - 3;
    this.vy = 0;
    this.exposure = 0;
    this.sunT = 0.5;
    this.sunTarget = 0.5;
    this.phase = "playing";
  }

  // --- geometry -------------------------------------------------------------

  /**
   * Is a level-space point in shadow? Cast a ray to the sun and test every
   * occluder. With a handful of boxes this is cheaper and far more exact than
   * building shadow polygons and doing point-in-polygon.
   */
  private inShadow(px: number, py: number): boolean {
    const s = this.sun;
    for (const b of this.level.boxes) {
      if (this.segmentHitsBox(px, py, s.x, s.y, b)) return true;
    }
    return false;
  }

  private segmentHitsBox(
    x0: number, y0: number, x1: number, y1: number, b: Box,
  ): boolean {
    // Slab method.
    const dx = x1 - x0;
    const dy = y1 - y0;
    let tmin = 0;
    let tmax = 1;

    for (let axis = 0; axis < 2; axis++) {
      const p = axis === 0 ? x0 : y0;
      const d = axis === 0 ? dx : dy;
      const lo = axis === 0 ? b.x : b.y;
      const hi = axis === 0 ? b.x + b.w : b.y + b.h;
      if (Math.abs(d) < 1e-6) {
        if (p < lo || p > hi) return false;
        continue;
      }
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) {
        const tmp = t1;
        t1 = t2;
        t2 = tmp;
      }
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return false;
    }
    return true;
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "sine", freq: 180, freqTo: 300, glide: 0.3,
          vol: 0.14, attack: 0.02, hold: 0.1, release: 0.4,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "dead" || this.phase === "won" || this.phase === "complete") {
      this.endTime += dt;
      if (this.endTime > 0.6 && (input.pointer.justUp || input.confirmPressed)) {
        if (this.phase === "won") {
          if (this.levelIndex + 1 >= LEVELS.length) {
            this.phase = "complete";
            this.endTime = 0;
          } else {
            this.loadLevel(this.levelIndex + 1);
          }
        } else if (this.phase === "complete") {
          this.restart();
        } else {
          this.loadLevel(this.levelIndex);
        }
      }
      return;
    }

    this.moveSun(dt);
    this.stepCreature(dt);
  }

  private moveSun(dt: number) {
    const { input } = this.c;
    // A single axis, deliberately. Two would make this a different game.
    if (input.isTouch) {
      if (input.pointer.down) {
        this.sunTarget += input.pointer.dx / (this.w * 0.7);
      }
    } else if (input.pointer.everMoved) {
      this.sunTarget = clamp01(input.pointer.x / this.w);
    }
    const kx = input.axisX;
    if (kx !== 0) this.sunTarget += kx * 0.45 * dt;
    this.sunTarget = clamp01(this.sunTarget);
    // The sun has mass. Instant light makes the shadows feel like a cursor.
    this.sunT = damp(this.sunT, this.sunTarget, 0.22, dt);
  }

  private stepCreature(dt: number) {
    const { fx, audio } = this.c;
    const SPEED = 7.2;
    const GRAV = 78;

    this.cx += SPEED * dt;

    this.vy += GRAV * dt;
    this.cy += this.vy * dt;

    // Land on any ground slab under the creature.
    this.grounded = false;
    for (const g of this.level.ground) {
      if (this.cx < g.x - 1 || this.cx > g.x + g.w + 1) continue;
      const top = g.y - 3;
      if (this.cy >= top && this.vy >= 0) {
        this.cy = top;
        this.vy = 0;
        this.grounded = true;
      }
    }

    // Fell into a gap.
    if (this.cy > LEVEL_H + 8) {
      this.die("FELL");
      return;
    }

    const shaded = this.inShadow(this.cx, this.cy - 1.5);
    this.lit = !shaded;

    if (this.lit) {
      this.exposure += dt;
      const step = 0.34;
      if (Math.floor(this.exposure / step) > Math.floor(this.warnTick / step)) {
        audio.play({
          wave: "square",
          freq: lerp(520, 980, clamp01(this.exposure / this.level.stamina)),
          vol: 0.08, attack: 0.001, hold: 0.008, release: 0.04,
        });
        fx.emit(this.sx(this.cx), this.sy(this.cy - 1.5), {
          count: 2, speed: 40, life: 0.4, size: 1.6,
          color: [BURN, "#ffd0a0"], drag: 2, additive: true,
        });
      }
      this.warnTick = this.exposure;
    } else {
      // Recovers in shade, but slower than it burns.
      this.exposure = Math.max(0, this.exposure - dt * 0.8);
      this.warnTick = this.exposure;
    }

    if (this.exposure >= this.level.stamina) {
      this.die("BURNED");
      return;
    }

    if (this.cx >= this.level.goalX) this.win();
  }

  private die(_why: string) {
    const { fx, audio } = this.c;
    this.phase = "dead";
    this.endTime = 0;
    fx.shake(12, 5);
    fx.flash(BURN, 0.14);
    fx.emit(this.sx(this.cx), this.sy(this.cy - 1.5), {
      count: 26, speed: 190, life: 0.7, lifeVar: 0.5, size: 2.6,
      color: [BURN, "#ffd0a0", CREATURE], drag: 2.4, additive: true,
    });
    audio.play({
      wave: "noise", freq: 1400, freqTo: 220, vol: 0.22,
      attack: 0.004, hold: 0.08, release: 0.4, filter: 2600, filterTo: 400,
    });
  }

  private win() {
    const { fx, audio } = this.c;
    this.phase = "won";
    this.endTime = 0;
    fx.flash("#ffffff", 0.1);
    fx.emit(this.sx(this.cx), this.sy(this.cy - 1.5), {
      count: 22, speed: 140, life: 0.8, size: 2.4,
      color: [CREATURE, SKY_HIGH], drag: 2.4, additive: true,
    });
    [0, 4, 9].forEach((s, i) =>
      audio.play({
        wave: "triangle", freq: 392 * Math.pow(2, s / 12),
        vol: 0.13, attack: 0.006, hold: 0.06, release: 0.5, delay: i * 0.07,
      }),
    );
    const solved = this.levelIndex + 1;
    if (this.c.store.recordBest("best", solved)) this.best = solved;
    this.c.report({ score: solved });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;

    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, SKY_HIGH);
    g.addColorStop(1, SKY_LOW);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    if (this.phase !== "title") {
      this.drawSun(ctx);
      this.drawShadows(ctx);
      this.drawGround(ctx);
      this.drawBoxes(ctx);
      this.drawGoal(ctx);
      this.drawCreature(ctx);
    } else {
      this.drawTitleScene(ctx);
    }
    fx.drawParticles(ctx);
    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "dead") this.drawBanner(ctx, "BURNED", BURN);
    if (this.phase === "won") this.drawBanner(ctx, "SHADE FOUND", "#ffffff");
    if (this.phase === "complete") this.drawComplete(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawSun(ctx: CanvasRenderingContext2D) {
    const s = this.sun;
    const x = this.sx(s.x);
    const y = this.sy(s.y);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const r = 70 * (this.scale / 8);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r * 4);
    g.addColorStop(0, "rgba(255,250,220,0.9)");
    g.addColorStop(0.3, "rgba(255,220,150,0.4)");
    g.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = g;
    ctx.fillRect(x - r * 4, y - r * 4, r * 8, r * 8);
    ctx.restore();

    ctx.beginPath();
    ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = "#fffbe8";
    ctx.fill();
  }

  /** Extrude each occluder's silhouette away from the sun. */
  private drawShadows(ctx: CanvasRenderingContext2D) {
    const s = this.sun;
    const FAR = 400;
    ctx.save();
    // Clip to the playfield. Extruded shadow polygons run hundreds of units
    // past the geometry, and without this they spill below the ground and
    // off the bottom of the screen as loose black wedges.
    ctx.beginPath();
    ctx.rect(
      this.sx(0),
      this.sy(0),
      LEVEL_W * this.scale,
      (this.level.ground[0]?.y ?? LEVEL_H) * this.scale,
    );
    ctx.clip();
    ctx.fillStyle = SHADE;
    ctx.globalAlpha = 0.9;

    for (const b of this.level.boxes) {
      const corners = [
        { x: b.x, y: b.y },
        { x: b.x + b.w, y: b.y },
        { x: b.x + b.w, y: b.y + b.h },
        { x: b.x, y: b.y + b.h },
      ];
      for (let i = 0; i < 4; i++) {
        const a = corners[i];
        const c = corners[(i + 1) % 4];
        // Only edges facing away from the light cast.
        const ex = c.x - a.x;
        const ey = c.y - a.y;
        const nx = ey;
        const ny = -ex;
        const lx = s.x - a.x;
        const ly = s.y - a.y;
        if (nx * lx + ny * ly > 0) continue;

        const a2 = this.project(a, s, FAR);
        const c2 = this.project(c, s, FAR);
        ctx.beginPath();
        ctx.moveTo(this.sx(a.x), this.sy(a.y));
        ctx.lineTo(this.sx(c.x), this.sy(c.y));
        ctx.lineTo(this.sx(c2.x), this.sy(c2.y));
        ctx.lineTo(this.sx(a2.x), this.sy(a2.y));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();
  }

  private project(p: { x: number; y: number }, s: { x: number; y: number }, far: number) {
    const dx = p.x - s.x;
    const dy = p.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * far, y: p.y + (dy / len) * far };
  }

  private drawGround(ctx: CanvasRenderingContext2D) {
    for (const g of this.level.ground) {
      ctx.fillStyle = SAND;
      ctx.fillRect(this.sx(g.x), this.sy(g.y), g.w * this.scale, g.h * this.scale);
      ctx.fillStyle = SAND_DARK;
      ctx.fillRect(this.sx(g.x), this.sy(g.y), g.w * this.scale, 2 * this.scale);
    }
  }

  private drawBoxes(ctx: CanvasRenderingContext2D) {
    for (const b of this.level.boxes) {
      ctx.fillStyle = BLOCK;
      ctx.fillRect(this.sx(b.x), this.sy(b.y), b.w * this.scale, b.h * this.scale);
    }
  }

  private drawGoal(ctx: CanvasRenderingContext2D) {
    const x = this.sx(this.level.goalX);
    const gy = this.level.ground[this.level.ground.length - 1].y;
    const y = this.sy(gy);
    ctx.save();
    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - 14 * this.scale);
    ctx.stroke();
    ctx.restore();
  }

  private drawCreature(ctx: CanvasRenderingContext2D) {
    const x = this.sx(this.cx);
    const y = this.sy(this.cy);
    const r = 1.6 * this.scale;
    const burn = clamp01(this.exposure / this.level.stamina);

    ctx.save();
    if (this.lit) {
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(x, y - r, 0, x, y - r, r * 5);
      g.addColorStop(0, `rgba(255,90,60,${0.25 + burn * 0.5})`);
      g.addColorStop(1, "rgba(255,90,60,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 5, y - r * 6, r * 10, r * 10);
    }
    ctx.restore();

    // Body: a small hunched thing, squashing as it walks.
    const bob = Math.sin(this.time * 11) * 0.12;
    ctx.save();
    ctx.translate(x, y - r);
    ctx.scale(1 + bob * 0.3, 1 - bob * 0.3);
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.15, r, 0, 0, Math.PI * 2);
    ctx.fillStyle = burn > 0.05
      ? `rgb(${247 - burn * 40},${236 - burn * 130},${216 - burn * 150})`
      : CREATURE;
    ctx.fill();
    ctx.restore();

    // Legs
    ctx.strokeStyle = CREATURE;
    ctx.lineWidth = Math.max(1, r * 0.3);
    for (const off of [-0.5, 0.5]) {
      const p = Math.sin(this.time * 11 + off * Math.PI) * r * 0.55;
      ctx.beginPath();
      ctx.moveTo(x + off * r * 0.7, y - r * 0.6);
      ctx.lineTo(x + off * r * 0.7 + p, y);
      ctx.stroke();
    }
  }

  private drawTitleScene(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    this.sunT = 0.5 + Math.sin(t * 0.35) * 0.42;
    this.level = LEVELS[0];
    this.drawSun(ctx);
    this.drawShadows(ctx);
    this.drawGround(ctx);
    this.drawBoxes(ctx);
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(43,26,36,0.55)";
    ctx.fillText("STRETCH", pad, pad + 34);
    ctx.font = monoFont(28, 700);
    ctx.fillStyle = SHADE;
    ctx.fillText(`${this.levelIndex + 1}/${LEVELS.length}`, pad, pad + 48);

    // Exposure as a bar that reads without a number.
    const barW = Math.min(190, this.w * 0.32);
    const barX = this.w - pad - barW;
    const k = clamp01(this.exposure / this.level.stamina);
    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(43,26,36,0.55)";
    ctx.fillText("EXPOSURE", this.w - pad, pad + 34);
    ctx.fillStyle = "rgba(43,26,36,0.2)";
    ctx.fillRect(barX, pad + 52, barW, 6);
    ctx.fillStyle = k > 0.65 ? BURN : SHADE;
    ctx.fillRect(barX, pad + 52, barW * k, 6);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(43,26,36,0.5)";
    ctx.fillText(
      this.c.isTouch
        ? "DRAG SIDEWAYS TO MOVE THE SUN"
        : "MOVE THE MOUSE — OR A/D — TO MOVE THE SUN",
      this.w / 2,
      this.h - 34,
    );
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.15, 84);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = SHADE;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("UMBRA", cx, this.h * 0.22);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(43,26,36,0.7)";
    ctx.fillText("IT WALKS ON ITS OWN. IT BURNS IN THE LIGHT.", cx, this.h * 0.22 + size * 0.58);
    ctx.fillStyle = "rgba(43,26,36,0.5)";
    ctx.fillText("YOU ONLY MOVE THE SUN.", cx, this.h * 0.22 + size * 0.58 + 20);

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(43,26,36,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.88);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(43,26,36,0.4)";
      ctx.fillText(`STRETCHES CROSSED — ${this.best}`, cx, this.h * 0.88 + 24);
    }
  }

  private drawBanner(ctx: CanvasRenderingContext2D, text: string, color: string) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.45));
    const cx = this.w / 2;
    ctx.fillStyle = `rgba(43,26,36,${0.5 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.13, 62), 800);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, this.h * 0.3);

    if (this.endTime > 0.6) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(255,255,255,${blink})`;
      ctx.fillText(
        this.phase === "won" ? "NEXT STRETCH" : "AGAIN",
        cx,
        this.h * 0.82,
      );
    }
  }

  private drawComplete(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.6));
    ctx.fillStyle = `rgba(43,26,36,${0.8 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.12, 60), 800);
    ctx.fillStyle = SKY_HIGH;
    ctx.fillText("IT MADE IT", this.w / 2, this.h * 0.4);
    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(248,211,138,${0.7 * ease})`;
    ctx.fillText(`ALL ${LEVELS.length} STRETCHES CROSSED`, this.w / 2, this.h * 0.4 + 44);
    if (this.endTime > 0.8) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(255,255,255,${blink})`;
      ctx.fillText("AGAIN", this.w / 2, this.h * 0.8);
    }
  }
}

const factory: GameFactory = (ctx) => new Umbra(ctx);
export default factory;
