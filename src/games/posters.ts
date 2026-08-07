import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Which games have a captured poster frame.
 *
 * Posters are real gameplay stills, taken by driving the deployed build with
 * a synthetic input bot and screenshotting mid-run. They are checked in under
 * public/posters/, so the catalog can be a wall of images instead of a wall
 * of text — which matters for an arcade whose games are mostly about how they
 * look in motion.
 *
 * Read at build time. This module is server-only; importing it from a client
 * component will fail the build, which is the intended guard rail.
 */
const POSTER_DIR = join(process.cwd(), "public", "posters");

export function hasPoster(slug: string): boolean {
  return existsSync(join(POSTER_DIR, `${slug}.jpg`));
}

export function posterSrc(slug: string): string {
  return `/posters/${slug}.jpg`;
}
