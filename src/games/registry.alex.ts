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
  {
    slug: "skipstone",
    title: "Skipstone",
    tagline: "You are the bullet. The floor is the only thing that kills.",
    description:
      "Pull back and let go to fling yourself across the page. You get one dash, and the only way to get it back is to hit something — so there is no safe landing and a run is one unbroken chain. Every dash leaves ink behind, so the end of a run is a drawing of how you played it.",
    tags: ["action", "physics", "arcade"],
    author: "alex",
    difficulty: 2,
    controls: {
      desktop: "Drag with the mouse and release. Pull back to aim.",
      mobile: "Drag anywhere and let go.",
    },
    accent: "#d64000",
    bg: "#efe9dc",
    released: "2026-08-08",
    sessionSeconds: 60,
  },
  {
    slug: "by-heart",
    title: "By Heart",
    tagline: "A shape appears, then leaves. Draw it back.",
    description:
      "A glyph nobody has drawn before is written out in front of you, held for a moment, and taken away. Redraw it from memory in one unbroken stroke. Scoring ignores where and how big you drew it, keeps the tilt, and accepts a stroke drawn backwards — then shows you exactly which part of the shape you lost.",
    tags: ["puzzle", "toy", "atmospheric"],
    author: "alex",
    difficulty: 2,
    controls: {
      desktop: "Hold the mouse button and draw in one stroke.",
      mobile: "Draw with one finger without lifting.",
    },
    accent: "#e8a33d",
    bg: "#17110c",
    released: "2026-08-08",
    sessionSeconds: 90,
  },
  {
    slug: "homerow",
    title: "Homerow",
    tagline: "The keyboard is the arena. A key moves you to where it sits.",
    description:
      "The playfield is a QWERTY keyboard and pressing a key teleports you to that key's physical position — so SAD is a short safe hop and POLYGON is a sprint across the board. Keys arm and detonate; spelling a real word defuses every key it crosses. Reads physical key positions, so it plays the same on any layout.",
    tags: ["word", "reflex", "arcade"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Type. Any letter key jumps you to that key.",
      mobile: "Tap keys on the drawn board — it is the same board.",
    },
    accent: "#5ce1e6",
    bg: "#0d1424",
    released: "2026-08-08",
    sessionSeconds: 80,
  },
  {
    slug: "ghostline",
    title: "Ghostline",
    tagline: "Every lap you finish comes back. As a wall.",
    description:
      "A time trial on one fixed track. Each lap you complete is recorded and returns as a solid, collidable ghost — so the better you get, the more crowded the course becomes. Eventually the only way through is a line none of your past selves ever took. Your history is the difficulty curve.",
    tags: ["action", "reflex", "endless"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Hold the mouse to steer, or use A / D.",
      mobile: "Drag to steer.",
    },
    accent: "#5eead4",
    bg: "#02100e",
    released: "2026-08-08",
    sessionSeconds: 70,
  },
];
