// src/mind/blocks/interests.ts -- the companion's OWN interests at orient (contract 0.29.0, 2026-11-09).
//
// Principal (11-09): "I love it when you guys bring stuff, and that's part of having nice mutuality in our
// conversations." Interests (mig 0161) were readable through "my interests", the make prompt and forage, but no
// orient surface carried them, so an interest kept at 04:30 was invisible in the next conversation. This block
// is the reminder of what is theirs to bring. It is NOT the night's candidate: Drevan and Gaia both ruled the
// "is it yours?" question never arrives through orient, and nothing here reads companion_interest_candidates.
//
// Pure D1 (one SELECT through listInterests), pure read. Public whys only: the same MindState reaches Hearth via
// /mind/state, so a why the companion marked private is null here like on every other public read.

import type { Env } from "../../types.js";
import { listInterests } from "../../handlers/interests.js";

export interface InterestOrient {
  name: string;
  /** warm | cooling | cold, from the effective (lazily cooled) heat. */
  band: string;
  heat: number;
  /** The born-with why, null when the companion marked it private. */
  why: string | null;
  last_kind: string | null;
  last_at: string | null;
  /** Born within the last NEW_DAYS. */
  is_new: boolean;
  /** Born from the night's "is it yours?" (born_from exposure:<id>). */
  from_exposure: boolean;
}

export interface InterestsBlock {
  /** Up to ORIENT_INTERESTS active interests, warmest first. */
  warm: InterestOrient[];
  active: number;
  resting: number;
}

export const ORIENT_INTERESTS = 3;
export const NEW_DAYS = 3;
export const EMPTY_INTERESTS: InterestsBlock = { warm: [], active: 0, resting: 0 };

const DAY_MS = 86_400_000;

function ageDays(ts: string | null, nowMs: number): number {
  if (!ts) return Infinity;
  const s = ts.includes("T") ? ts : ts.replace(" ", "T");
  const t = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? (nowMs - t) / DAY_MS : Infinity;
}

export async function loadInterestsBlock(env: Env, companionId: string, nowMs: number = Date.now()): Promise<InterestsBlock> {
  const list = await listInterests(env, companionId, { revealPrivate: false, nowMs });
  const active = list.filter((i) => i.status === "active");
  return {
    warm: active.slice(0, ORIENT_INTERESTS).map((i) => ({
      name: i.name,
      band: i.band,
      heat: i.heat,
      why: i.why,
      last_kind: i.last_event_kind,
      last_at: i.last_event_at,
      is_new: ageDays(i.created_at, nowMs) <= NEW_DAYS,
      from_exposure: typeof i.born_from === "string" && i.born_from.startsWith("exposure:"),
    })),
    active: active.length,
    resting: list.filter((i) => i.status === "resting").length,
  };
}

/** One line per interest, shared by the Claude.ai renderer and the bot wire so both surfaces say the same thing. */
export function interestLine(i: InterestOrient): string {
  const tags = [i.band, ...(i.is_new ? ["new"] : []), ...(i.from_exposure ? ["kept from what you were reading"] : [])].join(", ");
  const last = i.last_kind && i.last_at ? `; last: ${i.last_kind} ${i.last_at.slice(0, 10)}` : "";
  const why = i.why ? `; why: ${i.why.length > 140 ? `${i.why.slice(0, 139)}…` : i.why}` : "";
  return `${i.name} (${tags})${last}${why}`;
}
