import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BY_SLUG, GAMES } from "@/games/registry";
import GameStage from "./GameStage";

/** Unknown slugs 404 at build time rather than invoking a function. */
export const dynamicParams = false;
export const dynamic = "force-static";

export function generateStaticParams() {
  return GAMES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const game = BY_SLUG.get(slug);
  if (!game) return {};
  return {
    title: game.title,
    description: game.description,
    openGraph: {
      title: game.title,
      description: game.description,
      type: "website",
    },
  };
}

export default async function GamePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const game = BY_SLUG.get(slug);
  if (!game) notFound();

  return (
    <GameStage slug={game.slug} title={game.title} accent={game.accent} />
  );
}
