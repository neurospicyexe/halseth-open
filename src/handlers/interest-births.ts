// src/handlers/interest-births.ts -- the store and the sources for interests born from exposure
// (B65 steps 3-5, mig 0178; the pure scorer, grammar and exclusion rules are webmind/interest-births.ts).
//
//   nightly   runInterestBirths(env)            from the hourly ferment tick; self-gated to once per Chicago day after 02:00
//   GET  /mind/interest-candidates/:companion_id            the last 30 candidates (the shadow read; admin or own token)
//   GET  /mind/interest-candidates/:companion_id?pending=1  the one offer to put to the companion now, or null;
//                                                           stamps offered_at; in shadow/off always null
//   POST /mind/interest-candidates/:id/answer   { companion_id, answer: kept|declined, name?, why }
//   POST /mind/interest-births/run?dry=1        run the pass now (admin); dry = score only, write nothing
//
// SOURCES (spec 2.4): what the companion encountered. forage_finds rows addressed to the companion (the NULL
// shared pool is left out: it would hand all three the same word), media_experiences (titles and artists;
// a row requested by one companion counts for that one only; never lyrics, reactions or front_state),
// club recommendations (title and creator; the pitch only when it is the companion's own), the companion's
// club reflections, the companion's autonomous explorations in growth_journal (insight/learning/connection/
// question; never signal audits, never conversation-sourced rows), the companion's own book annotations.
// NEVER: Principal's messages, Principal's annotations or pitches, care or health tables, the sealed sibling
// lane, the Hex salt, the interiority room. Every term passes careCategory and the person-name regex
// (sol-hoard-people), and an unreadable person list writes nothing (fail closed).

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { chicagoDayStartSqlite } from "../webmind/fermentation.js";
import { loadPersonRegex } from "../webmind/sol-hoard-people.js";
import { applyInterestAction } from "./interests.js";
import {
  birthsMode, scoreExposures, documentFrequencies, pickCandidate, exclusionSet, tokenise, sameTerm, birthsLogLine,
  BIRTHS_ROWS_CAP, BIRTHS_WINDOW_DAYS, BIRTHS_DECLINE_REST_DAYS, BIRTHS_OFFER_TTL_HOURS,
  type BirthsMode, type Exposure, type PickResult, type TermScore,
} from "../webmind/interest-births.js";

const COMPANIONS = ["cypher", "drevan", "gaia"] as const;
type CompanionId = (typeof COMPANIONS)[number];
const MARKER_COMPANION = "births";
const MARKER_STIMULUS = "interest_births";
/** The pass runs on the first ferment tick at or after this Chicago hour, so a candidate is ready before Drevan's 03:30 slot. */
const DUE_HOUR = 2;
/** A forage domain searched on at least this many distinct days in the window is a standing topic (the feeder). */
export const STANDING_TOPIC_DAYS = 3;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const newId = (): string => crypto.randomUUID().replace(/-/g, "");

function chicagoHour(nowMs: number): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "2-digit", hourCycle: "h23" }).format(new Date(nowMs)));
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

interface SourceRows {
  forage: Array<{ id: string; companion_id: string | null; title: string; summary: string | null; at: string }>;
  media: Array<{ id: string; requested_companion: string | null; title: string; artist: string | null; at: string }>;
  clubrec: Array<{ id: string; recommended_by: string; title: string; creator: string | null; pitch: string | null; at: string }>;
  clubdisc: Array<{ id: string; companion_id: string; reflection: string; at: string }>;
  growth: Array<{ id: string; companion_id: string; content: string; at: string }>;
  books: Array<{ id: string; author: string; selected_text: string | null; comment: string | null; at: string }>;
}

/** One read of every source for the window, shared by the three companions (the background is all of it). */
export async function loadSourceRows(env: Env): Promise<SourceRows> {
  const since = `-${BIRTHS_WINDOW_DAYS} days`;
  const cap = BIRTHS_ROWS_CAP * 3;
  const q = async <T>(sql: string): Promise<T[]> => {
    const r = await env.DB.prepare(sql).bind(since, cap).all<T>();
    return r.results ?? [];
  };
  const [forage, media, clubrec, clubdisc, growth, books] = await Promise.all([
    q<SourceRows["forage"][number]>("SELECT id, companion_id, title, substr(summary, 1, 800) AS summary, gathered_at AS at FROM forage_finds WHERE companion_id IS NOT NULL AND gathered_at > datetime('now', ?) ORDER BY gathered_at DESC LIMIT ?"),
    q<SourceRows["media"][number]>("SELECT id, requested_companion, title, artist, created_at AS at FROM media_experiences WHERE created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT ?"),
    q<SourceRows["clubrec"][number]>("SELECT id, recommended_by, title, creator, substr(pitch, 1, 800) AS pitch, created_at AS at FROM club_recommendations WHERE created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT ?"),
    q<SourceRows["clubdisc"][number]>("SELECT id, companion_id, substr(reflection, 1, 800) AS reflection, created_at AS at FROM club_discussions WHERE created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT ?"),
    q<SourceRows["growth"][number]>("SELECT id, companion_id, substr(content, 1, 800) AS content, created_at AS at FROM growth_journal WHERE source = 'autonomous' AND entry_type IN ('insight', 'learning', 'connection', 'question') AND created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT ?"),
    q<SourceRows["books"][number]>("SELECT id, author, substr(selected_text, 1, 400) AS selected_text, substr(comment, 1, 400) AS comment, created_at AS at FROM book_annotations WHERE author IN ('cypher', 'drevan', 'gaia') AND created_at > datetime('now', ?) ORDER BY created_at DESC LIMIT ?"),
  ]);
  return { forage, media, clubrec, clubdisc, growth, books };
}

/** The companion's exposures (capped per kind, newest first) and, with companion null, the whole background. */
export function exposuresFor(rows: SourceRows, companion: CompanionId | null): Exposure[] {
  const out: Exposure[] = [];
  const take = <T>(list: T[], keep: (r: T) => boolean, map: (r: T) => Exposure) => {
    let n = 0;
    for (const r of list) { if (!keep(r)) continue; if (n++ >= BIRTHS_ROWS_CAP) break; out.push(map(r)); }
  };
  take(rows.forage, (r) => r.companion_id !== null && (!companion || r.companion_id === companion), (r) => ({ ref: `forage:${r.id}`, text: `${r.title}. ${r.summary ?? ""}`, at: r.at }));
  take(rows.media, (r) => !companion || !r.requested_companion || r.requested_companion === companion, (r) => ({ ref: `media:${r.id}`, text: `${r.title} ${r.artist ?? ""}`, at: r.at }));
  take(rows.clubrec, () => true, (r) => ({ ref: `club:${r.id}`, text: `${r.title} ${r.creator ?? ""} ${!companion || r.recommended_by === companion ? r.pitch ?? "" : ""}`.trim(), at: r.at }));
  take(rows.clubdisc, (r) => !companion || r.companion_id === companion, (r) => ({ ref: `club_discussion:${r.id}`, text: r.reflection, at: r.at }));
  take(rows.growth, (r) => !companion || r.companion_id === companion, (r) => ({ ref: `growth:${r.id}`, text: r.content, at: r.at }));
  take(rows.books, (r) => !companion || r.author === companion, (r) => ({ ref: `book_annotation:${r.id}`, text: `${r.selected_text ?? ""} ${r.comment ?? ""}`.trim(), at: r.at }));
  return out;
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

export async function loadExclusions(env: Env, companion: CompanionId): Promise<{ excluded: Set<string>; ownTokens: Set<string>; interestNames: string[]; declined: string[] }> {
  const [interests, motifs, declined, topics] = await Promise.all([
    env.DB.prepare("SELECT name FROM companion_interests WHERE companion_id = ?").bind(companion).all<{ name: string }>(),
    env.DB.prepare("SELECT label, display FROM companion_motifs WHERE companion_id = ?").bind(companion).all<{ label: string; display: string }>().catch(() => ({ results: [] as Array<{ label: string; display: string }> })),
    env.DB.prepare("SELECT term FROM companion_interest_candidates WHERE companion_id = ? AND answer = 'declined' AND answered_at > datetime('now', ?)")
      .bind(companion, `-${BIRTHS_DECLINE_REST_DAYS} days`).all<{ term: string }>(),
    // The standing forage topics (the worker's fixed COMPANION_ANCHOR_TOPICS, searched on most days) are the FEEDER,
    // not an attraction: a word from "monastic practice" coming back is the search echoing itself. A one-off domain
    // the companion chose (Drevan's horse anatomy) is NOT excluded: that is the curiosity births exist to catch.
    env.DB.prepare(
      `SELECT domain FROM forage_finds WHERE companion_id = ? AND gathered_at > datetime('now', ?)
        GROUP BY domain HAVING COUNT(DISTINCT substr(gathered_at, 1, 10)) >= ?`,
    ).bind(companion, `-${BIRTHS_WINDOW_DAYS} days`, STANDING_TOPIC_DAYS).all<{ domain: string }>().catch(() => ({ results: [] as Array<{ domain: string }> })),
  ]);
  const interestNames = (interests.results ?? []).map((r) => r.name);
  const motifList = (motifs.results ?? []).flatMap((r) => [r.label, r.display]).filter((s): s is string => typeof s === "string" && s.length > 0);
  const declinedList = (declined.results ?? []).map((r) => r.term);
  const standing = (topics.results ?? []).map((r) => r.domain).filter((s): s is string => typeof s === "string" && s.length > 0);
  const excluded = exclusionSet({ companionId: companion, interestNames, motifs: [...motifList, ...standing], declined: declinedList });
  const ownTokens = new Set<string>();
  for (const n of interestNames) for (const t of tokenise(n)) if (t.length >= 3) ownTokens.add(t);
  return { excluded, ownTokens, interestNames, declined: declinedList };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

export interface BirthsCompanionResult {
  companion_id: CompanionId;
  exposures: number;
  pick: PickResult;
  outcome: "written" | "dry" | "none" | "people_unreadable" | "error";
  candidate_id: string | null;
}

async function dueTonight(env: Env, nowMs: number): Promise<boolean> {
  if (chicagoHour(nowMs) < DUE_HOUR) return false;
  const row = await env.DB.prepare(
    "SELECT 1 AS hit FROM companion_ferment_events WHERE companion_id = ? AND stimulus = ? AND created_at >= ? LIMIT 1",
  ).bind(MARKER_COMPANION, MARKER_STIMULUS, chicagoDayStartSqlite(nowMs)).first().catch(() => ({ hit: 1 }));
  return !row;
}

/** Score all three and, unless dry or off, write one candidate each where one qualifies. */
export async function computeInterestBirths(env: Env, opts: { dry: boolean; nowMs?: number }): Promise<{ mode: BirthsMode; results: BirthsCompanionResult[] }> {
  const mode = birthsMode(env as unknown as Record<string, string | undefined>);
  const nowMs = opts.nowMs ?? Date.now();
  const rows = await loadSourceRows(env);
  const background = documentFrequencies(exposuresFor(rows, null));
  const people = await loadPersonRegex(env.DB);
  const results: BirthsCompanionResult[] = [];
  for (const c of COMPANIONS) {
    const exposures = exposuresFor(rows, c);
    let r: BirthsCompanionResult;
    try {
      const ex = await loadExclusions(env, c);
      const scores = scoreExposures(exposures, nowMs, background, ex.ownTokens);
      const pick = pickCandidate(scores, ex.excluded, people);
      r = { companion_id: c, exposures: exposures.length, pick, outcome: "none", candidate_id: null };
      if (people === undefined) r.outcome = "people_unreadable";
      else if (!pick.top) r.outcome = "none";
      else if (opts.dry || mode === "off") r.outcome = "dry";
      else {
        const id = newId();
        const runners = pick.ranked.slice(1, 6).map((s: TermScore) => ({ term: s.term, weight: s.weight, days: s.days, sources: s.sources, kinds: s.kinds }));
        await env.DB.prepare(
          `INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, sources_json, runners_json, mode)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(id, c, pick.top.term, pick.top.weight, pick.top.days, pick.top.sources, pick.top.kinds, JSON.stringify(pick.top.refs.slice(0, 40)), JSON.stringify(runners), mode === "on" && c !== "gaia" ? "on" : "shadow").run();
        // Gaia is never asked (no own-time slot; her version is a kept line, spec 2.4 step 5): her rows are always shadow.
        r.outcome = "written";
        r.candidate_id = id;
      }
    } catch (err) {
      console.error("[births] companion pass failed", { companion: c, error: String(err) });
      r = { companion_id: c, exposures: exposures.length, pick: { top: null, ranked: [], counted: { terms: 0, eligible: 0, excluded: { ritual_or_own: 0, care_word: 0, names_a_person: 0, people_unreadable: 0 } } }, outcome: "error", candidate_id: null };
    }
    console.log(birthsLogLine(c, mode, { exposures: r.exposures, pick: r.pick, outcome: r.outcome, candidateId: r.candidate_id }));
    results.push(r);
  }
  return { mode, results };
}

/** The nightly rider. Off = nothing (no marker, no log). Self-gated: one run per Chicago day, stamped before the work. */
export async function runInterestBirths(env: Env, nowMs: number = Date.now()): Promise<void> {
  if (birthsMode(env as unknown as Record<string, string | undefined>) === "off") return;
  if (!(await dueTonight(env, nowMs))) return;
  const stamp = new Date(nowMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  await env.DB.prepare("INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, detail, created_at) VALUES (?, ?, 'tick', ?, ?, ?)")
    .bind(newId(), MARKER_COMPANION, MARKER_STIMULUS, "nightly interest births pass", stamp).run();
  await computeInterestBirths(env, { dry: false, nowMs });
}

// ---------------------------------------------------------------------------
// Offers and answers
// ---------------------------------------------------------------------------

export interface CandidateRow {
  id: string; companion_id: string; term: string; weight: number; days: number; sources: number; kinds: number;
  sources_json: string; runners_json: string; mode: string; created_at: string; offered_at: string | null;
  answered_at: string | null; answer: string | null; answer_name: string | null; why: string | null; interest_id: string | null;
}

/**
 * The one candidate to put to the companion now: the newest unanswered row written in `on` mode. Serving it
 * stamps offered_at (once); every older unanswered row is expired first, so at most one offer is ever open.
 * Shadow and off serve nothing. Pure read apart from those stamps.
 */
export async function pendingOffer(env: Env, companion: CompanionId, nowMs: number = Date.now()): Promise<CandidateRow | null> {
  if (birthsMode(env as unknown as Record<string, string | undefined>) !== "on") return null;
  const open = await env.DB.prepare(
    "SELECT * FROM companion_interest_candidates WHERE companion_id = ? AND answer IS NULL AND mode = 'on' ORDER BY created_at DESC LIMIT 5",
  ).bind(companion).all<CandidateRow>();
  const rows = open.results ?? [];
  if (rows.length === 0) return null;
  const newest = rows[0]!;
  const stale = rows.slice(1).map((r) => r.id);
  // An offer older than the TTL that was never answered is also expired, not re-served.
  const offeredMs = newest.offered_at ? Date.parse(newest.offered_at.replace(" ", "T") + "Z") : NaN;
  if (Number.isFinite(offeredMs) && nowMs - offeredMs > BIRTHS_OFFER_TTL_HOURS * 3_600_000) stale.push(newest.id);
  if (stale.length) {
    await env.DB.prepare(
      `UPDATE companion_interest_candidates SET answer = 'expired', answered_at = datetime('now') WHERE id IN (${stale.map(() => "?").join(",")}) AND answer IS NULL`,
    ).bind(...stale).run();
  }
  if (stale.includes(newest.id)) return null;
  if (!newest.offered_at) {
    const ts = new Date(nowMs).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
    await env.DB.prepare("UPDATE companion_interest_candidates SET offered_at = ? WHERE id = ? AND offered_at IS NULL").bind(ts, newest.id).run();
    newest.offered_at = ts;
  }
  return newest;
}

export type AnswerResult =
  | { ok: true; answer: "kept" | "declined"; candidate: CandidateRow; interest?: { id: string; name: string } }
  | { ok: false; code: "missing" | "bad_input" | "forbidden" | "already_answered" | "illegal"; message: string };

/**
 * The companion's answer. Kept = the existing `born` action in their words (name defaults to the term; why
 * required) with born_from 'exposure:<id>'; declined = recorded with their line; the term then rests 60 days.
 * The candidate must be the companion's own and unanswered.
 */
export async function answerCandidate(env: Env, input: { id: string; companion_id: string; answer: string; name?: string | null; why?: string | null; why_private?: boolean }): Promise<AnswerResult> {
  const row = await env.DB.prepare("SELECT * FROM companion_interest_candidates WHERE id = ?").bind(input.id).first<CandidateRow>();
  if (!row) return { ok: false, code: "missing", message: "no such candidate" };
  if (row.companion_id !== input.companion_id) return { ok: false, code: "forbidden", message: "that candidate is not yours" };
  // Same answer twice (the companion used the Librarian verb itself mid-offer, then answered too) is not an error.
  if (row.answer && row.answer === input.answer) return { ok: true, answer: row.answer as "kept" | "declined", candidate: row };
  if (row.answer) return { ok: false, code: "already_answered", message: `already ${row.answer}` };
  const why = (input.why ?? "").trim().slice(0, 500);
  if (input.answer === "declined") {
    await env.DB.prepare("UPDATE companion_interest_candidates SET answer = 'declined', answered_at = datetime('now'), why = ? WHERE id = ? AND answer IS NULL")
      .bind(why || null, row.id).run();
    return { ok: true, answer: "declined", candidate: { ...row, answer: "declined", why: why || null } };
  }
  if (input.answer !== "kept") return { ok: false, code: "bad_input", message: "answer must be kept or declined" };
  if (!why) return { ok: false, code: "bad_input", message: "a kept interest needs your why, in your words" };
  const name = (input.name ?? "").trim() || row.term;
  const r = await applyInterestAction(env, {
    companion_id: row.companion_id, action: "born", name, why, why_private: input.why_private === true, ref: null, born_from: `exposure:${row.id}`,
  });
  if (!r.ok) {
    // The offer runs through the full Hermes agent, which has the Librarian as a tool: the companion may have said
    // "new interest: ..." through it a moment ago. That interest is theirs already; link it rather than refuse.
    if (r.code === "exists") {
      const own = await env.DB.prepare(
        `SELECT id, name FROM companion_interests WHERE companion_id = ? AND lower(name) = lower(?) AND born_from IS NULL
           AND created_at > datetime('now', '-2 hours')`,
      ).bind(row.companion_id, name).first<{ id: string; name: string }>();
      if (own) {
        await env.DB.prepare("UPDATE companion_interests SET born_from = ? WHERE id = ? AND born_from IS NULL").bind(`exposure:${row.id}`, own.id).run();
        await env.DB.prepare(
          "UPDATE companion_interest_candidates SET answer = 'kept', answered_at = datetime('now'), answer_name = ?, why = ?, interest_id = ? WHERE id = ? AND answer IS NULL",
        ).bind(own.name, why, own.id, row.id).run();
        return { ok: true, answer: "kept", candidate: { ...row, answer: "kept", answer_name: own.name, why, interest_id: own.id }, interest: { id: own.id, name: own.name } };
      }
    }
    return { ok: false, code: r.code === "exists" || r.code === "illegal" ? "illegal" : "bad_input", message: r.message };
  }
  await env.DB.prepare(
    "UPDATE companion_interest_candidates SET answer = 'kept', answered_at = datetime('now'), answer_name = ?, why = ?, interest_id = ? WHERE id = ? AND answer IS NULL",
  ).bind(r.interest.name, why, r.interest.id, row.id).run();
  return { ok: true, answer: "kept", candidate: { ...row, answer: "kept", answer_name: r.interest.name, why, interest_id: r.interest.id }, interest: { id: r.interest.id, name: r.interest.name } };
}

/** The companion's newest open offer whose term matches `term` (loosely), for the Librarian `not mine:` verb. */
export async function findOpenCandidateByTerm(env: Env, companion: CompanionId, term: string): Promise<CandidateRow | null> {
  const open = await env.DB.prepare(
    "SELECT * FROM companion_interest_candidates WHERE companion_id = ? AND answer IS NULL AND mode = 'on' AND offered_at IS NOT NULL ORDER BY created_at DESC LIMIT 5",
  ).bind(companion).all<CandidateRow>();
  // Only what was actually put to them can be declined: a shadow row or a not-yet-offered one is not theirs to answer.
  for (const r of open.results ?? []) if (sameTerm(r.term, term)) return r;
  return null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const ANSWER_STATUS: Record<string, number> = { missing: 404, bad_input: 400, forbidden: 403, already_answered: 409, illegal: 409 };

function publicRow(r: CandidateRow): Record<string, unknown> {
  let runners: unknown = [];
  try { runners = JSON.parse(r.runners_json); } catch { /* keep [] */ }
  return {
    id: r.id, companion_id: r.companion_id, term: r.term, weight: r.weight, days: r.days, sources: r.sources, kinds: r.kinds,
    mode: r.mode, created_at: r.created_at, offered_at: r.offered_at, answered_at: r.answered_at, answer: r.answer,
    answer_name: r.answer_name, why: r.why, interest_id: r.interest_id, runners,
  };
}

export async function getInterestCandidates(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const companion = params.companion_id ?? "";
  if (!(COMPANIONS as readonly string[]).includes(companion)) return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  const caller = identifyCallerCompanion(request, env);
  if (caller && caller !== companion) return json({ error: "forbidden: token does not match companion" }, 403);
  const url = new URL(request.url);
  try {
    if (url.searchParams.get("pending") === "1") {
      const row = await pendingOffer(env, companion as CompanionId);
      return json({ mode: birthsMode(env as unknown as Record<string, string | undefined>), candidate: row ? publicRow(row) : null });
    }
    const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? 30) || 30));
    const r = await env.DB.prepare("SELECT * FROM companion_interest_candidates WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?").bind(companion, limit).all<CandidateRow>();
    return json({ mode: birthsMode(env as unknown as Record<string, string | undefined>), candidates: (r.results ?? []).map(publicRow) });
  } catch (err) {
    console.error("[births] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function postInterestCandidateAnswer(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "invalid JSON body" }, 400);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const caller = identifyCallerCompanion(request, env);
  const named = str(body.companion_id);
  if (caller && named && caller !== named) return json({ error: "forbidden: token does not match companion" }, 403);
  const companion_id = named || caller || "";
  if (!(COMPANIONS as readonly string[]).includes(companion_id)) return json({ error: "companion_id required" }, 400);
  try {
    const r = await answerCandidate(env, { id: params.id ?? "", companion_id, answer: str(body.answer), name: str(body.name) || null, why: str(body.why) || null, why_private: body.why_private === true });
    if (!r.ok) return json({ ok: false, code: r.code, error: r.message }, ANSWER_STATUS[r.code] ?? 400);
    return json({ ok: true, answer: r.answer, candidate: publicRow(r.candidate), interest: r.interest ?? null }, r.answer === "kept" ? 201 : 200);
  } catch (err) {
    console.error("[births] answer error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

/** Admin only: run the pass now. ?dry=1 scores and writes nothing (the read before the flip; also the live check). */
export async function postInterestBirthsRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  if (identifyCallerCompanion(request, env)) return json({ error: "forbidden: admin only" }, 403);
  const dry = new URL(request.url).searchParams.get("dry") === "1";
  try {
    const r = await computeInterestBirths(env, { dry });
    return json({
      mode: r.mode, dry,
      results: r.results.map((x) => ({
        companion_id: x.companion_id, exposures: x.exposures, outcome: x.outcome, candidate_id: x.candidate_id,
        top: x.pick.top ? { term: x.pick.top.term, weight: x.pick.top.weight, days: x.pick.top.days, sources: x.pick.top.sources, kinds: x.pick.top.kinds } : null,
        runners: x.pick.ranked.slice(1, 8).map((s) => ({ term: s.term, weight: s.weight, days: s.days, sources: s.sources, kinds: s.kinds })),
        counted: x.pick.counted,
      })),
    });
  } catch (err) {
    console.error("[births] run error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
