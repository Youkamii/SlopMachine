/**
 * THE TELL
 *
 * A quickdraw duel that is not a reflex game. Every opponent has a different
 * micro-movement they make just before drawing, and firing before that tell
 * is an instant loss. So the first duel against someone is lost while you
 * learn what to look for, and the rematch is won on 200ms.
 *
 * The skill being measured is observation, not reaction.
 */

import { monoFont, uiFont } from "@/engine/draw";
import { TAU, clamp, clamp01, easeOutCubic, lerp } from "@/engine/math";
import type { GameContext, GameFactory, GameInstance } from "@/games/types";

// --- palette ----------------------------------------------------------------

const SKY_TOP = "#f6bd60";
const SKY_MID = "#f28482";
const SKY_LOW = "#84658f";
const GROUND = "#2b2233";
const SILHOUETTE = "#161119";
const HOT = "#ffe8a3";
const BAD = "#e5484d";

// --- opponents --------------------------------------------------------------

type TellKind = "shoulder" | "blink" | "hand" | "lean" | "coat";

interface Opponent {
  name: string;
  tell: TellKind;
  /** Seconds between the tell and their shot. Lower = harder. */
  window: number;
  /** Height multiplier, so each duellist is visually distinct. */
  build: number;
}

const OPPONENTS: Opponent[] = [
  { name: "THE COOPER", tell: "shoulder", window: 0.42, build: 1.0 },
  { name: "SILVA", tell: "coat", window: 0.36, build: 1.08 },
  { name: "OLD MERCY", tell: "blink", window: 0.32, build: 0.94 },
  { name: "THE DEACON", tell: "lean", window: 0.28, build: 1.12 },
  { name: "NOBODY", tell: "hand", window: 0.24, build: 1.0 },
];

const TELL_LABEL: Record<TellKind, string> = {
  shoulder: "THE SHOULDER LIFTS",
  blink: "THE EYE BLINKS",
  hand: "THE HAND TWITCHES",
  lean: "THE WEIGHT SHIFTS",
  coat: "THE COAT MOVES",
};

/** How long the tell is actually visible. Short enough to miss, long enough to be fair. */
const TELL_DURATION = 0.14;

type Phase =
  | "title"
  | "intro"
  | "waiting"
  | "tell"
  | "open"
  | "resolve"
  | "replay"
  | "matchOver"
  | "runOver";

class TheTell implements GameInstance {
  private readonly c: GameContext;

  private w = 0;
  private h = 0;

  private phase: Phase = "title";
  private titleTime = 0;
  private stateTime = 0;
  private time = 0;

  private oppIndex = 0;
  private wins = 0;
  private losses = 0;
  private duelsWon = 0;
  private best = 0;

  private waitFor = 0;
  /** performance.now() at the frame the tell was rendered. */
  private tellShownAt = 0;
  private reaction = -1;
  private lastResult: "win" | "early" | "late" | null = null;
  private bestReaction = 0;

  private flashFrames = 0;
  private replayT = 0;
  private knownTells = new Set<TellKind>();

  constructor(ctx: GameContext) {
    this.c = ctx;
    this.best = ctx.store.best("best") ?? 0;
    this.bestReaction = ctx.store.get<number>("bestReaction", 0);
    ctx.report({ status: "idle", score: 0 });
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
  }

  restart() {
    this.oppIndex = 0;
    this.duelsWon = 0;
    this.startDuel();
    this.c.report({ status: "playing", score: 0 });
  }

  private startDuel() {
    this.wins = 0;
    this.losses = 0;
    this.phase = "intro";
    this.stateTime = 0;
  }

  private startRound() {
    this.phase = "waiting";
    this.stateTime = 0;
    // Randomised so the wait can never be counted, only watched.
    this.waitFor = this.c.rng.range(1.1, 3.4);
    this.reaction = -1;
    this.lastResult = null;
    this.c.audio.play({
      wave: "sine", freq: 1180, vol: 0.03,
      attack: 0.4, hold: 2.0, release: 1.2,
    });
  }

  private get opponent() {
    return OPPONENTS[Math.min(this.oppIndex, OPPONENTS.length - 1)];
  }

  // --- update ---------------------------------------------------------------

  update(dt: number) {
    const { input } = this.c;
    this.time += dt;
    this.stateTime += dt;
    if (this.flashFrames > 0) this.flashFrames--;

    const fired = input.pointer.justDown || input.justPressed.size > 0;

    switch (this.phase) {
      case "title": {
        this.titleTime += dt;
        if (this.titleTime > 0.25 && fired) {
          this.c.audio.play({
            wave: "sine", freq: 330, freqTo: 220, glide: 0.2,
            vol: 0.14, attack: 0.006, hold: 0.06, release: 0.3,
          });
          this.restart();
        }
        break;
      }

      case "intro": {
        if (this.stateTime > 1.5 || fired) this.startRound();
        break;
      }

      case "waiting": {
        if (fired) {
          // Fired before the tell. This is the whole point of the game.
          this.resolve("early");
          break;
        }
        if (this.stateTime >= this.waitFor) {
          this.phase = "tell";
          this.stateTime = 0;
          this.tellShownAt = performance.now();
          // A near-subliminal click, panned to the opponent, so attentive
          // players get a second channel of information.
          this.c.audio.play({
            wave: "noise", freq: 3000, vol: 0.02,
            attack: 0.001, hold: 0.003, release: 0.012,
            filter: 6000, filterType: "highpass", pan: 0.6,
          });
        }
        break;
      }

      case "tell": {
        if (fired) {
          this.reaction = performance.now() - this.tellShownAt;
          this.resolve("win");
          break;
        }
        if (this.stateTime >= TELL_DURATION) {
          this.phase = "open";
          this.stateTime = 0;
        }
        break;
      }

      case "open": {
        if (fired) {
          this.reaction = performance.now() - this.tellShownAt;
          this.resolve("win");
          break;
        }
        if (this.stateTime >= this.opponent.window) {
          this.resolve("late");
        }
        break;
      }

      case "resolve": {
        if (this.stateTime > 1.4 || (this.stateTime > 0.5 && fired)) {
          if (this.lastResult === "win") this.wins++;
          else this.losses++;

          if (this.wins >= 2 || this.losses >= 2) {
            this.phase = this.lastResult === "win" && this.wins >= 2
              ? "matchOver"
              : "replay";
            this.stateTime = 0;
            this.replayT = 0;
            if (this.phase === "matchOver") this.finishDuel(true);
          } else {
            this.startRound();
          }
        }
        break;
      }

      case "replay": {
        // Slow-motion of the moment, with the tell circled. Losing has to
        // teach something or the whole thing is a coin flip.
        this.replayT += dt * 0.35;
        if (this.replayT > 1.6 && fired) {
          this.knownTells.add(this.opponent.tell);
          this.finishDuel(false);
        }
        break;
      }

      case "matchOver": {
        if (this.stateTime > 0.8 && fired) {
          this.oppIndex++;
          if (this.oppIndex >= OPPONENTS.length) {
            this.phase = "runOver";
            this.stateTime = 0;
          } else {
            this.startDuel();
          }
        }
        break;
      }

      case "runOver": {
        if (this.stateTime > 0.8 && fired) this.restart();
        break;
      }
    }
  }

  private resolve(result: "win" | "early" | "late") {
    const { fx, audio } = this.c;
    this.phase = "resolve";
    this.stateTime = 0;
    this.lastResult = result;
    this.flashFrames = 8;

    if (result === "win") {
      fx.shake(16, 5);
      fx.freeze(0.09);
      audio.play({
        wave: "noise", freq: 1600, freqTo: 200, vol: 0.3,
        attack: 0.0008, hold: 0.03, release: 0.5, filter: 3000, filterTo: 300,
      });
      audio.play({
        wave: "sine", freq: 90, freqTo: 40, glide: 0.3,
        vol: 0.2, attack: 0.001, hold: 0.05, release: 0.4,
      });
      this.knownTells.add(this.opponent.tell);
      if (this.reaction > 0 && (this.bestReaction === 0 || this.reaction < this.bestReaction)) {
        this.bestReaction = this.reaction;
        this.c.store.set("bestReaction", Math.round(this.reaction));
      }
    } else {
      fx.shake(10, 5);
      fx.flash(BAD, 0.12);
      audio.play({
        wave: "noise", freq: 900, freqTo: 120, vol: 0.24,
        attack: 0.001, hold: 0.04, release: 0.45, filter: 2000, filterTo: 200,
      });
    }
  }

  private finishDuel(won: boolean) {
    if (won) {
      this.duelsWon++;
      if (this.c.store.recordBest("best", this.duelsWon)) this.best = this.duelsWon;
      this.c.report({ score: this.duelsWon });
      this.c.audio.powerUp(0.16);
    } else {
      this.startDuel();
    }
  }

  // --- render ---------------------------------------------------------------

  draw(ctx: CanvasRenderingContext2D) {
    const { fx } = this.c;
    this.drawSky(ctx);

    fx.pushCamera(ctx, this.w / 2, this.h / 2);
    this.drawGround(ctx);

    if (this.phase !== "title") {
      const slow = this.phase === "replay";
      this.drawDuellists(ctx, slow);
    } else {
      this.drawTitleScene(ctx);
    }
    fx.drawParticles(ctx);
    fx.popCamera(ctx);

    // Hard monochrome inversion for a few frames at the moment of the shot.
    if (this.flashFrames > 0) {
      ctx.save();
      ctx.globalCompositeOperation = "difference";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.restore();
    }

    if (this.phase === "title") this.drawTitle(ctx);
    else this.drawHud(ctx);

    if (this.phase === "resolve") this.drawResult(ctx);
    if (this.phase === "replay") this.drawReplay(ctx);
    if (this.phase === "matchOver") this.drawMatchOver(ctx);
    if (this.phase === "runOver") this.drawRunOver(ctx);

    fx.drawFlash(ctx, this.w, this.h);
  }

  private drawSky(ctx: CanvasRenderingContext2D) {
    const g = ctx.createLinearGradient(0, 0, 0, this.h * 0.78);
    g.addColorStop(0, SKY_LOW);
    g.addColorStop(0.45, SKY_MID);
    g.addColorStop(1, SKY_TOP);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.w, this.h);

    // Low sun.
    const sunY = this.h * 0.6;
    const r = Math.min(this.w, this.h) * 0.16;
    const sg = ctx.createRadialGradient(this.w / 2, sunY, 0, this.w / 2, sunY, r * 2.2);
    sg.addColorStop(0, "rgba(255,240,190,0.85)");
    sg.addColorStop(0.4, "rgba(255,210,140,0.4)");
    sg.addColorStop(1, "rgba(255,200,120,0)");
    ctx.fillStyle = sg;
    ctx.fillRect(this.w / 2 - r * 2.2, sunY - r * 2.2, r * 4.4, r * 4.4);
  }

  private drawGround(ctx: CanvasRenderingContext2D) {
    const y = this.h * 0.78;
    ctx.fillStyle = GROUND;
    ctx.beginPath();
    ctx.moveTo(0, this.h);
    ctx.lineTo(0, y);
    for (let i = 0; i <= 16; i++) {
      const t = i / 16;
      ctx.lineTo(t * this.w, y + Math.sin(t * 7 + 1.2) * 5);
    }
    ctx.lineTo(this.w, this.h);
    ctx.closePath();
    ctx.fill();
  }

  /** Tell-driven pose. Returns the offsets each tell applies. */
  private tellPose(active: boolean, kind: TellKind) {
    const k = active ? 1 : 0;
    return {
      shoulder: kind === "shoulder" ? k * 7 : 0,
      blink: kind === "blink" ? k : 0,
      hand: kind === "hand" ? k * 4 : 0,
      lean: kind === "lean" ? k * 6 : 0,
      coat: kind === "coat" ? k * 8 : 0,
    };
  }

  private drawDuellists(ctx: CanvasRenderingContext2D, slow: boolean) {
    const groundY = this.h * 0.78;
    const scale = Math.min(this.w, this.h) / 620;
    const px = this.w * 0.26;
    const ox = this.w * 0.74;

    const tellActive =
      this.phase === "tell" ||
      (slow && this.replayT > 0.6 && this.replayT < 1.15);

    const drawn = this.phase === "resolve" || this.phase === "replay";

    this.drawFigure(ctx, px, groundY, scale, 1, false, drawn && this.lastResult === "win", {
      shoulder: 0, blink: 0, hand: 0, lean: 0, coat: 0,
    });
    this.drawFigure(
      ctx, ox, groundY, scale * this.opponent.build, -1,
      tellActive,
      drawn && this.lastResult !== "win",
      this.tellPose(tellActive, this.opponent.tell),
    );
  }

  private drawFigure(
    ctx: CanvasRenderingContext2D,
    x: number,
    groundY: number,
    scale: number,
    facing: number,
    tellOn: boolean,
    drawn: boolean,
    pose: { shoulder: number; blink: number; hand: number; lean: number; coat: number },
  ) {
    const s = scale;
    const bodyH = 150 * s;
    const headR = 17 * s;
    const shoulderY = groundY - bodyH;

    ctx.save();
    ctx.translate(x + pose.lean * facing * s, 0);
    ctx.fillStyle = SILHOUETTE;

    // Coat / body
    ctx.beginPath();
    ctx.moveTo(-20 * s, groundY);
    ctx.lineTo(-16 * s - pose.coat * s * 0.4, shoulderY + 24 * s);
    ctx.lineTo(-13 * s, shoulderY - pose.shoulder * s);
    ctx.lineTo(13 * s, shoulderY - pose.shoulder * s * 0.4);
    ctx.lineTo(17 * s + pose.coat * s * 0.6, shoulderY + 24 * s);
    ctx.lineTo(21 * s + pose.coat * s, groundY);
    ctx.closePath();
    ctx.fill();

    // Legs
    ctx.fillRect(-11 * s, groundY - 46 * s, 8 * s, 46 * s);
    ctx.fillRect(4 * s, groundY - 46 * s, 8 * s, 46 * s);

    // Head
    ctx.beginPath();
    ctx.arc(0, shoulderY - headR - 4 * s - pose.shoulder * s * 0.2, headR, 0, TAU);
    ctx.fill();

    // Hat brim
    ctx.fillRect(
      -headR * 1.7, shoulderY - headR * 2 - 4 * s - pose.shoulder * s * 0.2,
      headR * 3.4, 4.5 * s,
    );

    // Gun arm — drops when drawn.
    const armY = shoulderY + 18 * s;
    const twitch = pose.hand * s;
    ctx.save();
    ctx.translate(facing * 14 * s, armY);
    ctx.rotate(drawn ? facing * -1.1 : facing * (0.35 + twitch * 0.02));
    ctx.fillRect(0, -4 * s, facing * 34 * s, 8 * s);
    ctx.restore();

    // Eye: only visible during a blink tell, as a bright flicker.
    if (pose.blink > 0) {
      ctx.fillStyle = HOT;
      ctx.beginPath();
      ctx.arc(
        facing * -5 * s,
        shoulderY - headR - 5 * s,
        2.6 * s,
        0, TAU,
      );
      ctx.fill();
    }

    // Muzzle flash
    if (drawn) {
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const mx = facing * 48 * s;
      const my = armY - 26 * s;
      const g = ctx.createRadialGradient(mx, my, 0, mx, my, 26 * s);
      g.addColorStop(0, "rgba(255,240,190,0.95)");
      g.addColorStop(1, "rgba(255,200,120,0)");
      ctx.fillStyle = g;
      ctx.fillRect(mx - 26 * s, my - 26 * s, 52 * s, 52 * s);
      ctx.restore();
    }

    void tellOn;
    ctx.restore();
  }

  private drawTitleScene(ctx: CanvasRenderingContext2D) {
    const groundY = this.h * 0.78;
    const scale = Math.min(this.w, this.h) / 620;
    const zero = { shoulder: 0, blink: 0, hand: 0, lean: 0, coat: 0 };
    this.drawFigure(ctx, this.w * 0.26, groundY, scale, 1, false, false, zero);
    this.drawFigure(ctx, this.w * 0.74, groundY, scale, -1, false, false, zero);
  }

  private drawHud(ctx: CanvasRenderingContext2D) {
    const pad = 20;
    const opp = this.opponent;

    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(22,17,25,0.5)";
    ctx.fillText("DUEL", pad, pad + 34);
    ctx.font = monoFont(26, 700);
    ctx.fillStyle = SILHOUETTE;
    ctx.fillText(`${this.oppIndex + 1}/${OPPONENTS.length}`, pad, pad + 48);

    ctx.textAlign = "right";
    ctx.font = monoFont(11, 500);
    ctx.fillStyle = "rgba(22,17,25,0.5)";
    ctx.fillText(opp.name, this.w - pad, pad + 34);
    ctx.font = monoFont(22, 700);
    ctx.fillStyle = SILHOUETTE;
    ctx.fillText(`${this.wins} — ${this.losses}`, this.w - pad, pad + 50);

    if (this.knownTells.has(opp.tell)) {
      ctx.font = monoFont(10, 600);
      ctx.fillStyle = "rgba(22,17,25,0.45)";
      ctx.fillText(`TELL: ${TELL_LABEL[opp.tell]}`, this.w - pad, pad + 78);
    }

    if (this.phase === "waiting" || this.phase === "intro") {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = monoFont(11, 600);
      const a = 0.35 + Math.sin(this.time * 2.2) * 0.15;
      ctx.fillStyle = `rgba(22,17,25,${a})`;
      ctx.fillText("WAIT FOR THE TELL", this.w / 2, this.h * 0.14);
    }

    if (this.bestReaction > 0) {
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.font = monoFont(10, 500);
      ctx.fillStyle = "rgba(22,17,25,0.4)";
      ctx.fillText(`FASTEST ${Math.round(this.bestReaction)}ms`, pad, pad + 80);
    }
  }

  private drawResult(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.stateTime / 0.35));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const win = this.lastResult === "win";
    ctx.font = uiFont(Math.min(this.w * 0.11, 54), 800);
    ctx.fillStyle = win ? SILHOUETTE : BAD;
    ctx.globalAlpha = ease;
    ctx.fillText(
      win ? "CLEAN" : this.lastResult === "early" ? "TOO EARLY" : "TOO LATE",
      this.w / 2,
      this.h * 0.28,
    );

    ctx.font = monoFont(13, 600);
    ctx.fillStyle = "rgba(22,17,25,0.6)";
    if (win && this.reaction > 0) {
      ctx.fillText(`${Math.round(this.reaction)}ms`, this.w / 2, this.h * 0.28 + 44);
    } else if (this.lastResult === "early") {
      ctx.fillText("HE HADN'T MOVED YET", this.w / 2, this.h * 0.28 + 44);
    } else {
      ctx.fillText("HE WAS FASTER", this.w / 2, this.h * 0.28 + 44);
    }
    ctx.globalAlpha = 1;
  }

  private drawReplay(ctx: CanvasRenderingContext2D) {
    const opp = this.opponent;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = monoFont(11, 600);
    ctx.fillStyle = "rgba(22,17,25,0.55)";
    ctx.fillText("WATCH AGAIN — SLOWED", this.w / 2, this.h * 0.12);

    // Circle the tell so the lesson is unmissable.
    if (this.replayT > 0.5 && this.replayT < 1.3) {
      const scale = Math.min(this.w, this.h) / 620;
      const groundY = this.h * 0.78;
      const shoulderY = groundY - 150 * scale * opp.build;
      const x = this.w * 0.74;
      const spots: Record<TellKind, { x: number; y: number }> = {
        shoulder: { x: x - 12 * scale, y: shoulderY },
        blink: { x: x + 5 * scale, y: shoulderY - 22 * scale },
        hand: { x: x - 32 * scale, y: shoulderY + 18 * scale },
        lean: { x, y: groundY - 40 * scale },
        coat: { x: x + 20 * scale, y: shoulderY + 40 * scale },
      };
      const p = spots[opp.tell];
      const pulse = 0.5 + Math.sin(this.time * 9) * 0.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 26 * scale + pulse * 4, 0, TAU);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = BAD;
      ctx.stroke();

      ctx.font = monoFont(11, 700);
      ctx.fillStyle = BAD;
      ctx.fillText(TELL_LABEL[opp.tell], p.x, p.y - 44 * scale);
    }

    if (this.replayT > 1.6) {
      const blink = 0.5 + Math.sin(this.time * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(22,17,25,${blink})`;
      ctx.fillText("NOW YOU KNOW — GO AGAIN", this.w / 2, this.h * 0.9);
    }
  }

  private drawMatchOver(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.stateTime / 0.5));
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.globalAlpha = ease;
    ctx.font = uiFont(Math.min(this.w * 0.12, 58), 800);
    ctx.fillStyle = SILHOUETTE;
    ctx.fillText("HE FALLS", this.w / 2, this.h * 0.24);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = "rgba(22,17,25,0.6)";
    ctx.fillText(
      `${this.opponent.name} BEATEN  ·  ${this.duelsWon}/${OPPONENTS.length}`,
      this.w / 2,
      this.h * 0.24 + 44,
    );
    ctx.globalAlpha = 1;

    if (this.stateTime > 0.8) {
      const blink = 0.5 + Math.sin(this.stateTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(22,17,25,${blink})`;
      ctx.fillText("NEXT", this.w / 2, this.h * 0.9);
    }
  }

  private drawRunOver(ctx: CanvasRenderingContext2D) {
    const ease = easeOutCubic(clamp01(this.stateTime / 0.6));
    ctx.fillStyle = `rgba(43,34,51,${0.55 * ease})`;
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = uiFont(Math.min(this.w * 0.13, 64), 800);
    ctx.fillStyle = HOT;
    ctx.fillText("LAST ONE STANDING", this.w / 2, this.h * 0.4);

    ctx.font = monoFont(12, 500);
    ctx.fillStyle = `rgba(255,232,163,${0.7 * ease})`;
    ctx.fillText(
      `ALL ${OPPONENTS.length} BEATEN  ·  FASTEST ${Math.round(this.bestReaction)}ms`,
      this.w / 2,
      this.h * 0.4 + 46,
    );

    if (this.stateTime > 0.8) {
      const blink = 0.5 + Math.sin(this.stateTime * 3.6) * 0.35;
      ctx.font = monoFont(12, 700);
      ctx.fillStyle = `rgba(255,232,163,${blink})`;
      ctx.fillText("AGAIN", this.w / 2, this.h * 0.82);
    }
  }

  private drawTitle(ctx: CanvasRenderingContext2D) {
    const t = this.titleTime;
    const cx = this.w / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const size = Math.min(this.w * 0.14, 78);
    ctx.font = uiFont(size, 800);
    ctx.fillStyle = SILHOUETTE;
    ctx.letterSpacing = "-0.03em";
    ctx.fillText("THE TELL", cx, this.h * 0.2);
    ctx.letterSpacing = "0px";

    ctx.font = monoFont(Math.min(13, this.w * 0.03), 500);
    ctx.fillStyle = "rgba(22,17,25,0.65)";
    ctx.fillText("EVERY MAN MOVES BEFORE HE DRAWS.", cx, this.h * 0.2 + size * 0.6);
    ctx.fillStyle = "rgba(22,17,25,0.45)";
    ctx.fillText("A DIFFERENT MOVE EACH TIME.", cx, this.h * 0.2 + size * 0.6 + 20);

    const blink = 0.5 + Math.sin(t * 3.4) * 0.35;
    ctx.font = monoFont(12, 700);
    ctx.fillStyle = `rgba(22,17,25,${blink})`;
    ctx.fillText(
      this.c.isTouch ? "TAP TO DRAW" : "ANY KEY OR CLICK TO DRAW",
      cx,
      this.h * 0.92,
    );

    if (this.bestReaction > 0) {
      ctx.font = monoFont(10.5, 500);
      ctx.fillStyle = "rgba(22,17,25,0.4)";
      ctx.fillText(
        `FASTEST CLEAN DRAW ${Math.round(this.bestReaction)}ms`,
        cx,
        this.h * 0.92 - 22,
      );
    }
    void clamp;
    void lerp;
  }
}

const factory: GameFactory = (ctx) => new TheTell(ctx);
export default factory;
