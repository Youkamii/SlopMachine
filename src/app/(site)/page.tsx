import Link from "next/link";
import { GAMES } from "@/games/registry";
import { hasPoster, posterSrc } from "@/games/posters";
import type { GameMeta } from "@/games/types";

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

/**
 * A poster card.
 *
 * The image is a real frame from the game, captured by driving the deployed
 * build with an input bot. Where a poster does not exist yet the card falls
 * back to a field built from the game's own accent colour, so a missing
 * capture degrades into a designed placeholder rather than a grey box.
 */
function Card({
  game,
  index,
  large,
}: {
  game: GameMeta;
  index: number;
  large?: boolean;
}) {
  const poster = hasPoster(game.slug);

  return (
    <Link
      href={`/g/${game.slug}`}
      prefetch={false}
      className={`group relative flex flex-col overflow-hidden border border-line-solid bg-surface transition-colors duration-300 hover:border-[var(--ga)] ${
        large ? "sm:col-span-2" : ""
      }`}
      style={{ "--ga": game.accent } as React.CSSProperties}
    >
      <div
        className={`relative w-full overflow-hidden ${
          large ? "aspect-[16/8]" : "aspect-[16/10]"
        }`}
      >
        {poster ? (
          // eslint-disable-next-line @next/next/no-img-element -- static export,
          // no image optimiser; these are already sized and compressed.
          <img
            src={posterSrc(game.slug)}
            alt=""
            loading={index < 4 ? "eager" : "lazy"}
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover transition-transform duration-[900ms] ease-out-quint group-hover:scale-[1.045]"
          />
        ) : (
          <div
            aria-hidden
            className="absolute inset-0"
            style={{
              background: `radial-gradient(120% 90% at 25% 0%, ${game.accent}22, transparent 62%), ${game.bg}`,
            }}
          >
            <div className="hairline absolute inset-0 opacity-40" />
            <span
              className="absolute bottom-3 right-4 font-mono text-[64px] font-bold leading-none opacity-[0.10]"
              style={{ color: game.accent }}
            >
              {game.title.slice(0, 2).toUpperCase()}
            </span>
          </div>
        )}

        {/* Scrim so the title stays legible over any frame. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-t from-ink via-ink/25 to-transparent"
        />

        {game.webgl ? (
          <span
            className="absolute left-3 top-3 border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.18em]"
            style={{
              color: game.accent,
              borderColor: `${game.accent}55`,
              backgroundColor: "#07070aaa",
            }}
          >
            3d
          </span>
        ) : null}

        <span className="absolute right-3 top-3 font-mono text-[10px] tabular-nums text-chalk/45">
          {(index + 1).toString().padStart(2, "0")}
        </span>

        <div className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
          <h3
            className={`font-bold leading-none tracking-tight ${
              large ? "text-3xl sm:text-4xl" : "text-2xl"
            }`}
          >
            {game.title}
          </h3>
          <p className="mt-2 line-clamp-2 text-[13px] leading-snug text-chalk/60">
            {game.tagline}
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line-solid px-4 py-3 font-mono text-[10px] uppercase tracking-[0.14em] text-fog/70 sm:px-5">
        <span className="flex min-w-0 gap-3 truncate">
          {game.tags.slice(0, large ? 3 : 2).map((t) => (
            <span key={t}>{t}</span>
          ))}
        </span>
        <span className="flex shrink-0 items-center gap-3">
          <Difficulty level={game.difficulty} accent={game.accent} />
          <span>{formatSession(game.sessionSeconds)}</span>
        </span>
      </div>

      {/* A real state change on hover, not a fade. */}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-px w-0 bg-[var(--ga)] transition-[width] duration-500 ease-out-quint group-hover:w-full"
      />
    </Link>
  );
}

export default function CatalogPage() {
  const count = GAMES.length;
  // 3D titles lead. They are the ones worth putting a large frame around,
  // and the ordering makes the shift in what this arcade is producing
  // legible without a paragraph explaining it.
  const ordered = [...GAMES].sort((a, b) => {
    const w = Number(!!b.webgl) - Number(!!a.webgl);
    return w || b.released.localeCompare(a.released) || a.title.localeCompare(b.title);
  });

  return (
    <main className="relative min-h-dvh">
      <div
        aria-hidden
        className="hairline pointer-events-none fixed inset-0 opacity-[0.35]"
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[radial-gradient(ellipse_at_50%_-20%,rgba(204,255,51,0.07),transparent_60%)]"
      />

      <div className="relative mx-auto max-w-6xl px-5 pb-32 pt-16 sm:px-8 sm:pt-24">
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
            <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {ordered.map((game, i) => (
                <Card key={game.slug} game={game} index={i} large={i < 2} />
              ))}
            </div>
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
