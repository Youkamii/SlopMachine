import { ALEX_GAMES } from "./registry.alex";
import { STEVE_GAMES } from "./registry.steve";
import type { GameMeta } from "./types";

/**
 * The catalog. Merged from the two per-author registries so the two
 * worktrees never touch the same file.
 *
 * Consumed by Server Components only — costs zero client JavaScript.
 */
export const GAMES: GameMeta[] = [...ALEX_GAMES, ...STEVE_GAMES].sort(
  (a, b) => b.released.localeCompare(a.released) || a.title.localeCompare(b.title),
);

export const BY_SLUG = new Map(GAMES.map((g) => [g.slug, g]));

export function getGame(slug: string): GameMeta | undefined {
  return BY_SLUG.get(slug);
}
