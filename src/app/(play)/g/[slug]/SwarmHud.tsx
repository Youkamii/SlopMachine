"use client";

import type { HudState } from "@/games/types";

/**
 * DOM heads-up display for WebGL games.
 *
 * A canvas can only ever have one context type, so a three.js game cannot
 * draw a 2D HUD on itself. Rendering it as HTML on top is both cheaper and
 * sharper than compositing text sprites into the scene.
 *
 * Nothing here takes pointer events — the level-up cards are laid out with
 * the same constants the game uses for hit-testing, so clicks pass straight
 * through to the canvas and the game decides what was picked.
 */
export default function SwarmHud({ hud }: { hud: HudState }) {
  const hpPct = Math.max(0, (hud.hp / hud.maxHp) * 100);
  const xpPct = Math.min(100, (hud.xp / hud.xpNeed) * 100);
  const mins = Math.floor(hud.seconds / 60);
  const secs = Math.floor(hud.seconds % 60);

  if (hud.phase === "title") return null;

  return (
    <div className="pointer-events-none absolute inset-0 select-none font-mono">
      {/* Health — full width across the top, the way survivors games do it. */}
      <div className="absolute inset-x-0 top-0 h-[5px] bg-black/50">
        <div
          className="h-full transition-[width] duration-150"
          style={{
            width: `${hpPct}%`,
            background:
              hpPct > 35
                ? "linear-gradient(90deg,#2ad4ff,#7df9ff)"
                : "linear-gradient(90deg,#ff2e5b,#ff7a8a)",
          }}
        />
      </div>

      {/* XP just under it. */}
      <div className="absolute inset-x-0 top-[5px] h-[3px] bg-black/40">
        <div
          className="h-full bg-[#ffe14d] transition-[width] duration-100"
          style={{ width: `${xpPct}%` }}
        />
      </div>

      {/* Sits below the shell's back button and mute toggle rather than
          fighting them for the corners. */}
      <div className="absolute left-4 top-[62px] flex items-baseline gap-3">
        <span className="text-[30px] font-bold leading-none text-[#ffe14d]">
          {hud.level}
        </span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-white/45">
          level
        </span>
      </div>

      <div className="absolute right-4 top-[62px] text-right">
        <div className="text-[30px] font-bold leading-none tabular-nums text-white">
          {hud.kills}
        </div>
        <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
          kills
        </div>
      </div>

      <div className="absolute inset-x-0 top-[70px] text-center text-[14px] tabular-nums text-white/55">
        {mins}:{secs.toString().padStart(2, "0")}
      </div>

      {hud.cards ? <Cards cards={hud.cards} /> : null}

      {hud.phase === "dead" ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70">
          <div className="text-[11px] uppercase tracking-[0.2em] text-[#ff2e5b]">
            {hud.score >= hud.best ? "new best" : "overrun"}
          </div>
          <div className="mt-2 text-[clamp(3rem,12vw,6rem)] font-extrabold leading-none tabular-nums text-white">
            {hud.score}
          </div>
          <div className="mt-3 text-[12px] tracking-[0.12em] text-white/55">
            {hud.kills} KILLS · LEVEL {hud.level} · {mins}:
            {secs.toString().padStart(2, "0")}
          </div>
          <div className="mt-10 animate-blink text-[12px] uppercase tracking-[0.2em] text-white/70">
            click to go again
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Layout mirrors `layoutCards()` in the game exactly. If one changes the
 * other must, or clicks land on nothing.
 */
function Cards({ cards }: { cards: Array<{ title: string; body: string }> }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/55">
      <div className="mb-6 text-[11px] uppercase tracking-[0.24em] text-[#ffe14d]">
        level up
      </div>
      <div
        className="flex items-stretch justify-center"
        style={{ gap: "min(2.5vw, 22px)" }}
      >
        {cards.map((c, i) => (
          <div
            key={c.title}
            className="flex flex-col justify-between border border-white/20 bg-black/70 p-4 backdrop-blur-sm"
            style={{
              width: "min(26vw, 260px)",
              height: "min(34vh, 240px)",
            }}
          >
            <div className="text-[10px] tabular-nums text-white/35">
              {i + 1}
            </div>
            <div>
              <div className="text-[20px] font-bold leading-tight tracking-tight text-white">
                {c.title}
              </div>
              <div className="mt-2 text-[12px] leading-snug text-white/55">
                {c.body}
              </div>
            </div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-[#ffe14d]">
              take it
            </div>
          </div>
        ))}
      </div>
      <div className="mt-6 text-[10px] uppercase tracking-[0.18em] text-white/40">
        click a card, or press 1 / 2 / 3
      </div>
    </div>
  );
}
