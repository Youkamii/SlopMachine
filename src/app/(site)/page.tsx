import Link from "next/link";
import { GAMES } from "@/games/registry";

/**
 * Difficulty as five ascending bars. Drawn as elements rather than the
 * unicode block characters (▁▂▄▆█) — those sit on wildly different baselines
 * depending on which font actually resolves them, and the row never lines up.
 */
function Difficulty({ level, accent }: { level: number; accent: string }) {
  return (
    <span
      className="flex items-end gap-[2px]"
      title={`Difficulty ${level} of 5`}
      aria-label={`Difficulty ${level} of 5`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-[1px]"
          style={{
            height: `${4 + i * 2.5}px`,
            backgroundColor: i < level ? accent : "rgba(107,115,133,0.28)",
          }}
        />
      ))}
    </span>
  );
}

function formatSession(seconds?: number) {
  if (!seconds) return "—";
  if (seconds < 90) return `${seconds}s`;
  return `${Math.round(seconds / 60)} min`;
}

export default function CatalogPage() {
  const count = GAMES.length;

  return (
    <main className="relative min-h-dvh">
      {/* Ground layer: a faint engineering grid, not a gradient. */}
      <div
        aria-hidden
        className="hairline pointer-events-none fixed inset-0 opacity-[0.35]"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_50%_-20%,rgba(204,255,51,0.07),transparent_60%)]"
      />

      <div className="relative mx-auto max-w-5xl px-5 pb-32 pt-16 sm:px-8 sm:pt-24">
        <header className="animate-rise">
          <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-fog">
            <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-acid" />
            <span>line active</span>
            <span className="text-line-solid">/</span>
            <span>{count.toString().padStart(3, "0")} units shipped</span>
          </div>

          <h1 className="mt-6 text-[clamp(3rem,13vw,7.5rem)] font-extrabold leading-[0.82] tracking-[-0.045em]">
            SLOP
            <br />
            <span className="text-acid">MACHINE</span>
          </h1>

          <p className="mt-8 max-w-xl text-[15px] leading-relaxed text-fog sm:text-base">
            An arcade that keeps producing. Every game here is a few kilobytes
            of maths and synthesised sound — no downloads, no accounts, no
            loading bars. Open one, play it in twenty seconds, close the tab.
          </p>
        </header>

        <section className="mt-20">
          <div className="flex items-baseline justify-between border-b border-line-solid pb-3">
            <h2 className="font-mono text-[11px] uppercase tracking-[0.2em] text-fog">
              Catalog
            </h2>
            <span className="flex items-baseline gap-4 font-mono text-[11px] text-fog">
              <Link
                href="/all"
                className="uppercase tracking-[0.16em] transition-colors hover:text-acid"
              >
                everything ↗
              </Link>
              <span>
                {count} {count === 1 ? "title" : "titles"}
              </span>
            </span>
          </div>

          {count === 0 ? (
            <EmptyLine />
          ) : (
            <ol className="mt-2">
              {GAMES.map((game, i) => (
                <li key={game.slug}>
                  <Link
                    href={`/g/${game.slug}`}
                    prefetch={false}
                    className="group relative grid grid-cols-[auto_1fr_auto] items-center gap-x-5 border-b border-line-solid py-6 transition-colors duration-200 hover:bg-surface/60 sm:gap-x-8"
                    style={
                      { "--game-accent": game.accent } as React.CSSProperties
                    }
                  >
                    {/* Accent bar that grows on hover — a real state change, not a fade. */}
                    <span
                      aria-hidden
                      className="absolute bottom-0 left-0 h-px w-0 bg-[var(--game-accent)] transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:w-full"
                    />

                    <span className="font-mono text-xs tabular-nums text-fog transition-colors group-hover:text-[var(--game-accent)]">
                      {(i + 1).toString().padStart(2, "0")}
                    </span>

                    <span className="min-w-0">
                      <span className="block truncate text-xl font-bold tracking-tight transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1 sm:text-2xl">
                        {game.title}
                      </span>
                      <span className="mt-1 block truncate text-sm text-fog">
                        {game.tagline}
                      </span>
                      <span className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.14em] text-fog/70">
                        {game.tags.slice(0, 3).map((t) => (
                          <span key={t}>{t}</span>
                        ))}
                      </span>
                    </span>

                    <span className="flex flex-col items-end gap-2 font-mono text-[10px] uppercase tracking-[0.14em] text-fog/70">
                      <Difficulty level={game.difficulty} accent={game.accent} />
                      <span>{formatSession(game.sessionSeconds)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </section>

        <footer className="mt-24 flex flex-wrap items-center justify-between gap-4 border-t border-line-solid pt-6 font-mono text-[11px] uppercase tracking-[0.16em] text-fog/60">
          <span>Built for the browser. Nothing to install.</span>
          <a
            href="https://github.com/Youkamii/SlopMachine"
            className="transition-colors hover:text-acid"
            target="_blank"
            rel="noreferrer"
          >
            source ↗
          </a>
        </footer>
      </div>
    </main>
  );
}

function EmptyLine() {
  return (
    <div className="mt-16 flex flex-col items-start gap-6 border border-dashed border-line-solid px-6 py-14 sm:px-10">
      <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.2em] text-acid">
        <span className="inline-block h-1.5 w-1.5 animate-blink rounded-full bg-acid" />
        tooling up
      </div>
      <p className="max-w-md text-lg leading-snug text-fog">
        The first units are still on the line. Check back in a moment — this
        page updates itself every time one is finished.
      </p>
    </div>
  );
}
