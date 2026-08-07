/**
 * Deterministic RNG. Seeded runs are reproducible, which makes daily
 * challenges, replays and "same seed" sharing possible.
 */
export class RNG {
  private s: number;
  readonly seed: number;

  constructor(seed: number = (Math.random() * 0xffffffff) >>> 0) {
    this.seed = seed >>> 0;
    this.s = this.seed || 1;
  }

  /** mulberry32 — fast, tiny, statistically fine for games. */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return Math.floor(this.range(min, max + 1));
  }

  bool(chance = 0.5): boolean {
    return this.next() < chance;
  }

  /** -spread .. +spread */
  spread(spread: number): number {
    return (this.next() * 2 - 1) * spread;
  }

  sign(): number {
    return this.next() < 0.5 ? -1 : 1;
  }

  angle(): number {
    return this.next() * Math.PI * 2;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Weighted pick. `weights` must be the same length as `arr`. */
  pickWeighted<T>(arr: readonly T[], weights: readonly number[]): T {
    let total = 0;
    for (let i = 0; i < weights.length; i++) total += weights[i];
    let r = this.next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return arr[i];
    }
    return arr[arr.length - 1];
  }

  /** In-place Fisher-Yates. Returns the same array. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const t = arr[i];
      arr[i] = arr[j];
      arr[j] = t;
    }
    return arr;
  }

  /** Gaussian-ish via sum of uniforms. mean 0, stddev ~1. */
  normal(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }

  fork(): RNG {
    return new RNG((this.next() * 0xffffffff) >>> 0);
  }
}

/** Turn any string into a 32-bit seed (for daily challenges: seedFrom("2026-08-08")). */
export function seedFrom(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** UTC day key, so everyone gets the same daily seed at the same moment. */
export function todaySeed(salt = ""): number {
  const d = new Date();
  const key = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}${salt}`;
  return seedFrom(key);
}

/** Shared instance for throwaway visual randomness. */
export const rng = new RNG();
