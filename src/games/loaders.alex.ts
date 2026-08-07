import type { GameLoader } from "./loaders";

/**
 * Code-split entry points for `alex` games.
 *
 * Each value is a thunk containing a literal `import()`. The bundler emits
 * one chunk per call site and none of them end up in the parent chunk.
 * A template-literal import (`import(\`./${slug}/game\`)`) would drag every
 * file under games/ into the graph — never do that.
 */
export const ALEX_LOADERS: Record<string, GameLoader> = {
  grazefield: () => import("./grazefield/game"),
  skipstone: () => import("./skipstone/game"),
  "by-heart": () => import("./by-heart/game"),
  homerow: () => import("./homerow/game"),
  ghostline: () => import("./ghostline/game"),
  "friendly-fire": () => import("./friendly-fire/game"),
  kessler: () => import("./kessler/game"),
};
