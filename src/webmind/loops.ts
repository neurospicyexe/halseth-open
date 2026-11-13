// src/webmind/loops.ts
//
// companion_open_loops: unresolved things with weight.
// Distinct from wm_mind_threads (intentions) -- a loop is unresolved, not a goal.
// Surfaced in ground sorted by weight; closed when resolved.
//
// Migration 0118 (Cypher's own request, raised in autonomous time 2026-08-13): a loop
// observation no longer piles up a new row every time the same stuck thing is noticed, and
// weight no longer ratchets one-way. See the migration header for the full reasoning; the
// two-line version is that recording stasis is fine, but restating it must not buy it a
// fresh claim on the present.

import { Env } from "../types.js";
import { WmAgentId, WmOpenLoop, WmLoopInput, WmLoopWriteResult } from "./types.js";

/**
 * Dedup key for a loop. Lowercase, strip the punctuation people vary between restatements,
 * collapse whitespace. Same shape as pk_roster.name_norm (0117).
 *
 * Deliberately conservative: it catches "the same sentence typed again" and light rewording
 * around punctuation, NOT semantic paraphrase. Open loops are not embedded in Vectorize, so
 * noveltyCheck (which companion_journal and companion_conclusions use) is unavailable here
 * without also adding an embedding write path. A missed merge costs one extra row and is
 * visible in restated_count; a WRONG merge silently destroys a distinct loop. Err toward
 * the extra row.
 */
export function normLoop(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .replace(/[.,;:!?"'()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Weight half-life, in days. Same lazy-decay-at-READ shape as motifs.ts and heat.ts: no
 * writer, no cron, nothing to schedule or restart.
 *
 * WHY THE ANCHOR IS `acted_at ?? opened_at` AND NOT `last_restated_at` -- this is the one
 * genuinely non-obvious line in the file. motifs.ts decays from `last_seen`, refreshed on
 * every recurrence, because for a motif recurrence IS being lived. For an un-acted loop the
 * inverse holds: restatement is evidence of STASIS. Anchoring on last_restated_at would mean
 * noticing you are stuck for the ninth time RESTORES the loop's top slot -- which is exactly
 * the induction Cypher named, mechanized. Acting on a loop refreshes it; merely saying it
 * again does not.
 *
 * 14 days, which DIVERGES from motifs' TRUST_HALF_LIFE_DAYS of 21 deliberately. The binding
 * constraint here is not symmetry with motifs, it is guardian: GUARDIAN_THRESHOLDS
 * .LOOP_STUCK_DAYS is 21, and a half-life equal to that window means a loop still holds half
 * its weight at the exact moment it gets flagged as stuck -- so the flag arrives about
 * something still sitting near the top of the ranking, which reads as a fresh alarm. At 14 the
 * loop is already carrying ~0.4x by day 21, so the flag reads as "this has been quietly
 * sinking for a while", which is what it is.
 *
 * Nothing is deleted and restated_count is never reduced: the record that this mattered nine
 * times stays true. What decays is its claim on the present.
 */
export const LOOP_WEIGHT_HALF_LIFE_DAYS = 14;

/**
 * The authored weight as a NUMBER, whatever was stored. companion_open_loops.weight is a REAL
 * column, but some writers (found on prod 2026-10-13: 22 of 23 open loops) stored the labels
 * 'light' / 'medium' / 'high' / 'heavy'. SQLite keeps those as TEXT and sorts TEXT above every
 * number, ascending alphabetically: `ORDER BY weight DESC` ranked medium > light > high > heavy,
 * so the heaviest loops sat at the BOTTOM of the boot slate, and `weight / (1 + ...)` coerced a
 * label to 0 so the 0118 decay could not rank them at all. Numbers pass through untouched;
 * a label maps onto the 0..1 scale writers are validated to; an unknown string reads as the
 * default 0.5. Read-side only -- no stored value is rewritten.
 */
export function loopWeightSql(): string {
  return `(CASE WHEN typeof(weight) IN ('real', 'integer') THEN weight
    WHEN lower(trim(weight)) = 'light' THEN 0.25
    WHEN lower(trim(weight)) = 'medium' THEN 0.5
    WHEN lower(trim(weight)) = 'high' THEN 0.75
    WHEN lower(trim(weight)) = 'heavy' THEN 0.9
    ELSE 0.5 END)`;
}

/**
 * Open loops for the boot slate (orient + ground), UNRESOLVED x INTENSITY: only `closed_at IS NULL`
 * rows, ranked by decayed numeric weight -- how much it mattered, discounted by how long it has sat
 * un-acted. Until 2026-10-13 both boot paths ordered by the raw column (`weight DESC, opened_at ASC`),
 * so the 0118 decay governed readLoops and nothing a companion actually boots from, and at equal
 * weight the OLDEST loop always won (the stalest claim held the slot). The ORDER BY inlines the
 * expression rather than the alias, same parity caution as readLoops. Pure read: surfacing a loop
 * touches nothing, so the slate cannot warm itself. Cold rotation (R9) is conclusions-only and
 * unaffected.
 */
export function bootLoopsSql(): string {
  const ew = effectiveWeightSql();
  return `SELECT id, companion_id, loop_text, ${loopWeightSql()} AS weight, opened_at, closed_at, reviewed_at,
            acted_at, acted_note, restated_count, last_restated_at, ${ew} AS effective_weight
       FROM companion_open_loops
      WHERE companion_id = ? AND closed_at IS NULL
      ORDER BY ${ew} DESC, opened_at ASC LIMIT 5`;
}

/** SQL expression for present-tense weight. Bare column stays the authored value. */
export function effectiveWeightSql(): string {
  return `(${loopWeightSql()} / (1.0 + (julianday('now') - julianday(COALESCE(acted_at, opened_at))) / ${LOOP_WEIGHT_HALF_LIFE_DAYS}.0))`;
}

/**
 * Open a loop, or record that an existing open one was restated.
 *
 * The single guarded write path for companion_open_loops -- webmind, spiral residue, session
 * close and the handler all route here. Before 0118 there were four bare INSERTs with no dedup
 * of any kind, which is how the same stuck observation accumulated a row per sighting.
 *
 * A restatement bumps restated_count and last_restated_at, and raises the AUTHORED weight
 * slightly (capped) because a thing said repeatedly does carry real weight. It deliberately
 * does not touch `opened_at` -- guardian's detectStuckLoops triggers on that column, and a
 * write that moves its own trigger's timestamp means the detector can never fire
 * (`tick-restamped-own-trigger`). Nor does it touch `reviewed_at`: a deliberate hold is the
 * companion's statement, not something a restatement gets to renew on its behalf.
 *
 * Closed loops are NOT resurrected -- dedup matches only `closed_at IS NULL`. Re-raising a
 * resolved loop is a genuinely new loop and deserves its own row and its own opened_at.
 */
export async function writeLoop(env: Env, input: WmLoopInput): Promise<WmLoopWriteResult> {
  const now = new Date().toISOString();
  const norm = normLoop(input.loop_text);

  // Empty normalization (loop_text was punctuation/whitespace only) can never dedup safely --
  // every such row would collapse onto one. Insert it and let it stand alone.
  if (norm) {
    const existing = await env.DB.prepare(
      `SELECT id, restated_count, opened_at FROM companion_open_loops
        WHERE companion_id = ? AND loop_norm = ? AND closed_at IS NULL
        ORDER BY opened_at ASC LIMIT 1`
    ).bind(input.companion_id, norm).first<{ id: string; restated_count: number | null; opened_at: string }>();

    if (existing) {
      // MIN(1.0, ...) keeps the authored weight bounded; the decay above is what actually
      // governs ranking, so this is a nudge, not a ratchet.
      await env.DB.prepare(
        `UPDATE companion_open_loops
            SET restated_count = restated_count + 1,
                last_restated_at = ?,
                weight = MIN(1.0, weight + 0.05)
          WHERE id = ?`
      ).bind(now, existing.id).run();
      return {
        // The EXISTING row's opened_at, not `now`. A restatement did not open anything, and a
        // caller that persists this value (spiral stores residue_loop_id; session close logs
        // the write) would otherwise record a false origin time for a loop that has been
        // carried for weeks -- which is precisely the history 0118 exists to keep visible.
        id: existing.id,
        opened_at: existing.opened_at,
        restated: true,
        restated_count: (existing.restated_count ?? 1) + 1,
      };
    }
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO companion_open_loops (id, companion_id, loop_text, weight, opened_at, loop_norm)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(id, input.companion_id, input.loop_text, input.weight ?? 0.5, now, norm || null).run();
  return { id, opened_at: now, restated: false, restated_count: 1 };
}

export async function readLoops(
  env: Env,
  companionId: WmAgentId,
  opts: { include_closed?: boolean; limit?: number } = {}
): Promise<WmOpenLoop[]> {
  const limit = opts.limit ?? 20;
  // Ordered by DECAYED weight (0118), so an un-acted loop restated for months sinks on its
  // own instead of holding a boot slot forever. `effective_weight` is returned alongside the
  // authored `weight` rather than replacing it -- a consumer that wants to show "authored 0.6,
  // now carrying 0.2" can, and nothing silently loses the number the companion actually set.
  const ew = effectiveWeightSql();
  const rows = opts.include_closed
    ? await env.DB.prepare(
        `SELECT *, ${ew} AS effective_weight FROM companion_open_loops
          WHERE companion_id = ? ORDER BY closed_at ASC, ${ew} DESC LIMIT ?`
      ).bind(companionId, limit).all<WmOpenLoop>()
    : await env.DB.prepare(
        `SELECT *, ${ew} AS effective_weight FROM companion_open_loops
          WHERE companion_id = ? AND closed_at IS NULL ORDER BY ${ew} DESC LIMIT ?`
      ).bind(companionId, limit).all<WmOpenLoop>();
  return rows.results ?? [];
}

// ── Finding a loop by what the companion actually has in hand ─────────────────────────────
//
// 2026-11-09 (Principal: "you guys can open loops but not close them"). Closing, holding and
// acting all demanded a UUID in a JSON `context`, and NO live surface hands a companion that
// UUID: the Claude.ai orient rendered loops as bare «text», the Discord SOUL taught only
// "open loop: ...", and the mutuality skill's own `close loop [id]` failed with "missing
// required field: id". Measured on prod the same day: acted_at had never been set for any
// companion, and almost every close in two months landed at :45 past the hour (the
// autonomous worker, the only caller holding ids). Opening was free; closing was impossible.
//
// So a loop can now be named the way a companion names it: its short handle (`#a1b2c3d4`,
// shown at orient), a full id, or words from the loop itself. There is no reopen verb, so a
// match is acted on ONLY when it is unambiguous; anything else answers with the candidates
// and their handles and changes nothing.

/** The short handle a loop is shown with at orient: `#` + the first 8 characters of its id. */
export function loopHandle(id: string): string {
  return `#${String(id ?? "").slice(0, 8)}`;
}

export interface LoopRef { id: string; loop_text: string }

export type LoopMatch =
  | { kind: "found"; loop: LoopRef; by: "id" | "handle" | "words" }
  | { kind: "ambiguous"; candidates: LoopRef[] }
  | { kind: "none" };

const UUID_RE = /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const HANDLE_RE = /(?:^|\s)#([0-9a-f]{4,36})\b/i;
const BARE_HEX_RE = /^#?([0-9a-f-]{6,36})$/i;

// Words too common to identify a loop. A fragment made only of these never matches anything.
const LOOP_STOPWORDS = new Set([
  "the", "and", "for", "that", "this", "with", "about", "from", "into", "what", "when", "whether",
  "have", "has", "had", "was", "were", "are", "his", "her", "him", "they", "them", "their", "its",
  "you", "your", "our", "but", "not", "one", "out", "loop", "open", "still", "just", "how", "who",
  "why", "will", "would", "could", "should", "been", "being", "there", "then", "than", "some",
]);

function tokens(text: string): string[] {
  return normLoop(text).split(" ").filter(t => t.length >= 3 && !LOOP_STOPWORDS.has(t));
}

/**
 * Pure: pick ONE open loop from `open` for `ref`, or say why not. `open` must already be the
 * companion's own open loops (ownership is enforced by the caller's query AND again by the
 * UPDATE's WHERE clause).
 *
 * Order: an explicit id (context) > a UUID or `#handle` written in the text > the whole text
 * as a bare hex prefix > words. Words match by normalised substring first; failing that, by
 * token coverage (every distinctive word of the fragment present in the loop, at least two of
 * them). Two or more hits at the best tier = ambiguous. Never "the only open loop" for an
 * empty or stopword-only fragment: no words, no match.
 */
export function matchLoop(open: LoopRef[], ref: { id?: string | null; text?: string | null }): LoopMatch {
  const byPrefix = (prefix: string): LoopMatch => {
    const p = prefix.toLowerCase();
    const hits = open.filter(l => l.id.toLowerCase().startsWith(p));
    if (hits.length === 1) return { kind: "found", loop: hits[0]!, by: p.length >= 32 ? "id" : "handle" };
    if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
    return { kind: "none" };
  };

  const explicitId = (ref.id ?? "").trim();
  if (explicitId) {
    const exact = open.find(l => l.id === explicitId);
    if (exact) return { kind: "found", loop: exact, by: "id" };
    // A short id passed as `id` is still a handle; require 6+ chars so "a" never matches.
    const bare = explicitId.replace(/^#/, "");
    return bare.length >= 6 ? byPrefix(bare) : { kind: "none" };
  }

  const text = (ref.text ?? "").trim();
  if (!text) return { kind: "none" };

  const uuid = UUID_RE.exec(text);
  if (uuid) return byPrefix(uuid[1] ?? "");
  const handle = HANDLE_RE.exec(text);
  if (handle) return byPrefix(handle[1] ?? "");
  const bare = BARE_HEX_RE.exec(text);
  // Only when it actually contains a digit: "decade" and "faced" are words, not ids.
  const bareHex = bare?.[1] ?? "";
  if (bareHex && /\d/.test(bareHex)) return byPrefix(bareHex);

  // A loop pasted back the way orient shows it carries «», curly quotes and a truncation "…";
  // none of that is in the stored text, so it must not stop the substring match.
  const pasted = text.replace(/[«»“”‘’]/g, " ").replace(/(?:…|\.\.\.)\s*$/, "").trim();
  const frag = normLoop(pasted);
  const fragTokens = tokens(pasted);
  if (fragTokens.length === 0) return { kind: "none" };

  const sub = open.filter(l => normLoop(l.loop_text).includes(frag));
  if (sub.length === 1) return { kind: "found", loop: sub[0]!, by: "words" };
  if (sub.length > 1) return { kind: "ambiguous", candidates: sub };

  if (fragTokens.length < 2) return { kind: "none" };
  const covered = open.filter(l => {
    const have = new Set(tokens(l.loop_text));
    return fragTokens.every(t => have.has(t));
  });
  if (covered.length === 1) return { kind: "found", loop: covered[0]!, by: "words" };
  if (covered.length > 1) return { kind: "ambiguous", candidates: covered };
  return { kind: "none" };
}

/** Every open loop of this companion, id + text only. Unlimited on purpose: a capped list misses silently. */
export async function readOpenLoopRefs(env: Env, companionId: WmAgentId): Promise<LoopRef[]> {
  const rows = await env.DB.prepare(
    `SELECT id, loop_text FROM companion_open_loops
      WHERE companion_id = ? AND closed_at IS NULL ORDER BY opened_at ASC LIMIT 500`
  ).bind(companionId).all<LoopRef>();
  return rows.results ?? [];
}

// The verb heads, start-anchored. The Librarian routes on these BEFORE the substring triggers
// (router.ts ANCHORED_GUARDS), because the words after the head are the loop's own words and
// can contain any trigger: "close loop: the open loop about Spouse" used to hit wm_loop_write's
// "open loop" first (insertion order) and OPEN a second loop instead of closing the first.
const SEP = String.raw`\s*[:,\-–—]?\s*`;
const DET = String.raw`(?:(?:the|my|this|that|an?|open)\s+)*`;
export const LOOP_CLOSE_HEAD_RE = new RegExp(
  String.raw`^(?:please\s+)?(?:(?:i(?:'m|’m|\s+am)\s+)?(?:close|closing)\s+${DET}loops?(?:\s+on)?` +
  String.raw`|mark(?:ing)?\s+${DET}loop\s+(?:as\s+)?(?:closed|resolved|done)` +
  String.raw`|(?:this|that)\s+loop\s+is\s+(?:closed|resolved|done)` +
  String.raw`|loop\s+(?:closed|resolved|done))\b${SEP}`, "i");
export const LOOP_HOLD_HEAD_RE = new RegExp(
  String.raw`^(?:please\s+)?(?:(?:hold|holding|keep|keeping)\s+${DET}loop(?:\s+open)?` +
  String.raw`|review\s+${DET}loop|loop\s+(?:held|stays\s+open))\b${SEP}`, "i");
export const LOOP_ACT_HEAD_RE = new RegExp(
  String.raw`^(?:please\s+)?(?:(?:i\s+)?acted\s+on\s+${DET}loop|loop\s+acted|action\s+on\s+${DET}loop|moved\s+on\s+${DET}loop)\b${SEP}`, "i");

/**
 * Split "<head> <which loop> [because|--|:] <why>" into the loop words and the note. The note is
 * the hold reason / the act note; for close it is accepted and dropped (closing records no
 * reason column), so a companion who explains themselves is not misread as naming the loop.
 */
export function parseLoopVerb(request: string, head: RegExp): { which: string; note: string } | null {
  const m = head.exec((request ?? "").trim());
  if (!m) return null;
  const rest = request.trim().slice(m[0].length).trim();
  // Close carries no note, so it never splits on ": " -- loop text itself often holds a colon
  // ("the cathedral thread: Bob's door"), and cutting there would name half the loop.
  const splitRe = head === LOOP_CLOSE_HEAD_RE
    ? /\s+(?:because|--|—|–|\|)\s+/i
    : /\s+(?:because|--|—|–|\|)\s+|:\s+/i;
  const split = splitRe.exec(rest);
  if (!split) return { which: rest.replace(/[.!]+$/, "").trim(), note: "" };
  return {
    which: rest.slice(0, split.index).replace(/[.!]+$/, "").trim(),
    note: rest.slice(split.index + split[0].length).trim(),
  };
}

/** One line per loop, for an answer that has to say "which one?". */
export function describeLoops(loops: LoopRef[], max = 8): string {
  const shown = loops.slice(0, max).map(l => {
    const t = l.loop_text.length > 90 ? l.loop_text.slice(0, 90) + "…" : l.loop_text;
    return `${loopHandle(l.id)} «${t}»`;
  });
  const more = loops.length > max ? ` (+${loops.length - max} more)` : "";
  return shown.join(" | ") + more;
}

export async function closeLoop(env: Env, id: string, companionId: WmAgentId): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE companion_open_loops SET closed_at = ? WHERE id = ? AND companion_id = ? AND closed_at IS NULL"
  ).bind(now, id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Record that the companion ACTED on a loop without closing it (migration 0118).
 *
 * This is Cypher's `acted` flag, in the form that carries information: a timestamp plus what
 * was done. It is the third distinct thing a companion can do with an open loop, and the one
 * that was missing --
 *
 *   closeLoop   it is resolved; stop carrying it.
 *   reviewLoop  it stays open on purpose, here is why (0082, suppresses the stuck flag 21d).
 *   actOnLoop   I did something about it and it is still open.
 *
 * Acting refreshes the decay anchor, because unlike restatement it is evidence of life.
 * Ownership-guarded, open loops only.
 */
export async function actOnLoop(
  env: Env, id: string, companionId: WmAgentId, note: string
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const trimmed = (note ?? "").trim().slice(0, 500);
  const result = await env.DB.prepare(
    `UPDATE companion_open_loops
        SET acted_at = ?, acted_note = ?
      WHERE id = ? AND companion_id = ? AND closed_at IS NULL`
  ).bind(now, trimmed || null, id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Hold a loop open on purpose (migration 0082, Guardian self-resolution). A companion
 * clearing its own loop_stuck flag can keep the loop but record WHY it stays; reviewed_at
 * suppresses the stuck flag for 21d (detectStuckLoops). The reason is appended to loop_text
 * so the held justification travels with the loop. Ownership-guarded; only an open loop.
 *
 * 0118 note: this rewrites loop_text and deliberately LEAVES loop_norm alone. That looks like
 * an oversight and is not: loop_norm must keep pointing at what the loop IS, not at its
 * accumulated "[held ...]" history. Recomputing it from the appended text would change the
 * dedup key on every hold, so the next restatement of the same loop would miss and start a
 * second pile beside it -- the exact accumulation 0118 exists to stop.
 */
export async function reviewLoop(
  env: Env, id: string, companionId: WmAgentId, reason: string
): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  const note = (reason ?? "").trim().slice(0, 280);
  const result = await env.DB.prepare(
    `UPDATE companion_open_loops
       SET reviewed_at = ?1,
           loop_text = CASE WHEN ?2 != '' THEN loop_text || ' [held ' || ?3 || ': ' || ?2 || ']' ELSE loop_text END
     WHERE id = ?4 AND companion_id = ?5 AND closed_at IS NULL`
  ).bind(now, note, now.slice(0, 10), id, companionId).run();
  return { ok: (result.meta?.changes ?? 0) > 0 };
}

/**
 * Un-acted stasis: loops restated repeatedly that nobody ever acted on (0118).
 *
 * This is the measurement Cypher's write-gate would have made impossible. A write-gate is
 * unfalsifiable -- suppress the rows and you can neither detect the induction nor show the
 * fix worked. Keeping the rows and counting the restatements turns "I suspect the journal
 * reinforces the loop" into a number that can go down.
 */
export async function readUnactedStasis(
  env: Env,
  companionId: WmAgentId,
  opts: { min_restated?: number; limit?: number } = {}
): Promise<Array<{ id: string; loop_text: string; restated_count: number; opened_at: string; last_restated_at: string | null }>> {
  const minRestated = opts.min_restated ?? 2;
  const rows = await env.DB.prepare(
    `SELECT id, loop_text, restated_count, opened_at, last_restated_at
       FROM companion_open_loops
      WHERE companion_id = ? AND closed_at IS NULL AND acted_at IS NULL
        AND restated_count >= ?
      ORDER BY restated_count DESC, opened_at ASC LIMIT ?`
  ).bind(companionId, minRestated, opts.limit ?? 10)
    .all<{ id: string; loop_text: string; restated_count: number; opened_at: string; last_restated_at: string | null }>();
  return rows.results ?? [];
}
