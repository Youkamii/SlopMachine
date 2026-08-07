import type { AudioKit } from "@/engine/audio";
import type { Input } from "@/engine/input";
import type { Juice } from "@/engine/juice";
import type { RNG } from "@/engine/rng";
import type { GameStore } from "@/engine/storage";

/**
 * What a game receives when it is created. Everything a game needs is here —
 * a game never reaches for globals, which is what makes hot-swapping games
 * inside one shell possible.
 */
export interface GameContext {
  /** Canvas size in CSS pixels. Re-read every frame; it changes on resize. */
  readonly width: number;
  readonly height: number;
  readonly input: Input;
  readonly audio: AudioKit;
  readonly fx: Juice;
  readonly store: GameStore;
  readonly rng: RNG;
  /** True on phones/tablets — use it to swap control hints and hit sizes. */
  readonly isTouch: boolean;
  /** Push state up to the React shell (top bar score, game-over card). */
  report(state: GameReport): void;
}

export interface GameReport {
  score?: number;
  best?: number;
  /** Short status line under the title, e.g. "WAVE 4" or "3 moves left". */
  label?: string;
  /** Drives the shell's overlay. Games that never end can stay "playing". */
  status?: "idle" | "playing" | "over" | "won";
}

/**
 * A game is three functions. The shell owns the loop, the canvas and input;
 * the game owns everything drawn inside the frame, HUD included.
 */
export interface GameInstance {
  /** Fixed timestep. `dt` is always 1/60 unless the game asks otherwise. */
  update(dt: number): void;
  /**
   * Draw a full frame. The transform is already reset to CSS pixels and the
   * canvas is NOT auto-cleared — clear it yourself so trail effects are possible.
   */
  draw(ctx: CanvasRenderingContext2D): void;
  /** Called on mount and whenever the canvas box changes. */
  resize?(width: number, height: number): void;
  /** Start a fresh run without tearing down the instance. */
  restart?(): void;
  /** Release timers, workers, audio loops. */
  destroy?(): void;
}

export type GameFactory = (ctx: GameContext) => GameInstance;

export type GameTag =
  | "action"
  | "puzzle"
  | "rhythm"
  | "physics"
  | "reflex"
  | "strategy"
  | "word"
  | "toy"
  | "roguelite"
  | "arcade"
  | "atmospheric"
  | "one-button"
  | "deduction"
  | "endless";

export interface GameMeta {
  /** URL segment. Lowercase, kebab-case, stable forever once shipped. */
  slug: string;
  title: string;
  /** One line, shown on the card. Keep it under ~60 chars. */
  tagline: string;
  /** A paragraph for the game page and social preview. */
  description: string;
  tags: GameTag[];
  /** Who built it — the two worktrees keep their own registries. */
  author: "alex" | "steve";
  /** 1 = anyone clears it, 5 = brutal. */
  difficulty: 1 | 2 | 3 | 4 | 5;
  controls: {
    desktop: string;
    mobile: string;
  };
  /** Card accent + background. Should match the game's own palette. */
  accent: string;
  bg: string;
  /** ISO date, used for "new" badges and catalog ordering. */
  released: string;
  /** Typical single-session length, in seconds. Shown as "~2 min". */
  sessionSeconds?: number;
}

export interface GameEntry {
  meta: GameMeta;
  /** Code-split entry point. The heavy game code loads only on its own route. */
  load: () => Promise<{ default: GameFactory }>;
}
