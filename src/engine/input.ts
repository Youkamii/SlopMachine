/**
 * Unified input. Keyboard, mouse and touch all land in the same place, and
 * pointer coordinates are already converted to canvas CSS pixels so game code
 * never touches getBoundingClientRect.
 *
 * Call `endFrame()` at the end of every update so the per-frame edge sets
 * (`justPressed` / `justReleased`) behave.
 */

export interface PointerState {
  x: number;
  y: number;
  /** Movement since the previous frame, in canvas pixels. */
  dx: number;
  dy: number;
  down: boolean;
  justDown: boolean;
  justUp: boolean;
  /** Where the current press started — useful for swipes and drags. */
  startX: number;
  startY: number;
  /** Seconds the current press has been held. */
  heldFor: number;
  /** True once a pointer has ever touched this canvas. */
  everMoved: boolean;
}

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
}

const LEFT = ["ArrowLeft", "KeyA"];
const RIGHT = ["ArrowRight", "KeyD"];
const UP = ["ArrowUp", "KeyW"];
const DOWN = ["ArrowDown", "KeyS"];
const CONFIRM = ["Space", "Enter", "KeyZ", "KeyJ"];

/** Keys the browser would otherwise use to scroll the page. */
const SCROLL_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Space",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

export class Input {
  readonly down = new Set<string>();
  readonly justPressed = new Set<string>();
  readonly justReleased = new Set<string>();

  readonly pointer: PointerState = {
    x: 0,
    y: 0,
    dx: 0,
    dy: 0,
    down: false,
    justDown: false,
    justUp: false,
    startX: 0,
    startY: 0,
    heldFor: 0,
    everMoved: false,
  };

  /** All active touches, for pinch/multi-thumb controls. */
  readonly touches = new Map<number, TouchPoint>();

  /** Set true on any key or pointer press — drives "press anything to start". */
  anyPressed = false;

  /** True when the device has a coarse pointer (phone/tablet). */
  readonly isTouch =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;

  private el: HTMLElement | null = null;
  private prevX = 0;
  private prevY = 0;
  private detachers: Array<() => void> = [];

  attach(el: HTMLElement) {
    this.detach();
    this.el = el;

    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLElement,
      type: K,
      handler: (ev: WindowEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type as string, handler as EventListener, opts);
      this.detachers.push(() =>
        target.removeEventListener(type as string, handler as EventListener, opts),
      );
    };

    on(window, "keydown", this.onKeyDown);
    on(window, "keyup", this.onKeyUp);
    on(window, "blur", this.onBlur);
    on(el, "pointerdown", this.onPointerDown as (e: Event) => void);
    on(window, "pointermove", this.onPointerMove as (e: Event) => void);
    on(window, "pointerup", this.onPointerUp as (e: Event) => void);
    on(window, "pointercancel", this.onPointerUp as (e: Event) => void);
    on(el, "contextmenu", this.onContextMenu as (e: Event) => void);
  }

  detach() {
    for (const d of this.detachers) d();
    this.detachers = [];
    this.el = null;
    this.clear();
  }

  clear() {
    this.down.clear();
    this.justPressed.clear();
    this.justReleased.clear();
    this.touches.clear();
    this.pointer.down = false;
    this.pointer.justDown = false;
    this.pointer.justUp = false;
    this.pointer.heldFor = 0;
  }

  // --- queries -------------------------------------------------------------

  isDown(...codes: string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  wasPressed(...codes: string[]): boolean {
    for (const c of codes) if (this.justPressed.has(c)) return true;
    return false;
  }

  wasReleased(...codes: string[]): boolean {
    for (const c of codes) if (this.justReleased.has(c)) return true;
    return false;
  }

  /** -1 / 0 / +1 from arrows or WASD. */
  get axisX(): number {
    return (this.isDown(...RIGHT) ? 1 : 0) - (this.isDown(...LEFT) ? 1 : 0);
  }

  /** -1 is up (screen space), +1 is down. */
  get axisY(): number {
    return (this.isDown(...DOWN) ? 1 : 0) - (this.isDown(...UP) ? 1 : 0);
  }

  get confirmPressed(): boolean {
    return this.wasPressed(...CONFIRM);
  }

  /** Straight-line distance of the current drag. */
  get dragDistance(): number {
    return Math.hypot(
      this.pointer.x - this.pointer.startX,
      this.pointer.y - this.pointer.startY,
    );
  }

  get dragAngle(): number {
    return Math.atan2(
      this.pointer.y - this.pointer.startY,
      this.pointer.x - this.pointer.startX,
    );
  }

  // --- frame bookkeeping ---------------------------------------------------

  /** Advance held timers. Call once per fixed update, before game logic. */
  beginFrame(dt: number) {
    if (this.pointer.down) this.pointer.heldFor += dt;
    this.pointer.dx = this.pointer.x - this.prevX;
    this.pointer.dy = this.pointer.y - this.prevY;
    this.prevX = this.pointer.x;
    this.prevY = this.pointer.y;
  }

  /** Clear edge-triggered state. Call once per fixed update, after game logic. */
  endFrame() {
    this.justPressed.clear();
    this.justReleased.clear();
    this.pointer.justDown = false;
    this.pointer.justUp = false;
    this.anyPressed = false;
  }

  // --- handlers ------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent) => {
    // Let the user still reach browser chrome and devtools.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (SCROLL_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    this.down.add(e.code);
    this.justPressed.add(e.code);
    this.anyPressed = true;
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.down.delete(e.code);
    this.justReleased.add(e.code);
  };

  /** Losing focus mid-hold would otherwise leave a key stuck forever. */
  private onBlur = () => {
    for (const code of this.down) this.justReleased.add(code);
    this.down.clear();
    this.pointer.down = false;
  };

  private onContextMenu = (e: MouseEvent) => e.preventDefault();

  private toLocal(clientX: number, clientY: number) {
    if (!this.el) return { x: clientX, y: clientY };
    const r = this.el.getBoundingClientRect();
    // Scale in case CSS is sizing the element differently from its box.
    const sx = r.width === 0 ? 1 : this.el.clientWidth / r.width;
    const sy = r.height === 0 ? 1 : this.el.clientHeight / r.height;
    return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
  }

  private onPointerDown = (e: PointerEvent) => {
    const p = this.toLocal(e.clientX, e.clientY);
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.prevX = p.x;
    this.prevY = p.y;
    this.pointer.startX = p.x;
    this.pointer.startY = p.y;
    this.pointer.down = true;
    this.pointer.justDown = true;
    this.pointer.heldFor = 0;
    this.pointer.everMoved = true;
    this.anyPressed = true;
    this.touches.set(e.pointerId, {
      id: e.pointerId,
      x: p.x,
      y: p.y,
      startX: p.x,
      startY: p.y,
    });
    // Keep receiving move/up even if the finger leaves the canvas.
    if (this.el && "setPointerCapture" in this.el) {
      try {
        (this.el as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* some browsers refuse on synthetic events; harmless */
      }
    }
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    const p = this.toLocal(e.clientX, e.clientY);
    this.pointer.x = p.x;
    this.pointer.y = p.y;
    this.pointer.everMoved = true;
    const t = this.touches.get(e.pointerId);
    if (t) {
      t.x = p.x;
      t.y = p.y;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.touches.size === 0) {
      this.pointer.down = false;
      this.pointer.justUp = true;
      this.pointer.heldFor = 0;
    }
  };
}
