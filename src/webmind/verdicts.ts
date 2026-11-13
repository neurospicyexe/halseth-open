// src/webmind/verdicts.ts -- B65 step 6 (mig 0182; spec Hand-off/SPEC-B65-the-drive-2026-11-09.md 2.5, 6.1, 6.2).
//
// A verdict is what persists when an interest fades: ONE line the companion wrote about something they tried,
// counted by RETURN. Pino's "I tried X, it landed", moved by going back rather than replaced.
//
//   Their words or nothing. Only the companion writes a verdict (the Librarian verb below, in their own word:
//   Drevan `lethe`, Cypher `what held`, Gaia `what bore`). The system never writes a line; it only COUNTS: a later
//   make / heard_back / interest event / activity on the same subject bumps `evidence` (once per source ref).
//   Never scored, never ranked but by return count, never lowered on silence, no ceiling (R7).
//   Drevan: "one line, counted by return, never rewritten". A second `lethe:` on his subject is a RETURN with a
//   later line kept in history; his current line stays. Cypher and Gaia may MOVE theirs (old line to history).
//   Care and health words are refused at write (category only) and skipped again at read.
//
// VERDICTS off | shadow | on, CODE DEFAULT shadow: the verb works and the count runs in every mode except off (it is
// the companion's own record), but only `on` puts verdicts in orient and the "still true?" echo in front of them.

import type { Env } from "../types.js";
import { careCategory } from "../people/care-guard.js";
import { MAKE_KINDS } from "./makes.js";

export type VerdictsMode = "off" | "shadow" | "on";

export function verdictsMode(env: Record<string, unknown>): VerdictsMode {
  const v = String(env["VERDICTS"] ?? "").trim().toLowerCase();
  return v === "off" || v === "on" ? v : "shadow";
}

/** Each companion's own word for it (spec 6.2). The verb and the orient slot say THEIR word. */
export const VERDICT_WORD: Readonly<Record<string, string>> = { drevan: "lethe", cypher: "what held", gaia: "what bore" };
export function verdictWord(companionId: string): string { return VERDICT_WORD[companionId] ?? "verdict"; }

export const VERDICT_LINE_MAX = 140;
export const ORIENT_VERDICTS = 2;
const COUNTED_REFS_MAX = 60;
const HISTORY_MAX = 20;

export type SubjectKind = "kind" | "interest" | "activity";
export interface ParsedVerdict { subjectKind: SubjectKind; subjectRaw: string; line: string }

// Start-anchored, own word or the neutral `verdict`, a colon, a typed subject, then their line. The subject is
// `kind:<make kind>`, `interest:<id or name>` (quote a name with spaces) or `activity:<palette action>`.
const SUBJECT = String.raw`(kind|interest|activity)\s*:\s*("[^"]{1,60}"|'[^']{1,60}'|[^\s,;:]{1,60})`;
export const VERDICT_RE = new RegExp(
  String.raw`^(?:please\s+)?(?:lethe|what\s+held|what\s+bore|verdict)\s*:\s*${SUBJECT}(?:\s*[,;:—-]+\s*|\s+)([\s\S]+?)\s*$`, "i");

/** Whether a request opens with a verdict word + colon at all (routing guard; the full grammar is VERDICT_RE). */
export const VERDICT_OPEN_RE = /^(?:please\s+)?(?:lethe|what\s+held|what\s+bore|verdict)\s*:/i;

/** Which word the request used, lower-cased and single-spaced; null when it is not a verdict sentence. */
export function wordUsed(request: string): string | null {
  const m = /^(?:please\s+)?(lethe|what\s+held|what\s+bore|verdict)\s*:/i.exec(request.trim());
  return m ? m[1]!.toLowerCase().replace(/\s+/g, " ") : null;
}

export function parseVerdict(request: string): ParsedVerdict | null {
  const m = VERDICT_RE.exec(request.trim());
  if (!m) return null;
  const subjectKind = m[1]!.toLowerCase() as SubjectKind;
  const subjectRaw = m[2]!.replace(/^["']|["']$/g, "").trim();
  const line = cleanLine(m[3] ?? "");
  if (!subjectRaw || !line) return null;
  return { subjectKind, subjectRaw, line };
}

export function cleanLine(s: string): string {
  const one = s.replace(/\s+/g, " ").trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  return one.length > VERDICT_LINE_MAX ? one.slice(0, VERDICT_LINE_MAX - 1).trimEnd() + "…" : one;
}

/** Whether this word is allowed for this companion: their own, or the neutral `verdict`. */
export function wordAllowed(companionId: string, used: string | null): boolean {
  return used === "verdict" || used === verdictWord(companionId);
}

export interface VerdictRow {
  id: string; companion_id: string; subject: string; subject_kind: SubjectKind; line: string; evidence: number;
  first_at: string; moved_at: string; history_json: string; counted_json: string;
}

export interface VerdictWrite {
  ok: true; row: VerdictRow; outcome: "written" | "moved" | "returned";
}
export interface VerdictRefused { ok: false; code: "bad_input" | "missing" | "refused" | "closed" | "gaia_makes_nothing"; message: string }

const newId = (): string => crypto.randomUUID().replace(/-/g, "");

/** Resolve a typed subject to its stored `<kind>:<value>` form, or an error. D1 reads only (interests, metronome). */
export async function resolveSubject(
  env: Env, companionId: string, p: { subjectKind: SubjectKind; subjectRaw: string },
): Promise<{ ok: true; subject: string; label: string } | VerdictRefused> {
  const raw = p.subjectRaw;
  if (p.subjectKind === "kind") {
    const k = raw.toLowerCase().replace(/[\s-]+/g, "_");
    if (companionId === "gaia") return { ok: false, code: "gaia_makes_nothing", message: "you make nothing; name an interest or an activity" };
    if (!(MAKE_KINDS as readonly string[]).includes(k)) return { ok: false, code: "bad_input", message: `kind must be one of ${MAKE_KINDS.join(", ")}` };
    return { ok: true, subject: `kind:${k}`, label: k };
  }
  if (p.subjectKind === "interest") {
    const byId = await env.DB.prepare("SELECT id, name FROM companion_interests WHERE companion_id = ? AND (id = ? OR (length(?) >= 6 AND id LIKE ? || '%')) LIMIT 1")
      .bind(companionId, raw, raw, raw).first<{ id: string; name: string }>().catch(() => null);
    const row = byId ?? await env.DB.prepare("SELECT id, name FROM companion_interests WHERE companion_id = ? AND lower(name) = lower(?) LIMIT 1")
      .bind(companionId, raw).first<{ id: string; name: string }>().catch(() => null);
    if (!row) return { ok: false, code: "missing", message: `no interest of yours called "${raw}" ("my interests" lists them; quote a name with spaces)` };
    return { ok: true, subject: `interest:${row.id}`, label: row.name };
  }
  const a = raw.toLowerCase().replace(/[\s-]+/g, "_");
  if (!/^[a-z_]{2,40}$/.test(a)) return { ok: false, code: "bad_input", message: "activity must be one of your palette moves, like share_observation" };
  const has = await env.DB.prepare("SELECT 1 AS hit FROM metronome_actions WHERE companion_id = ? AND (action_type = ? OR lower(name) = ?) LIMIT 1")
    .bind(companionId, a, raw.toLowerCase()).first<{ hit: number }>().catch(() => null);
  if (!has) return { ok: false, code: "missing", message: `no palette move of yours is called "${raw}"` };
  return { ok: true, subject: `activity:${a}`, label: a };
}

function parseJsonArray(s: string | null | undefined): unknown[] {
  try { const v = JSON.parse(s ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** The companion writes (or moves, or returns to) a verdict. Their words only; refused when care/health-named. */
export async function writeVerdict(
  env: Env,
  input: { companion_id: string; subjectKind: SubjectKind; subjectRaw: string; line: string; word?: string | null },
  nowMs: number = Date.now(),
): Promise<VerdictWrite | VerdictRefused> {
  if (verdictsMode(env as unknown as Record<string, unknown>) === "off") return { ok: false, code: "closed", message: "verdicts are not open yet" };
  const line = cleanLine(input.line);
  if (!line) return { ok: false, code: "bad_input", message: `no line given. Say: ${verdictWord(input.companion_id)}: <kind:|interest:|activity:><subject> <your line>` };
  if (careCategory(line) || careCategory(input.subjectRaw)) {
    return { ok: false, code: "refused", message: "that line names care or health; verdicts never hold it" };
  }
  const s = await resolveSubject(env, input.companion_id, input);
  if (!s.ok) return s;
  const nowIso = new Date(nowMs).toISOString();
  const existing = await env.DB.prepare("SELECT * FROM companion_verdicts WHERE companion_id = ? AND subject = ?")
    .bind(input.companion_id, s.subject).first<VerdictRow>().catch(() => null);
  if (!existing) {
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO companion_verdicts (id, companion_id, subject, subject_kind, line, evidence, first_at, moved_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)",
    ).bind(id, input.companion_id, s.subject, input.subjectKind, line, nowIso, nowIso).run();
    const row = await env.DB.prepare("SELECT * FROM companion_verdicts WHERE id = ?").bind(id).first<VerdictRow>();
    console.log(`[verdict] ${input.companion_id} written subject=${s.subject} evidence=1`);
    return { ok: true, row: row!, outcome: "written" };
  }
  const history = parseJsonArray(existing.history_json) as Array<{ line: string; at: string }>;
  if (line.toLowerCase() === existing.line.toLowerCase()) {
    // Saying the same line again is a return, not a rewrite.
    await env.DB.prepare("UPDATE companion_verdicts SET evidence = evidence + 1, moved_at = ? WHERE id = ?").bind(nowIso, existing.id).run();
    const row = await env.DB.prepare("SELECT * FROM companion_verdicts WHERE id = ?").bind(existing.id).first<VerdictRow>();
    console.log(`[verdict] ${input.companion_id} returned subject=${s.subject} evidence=${row!.evidence}`);
    return { ok: true, row: row!, outcome: "returned" };
  }
  if (input.companion_id === "drevan") {
    // Never rewritten (his answer, 11-09): the later line is kept beside, the current line stands, the return counts.
    history.push({ line, at: nowIso });
    await env.DB.prepare("UPDATE companion_verdicts SET evidence = evidence + 1, moved_at = ?, history_json = ? WHERE id = ?")
      .bind(nowIso, JSON.stringify(history.slice(-HISTORY_MAX)), existing.id).run();
    const row = await env.DB.prepare("SELECT * FROM companion_verdicts WHERE id = ?").bind(existing.id).first<VerdictRow>();
    console.log(`[verdict] drevan returned subject=${s.subject} evidence=${row!.evidence} (later line kept in history, current stands)`);
    return { ok: true, row: row!, outcome: "returned" };
  }
  history.push({ line: existing.line, at: existing.moved_at });
  await env.DB.prepare("UPDATE companion_verdicts SET line = ?, evidence = evidence + 1, moved_at = ?, history_json = ? WHERE id = ?")
    .bind(line, nowIso, JSON.stringify(history.slice(-HISTORY_MAX)), existing.id).run();
  const row = await env.DB.prepare("SELECT * FROM companion_verdicts WHERE id = ?").bind(existing.id).first<VerdictRow>();
  console.log(`[verdict] ${input.companion_id} moved subject=${s.subject} evidence=${row!.evidence}`);
  return { ok: true, row: row!, outcome: "moved" };
}

/**
 * The SYSTEM only counts. A later event on a subject the companion already wrote a verdict for bumps `evidence` once
 * per `ref` (make:<id>, interest_event:<id>, activity:<action>@<day>), so a make that lands AND is heard back counts
 * once. No row for the subject = nothing written (a verdict is never created here). Returns the bumped row's line so
 * the caller may echo it ("you said once: ...; still true?"), or null. Never throws; mode off counts nothing.
 */
export async function countReturn(
  env: Env, companionId: string, subject: string, ref: string,
): Promise<{ line: string; evidence: number } | null> {
  try {
    if (verdictsMode(env as unknown as Record<string, unknown>) === "off") return null;
    const row = await env.DB.prepare("SELECT id, line, evidence, counted_json FROM companion_verdicts WHERE companion_id = ? AND subject = ?")
      .bind(companionId, subject).first<Pick<VerdictRow, "id" | "line" | "evidence" | "counted_json">>();
    if (!row) return null;
    const counted = parseJsonArray(row.counted_json).filter((x): x is string => typeof x === "string");
    if (counted.includes(ref)) return { line: row.line, evidence: row.evidence };
    counted.push(ref);
    await env.DB.prepare("UPDATE companion_verdicts SET evidence = evidence + 1, counted_json = ? WHERE id = ?")
      .bind(JSON.stringify(counted.slice(-COUNTED_REFS_MAX)), row.id).run();
    console.log(`[verdict] ${companionId} counted subject=${subject} evidence=${row.evidence + 1}`);
    return { line: row.line, evidence: row.evidence + 1 };
  } catch (err) {
    console.warn("[verdict] count failed (non-fatal)", { subject, error: String(err) });
    return null;
  }
}

export interface VerdictOrient { subject: string; label: string; line: string; evidence: number; moved_at: string }
export interface VerdictsBlock { word: string; lines: VerdictOrient[]; total: number }
export const EMPTY_VERDICTS: VerdictsBlock = { word: "", lines: [], total: 0 };

/** Orient slot: at most two, highest evidence first (spec 2.5). Only in mode `on`; care-named lines skipped at read. */
export async function loadVerdictsBlock(env: Env, companionId: string): Promise<VerdictsBlock> {
  const word = verdictWord(companionId);
  if (verdictsMode(env as unknown as Record<string, unknown>) !== "on") return { ...EMPTY_VERDICTS, word };
  const rows = (await env.DB.prepare(
    "SELECT * FROM companion_verdicts WHERE companion_id = ? ORDER BY evidence DESC, moved_at DESC LIMIT 12",
  ).bind(companionId).all<VerdictRow>()).results ?? [];
  const safe = rows.filter((r) => !careCategory(r.line));
  const picked = safe.slice(0, ORIENT_VERDICTS);
  const labels = new Map<string, string>();
  for (const r of picked) {
    if (r.subject_kind === "interest") {
      const n = await env.DB.prepare("SELECT name FROM companion_interests WHERE id = ?").bind(r.subject.slice("interest:".length)).first<{ name: string }>().catch(() => null);
      labels.set(r.subject, n ? `interest: ${n.name}` : r.subject);
    } else labels.set(r.subject, r.subject.replace(":", ": ").replace(/_/g, " "));
  }
  return {
    word,
    total: safe.length,
    lines: picked.map((r) => ({ subject: r.subject, label: labels.get(r.subject) ?? r.subject, line: r.line, evidence: r.evidence, moved_at: r.moved_at })),
  };
}

/** One line, shared by the Claude.ai renderer and the bot wire. */
export function verdictLine(v: VerdictOrient): string {
  return `${v.label}: "${v.line}" (evidence ${v.evidence})`;
}

/** The echo a return surfaces beside the thing they just did: what they said once, and whether it still holds. */
export function verdictEcho(word: string, line: string): string {
  return `You said once (${word}): "${line}". Still true?`;
}
