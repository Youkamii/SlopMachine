import type { Metadata } from "next";
import Link from "next/link";
import { ALEX_GAMES } from "@/games/registry.alex";
import { STEVE_GAMES } from "@/games/registry.steve";
import type { GameMeta } from "@/games/types";

export const metadata: Metadata = {
  title: "Everything",
  description:
    "The whole production line at a glance — every game, who built it, and what it is.",
};

const BUILDERS = [
  {
    id: "alex" as const,
    name: "Alex",
    hint: "Claude",
    games: ALEX_GAMES,
  },
  {
    id: "steve" as const,
    name: "Steve",
    hint: "Codex",
    games: STEVE_GAMES,
  },
];

function tally(games: GameMeta[]) {
  const tags = new Map<string, number>();
  let seconds = 0;
  for (const g of games) {
    for (const t of g.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    seconds += g.sessionSeconds ?? 0;
  }
  return {
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]),
    minutes: Math.round(seconds / 60),
  };
}

export default function EverythingPage() {
  const all = [...ALEX_GAMES, ...STEVE_GAMES];
  const stats = tally(all);

  return (
    <main className="relative min-h-dvh">
      <div
        aria-hidden
        className="hairline pointer-events-none fixed inset-0 opacity-[0.3]"
      />

      <div className="relative mx-auto max-w-6xl px-5 pb-32 pt-14 sm:px-8">
        <header>
          <Link
            href="/"
            className="font-mono text-[11px] uppercase tracking-[0.18em] text-fog transition-colors hover:text-acid"
          >
            ← slop machine
          </Link>

          <h1 className="mt-7 text-[clamp(2.2rem,7vw,4rem)] font-extrabold leading-[0.88] tracking-[-0.04em]">
            The whole line
          </h1>

          {/* Production readout rather than a stat-card row. */}
          <dl className="mt-9 grid grid-cols-2 gap-x-8 gap-y-5 border-y border-line-solid py-6 font-mono sm:grid-cols-4">
            <Stat label="titles" value={all.length.toString().padStart(3, "0")} />
            <Stat label="by alex" value={ALEX_GAMES.length.toString().padStart(3, "0")} />
            <Stat label="by steve" value={STEVE_GAMES.length.toString().padStart(3, "0")} />
            <Stat label="play time" value={`~${stats.minutes}m`} />
          </dl>

          {stats.tags.length > 0 ? (
            <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-[10px] uppercase tracking-[0.14em] text-fog/70">
              {stats.tags.map(([tag, n]) => (
                <span key={tag}>
                  {tag}
                  <span className="ml-1.5 text-fog/40">{n}</span>
                </span>
              ))}
            </div>
          ) : null}
        </header>

        {BUILDERS.map((builder) => (
          <section key={builder.id} className="mt-20">
            <div className="flex items-baseline justify-between border-b border-line-solid pb-3">
              <h2 className="flex items-baseline gap-3">
                <span className="text-xl font-bold tracking-tight">
                  {builder.name}
                </span>
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fog/60">
                  {builder.hint}
                </span>
              </h2>
              <span className="font-mono text-[11px] text-fog">
                {builder.games.length}{" "}
                {builder.games.length === 1 ? "title" : "titles"}
              </span>
            </div>

            {builder.games.length === 0 ? (
              <p className="mt-8 max-w-md font-mono text-[11px] uppercase leading-relaxed tracking-[0.14em] text-fog/50">
                nothing on the line yet
              </p>
            ) : (
              <ul className="mt-2 grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">
                {[...builder.games]
                  .sort((a, b) => a.title.localeCompare(b.title))
                  .map((game) => (
                    <li key={game.slug}>
                      <Link
                        href={`/g/${game.slug}`}
                        prefetch={false}
                        className="group flex gap-4 border-b border-line-solid py-5 transition-colors hover:bg-surface/50"
                      >
                        {/* The game's own colour, as a physical swatch. */}
                        <span
                          aria-hidden
                          className="mt-1 h-10 w-1 shrink-0 rounded-full transition-transform duration-300 group-hover:scale-y-125"
                          style={{ backgroundColor: game.accent }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-base font-bold tracking-tight">
                            {game.title}
                          </span>
                          <span className="mt-1 block text-[13px] leading-snug text-fog">
                            {game.tagline}
                          </span>
                          <span className="mt-2 flex flex-wrap gap-x-2.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-fog/55">
                            {game.tags.map((t) => (
                              <span key={t}>{t}</span>
                            ))}
                            <span className="text-fog/35">
                              {"·".repeat(1)} lv{game.difficulty}
                            </span>
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            )}
          </section>
        ))}

        <footer className="mt-24 flex flex-wrap items-center justify-between gap-4 border-t border-line-solid pt-6 font-mono text-[11px] uppercase tracking-[0.16em] text-fog/60">
          <Link href="/" className="transition-colors hover:text-acid">
            ← back to the catalog
          </Link>
          <a
            href="https://github.com/Youkamii/SlopMachine"
            target="_blank"
            rel="noreferrer"
            className="transition-colors hover:text-acid"
          >
            source ↗
          </a>
        </footer>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.2em] text-fog/60">
        {label}
      </dt>
      <dd className="mt-1.5 text-2xl font-bold tabular-nums tracking-tight text-chalk">
        {value}
      </dd>
    </div>
  );
}
