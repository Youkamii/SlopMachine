/**
 * Binds a GameFactory to a canvas element: context, loop, input, audio,
 * resize, visibility, persistence. React's involvement ends at calling this.
 *
 * Everything is torn down by a single `destroy()`, so React StrictMode's
 * double-mount in development is a non-event rather than something to guard
 * against with a "didInit" ref.
 */

import type { GameFactory, GameInstance, GameReport } from "@/games/types";
import { audio } from "./audio";
import { fitCanvas, observeSize, resetTransform } from "./canvas";
import { Input } from "./input";
import { Juice } from "./juice";
import { Loop } from "./loop";
import { RNG } from "./rng";
import { GameStore, prefs } from "./storage";

export interface MountOptions {
  slug: string;
  /** Called whenever the game reports score/status changes. */
  onReport?: (report: GameReport) => void;
  /** Fixed update rate. 60 unless a game needs tighter physics. */
  hz?: number;
  /** Integer-scaled, non-smoothed rendering for pixel art. */
  pixelated?: boolean;
  /** Seed for reproducible runs (daily challenges). */
  seed?: number;
}

export interface GameHandle {
  destroy(): void;
  pause(): void;
  resume(): void;
  restart(): void;
  readonly paused: boolean;
  readonly report: GameReport;
}

export function mountGame(
  canvas: HTMLCanvasElement,
  factory: GameFactory,
  opts: MountOptions,
): GameHandle {
  const ctx = canvas.getContext("2d", {
    // Opaque canvas — the browser can skip the alpha composite entirely.
    alpha: false,
    // Lower input-to-photon latency. Harmless when unsupported.
    desynchronized: true,
  }) as CanvasRenderingContext2D;

  const parent = canvas.parentElement ?? canvas;
  const input = new Input();
  const fx = new Juice();
  const store = new GameStore(opts.slug);
  const rng = new RNG(opts.seed);

  let size = fitCanvas(canvas, parent.clientWidth, parent.clientHeight, {
    pixelated: opts.pixelated,
  });

  let report: GameReport = { status: "idle", score: 0 };
  const emitReport = (patch: GameReport) => {
    report = { ...report, ...patch };
    opts.onReport?.(report);
  };

  const gameCtx = {
    get width() {
      return size.width;
    },
    get height() {
      return size.height;
    },
    input,
    audio,
    fx,
    store,
    rng,
    isTouch: input.isTouch,
    report: emitReport,
  };

  const game: GameInstance = factory(gameCtx);
  game.resize?.(size.width, size.height);

  const loop = new Loop(
    {
      update(dt) {
        input.beginFrame(dt);
        game.update(dt);
        // Edge state must be cleared per fixed step, not per rAF frame —
        // otherwise a catch-up frame running two steps double-fires a jump.
        input.endFrame();
        fx.update(dt);
        if (fx.pendingFreeze > 0) {
          loop.freeze = Math.max(loop.freeze, fx.pendingFreeze);
          fx.pendingFreeze = 0;
        }
      },
      render() {
        resetTransform(ctx, size.dpr);
        game.draw(ctx);
      },
    },
    { hz: opts.hz },
  );

  input.attach(canvas);
  audio.setMuted(prefs.muted);

  const stopObserving = observeSize(parent, (w, h) => {
    if (w < 1 || h < 1) return;
    size = fitCanvas(canvas, w, h, { pixelated: opts.pixelated });
    game.resize?.(size.width, size.height);
  });

  // --- lifecycle -----------------------------------------------------------

  let paused = false;
  let destroyed = false;

  const pause = () => {
    if (paused || destroyed) return;
    paused = true;
    loop.stop();
    audio.suspend();
  };

  const resume = () => {
    if (!paused || destroyed) return;
    paused = false;
    audio.resume();
    loop.resync();
    loop.start();
  };

  const onVisibility = () => {
    if (document.hidden) pause();
  };
  const onBlur = () => pause();
  const unlockAudio = () => audio.unlock();

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("blur", onBlur);
  // The browser will not start an AudioContext outside a real gesture.
  canvas.addEventListener("pointerdown", unlockAudio);
  window.addEventListener("keydown", unlockAudio);

  loop.start();

  return {
    get paused() {
      return paused;
    },
    get report() {
      return report;
    },
    pause,
    resume,
    restart() {
      fx.reset();
      input.clear();
      game.restart?.();
      loop.resync();
      emitReport({ status: "playing", score: 0 });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      loop.stop();
      stopObserving();
      input.detach();
      audio.stopMusic();
      game.destroy?.();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    },
  };
}
