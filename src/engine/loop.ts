/**
 * Fixed-timestep game loop with an accumulator.
 *
 * Physics/gameplay tick at a constant rate so behaviour is identical on a
 * 60Hz laptop and a 165Hz gaming monitor. Rendering happens once per rAF with
 * an `alpha` value for interpolation when a game cares about it.
 */

export interface LoopHandlers {
  /** Called at a fixed rate. `dt` is always `1 / hz`. */
  update: (dt: number) => void;
  /** Called once per animation frame. `alpha` is 0..1 within the current step. */
  render: (alpha: number) => void;
}

export interface LoopOptions {
  hz?: number;
  /** Hard cap on catch-up steps to avoid the spiral of death after a stall. */
  maxSteps?: number;
}

export class Loop {
  private readonly step: number;
  private readonly maxSteps: number;
  private accumulator = 0;
  private last = 0;
  private raf = 0;
  private running = false;
  private handlers: LoopHandlers;

  /** Seconds of gameplay time to swallow before the next update (hit-stop). */
  freeze = 0;
  /** Multiplies gameplay time. 0.3 = slow motion, 2 = double speed. */
  timeScale = 1;
  /** Wall-clock seconds since start(), ignoring freeze. Handy for shaders. */
  elapsed = 0;

  constructor(handlers: LoopHandlers, opts: LoopOptions = {}) {
    this.handlers = handlers;
    this.step = 1 / (opts.hz ?? 60);
    this.maxSteps = opts.maxSteps ?? 5;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    this.accumulator = 0;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** Drop accumulated time — call after unpausing so we don't fast-forward. */
  resync() {
    this.last = performance.now();
    this.accumulator = 0;
  }

  private tick = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.tick);

    // Clamp: a backgrounded tab or a breakpoint must not produce a 30s delta.
    let frame = (now - this.last) / 1000;
    this.last = now;
    if (frame > 0.25) frame = 0.25;
    this.elapsed += frame;

    let scaled = frame * this.timeScale;

    if (this.freeze > 0) {
      const eaten = Math.min(this.freeze, scaled);
      this.freeze -= eaten;
      scaled -= eaten;
    }

    this.accumulator += scaled;

    let steps = 0;
    while (this.accumulator >= this.step && steps < this.maxSteps) {
      this.handlers.update(this.step);
      this.accumulator -= this.step;
      steps++;
    }
    // If we blew the budget, drop the backlog rather than compounding it.
    if (steps === this.maxSteps) this.accumulator = 0;

    this.handlers.render(this.accumulator / this.step);
  };
}
