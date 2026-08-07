import type { GameMeta } from "./types";

/**
 * Games built in the `alex` worktree.
 *
 * DATA ONLY — this file must never import game code, or every game's bundle
 * gets pulled into any chunk that touches the catalog. Code lives in
 * `loaders.alex.ts`.
 */
export const ALEX_GAMES: GameMeta[] = [];
