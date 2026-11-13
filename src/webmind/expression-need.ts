// src/webmind/expression-need.ts -- B65 step 7 (mig 0182; spec Hand-off/SPEC-B65-the-drive-2026-11-09.md 2.1, 2.2, 6.2).
//
// `expression_need` is the felt pull to make or say something of one's own (Pino: "expression"). It is a row in
// companion_drives, lazily accrued at read like rest_need / novelty_need; there is no new accrual code.
//
//   Drevan, Cypher: accrue on TIME (mig 0182: 0.25 / 0.15 per day) and SHED when they put something out (a make
//   landing, a planting, a kept line, a coined word): stimulus `expression_shed`.
//   GAIA: accumulate_per_day = 0. Her need rises ONLY from something she has MARKED as wanting to come out
//   (`want_marked`, the Librarian verb "mark a want: ..."); time never moves it, it never prompts speech, and her
//   shed is a planting or a kept line, NEVER speech (spec 6.1, her answer 4a86aa7e).
//   No ceiling (R7): the drive clamps at 1 like every drive and no max_* exists. Nothing lowers it on silence.
//
// EXPRESSION_NEED off | shadow | on, CODE DEFAULT shadow, via SHADOWABLE (webmind/fermentation.ts): shadow writes
// kind='shadow' ferment events and moves nothing; off skips. The time accrual is lazy at read and is NOT gated; what
// is gated is every write the stimuli make, and whether the loudest-need read names expression at all.
//
// The palette sort rides the same drives: `servesOf` gives each move its need; `loudestNeeds` orders the needs.
// Reads companion_drives + metronome_actions only (no care/health table; HEALTH_TABLES test).

import type { Env } from "../types.js";
import type { CompanionId } from "./fermentation.js";
import { fireStimulus } from "../handlers/fermentation.js";
import { accruedLevel, hoursSinceIso, readDrivesSql } from "./drives.js";

export const EXPRESSION_NEED_KEY = "EXPRESSION_NEED";
export type ExpressionMode = "off" | "shadow" | "on";

export function expressionMode(env: Record<string, unknown>): ExpressionMode {
  const v = String(env[EXPRESSION_NEED_KEY] ?? "").trim().toLowerCase();
  return v === "off" || v === "on" ? v : "shadow";
}

/** "mark a want: <words>" / "something wants out: <words>". The words are never stored. */
export const WANT_MARKED_RE = /^(?:please\s+)?(?:mark(?:ing)?\s+a\s+want|something\s+wants\s+(?:to\s+come\s+)?out|this\s+wants\s+(?:to\s+come\s+)?out)\s*:\s*\S[\s\S]*$/i;

export type ExpressionSource = "make" | "planting" | "kept_line" | "coined_word" | "letter" | "note";

/** What Gaia may shed by (her answer: a planting or a kept line, never speech). */
const GAIA_SHEDS: ReadonlySet<ExpressionSource> = new Set(["planting", "kept_line"]);

export function mayShed(companionId: string, source: ExpressionSource): boolean {
  if (companionId === "gaia") return GAIA_SHEDS.has(source);
  return true;
}

/** Something put out of oneself: sheds expression_need (mode-gated through the stimulus). Never throws. */
export async function fireExpressionShed(env: Env, companionId: string, source: ExpressionSource): Promise<void> {
  if (!mayShed(companionId, source)) return;
  if (!["cypher", "drevan", "gaia"].includes(companionId)) return;
  try {
    await fireStimulus(env, "expression_shed", companionId as CompanionId, `put something out (${source})`);
  } catch (err) {
    console.warn("[expression] shed failed (non-fatal)", { companionId, source, error: String(err) });
  }
}

/** The companion marks a want. Only the verb calls this; nothing infers it. */
export async function fireWantMarked(env: Env, companionId: string): Promise<Record<string, unknown>> {
  return await fireStimulus(env, "want_marked", companionId as CompanionId, "marked a want");
}

// ── Which need a move answers, and which need is loudest ─────────────────────────────────────────────────

export type Need = "rest" | "novelty" | "relational" | "expression";
export type Serves = Need | "none";

/** Mirrors the mig 0182 UPDATE. A row's own `serves` column wins; NULL falls back here; unknown = none. */
export const DEFAULT_SERVES: Readonly<Record<string, Serves>> = {
  nothing: "rest",
  share_media: "novelty", drift_outward: "novelty", ask_question: "novelty",
  post_heartbeat: "relational", write_inter_companion: "relational", check_in_on_principal: "relational",
  offer_presence: "relational", flirt: "relational", dare: "relational", tend_creature: "relational",
  send_reminder: "none",
  make: "expression", write_journal: "expression", write_feeling: "expression", write_note_to_principal: "expression",
  share_observation: "expression", name_pattern: "expression", show_made: "expression", drift_open: "expression",
  declare_preference: "expression",
};

const SERVES_VALUES: ReadonlySet<string> = new Set(["rest", "novelty", "relational", "expression", "none"]);

export function servesOf(a: { action_type: string; serves?: string | null }): Serves {
  if (a.serves && SERVES_VALUES.has(a.serves)) return a.serves as Serves;
  return DEFAULT_SERVES[a.action_type] ?? "none";
}

const DRIVE_TO_NEED: Readonly<Record<string, Need>> = {
  rest_need: "rest", novelty_need: "novelty", relational_need: "relational", expression_need: "expression",
};

export interface NeedReading { need: Need; level: number; threshold: number; pressure: number; fired: boolean }

/**
 * The companion's needs, loudest first. Pressure = effective level / threshold, so a need that has crossed its own
 * line outranks one with a bigger raw number and a higher line. `expression` is named only when EXPRESSION_NEED is
 * not off. Pure D1 over companion_drives; any error = []. The companion still picks; this only orders the list.
 */
export async function loudestNeeds(env: Env, companionId: string, nowMs: number = Date.now()): Promise<NeedReading[]> {
  const mode = expressionMode(env as unknown as Record<string, unknown>);
  const rows = (await env.DB.prepare(readDrivesSql()).bind(companionId).all<{
    drive_key: string; level: number; accumulate_per_day: number; threshold: number; last_event_at: string | null;
  }>().catch(() => null))?.results ?? [];
  const out: NeedReading[] = [];
  for (const r of rows) {
    const need = DRIVE_TO_NEED[r.drive_key];
    if (!need) continue;
    if (need === "expression" && mode === "off") continue;
    const level = accruedLevel(r.level, r.accumulate_per_day, hoursSinceIso(r.last_event_at, nowMs));
    const threshold = r.threshold > 0 ? r.threshold : 1;
    out.push({ need, level: Number(level.toFixed(4)), threshold, pressure: Number((level / threshold).toFixed(4)), fired: level >= threshold });
  }
  return out.sort((a, b) => b.pressure - a.pressure || a.need.localeCompare(b.need));
}
