import type { GameMeta } from "./types";

/**
 * Games built in the `alex` worktree.
 *
 * DATA ONLY — this file must never import game code, or every game's bundle
 * gets pulled into any chunk that touches the catalog. Code lives in
 * `loaders.alex.ts`.
 */
export const ALEX_GAMES: GameMeta[] = [
  {
    slug: "grazefield",
    title: "Grazefield",
    tagline: "You have no weapon. Almost dying is the weapon.",
    description:
      "A bullet hell where the only way to fight back is to nearly be hit. Passing within a few pixels of a bullet grazes it, charging a beam and bleeding colour into a monochrome world. Play it safe and the screen stays grey; live on the edge and it blooms.",
    tags: ["action", "arcade", "reflex"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Mouse to move, or WASD. Hold Shift to slow down.",
      mobile: "Drag anywhere — your finger never covers the ship.",
    },
    accent: "#ff2e88",
    bg: "#050507",
    released: "2026-08-08",
    sessionSeconds: 75,
  },
];
