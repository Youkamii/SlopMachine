/**
 * SHUNT
 *
 * Moving does not move you. It shifts the entire row or column you occupy by
 * one cell, carrying you, the enemies and everything else along like a slice
 * of a Rubik's cube. Anything pushed past the edge is crushed.
 *
 * So you never walk the floor — you operate the machine the floor is made of.
 * Kills happen by shunting an enemy off the board, and you die the same way.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp01, easeOutBack, easeOutCubic, lerp } from "@/engine/math";
import { RNG } from "@/engine/rng";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const CHASSIS = "#1c1c1e";
const CHASSIS_2 = "#141416";
const PLATE = "#f2efe8";
/**
 * Inactive plates are pushed well down in value. Which row and column you
 * occupy is the single most important thing on screen — at the first pass
 * the two tones were close enough that the live slice did not read.
 */
const PLATE_EDGE = "#67635b";
const INK = "#141416";
const YELLOW = "#f5c518";
const RED = "#e0413a";

const SIZE = 6;

type Kind = "grunt" | "heavy";

interface Piece {
  id: number;
  x: number;
  y: number;
  kind: Kind;
  alive: boolean;
  /** Previous cell, for slide animation. */
  px: number;
  py: number;
  /** Set the frame it is crushed, for the death animation. */
  dying: number;
}

type Phase = "title" | "playing" | "dead" | "cleared";

let nextId = 1;

class Shunt implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;
  private cell = 0;
  private bx = 0;
  private by = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private endTime = 0;
  private time = 0;

  private rng: RNG;
  private floor = 1;
  private best = 0;
  private kills = 0;
  private moves = 0;

  private player: Piece;
  private enemies: Piece[] = [];
  /** Enemies act on alternate ticks, halving the mental load per move. */
  private tick = 0;
  private anim = 1;

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.rng = new RNG(ctx.rng.int(1, 0xffffff));
    this.best = ctx.store.best("best") ?? 0;
    this.player = {
      id: 0, x: 2, y: 2, kind: "grunt", alive: true, px: 2, py: 2, dying: 0,
    };
    this.buildFloor(1);
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    const avail = Math.min(w * 0.86, h * 0.6, 480);
    this.cell = Math.floor(avail / SIZE);
    const size = this.cell * SIZE;
    this.bx = (w - size) / 2;
    this.by = h * 0.53 - size / 2;
  }

  private centre(x: number, y: number) {
    return {
      x: this.bx + (x + 0.5) * this.cell,
      y: this.by + (y + 0.5) * this.cell,
    };
  }

  private buildFloor(n: number) {
    this.floor = n;
    this.enemies = [];
    this.tick = 0;
    this.anim = 1;

    const taken = new Set<string>();
    // Player starts centre-ish, never on an edge — an edge start means one
    // wrong press ends the floor before you have read it.
    this.player.x = this.rng.int(1, SIZE - 2);
    this.player.y = this.rng.int(1, SIZE - 2);
    this.player.px = this.player.x;
    this.player.py = this.player.y;
    this.player.alive = true;
    this.player.dying = 0;
    taken.add(`${this.player.x},${this.player.y}`);

    const count = Math.min(2 + Math.floor(n / 2), 6);
    for (let i = 0; i < count; i++) {
      for (let attempt = 0; attempt < 60; attempt++) {
        const x = this.rng.int(0, SIZE - 1);
        const y = this.rng.int(0, SIZE - 1);
        const key = `${x},${y}`;
        if (taken.has(key)) continue;
        // Never spawn adjacent to the player.
        if (Math.abs(x - this.player.x) + Math.abs(y - this.player.y) < 2) continue;
        taken.add(key);
        this.enemies.push({
          id: nextId++,
          x, y, px: x, py: y,
          kind: n >= 3 && this.rng.bool(0.3) ? "heavy" : "grunt",
          alive: true,
          dying: 0,
        });
        break;
      }
    }
  }

  restart() {
    this.phase = "playing";
    this.kills = 0;
    this.moves = 0;
    this.buildFloor(1);
    this.c.report({ status: "playing", score: 0 });
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;
    if (this.anim < 1) this.anim = Math.min(1, this.anim + dt * 7);

    for (const e of this.enemies) {
      if (e.dying > 0) e.dying = Math.max(0, e.dying - dt * 2.2);
    }

    if (this.phase === "title") {
      this.titleTime += dt;
      if (this.titleTime > 0.25 && (input.pointer.justUp || input.confirmPressed)) {
        this.c.audio.play({
          wave: "square", freq: 140, freqTo: 280, glide: 0.14,
          vol: 0.14, attack: 0.004, hold: 0.04, release: 0.18, filter: 1400,
        });
        this.restart();
      }
      return;
    }

    if (this.phase === "dead" || this.phase === "cleared") {
      this.endTime += dt;
      if (this.endTime > 0.6 && (input.pointer.justUp || input.confirmPressed)) {
        if (this.phase === "cleared") {
          this.buildFloor(this.floor + 1);
          this.phase = "playing";
        } else {
          this.restart();
        }
      }
      return;
    }

    if (this.anim < 1) return;

    let dir: { dx: number; dy: number } | null = null;
    if (input.wasPressed("ArrowRight", "KeyD")) dir = { dx: 1, dy: 0 };
    else if (input.wasPressed("ArrowLeft", "KeyA")) dir = { dx: -1, dy: 0 };
    else if (input.wasPressed("ArrowDown", "KeyS")) dir = { dx: 0, dy: 1 };
    else if (input.wasPressed("ArrowUp", "KeyW")) dir = { dx: 0, dy: -1 };

    if (!dir && input.pointer.justUp && input.dragDistance >= 20) {
      const deg = ((input.dragAngle * 180) / Math.PI + 360) % 360;
      if (deg < 45 || deg >= 315) dir = { dx: 1, dy: 0 };
      else if (deg < 135) dir = { dx: 0, dy: 1 };
      else if (deg < 225) dir = { dx: -1, dy: 0 };
      else dir = { dx: 0, dy: -1 };
    }

    if (dir) this.shunt(dir.dx, dir.dy);
  }

  /** All pieces in the player's row (or column) move one cell. */
  private shunt(dx: number, dy: number) {
    const { fx, audio } = this.c;
    const horizontal = dx !== 0;
    const line = horizontal ? this.player.y : this.player.x;

    const onLine = (p: Piece) => (horizontal ? p.y === line : p.x === line);

    const movers: Piece[] = [this.player, ...this.enemies.filter((e) => e.alive)]
      .filter(onLine);

    for (const p of movers) {
      p.px = p.x;
      p.py = p.y;
      p.x += dx;
      p.y += dy;
    }

    let crushed = 0;
    let playerCrushed = false;
    for (const p of movers) {
      if (p.x >= 0 && p.x < SIZE && p.y >= 0 && p.y < SIZE) continue;
      if (p === this.player) {
        playerCrushed = true;
        continue;
      }
      p.alive = false;
      p.dying = 1;
      crushed++;
      this.kills++;
      const c = this.centre(
        Math.max(-0.5, Math.min(SIZE - 0.5, p.x)),
        Math.max(-0.5, Math.min(SIZE - 0.5, p.y)),
      );
      fx.emit(c.x, c.y, {
        count: 14, speed: 210, life: 0.45, size: 2.6,
        color: [RED, INK, YELLOW], drag: 3, shape: "square", spin: 12,
      });
    }

    this.moves++;
    this.anim = 0;

    // Detent click, pitched by the line index so running the machine has a
    // sense of position.
    const pitch = 1 + (line / SIZE) * 0.5;
    audio.play({
      wave: "noise", freq: 1400 * pitch, freqTo: 500 * pitch,
      vol: 0.1, attack: 0.001, hold: 0.012, release: 0.07,
      filter: 2200, filterType: "bandpass", q: 1.4,
    });
    audio.play({
      wave: "square", freq: 96 * pitch, freqTo: 74 * pitch, glide: 0.07,
      vol: 0.12, attack: 0.002, hold: 0.02, release: 0.08, filter: 900,
    });

    if (crushed > 0) {
      fx.shake(6 + crushed * 2, 6);
      fx.freeze(0.05);
      audio.play({
        wave: "noise", freq: 420, freqTo: 90, vol: 0.2,
        attack: 0.001, hold: 0.04, release: 0.2, filter: 1600, filterTo: 260,
      });
    }

    if (playerCrushed) {
      this.die("CRUSHED");
      return;
    }

    if (this.enemies.every((e) => !e.alive)) {
      this.clearFloor();
      return;
    }

    this.tick++;
    if (this.tick % 2 === 0) this.enemyTurn();
  }

  private enemyTurn() {
    const occupied = new Set<string>();
    for (const e of this.enemies) if (e.alive) occupied.add(`${e.x},${e.y}`);

    for (const e of this.enemies) {
      if (!e.alive) continue;
      e.px = e.x;
      e.py = e.y;

      // Heavies only move every other enemy turn, which makes them a
      // positional obstacle rather than a second chaser.
      if (e.kind === "heavy" && this.tick % 4 !== 0) continue;

      const dx = this.player.x - e.x;
      const dy = this.player.y - e.y;
      let mx = 0;
      let my = 0;
      if (Math.abs(dx) >= Math.abs(dy)) mx = Math.sign(dx);
      else my = Math.sign(dy);

      const nx = e.x + mx;
      const ny = e.y + my;
      if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
      if (occupied.has(`${nx},${ny}`)) continue;
      occupied.delete(`${e.x},${e.y}`);
      e.x = nx;
      e.y = ny;
      occupied.add(`${nx},${ny}`);
    }

    if (this.enemies.some((e) => e.alive && e.x === this.player.x && e.y === this.player.y)) {
      this.die("CAUGHT");
    }
  }

  private die(_reason: string) {
    const { fx, audio } = this.c;
    if (this.phase !== "playing") return;
    this.phase = "dead";
    this.endTime = 0;
    this.player.alive = false;

    fx.shake(18, 4);
    fx.freeze(0.12);
    fx.flash(RED, 0.14);
    const c = this.centre(
      Math.max(-0.5, Math.min(SIZE - 0.5, this.player.x)),
      Math.max(-0.5, Math.min(SIZE - 0.5, this.player.y)),
    );
    fx.emit(c.x, c.y, {
      count: 34, speed: 300, speedVar: 0.8, life: 0.8, lifeVar: 0.5,
      size: 3, color: [YELLOW, RED, PLATE], drag: 2, shape: "square", spin: 14,
    });

    audio.play({
      wave: "sawtooth", freq: 190, freqTo: 44, glide: 0.5,
      vol: 0.22, attack: 0.004, hold: 0.1, release: 0.45, filter: 1200, filterTo: 180,
    });

    if (this.c.store.recordBest("best", this.floor)) this.best = this.floor;
    this.c.store.bump("plays");
    this.c.report({ status: "over", score: this.floor, best: this.best });
  }

  private clearFloor() {
    const { fx, audio } = this.c;
    this.phase = "cleared";
    this.endTime = 0;
    fx.flash(YELLOW, 0.1);
    [0, 5, 7, 12].forEach((s, i) =>
      audio.play({
        wave: "square", freq: 330 * Math.pow(2, s / 12),
        vol: 0.12, attack: 0.003, hold: 0.04, release: 0.2, delay: i * 0.05,
        filter: 2600,
      }),
    );
    if (this.c.store.recordBest("best", this.floor)) this.best = this.floor;
    this.c.report({ score: this.floor });
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    ctx.fillStyle = CHASSIS;
    ctx.fillRect(0, 0, this.w, this.h);
    const g = ctx.createLinearGradient(0, 0, 0, this.h);
    g.addColorStop(0, CHASSIS);
    g.addColorStop(1, CHASSIS_2);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);

    this.drawBoard(ctx);
    if (this.phase !== "title") {
      this.drawEjectMarkers(ctx);
      this.drawPieces(ctx);
    }
    fx.drawParticles(ctx);

    fx.popCamera(ctx);

    if (this.phase === "playing") this.drawHud(ctx);
    if (this.phase === "title") this.drawTitle(ctx);
    if (this.phase === "dead") this.drawBanner(ctx, "CRUSHED", RED);
    if (this.phase === "cleared") this.drawBanner(ctx, "FLOOR CLEAR", YELLOW);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawBoard(ctx: CanvasRenderingContext2D) {
    const size = this.cell * SIZE;

    ctx.fillStyle = "#000000";
    ctx.globalAlpha = 0.35;
    ctx.fillRect(this.bx + 4, this.by + 6, size, size);
    ctx.globalAlpha = 1;

    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const px = this.bx + x * this.cell;
        const py = this.by + y * this.cell;
        const lit =
          this.phase !== "title" &&
          (y === this.player.y || x === this.player.x);
        ctx.fillStyle = lit ? PLATE : PLATE_EDGE;
        ctx.fillRect(px + 1.5, py + 1.5, this.cell - 3, this.cell - 3);
      }
    }

    ctx.strokeStyle = YELLOW;
    ctx.lineWidth = 2;
    ctx.strokeRect(this.bx - 2, this.by - 2, size + 4, size + 4);
  }

  /**
   * Marks the piece that would be ejected by each of the four shunts. This is
   * the whole readability problem solved without a preview overlay: you can
   * see the consequence of every direction at a glance.
   */
  private drawEjectMarkers(ctx: CanvasRenderingContext2D) {
    if (this.anim < 1 || this.phase !== "playing") return;
    const size = this.cell * SIZE;
    const marks: Array<{ x: number; y: number; dx: number; dy: number }> = [];

    const rowPieces = [this.player, ...this.enemies.filter((e) => e.alive)]
      .filter((p) => p.y === this.player.y);
    const colPieces = [this.player, ...this.enemies.filter((e) => e.alive)]
      .filter((p) => p.x === this.player.x);

    const edgeOf = (arr: Piece[], key: "x" | "y", dir: number) => {
      let best: Piece | null = null;
      for (const p of arr) {
        if (!best || (dir > 0 ? p[key] > best[key] : p[key] < best[key])) best = p;
      }
      return best && best[key] === (dir > 0 ? SIZE - 1 : 0) ? best : null;
    };

    const r = edgeOf(rowPieces, "x", 1);
    const l = edgeOf(rowPieces, "x", -1);
    const d = edgeOf(colPieces, "y", 1);
    const u = edgeOf(colPieces, "y", -1);
    if (r) marks.push({ x: r.x, y: r.y, dx: 1, dy: 0 });
    if (l) marks.push({ x: l.x, y: l.y, dx: -1, dy: 0 });
    if (d) marks.push({ x: d.x, y: d.y, dx: 0, dy: 1 });
    if (u) marks.push({ x: u.x, y: u.y, dx: 0, dy: -1 });

    for (const m of marks) {
      const isPlayer = m.x === this.player.x && m.y === this.player.y;
      const c = this.centre(m.x, m.y);
      const ox = c.x + m.dx * this.cell * 0.62;
      const oy = c.y + m.dy * this.cell * 0.62;
      const pulse = 0.55 + Math.sin(this.time * 6) * 0.35;
      ctx.save();
      ctx.globalAlpha = pulse;
      ctx.fillStyle = isPlayer ? RED : YELLOW;
      const a = Math.atan2(m.dy, m.dx);
      ctx.beginPath();
      ctx.moveTo(ox + Math.cos(a) * 9, oy + Math.sin(a) * 9);
      ctx.lineTo(ox + Math.cos(a + 2.4) * 9, oy + Math.sin(a + 2.4) * 9);
      ctx.lineTo(ox + Math.cos(a - 2.4) * 9, oy + Math.sin(a - 2.4) * 9);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    void size;
  }

  private drawPieces(ctx: CanvasRenderingContext2D) {
    const e = easeOutBack(clamp01(this.anim));
    const r = this.cell * 0.3;

    for (const en of this.enemies) {
      if (!en.alive && en.dying <= 0) continue;
      const a = this.centre(en.px, en.py);
      const b = this.centre(en.x, en.y);
      const x = lerp(a.x, b.x, e);
      const y = lerp(a.y, b.y, e);
      const fade = en.alive ? 1 : en.dying;

      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(x, y);
      if (en.kind === "heavy") {
        ctx.fillStyle = INK;
        ctx.fillRect(-r * 1.05, -r * 1.05, r * 2.1, r * 2.1);
        ctx.strokeStyle = YELLOW;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(-r * 0.5, -r * 0.5, r, r);
      } else {
        ctx.beginPath();
        for (let i = 0; i < 3; i++) {
          const ang = -Math.PI / 2 + (i / 3) * TAU;
          const px = Math.cos(ang) * r * 1.15;
          const py = Math.sin(ang) * r * 1.15;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = INK;
        ctx.fill();
      }
      ctx.restore();
    }

    if (!this.player.alive && this.phase === "dead") return;
    const a = this.centre(this.player.px, this.player.py);
    const b = this.centre(this.player.x, this.player.y);
    const x = lerp(a.x, b.x, e);
    const y = lerp(a.y, b.y, e);

    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fillStyle = YELLOW;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(233,230,223,0.42)";
    ctx.fillText("FLOOR", pad, pad + 34);
    ctx.font = monoFont(28, 700);
    ctx.fillStyle = YELLOW;
    ctx.fillText(this.floor.toString().padStart(2, "0"), pad, pad + 48);

    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(233,230,223,0.42)";
    ctx.fillText("LEFT", this.w - pad, pad + 34);
    ctx.font = monoFont(28, 700);
    ctx.fillStyle = PLATE;
    ctx.fillText(
      this.enemies.filter((e) => e.alive).length.toString(),
      this.w - pad,
      pad + 48,
    );

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(10.5, 500);
    ctx.fillStyle = "rgba(233,230,223,0.4)";
    ctx.fillText(
      this.c.isTouch
        ? "SWIPE — YOUR WHOLE ROW OR COLUMN SHIFTS"
        : "ARROWS / WASD — YOUR WHOLE ROW OR COLUMN SHIFTS",
      this.w / 2,
      this.by + this.cell * SIZE + 32,
    );
    ctx.font = monoFont(10, 500);
    ctx.fillStyle = "rgba(245,197,24,0.55)";
    ctx.fillText(
      "ARROWS AT THE EDGE MARK WHAT GETS CRUSHED",
      this.w / 2,
      this.by + this.cell * SIZE + 52,
    );
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;

    ctx.fillStyle = "rgba(20,20,22,0.88)";
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const size = Math.min(this.w * 0.15, 84);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = YELLOW;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("SHUNT", cx, this.h * 0.3);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(233,230,223,0.62)";
    ctx.fillText("YOU DO NOT MOVE.", cx, this.h * 0.3 + size * 0.6);
    ctx.fillStyle = "rgba(233,230,223,0.42)";
    ctx.fillText("THE ROW YOU STAND IN MOVES.", cx, this.h * 0.3 + size * 0.6 + 20);

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(233,230,223,${blink})`;
    ctx.fillText(this.c.isTouch ? "TAP TO BEGIN" : "CLICK TO BEGIN", cx, this.h * 0.82);

    if (this.best > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(233,230,223,0.34)";
      ctx.fillText(`DEEPEST FLOOR ${this.best}`, cx, this.h * 0.82 + 24);
    }
  }

  private drawBanner(ctx: CanvasRenderingContext2D, text: string, color: string) {
    const ease = easeOutCubic(clamp01(this.endTime / 0.5));
    const cx = this.w / 2;
    const above = Math.max(70, this.by - 66);
    const below = Math.min(this.h - 34, this.by + this.cell * SIZE + 84);

    ctx.fillStyle = `rgba(20,20,22,${0.55 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.13, 60), 800);
    ctx.fillStyle = color;
    ctx.fillText(text, cx, above);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(233,230,223,${0.55 * ease})`;
    ctx.fillText(
      `FLOOR ${this.floor}   ·   ${this.kills} CRUSHED   ·   ${this.moves} SHUNTS`,
      cx,
      above + 38,
    );

    if (this.endTime > 0.6) {
      const blink = 0.5 + Math.sin(this.endTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(233,230,223,${blink})`;
      ctx.fillText(
        this.phase === "cleared" ? "DESCEND" : "RUN AGAIN",
        cx,
        below,
      );
    }
  }
}

const factory: GameFactory = (ctx) => new Shunt(ctx);
export default factory;
