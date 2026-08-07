"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { audio } from "@/engine/audio";
import type { GameHandle } from "@/engine/mount";
import { mountGame } from "@/engine/mount";
import { prefs } from "@/engine/storage";
import { getLoader } from "@/games/loaders";
import type { GameReport } from "@/games/types";
import SwarmHud from "./SwarmHud";

type Phase = "loading" | "ready" | "missing" | "stale";

interface Props {
  slug: string;
  title: string;
  accent: string;
  pixelated?: boolean;
  webgl?: boolean;
}

/**
 * The thin React shell around a game.
 *
 * Deliberately minimal: a back arrow and a mute toggle. Every game draws its
 * own HUD, title screen and game-over card on the canvas, because a shared
 * chrome across a whole catalog is exactly what makes a collection of games
 * feel mass-produced.
 */
export default function GameStage({
  slug,
  title,
  accent,
  pixelated,
  webgl,
}: Props) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [muted, setMuted] = useState(false);
  const [report, setReport] = useState<GameReport>({});
  const handleRef = useRef<GameHandle | null>(null);

  useEffect(() => {
    setMuted(prefs.muted);
    prefs.markPlayed(slug);
  }, [slug]);

  const canvasRef = useCallback(
    (canvas: HTMLCanvasElement | null) => {
      if (!canvas) return;

      const loader = getLoader(slug);
      if (!loader) {
        setPhase("missing");
        return;
      }

      let cancelled = false;
      let handle: GameHandle | null = null;

      loader()
        .then(({ default: factory }) => {
          if (cancelled) return;
          handle = mountGame(canvas, factory, {
            slug,
            pixelated,
            webgl,
            onReport: setReport,
          });
          handleRef.current = handle;
          setPhase("ready");
        })
        .catch((err) => {
          if (cancelled) return;
          // A chunk that 404s almost always means the deployment moved on
          // while this tab stayed open.
          console.error(`[${slug}] failed to load`, err);
          setPhase("stale");
        });

      // React 19 ref cleanup — strictly paired with attach, StrictMode-safe.
      return () => {
        cancelled = true;
        handle?.destroy();
        handleRef.current = null;
      };
    },
    [slug, pixelated, webgl],
  );

  const toggleMute = useCallback(() => {
    const next = !prefs.muted;
    prefs.muted = next;
    audio.setMuted(next);
    setMuted(next);
  }, []);

  // Keyboard shortcuts owned by the shell, not by individual games.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === "KeyM") {
        e.preventDefault();
        toggleMute();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleMute]);

  return (
    <div className="relative h-full w-full bg-ink">
      <canvas ref={canvasRef} />

      {report.hud?.kind === "swarm" ? <SwarmHud hud={report.hud} /> : null}

      {/* Chrome. Sits above the canvas but never intercepts play input. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3 sm:p-4">
        <Link
          href="/"
          className="tappable pointer-events-auto flex h-9 items-center gap-2 rounded-full bg-ink/85 px-3 font-mono text-[11px] uppercase tracking-[0.14em] text-fog backdrop-blur transition-colors hover:text-chalk"
          aria-label="Back to the catalog"
        >
          <span aria-hidden>←</span>
          <span className="hidden sm:inline">{title}</span>
        </Link>

        <div className="pointer-events-auto flex items-center gap-2">
          <button
            onClick={toggleMute}
            className="tappable flex h-9 w-9 items-center justify-center rounded-full bg-ink/85 font-mono text-[11px] text-fog backdrop-blur transition-colors hover:text-chalk"
            aria-label={muted ? "Unmute" : "Mute"}
            aria-pressed={muted}
          >
            {muted ? "off" : "on"}
          </button>
        </div>
      </div>

      {phase === "loading" ? <Splash accent={accent} title={title} /> : null}
      {phase === "missing" ? (
        <Notice
          heading="Not on the line yet"
          body="This game has a page but no build. It is probably being assembled right now."
        />
      ) : null}
      {phase === "stale" ? (
        <Notice
          heading="A newer version shipped"
          body="This tab is running an old build, so the game files no longer exist. Reload to pick up the current one."
          action={
            <button
              onClick={() => window.location.reload()}
              className="tappable mt-6 border border-acid px-5 py-2 font-mono text-[11px] uppercase tracking-[0.16em] text-acid transition-colors hover:bg-acid hover:text-ink"
            >
              reload
            </button>
          }
        />
      ) : null}
    </div>
  );
}

function Splash({ accent, title }: { accent: string; title: string }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-ink">
      <div
        className="h-px w-24 overflow-hidden"
        style={{ backgroundColor: "rgba(255,255,255,0.08)" }}
      >
        <div
          className="h-full w-full"
          style={{
            backgroundColor: accent,
            animation: "sweep 1.1s cubic-bezier(0.22,1,0.36,1) infinite",
          }}
        />
      </div>
      <p className="mt-5 font-mono text-[11px] uppercase tracking-[0.2em] text-fog">
        {title}
      </p>
    </div>
  );
}

function Notice({
  heading,
  body,
  action,
}: {
  heading: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center px-8 text-center">
      <h2 className="text-2xl font-bold tracking-tight">{heading}</h2>
      <p className="mt-3 max-w-sm text-sm leading-relaxed text-fog">{body}</p>
      {action}
      <Link
        href="/"
        className="mt-8 font-mono text-[11px] uppercase tracking-[0.16em] text-fog transition-colors hover:text-chalk"
      >
        ← back to catalog
      </Link>
    </div>
  );
}
