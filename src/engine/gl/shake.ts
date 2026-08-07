/**
 * Camera shake, hit-stop and time dilation — the three things that make a
 * hit land. Kept out of the games so they all feel like they come from the
 * same hand.
 */

import * as THREE from "three";

export class Shake {
  private trauma = 0;
  private t = 0;
  private readonly seedX = Math.random() * 1000;
  private readonly seedY = Math.random() * 1000;
  private readonly seedZ = Math.random() * 1000;

  /** Additive. Trauma decays quadratically, so small hits stay subtle. */
  add(amount: number) {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  get amount() {
    return this.trauma;
  }

  update(dt: number) {
    this.t += dt;
    this.trauma = Math.max(0, this.trauma - dt * 1.6);
  }

  /**
   * Applies the shake as an offset + roll to a camera that has already been
   * positioned this frame. Call last, right before rendering.
   */
  apply(camera: THREE.Camera, magnitude = 1) {
    if (this.trauma <= 0) return;
    const s = this.trauma * this.trauma * magnitude;
    const t = this.t * 34;
    camera.position.x += noise(t + this.seedX) * s;
    camera.position.y += noise(t + this.seedY) * s;
    camera.position.z += noise(t + this.seedZ) * s * 0.5;
    camera.rotateZ(noise(t * 0.7 + 41.3) * s * 0.06);
  }
}

/** Cheap smooth pseudo-noise in [-1, 1]. Three sines beat a random(). */
function noise(x: number) {
  return (
    Math.sin(x) * 0.5 + Math.sin(x * 2.13 + 1.7) * 0.3 + Math.sin(x * 4.7) * 0.2
  );
}

/**
 * Time control: a hard freeze for impact, and a slow-motion ramp for the
 * moments a game wants to show off.
 *
 * Games multiply their own `dt` by `scale` and skip the frame when `frozen`.
 */
export class TimeWarp {
  private freeze = 0;
  private slow = 1;
  private slowLeft = 0;
  private slowStrength = 1;

  /** Stops the world dead. 0.06 for a normal hit, 0.16 for a kill. */
  hitStop(seconds: number) {
    this.freeze = Math.max(this.freeze, seconds);
  }

  /** `strength` is the time scale to fall to, e.g. 0.25 for quarter speed. */
  slowMo(seconds: number, strength = 0.3) {
    this.slowLeft = Math.max(this.slowLeft, seconds);
    this.slowStrength = Math.min(this.slowStrength, strength);
  }

  get frozen() {
    return this.freeze > 0;
  }

  get scale() {
    return this.slow;
  }

  /** Feed real elapsed time. Returns the scaled dt the game should use. */
  step(dtReal: number): number {
    if (this.freeze > 0) {
      this.freeze -= dtReal;
      return 0;
    }
    if (this.slowLeft > 0) {
      this.slowLeft -= dtReal;
      // Ease back to full speed over the last third so it does not snap.
      const target = this.slowLeft > 0 ? this.slowStrength : 1;
      this.slow += (target - this.slow) * Math.min(1, dtReal * 12);
      if (this.slowLeft <= 0) this.slowStrength = 1;
    } else {
      this.slow += (1 - this.slow) * Math.min(1, dtReal * 6);
      if (this.slow > 0.995) this.slow = 1;
    }
    return dtReal * this.slow;
  }

  reset() {
    this.freeze = 0;
    this.slow = 1;
    this.slowLeft = 0;
    this.slowStrength = 1;
  }
}
