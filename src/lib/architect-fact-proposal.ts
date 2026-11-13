// src/lib/architect-fact-proposal.ts
//
// A fact Principal STATED in Discord, proposed for review (GAP-MAP A3, 2026-11-11).
//
// WHY. `architect_facts` got 0 Principal-sourced rows in the 14 days before this shipped: the bots'
// writeback gate only writes companion notes / witness logs / threads, in the companion's voice, as
// tray drafts. "No, Hope is the dog; PersonP was a friend" was said in a room and went nowhere the
// facts picker reads. This is the write path for that one shape, and it is a PROPOSAL:
//
//   - status 'open' (never 'active'): the existing review state. Hearth /facts lists open rows
//     under "proposed" with Confirm / Retire / Fix; the orient renders at most OPEN_FACTS_MAX of them
//     as questions to ask, never as facts (open-facts-gate.ts). Trust derives to 0.5 (open cap).
//   - provenance in `source`: `discord-stated:<channel>/<message> heard_by=<companion> at=<iso>`.
//     companion_id = the companion that heard it (who recorded it). The prefix is also the
//     idempotency key (one proposal per Discord message, whichever bot gets there first).
//   - a CORRECTION points at the fact it would replace through `supersedes_id`, WITHOUT retiring it.
//     The wrong fact keeps rendering until the proposal is confirmed: Hearth Confirm (PATCH open ->
//     active) or a supersede of the proposal itself (Hearth Fix, a companion's re-write) retires it
//     then (applyPendingCorrection below). Retiring the proposal leaves the old fact alone.
//   - HARD GUARD: a fact that reads as meds, care, health, biometrics, symptoms, diagnoses or a
//     body state is REFUSED here, at write, whatever the bot decided. The bot runs the same class of
//     check at classification (nullsafe-discord facts-write.ts); this is the second line. The rule
//     is this path's, not the table's: Principal's own Hearth writes and the companions' Librarian
//     writes are ruled differently (health facts are pickable there, B3 10-19).

import { careCategory } from "../people/care-guard.js";
import { healthValueNumbers } from "../ledger/grammar.js";
import { embedText, storeVector } from "../mcp/embed.js";
import { NOVELTY_SKIP } from "../webmind/novelty.js";
import { schemaGap } from "../care/schema-gap.js";
import type { Env } from "../types.js";
import { MAX_FACT_CHARS, OPEN_FACT_SKIP, PROPOSAL_SOURCE_PREFIX, RELATED_FACT_SURFACE, deriveFactTrust } from "./architect-fact-write.js";

export { PROPOSAL_SOURCE_PREFIX };
export { pendingCorrectionTarget } from "./architect-fact-write.js";

/** A correction names the nearest ACTIVE fact at or above this cosine as the one it would replace.
 *  Below it the proposal still lands, just without a target (Principal sees it on Hearth either way).
 *  RELATED_FACT_SURFACE (0.8) is the only measured bar in this code (28 of 6,105 live-fact pairs on
 *  prod clear it, 2026-10-07); a lower floor would hand Confirm a retire target nobody measured. */
export const CORRECTION_MATCH_MIN = RELATED_FACT_SURFACE;

const COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

// Body states, symptoms and diagnoses careCategory does not carry (it was written for people frame
// lines, not for "my ankle is swollen again"). Mirrored in nullsafe-discord `facts-write.ts`
// (FACT_BODY_RE / FACT_DIAGNOSIS_RE): two repos, one list; change both. Over-blocking is the
// intended failure: a dropped fact costs a re-tell, a health fact in a companion's mouth costs trust.
const FACT_BODY_RE = new RegExp(
  "(?<![\\p{L}\\p{N}])(" + [
    "glucose", "blood\\s*sugar", "insulin", "a1c", "cgm", "diabet\\p{L}*", "bp", "blood\\s*pressure", "heart\\s*-?\\s*rate", "hrv", "pulse",
    "sleep\\p{L}*", "slept", "insomnia", "nightmares?", "doctors?", "dr\\.?", "physician\\p{L}*", "nurse\\p{L}*", "clinic\\p{L}*",
    "surger\\p{L}*", "surgical", "mri", "x-?rays?", "blood\\s*(?:test|work)", "lab\\s*(?:work|results?)", "appointments?",
    "injur\\p{L}*", "sprain\\p{L}*", "fractur\\p{L}*", "broken\\s+(?:bone|arm|leg|wrist|ankle|foot|toe)", "ankles?", "achilles", "tendons?",
    "knees?", "wrists?", "back\\s+(?:pain|ache)", "headaches?", "aches?", "aching", "hurts?", "hurting", "sore", "swollen", "swelling",
    "bruis\\p{L}*", "bleed\\p{L}*", "sick", "ill", "illness", "flu", "fever\\p{L}*", "nause\\p{L}*", "vomit\\p{L}*", "cough\\p{L}*",
    "covid", "allerg\\p{L}*", "asthma", "cramps?", "pregnan\\p{L}*", "weigh\\p{L}*", "lbs?", "calories?", "eating\\s+disorder", "binge\\p{L}*",
    "health\\p{L}*", "wellness", "exhausted", "exhaustion", "fatigue\\p{L}*", "burn\\s*-?out", "meltdowns?", "shutdowns?",
    "overstimulat\\p{L}*", "sensory\\s+overload", "dysregulat\\p{L}*", "panic\\s+attacks?", "anxiety", "anxious", "depress\\p{L}*",
    "autis\\p{L}*", "adhd", "audhd", "ocpd", "c-?ptsd", "ptsd", "bipolar", "schizo\\p{L}*", "dissociative",
  ].join("|") + ")(?![\\p{L}\\p{N}])",
  "iu",
);
// Upper-case only: "DID" the diagnosis, never "did" the verb; "OCD" stays case-sensitive with it.
const FACT_DIAGNOSIS_RE = /(?<![\p{L}\p{N}])(DID|OCD|EDS|POTS)(?![\p{L}\p{N}])/u;

/**
 * Non-null when `text` must never become a proposed fact: careCategory (the shared care/health
 * check), a labelled health value (healthValueNumbers, the ledger's rule), or a body state,
 * symptom or diagnosis. Answers a category, never the matched term.
 */
export function factProposalCareCategory(text: string | null | undefined): string | null {
  if (!text) return null;
  const c = careCategory(text);
  if (c) return c;
  if (healthValueNumbers(text)) return "health";
  if (FACT_BODY_RE.test(text) || FACT_DIAGNOSIS_RE.test(text)) return "health";
  return null;
}

export interface FactProposalInput {
  fact: string;
  category?: string | null;
  /** The companion that heard it; recorded as companion_id. */
  companionId: string;
  channelId: string;
  messageId: string;
  /** When Principal said it (the Discord message time), ISO. */
  statedAt?: string | null;
  /** The bot read this as correcting a wrong belief. */
  correction: boolean;
}

export type FactProposalResult =
  | { kind: "invalid"; error: string }
  | { kind: "refused"; category: string }
  /** This Discord message already has a proposal (another bot, or a retry). */
  | { kind: "duplicate"; id: string }
  /** A held open proposal says the same thing. */
  | { kind: "held"; matchId: string; score: number }
  /** An active fact already says it. */
  | { kind: "known"; matchId: string; score: number }
  | { kind: "proposed"; id: string; correctsId: string | null; correctsScore: number | null };

const DISCORD_ID = /^\d{5,25}$/;

export function proposalSourceKey(channelId: string, messageId: string): string {
  return `${PROPOSAL_SOURCE_PREFIX}${channelId}/${messageId}`;
}

interface Neighbor { id: string; score: number; status: string; fact?: string }

/** Nearest live facts by meaning, with their D1 status. Fails open to [] (the proposal still lands). */
async function nearestLiveFacts(env: Env, embedding: number[]): Promise<Neighbor[]> {
  try {
    const res = await env.VECTORIZE.query(embedding, { topK: 5, filter: { table: "architect_facts" }, returnValues: true });
    const matches = (res.matches ?? []).map((m) => ({
      id: String(m.id).startsWith("architect_facts:") ? String(m.id).slice("architect_facts:".length) : String(m.id),
      score: m.score ?? 0,
    }));
    if (matches.length === 0) return [];
    const rows = await env.DB.prepare(
      `SELECT id, status, fact FROM architect_facts WHERE id IN (${matches.map(() => "?").join(", ")}) AND status != 'retired'`,
    ).bind(...matches.map((m) => m.id)).all<{ id: string; status: string; fact: string }>();
    const byId = new Map((rows.results ?? []).map((r) => [r.id, r]));
    return matches
      .filter((m) => byId.has(m.id))
      .map((m) => ({ ...m, status: byId.get(m.id)!.status, fact: byId.get(m.id)!.fact }))
      .sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

export async function proposeArchitectFact(env: Env, input: FactProposalInput): Promise<FactProposalResult> {
  const fact = (input.fact ?? "").trim();
  if (!fact) return { kind: "invalid", error: "fact is required" };
  if (fact.length > MAX_FACT_CHARS) return { kind: "invalid", error: `fact is over ${MAX_FACT_CHARS} chars` };
  const companionId = (input.companionId ?? "").trim().toLowerCase();
  if (!COMPANIONS.has(companionId)) return { kind: "invalid", error: "companion_id must be cypher | drevan | gaia" };
  if (!DISCORD_ID.test(input.channelId ?? "") || !DISCORD_ID.test(input.messageId ?? "")) {
    return { kind: "invalid", error: "channel_id and message_id must be Discord ids" };
  }

  // The hard guard, at write. Before any embedding: a refused fact is never indexed either.
  const care = factProposalCareCategory(fact);
  if (care) return { kind: "refused", category: care };

  // One proposal per Discord message. The ids are digits only (checked above), so LIKE has no
  // wildcard in the key itself.
  const key = proposalSourceKey(input.channelId, input.messageId);
  const existing = await env.DB.prepare("SELECT id FROM architect_facts WHERE source LIKE ? LIMIT 1")
    .bind(`${key} %`).first<{ id: string }>();
  if (existing) return { kind: "duplicate", id: existing.id };

  const embedding = await embedText(env, fact).catch(() => null);
  const neighbors = embedding ? await nearestLiveFacts(env, embedding) : [];

  const heldSame = neighbors.find((n) => n.status === "open" && n.score >= OPEN_FACT_SKIP);
  if (heldSame) return { kind: "held", matchId: heldSame.id, score: heldSame.score };

  const bestActive = neighbors.find((n) => n.status === "active") ?? null;
  if (bestActive && (norm(bestActive.fact ?? "") === norm(fact) || (!input.correction && bestActive.score >= NOVELTY_SKIP))) {
    return { kind: "known", matchId: bestActive.id, score: bestActive.score };
  }
  // A correction scores CLOSE to the fact it corrects ("Hope is the dog" vs "PersonP is the dog"), so
  // the 0.95 restatement rule cannot apply to it: it would eat exactly the facts this exists for.
  const target = input.correction && bestActive && bestActive.score >= CORRECTION_MATCH_MIN ? bestActive : null;

  const id = crypto.randomUUID();
  const category = input.category && /^[a-z_]{2,32}$/.test(input.category.trim().toLowerCase())
    ? input.category.trim().toLowerCase()
    : "general";
  const statedAt = input.statedAt && !Number.isNaN(Date.parse(input.statedAt)) ? new Date(input.statedAt).toISOString() : new Date().toISOString();
  const source = `${key} heard_by=${companionId} at=${statedAt}`;
  const trust = deriveFactTrust({ source, companionId, status: "open" });

  const insert = (withTrust: boolean) => env.DB.prepare(
    withTrust
      ? `INSERT INTO architect_facts (id, fact, category, status, companion_id, source, supersedes_id, weight, trust, created_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, 100, ?, datetime('now'))`
      : `INSERT INTO architect_facts (id, fact, category, status, companion_id, source, supersedes_id, weight, created_at)
         VALUES (?, ?, ?, 'open', ?, ?, ?, 100, datetime('now'))`,
  ).bind(...(withTrust
    ? [id, fact, category, companionId, source, target?.id ?? null, trust]
    : [id, fact, category, companionId, source, target?.id ?? null]));
  try {
    await insert(true).run();
  } catch (e) {
    if (!schemaGap(e)) throw e;
    await insert(false).run();
  }

  if (embedding) {
    await storeVector(env, embedding, "architect_facts", id, companionId)
      .catch(() => { console.warn(`[architect-facts] proposal vector store failed for ${id}`); });
  }
  return { kind: "proposed", id, correctsId: target?.id ?? null, correctsScore: target?.score ?? null };
}
