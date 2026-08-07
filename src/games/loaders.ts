import { ALEX_LOADERS } from "./loaders.alex";
import { STEVE_LOADERS } from "./loaders.steve";
import type { GameFactory } from "./types";

export type GameLoader = () => Promise<{ default: GameFactory }>;

export const LOADERS: Record<string, GameLoader> = {
  ...ALEX_LOADERS,
  ...STEVE_LOADERS,
};

export function getLoader(slug: string): GameLoader | undefined {
  return LOADERS[slug];
}
