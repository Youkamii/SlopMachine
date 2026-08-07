/**
 * Namespaced, SSR-safe, quota-safe local persistence.
 *
 * Every game gets its own prefix so a bad key in one game can never corrupt
 * another. All reads are defensive: a user with localStorage disabled, a
 * private window, or a half-written value must not crash the game.
 */

const PREFIX = "sm";

function available(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const k = "__sm_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return true;
  } catch {
    return false;
  }
}

let cachedAvailable: boolean | null = null;
function ok(): boolean {
  if (cachedAvailable === null) cachedAvailable = available();
  return cachedAvailable;
}

export class GameStore {
  private readonly ns: string;

  constructor(gameSlug: string) {
    this.ns = `${PREFIX}:${gameSlug}:`;
  }

  get<T>(key: string, fallback: T): T {
    if (!ok()) return fallback;
    try {
      const raw = window.localStorage.getItem(this.ns + key);
      if (raw === null) return fallback;
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  set<T>(key: string, value: T): void {
    if (!ok()) return;
    try {
      window.localStorage.setItem(this.ns + key, JSON.stringify(value));
    } catch {
      // Quota exceeded or blocked — losing a high score beats crashing.
    }
  }

  remove(key: string): void {
    if (!ok()) return;
    try {
      window.localStorage.removeItem(this.ns + key);
    } catch {
      /* ignore */
    }
  }

  /** Store a personal best. Returns true when the record was beaten. */
  recordBest(key: string, value: number, higherIsBetter = true): boolean {
    const current = this.get<number | null>(key, null);
    const better =
      current === null ||
      (higherIsBetter ? value > current : value < current);
    if (better) this.set(key, value);
    return better;
  }

  best(key: string): number | null {
    return this.get<number | null>(key, null);
  }

  /** Increment a counter (plays, deaths, total score...). */
  bump(key: string, by = 1): number {
    const next = this.get<number>(key, 0) + by;
    this.set(key, next);
    return next;
  }
}

/** Site-wide preferences, shared across every game. */
export const prefs = {
  get muted(): boolean {
    if (!ok()) return false;
    try {
      return window.localStorage.getItem(`${PREFIX}:muted`) === "1";
    } catch {
      return false;
    }
  },
  set muted(v: boolean) {
    if (!ok()) return;
    try {
      window.localStorage.setItem(`${PREFIX}:muted`, v ? "1" : "0");
    } catch {
      /* ignore */
    }
  },
  markPlayed(slug: string) {
    if (!ok()) return;
    try {
      const raw = window.localStorage.getItem(`${PREFIX}:played`);
      const list: string[] = raw ? JSON.parse(raw) : [];
      if (!list.includes(slug)) {
        list.push(slug);
        window.localStorage.setItem(`${PREFIX}:played`, JSON.stringify(list));
      }
    } catch {
      /* ignore */
    }
  },
  played(): string[] {
    if (!ok()) return [];
    try {
      const raw = window.localStorage.getItem(`${PREFIX}:played`);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch {
      return [];
    }
  },
};
