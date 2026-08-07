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
  {
    slug: "friendly-fire",
    title: "Friendly Fire",
    tagline: "You have no attack. Make them walk into each other.",
    description:
      "A 5x5 tactics puzzle where your only actions are moving one tile or waiting. Every kill has to be arranged by luring two enemies onto the same square. Fully telegraphed, fully deterministic, unlimited undo — and every puzzle is machine-solved before you see it, so it is always winnable and never trivial.",
    tags: ["puzzle", "strategy", "deduction"],
    author: "alex",
    difficulty: 2,
    controls: {
      desktop: "Arrows or WASD to move, Space to wait, Z to undo, R to reset.",
      mobile: "Tap a neighbouring tile, or tap yourself to wait.",
    },
    accent: "#d92b2b",
    bg: "#e9ebec",
    released: "2026-08-08",
    sessionSeconds: 150,
  },
  {
    slug: "kessler",
    title: "Kessler",
    tagline: "Success is what triggers the catastrophe.",
    description:
      "Drag to fling satellites into orbit around a planet. Satellites that collide leave debris, debris stays up forever, and debris shreds satellites. Push the constellation far enough and you set off a real cascade — one collision tears a ring, that ring tears the next, and the whole network unzips while you watch, unable to stop it.",
    tags: ["physics", "toy", "strategy"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Drag near the planet to launch. Sideways gives a circular orbit.",
      mobile: "Drag near the planet to launch.",
    },
    accent: "#ff7a45",
    bg: "#0a0410",
    released: "2026-08-08",
    sessionSeconds: 180,
  },
  {
    slug: "ostinato",
    title: "Ostinato",
    tagline: "The solution to the puzzle is the song.",
    description:
      "Everything you do inside a four-bar loop is recorded, and on the next loop a solid ghost of your past self repeats it. Rooms are solved by layering three or four selves — and because each ghost plays one instrument, the arrangement completes at the exact moment the puzzle does. Moves snap to the beat, so playing badly sounds wrong before it looks wrong.",
    tags: ["rhythm", "puzzle", "atmospheric"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Arrows or WASD. Moves snap to the sixteenth. R resets the loop.",
      mobile: "Swipe to move, or tap an adjacent tile.",
    },
    accent: "#5ad2e0",
    bg: "#242932",
    released: "2026-08-08",
    sessionSeconds: 240,
  },
  {
    slug: "shunt",
    title: "Shunt",
    tagline: "You do not move. The row you stand in moves.",
    description:
      "A turn-based grid roguelite where pressing a direction shifts your entire row or column one cell, carrying you, the enemies and everything else along like a slice of a Rubik's cube. Anything pushed past the edge is crushed — that is how you kill, and how you die. You are not walking a floor, you are operating one.",
    tags: ["roguelite", "strategy", "puzzle"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Arrows or WASD. Edge arrows mark what gets crushed.",
      mobile: "Swipe in any direction.",
    },
    accent: "#f5c518",
    bg: "#1c1c1e",
    released: "2026-08-08",
    sessionSeconds: 200,
  },
  {
    slug: "foldscape",
    title: "Foldscape",
    tagline: "Do not walk to the goal. Fold the map until it is here.",
    description:
      "Drag across a crease and the sheet folds, physically overlapping tiles that were at opposite ends of the level. Floors merge, walls refuse. You reach the goal by making the map shorter rather than by crossing it. Every pair about to merge is shown in green or red while you drag, and every sheet is machine-verified solvable before you see it.",
    tags: ["puzzle", "toy", "strategy"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Drag across a crease to fold. Z undo, R reset.",
      mobile: "Drag across a crease to fold.",
    },
    accent: "#e0563b",
    bg: "#f2e2ce",
    released: "2026-08-08",
    sessionSeconds: 210,
  },
  {
    slug: "the-tell",
    title: "The Tell",
    tagline: "Every man moves before he draws. A different move each time.",
    description:
      "A quickdraw duel that is not a reflex test. Each opponent makes a different micro-movement just before drawing, and firing before that tell loses instantly. You lose the first duel learning what to watch for, then win the rematch on two hundred milliseconds. Losing replays the moment in slow motion with the tell circled.",
    tags: ["reflex", "deduction", "arcade"],
    author: "alex",
    difficulty: 2,
    controls: {
      desktop: "Any key or click to draw. Nothing else.",
      mobile: "Tap to draw.",
    },
    accent: "#f6bd60",
    bg: "#84658f",
    released: "2026-08-08",
    sessionSeconds: 90,
  },
  {
    slug: "umbra",
    title: "Umbra",
    tagline: "It walks on its own. You only move the sun.",
    description:
      "The creature walks by itself and burns in direct sunlight. You never touch it — you drag the sun across the sky, and every shadow in the level is redrawn at once. The negative space is the path. One axis of input, and the whole level rearranges with it.",
    tags: ["puzzle", "atmospheric", "one-button"],
    author: "alex",
    difficulty: 3,
    controls: {
      desktop: "Move the mouse, or A / D, to move the sun.",
      mobile: "Drag sideways to move the sun.",
    },
    accent: "#f8d38a",
    bg: "#e2703b",
    released: "2026-08-08",
    sessionSeconds: 150,
  },
  {
    slug: "tideglass",
    title: "Tideglass",
    tagline: "There is nothing to win. Something grows toward your hand.",
    description:
      "A reef that grows toward wherever you point. No goal, no score, no failure state — the quiet tab in a collection that is otherwise all tension. Bioluminescent nodes pluck notes in a mode that drifts every forty seconds, and the garden's genome sits in the URL, so a shared link regrows the same organism.",
    tags: ["toy", "atmospheric"],
    author: "alex",
    difficulty: 1,
    controls: {
      desktop: "Move the mouse. That is the whole game.",
      mobile: "Drag — every finger grows something.",
    },
    accent: "#7df9ff",
    bg: "#03121d",
    released: "2026-08-08",
    sessionSeconds: 120,
  },
];
