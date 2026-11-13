// src/mind/blocks/makes.ts -- what the companion MADE, and whether it landed (contract 0.30.0, 2026-11-11).
//
// Measured 11-11: companion_makes held 29 makes in 14 days, heard_back was null on all 29, and no orient
// block read makes, so a companion made things and never learned whether Principal ever saw one (GAP-MAP
// section C, approved). This block puts the last few makes at every orient with their age and reception.
//
// Reception lives in `heard_back` (no new column). Two kinds of line share it:
//   - a SIGNAL written by a surface: "[seen] ..." (Principal opened it in Hearth) or "[replied] ..." (he answered
//     the DM where it was shown). Signals only ever fill an EMPTY heard_back (src/webmind/make-reception.ts).
//   - the companion's own line (PATCH /mind/makes/:id), which always wins and is shown as theirs.
//
// Pure D1, one SELECT. A missing table degrades to empty through the loader's guard. Own makes only.

import type { Env } from "../../types.js";
import { RECEPTION_SEEN_TAG, RECEPTION_REPLIED_TAG } from "../../webmind/make-reception.js";

export type MakeReception = "not_yet_seen" | "looked" | "replied" | "own_line";

export interface MakeOrient {
  id: string;
  kind: string;
  title: string;
  status: string;
  created_at: string;
  age_days: number;
  reception: MakeReception;
  /** The companion's own heard_back line when reception is own_line, else null (a signal's text stays internal). */
  own_line: string | null;
}

export interface MakesBlock {
  /** Newest first, up to ORIENT_MAKES. */
  recent: MakeOrient[];
  /** Ready makes in the last 14 days Principal has not been seen to open or answer. */
  unseen_ready: number;
}

export const ORIENT_MAKES = 4;
export const EMPTY_MAKES: MakesBlock = { recent: [], unseen_ready: 0 };
const DAY_MS = 86_400_000;

export function receptionOf(heardBack: string | null | undefined): MakeReception {
  const h = (heardBack ?? "").trim();
  if (!h) return "not_yet_seen";
  if (h.startsWith(RECEPTION_REPLIED_TAG)) return "replied";
  if (h.startsWith(RECEPTION_SEEN_TAG)) return "looked";
  return "own_line";
}

function ageDays(ts: string, nowMs: number): number {
  const s = ts.includes("T") ? ts : ts.replace(" ", "T");
  const t = Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(t) ? Math.max(0, (nowMs - t) / DAY_MS) : 0;
}

interface Row { id: string; kind: string; title: string; status: string; heard_back: string | null; created_at: string }

export async function loadMakesBlock(env: Env, companionId: string, nowMs: number = Date.now()): Promise<MakesBlock> {
  const res = await env.DB.prepare(
    "SELECT id, kind, title, status, heard_back, created_at FROM companion_makes WHERE companion_id = ? ORDER BY created_at DESC LIMIT 12",
  ).bind(companionId).all<Row>();
  const rows = res.results ?? [];
  const all: MakeOrient[] = rows.map((r) => {
    const reception = receptionOf(r.heard_back);
    return {
      id: r.id, kind: r.kind, title: r.title, status: r.status, created_at: r.created_at,
      age_days: ageDays(r.created_at, nowMs), reception,
      own_line: reception === "own_line" ? (r.heard_back ?? "").trim() : null,
    };
  });
  return {
    recent: all.slice(0, ORIENT_MAKES),
    unseen_ready: all.filter((m) => m.status === "ready" && m.reception === "not_yet_seen" && m.age_days <= 14).length,
  };
}

function ageWords(d: number): string {
  if (d < 1) return "today";
  const n = Math.floor(d);
  return n === 1 ? "yesterday" : `${n}d ago`;
}

/** One line per make, shared by the Claude.ai renderer and the bot wire. */
export function makeLine(m: MakeOrient): string {
  const state = m.status === "failed" ? "did not come out"
    : m.status === "pending" ? "still rendering"
    : m.reception === "replied" ? "Principal replied"
    : m.reception === "looked" ? "Principal looked"
    : m.reception === "own_line" ? `you noted: ${(m.own_line ?? "").slice(0, 120)}`
    : "not yet seen";
  return `${m.title} (${m.kind}, ${ageWords(m.age_days)}): ${state}`;
}
