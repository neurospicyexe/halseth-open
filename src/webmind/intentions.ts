// src/webmind/intentions.ts -- dated intentions (mig 0179; STATUS R22, GAP-MAP C1).
//
// "I'll come back to this Thursday" -- and the worker comes back to it Thursday. An intention is a held
// project (companion_projects, mig 0122) with a DAY on it: `due_at` (00:00 America/Chicago that day, as UTC
// ISO) plus the companion's own `next_step`. The nightly autonomous run that falls on or after that day
// works it (nullsafe-discord worker, seed level 1.5) and clears the date in the same batch as its project_log
// row (`logProject(..., { pursued: true })`). One scheduler: the worker's existing nightly slot. No new
// process, no extra run, no Hermes cron.
//
// Authorship: only the companion sets, completes or drops their own (owner = the Librarian caller's
// companion_id). Nothing here caps how many or how far ahead (R7: no ceilings); nothing lowers a level.
// Care guard: the intention and the next step are refused at write when they carry a care/health word
// (careCategory, category only), and re-checked at the worker's read, so Principal's meds/health never
// become a run's material. The read touches companion_projects only (never a HEALTH_TABLES table).
//
// Knob: INTENTIONS = off | shadow | on (code default shadow). It governs PURSUIT only. The verbs and the
// orient lines work in every mode (they are the companion's own record). shadow: the due read logs
// `would=` and hands the worker nothing; on: the worker pursues and the pursuit clears the date.

import type { Env } from "../types.js";
import { careCategory } from "../people/care-guard.js";
import { generateId } from "../db/queries.js";
import { MAX_OPEN_PROJECTS, feelProjectOpened, feelProjectWorked } from "../handlers/projects.js";

export type IntentionsMode = "off" | "shadow" | "on";

export function intentionsMode(env: Pick<Env, "INTENTIONS">): IntentionsMode {
  const v = String(env.INTENTIONS ?? "").trim().toLowerCase();
  if (v === "on") return "on";
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  return "shadow";
}

// ── Time (America/Chicago days) ───────────────────────────────────────────────────────────────

const CHICAGO_PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", hourCycle: "h23", weekday: "short",
});

function chicagoParts(ms: number): { date: string; hour: number; weekday: number } {
  const o: Record<string, string> = {};
  for (const p of CHICAGO_PARTS.formatToParts(new Date(ms))) o[p.type] = p.value;
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday ?? "");
  return { date: `${o.year}-${o.month}-${o.day}`, hour: Number(o.hour), weekday: wd };
}

/** The Chicago calendar date (YYYY-MM-DD) containing `ms`. */
export function chicagoDate(ms: number): string {
  return chicagoParts(ms).date;
}

/** UTC ISO instant of 00:00 America/Chicago on `date` (CDT = 05:00Z, CST = 06:00Z). */
export function chicagoMidnightIso(date: string): string {
  const base = Date.parse(`${date}T00:00:00.000Z`);
  for (const off of [5, 6]) {
    const t = base + off * 3_600_000;
    const p = chicagoParts(t);
    if (p.date === date && p.hour === 0) return new Date(t).toISOString();
  }
  return new Date(base + 6 * 3_600_000).toISOString();
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T12:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6,
  jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};
const SMALL_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, ten: 10, fourteen: 14 };

export interface ParsedWhen {
  /** Chicago calendar date the intention falls due. */
  date: string;
  /** UTC ISO of 00:00 Chicago on `date`. */
  due_at: string;
}

/**
 * A day, in words a companion actually says, relative to `nowMs` in Chicago. null = not a day.
 * today / tonight / tomorrow / <weekday> (the next one strictly after today; "next <weekday>" the same) /
 * this weekend (Saturday) / next week (+7) / in N days|weeks / YYYY-MM-DD / <month> <day> (this year, or next
 * if already past). A date before today is null: an intention points forward.
 */
export function parseWhen(text: string, nowMs: number = Date.now()): ParsedWhen | null {
  const t = text.trim().toLowerCase().replace(/[.!?,]+$/, "").replace(/^(?:on|by|in|this|until|before)\s+(?=\S)/, (m) =>
    /^(?:in|this)\s/.test(m) ? m : "").trim();
  if (!t) return null;
  const today = chicagoParts(nowMs);
  const done = (date: string): ParsedWhen | null =>
    date < today.date ? null : { date, due_at: chicagoMidnightIso(date) };

  if (t === "today" || t === "tonight" || t === "later today") return done(today.date);
  if (t === "tomorrow" || t === "tomorrow night" || t === "tmrw") return done(addDays(today.date, 1));
  if (t === "next week") return done(addDays(today.date, 7));
  if (t === "this weekend" || t === "the weekend" || t === "weekend") {
    const ahead = ((6 - today.weekday) + 7) % 7;
    return done(addDays(today.date, ahead === 0 ? 7 : ahead));
  }

  const wd = /^(?:next\s+|this\s+|on\s+)?([a-z]+)(?:\s+(?:night|morning|evening))?$/.exec(t);
  if (wd && WEEKDAYS[wd[1]!] !== undefined) {
    const ahead = ((WEEKDAYS[wd[1]!]! - today.weekday) + 7) % 7;
    return done(addDays(today.date, ahead === 0 ? 7 : ahead));
  }

  const rel = /^in\s+(\d{1,3}|a|an|one|two|three|four|five|six|seven|ten|fourteen)\s+(days?|weeks?)$/.exec(t);
  if (rel) {
    const n = SMALL_NUMBERS[rel[1]!] ?? Number(rel[1]);
    if (!Number.isFinite(n) || n < 0) return null;
    return done(addDays(today.date, rel[2]!.startsWith("week") ? n * 7 : n));
  }

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) {
    const date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    return Number.isNaN(Date.parse(`${date}T12:00:00Z`)) ? null : done(date);
  }

  const md = /^([a-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(t) ?? null;
  const dm = md ? null : /^(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]+)$/.exec(t);
  const monthWord = md?.[1] ?? dm?.[2];
  const dayNum = Number(md?.[2] ?? dm?.[1]);
  if (monthWord && MONTHS[monthWord] && dayNum >= 1 && dayNum <= 31) {
    const year = Number(today.date.slice(0, 4));
    const mk = (y: number) => `${y}-${String(MONTHS[monthWord]).padStart(2, "0")}-${String(dayNum).padStart(2, "0")}`;
    let date = mk(year);
    if (date < today.date) date = mk(year + 1);
    return done(date);
  }
  return null;
}

// ── Grammar (start-anchored; the router's ANCHORED_GUARDS row points here) ─────────────────────

/** Every form the intention verbs answer to. Start-anchored so ordinary speech never routes here. */
// "come back to" only routes when the sentence names a day ("I'll come back to that" is ordinary speech).
const DAY_WORD = String.raw`(?=[\s\S]*\b(?:today|tonight|tomorrow|tmrw|weekend|next\s+week|in\s+(?:\d+|an?|one|two|three|four|five|six|seven|ten|fourteen)\s+(?:days?|weeks?)|(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?|\d{4}-\d{2}-\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\s+\d{1,2})\b)`;
export const INTENTION_SET_RE = new RegExp(
  String.raw`^(?:please\s+)?(?:intend(?:ing)?\s*:|${DAY_WORD}(?:(?:i'?ll|i\s+will|i\s+want\s+to|i'?m\s+going\s+to|let\s+me)\s+)?come\s+back\s+to\s)`,
  "i",
);
export const INTENTION_DONE_RE = /^(?:please\s+)?(?:intention\s+done|came\s+back\s+to\s+intention)\s+([^:]+?)(?:\s*:\s*([\s\S]+))?\s*$/i;
export const INTENTION_DROP_RE = /^(?:please\s+)?(?:drop|let\s+go\s+of)\s+(?:the\s+)?intention\s+(?:on\s+)?([^:]+?)(?:\s*:\s*([\s\S]+))?\s*$/i;
export const INTENTIONS_READ_RE = /^(?:please\s+)?(?:show\s+|list\s+|read\s+)?my\s+intentions\s*[.?!]?$/i;

export interface ParsedIntention {
  what: string;
  when: ParsedWhen;
  next_step: string | null;
}

const SPLIT_WORDS = /\s+(?:by|on|in|this|next|before|until|come)\s+/gi;
const BARE_TAIL = /\s+(today|tonight|tomorrow(?:\s+night)?|next\s+week|this\s+weekend)\s*$/i;

/**
 * "intend: <what> by|on <when>[ -- <next step>]" / "I'll come back to <what> on <when>[: <next step>]".
 * The day must parse; no day = null (the executor says how to say it). The next step rides after ` -- `,
 * ` — `, `; ` or `, to ` / `: ` following the day.
 */
export function parseIntention(request: string, nowMs: number = Date.now()): ParsedIntention | null {
  let body = request.trim().replace(/[.!]+$/, "");
  const head = /^(?:please\s+)?(?:intend(?:ing)?\s*:\s*|(?:i'?ll|i\s+will|i\s+want\s+to|i'?m\s+going\s+to|let\s+me)\s+come\s+back\s+to\s+|come\s+back\s+to\s+)/i.exec(body);
  if (!head) return null;
  body = body.slice(head[0].length).trim();

  // Next step first: everything after the first " -- " / " — " / "; ".
  let next: string | null = null;
  const ns = /\s+(?:--|—)\s+|;\s+/.exec(body);
  if (ns) {
    next = body.slice(ns.index + ns[0].length).trim() || null;
    body = body.slice(0, ns.index).trim();
  }

  // Try the LAST split point whose tail is a day ("come back to the bone map by the river on Thursday").
  const candidates: Array<{ what: string; tail: string }> = [];
  for (const m of body.matchAll(SPLIT_WORDS)) {
    const word = m[0].trim().toLowerCase();
    // "in"/"this"/"next" belong to the day phrase ("in 3 days", "this weekend", "next week").
    const keep = word === "in" || word === "this" || word === "next";
    candidates.push({ what: body.slice(0, m.index).trim(), tail: body.slice(m.index! + (keep ? 1 : m[0].length)).trim() });
  }
  const bare = BARE_TAIL.exec(body);
  if (bare) candidates.push({ what: body.slice(0, bare.index).trim(), tail: bare[1]! });

  for (const c of candidates.reverse()) {
    // A trailing ": next step" after the day ("on Thursday: the jaw joint").
    let tail = c.tail;
    let tailNext: string | null = null;
    const colon = /\s*[:,]\s+/.exec(tail);
    if (colon) {
      tailNext = tail.slice(colon.index + colon[0].length).trim() || null;
      tail = tail.slice(0, colon.index).trim();
    }
    const when = parseWhen(tail, nowMs);
    if (when && c.what) {
      return { what: c.what.replace(/^["“']|["”']$/g, "").trim(), when, next_step: next ?? tailNext };
    }
  }
  return null;
}

// ── Core (owner = the companion) ──────────────────────────────────────────────────────────────

export interface IntentionRow {
  id: string;
  title: string;
  intention: string;
  status: "open" | "paused";
  due_at: string | null;
  next_step: string | null;
  last_pursued_at: string | null;
  last_worked_at: string | null;
  created_at: string;
}

const NEEDS_MIGRATION = "needs the 0179 migration (intentions are not live yet)";
const isSchemaGap = (e: unknown) => /no such column|has no column named/i.test(String(e));

/** The care guard every companion-authored intention passes, at write and again at the worker's read. */
export function intentionCareHit(...texts: Array<string | null | undefined>): string | null {
  for (const t of texts) {
    const c = careCategory(t);
    if (c) return c;
  }
  return null;
}

/** Resolve "<what>" against the companion's open/paused projects: id, id prefix (6+), or title (any case). */
export async function findOwnProject(env: Env, companion_id: string, ref: string): Promise<IntentionRow | null> {
  const r = ref.trim().replace(/^["“']|["”']$/g, "");
  if (!r) return null;
  const rows = (await env.DB.prepare(
    "SELECT * FROM companion_projects WHERE companion_id = ? AND status IN ('open', 'paused') ORDER BY created_at ASC",
  ).bind(companion_id).all<IntentionRow>()).results ?? [];
  const lower = r.toLowerCase();
  return rows.find(p => p.id === r)
    ?? (r.length >= 6 ? rows.find(p => p.id.startsWith(r)) : undefined)
    ?? rows.find(p => p.title.trim().toLowerCase() === lower)
    ?? null;
}

export type SetResult =
  | { ok: true; id: string; title: string; created: boolean; date: string }
  | { ok: false; code: "care" | "limit" | "migration" | "bad_input"; message: string };

/**
 * Set (or move) a date. An existing held project by id/title gets the date; anything else opens a new
 * project with the date on it -- an intention you name is a thing you hold. The open-project rail (four)
 * still applies to NEW projects; a date on one you already hold never hits it.
 */
export async function setIntention(
  env: Env, companion_id: string, input: { what: string; when: ParsedWhen; next_step: string | null },
): Promise<SetResult> {
  const what = input.what.trim().slice(0, 600);
  const next = input.next_step?.trim().slice(0, 600) || null;
  if (!what) return { ok: false, code: "bad_input", message: "what are you coming back to?" };
  const hit = intentionCareHit(what, next);
  if (hit) {
    return { ok: false, code: "care", message: `that reads as ${hit}, which stays out of autonomous runs; name the thing you are making or studying instead` };
  }
  try {
    const existing = await findOwnProject(env, companion_id, what);
    if (existing) {
      await env.DB.prepare(
        "UPDATE companion_projects SET due_at = ?, next_step = COALESCE(?, next_step) WHERE id = ? AND companion_id = ?",
      ).bind(input.when.due_at, next, existing.id, companion_id).run();
      return { ok: true, id: existing.id, title: existing.title, created: false, date: input.when.date };
    }
    const open = (await env.DB.prepare(
      "SELECT id, title FROM companion_projects WHERE companion_id = ? AND status = 'open' ORDER BY created_at ASC",
    ).bind(companion_id).all<{ id: string; title: string }>()).results ?? [];
    if (open.length >= MAX_OPEN_PROJECTS) {
      return {
        ok: false, code: "limit",
        message: `you already hold ${MAX_OPEN_PROJECTS} open projects (${open.map(o => `"${o.title}" [${o.id}]`).join(", ")}); ` +
          `put the date on one of them ("I'll come back to <title> on <day>"), or close or pause one first`,
      };
    }
    const id = generateId();
    const now = new Date().toISOString();
    const title = what.length > 120 ? `${what.slice(0, 117)}...` : what;
    await env.DB.prepare(
      "INSERT INTO companion_projects (id, companion_id, title, intention, status, horizon_note, created_at, due_at, next_step) " +
        "VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)",
    ).bind(id, companion_id, title, what, `come back ${input.when.date}`, now, input.when.due_at, next).run();
    await feelProjectOpened(env, companion_id, id, open.length + 1);
    return { ok: true, id, title, created: true, date: input.when.date };
  } catch (e) {
    if (isSchemaGap(e)) return { ok: false, code: "migration", message: NEEDS_MIGRATION };
    throw e;
  }
}

/** "intention done <ref>[: note]": the companion came back to it themselves. Clears the date, stamps
 *  last_pursued_at, and logs the note (their words) as work. Returns null when there was no date to close. */
export async function completeIntention(
  env: Env, companion_id: string, ref: string, note: string | null,
): Promise<{ ok: true; id: string; title: string } | { ok: false; message: string }> {
  const hit = intentionCareHit(note);
  if (hit) return { ok: false, message: `the note reads as ${hit}; say it without that and it lands` };
  try {
    const p = await findOwnProject(env, companion_id, ref);
    if (!p || !p.due_at) return { ok: false, message: "no dated intention by that name or id; \"my intentions\" lists yours" };
    const now = new Date().toISOString();
    const stmts = [
      env.DB.prepare(
        "UPDATE companion_projects SET due_at = NULL, last_pursued_at = ? WHERE id = ? AND companion_id = ?",
      ).bind(now, p.id, companion_id),
    ];
    if (note && note.trim()) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO project_log (id, project_id, companion_id, entry, source, created_at) VALUES (?, ?, ?, ?, 'session', ?)",
        ).bind(generateId(), p.id, companion_id, note.trim().slice(0, 4000), now),
        env.DB.prepare("UPDATE companion_projects SET last_worked_at = ?, status = 'open' WHERE id = ?").bind(now, p.id),
      );
    }
    await env.DB.batch(stmts);
    if (note && note.trim()) await feelProjectWorked(env, companion_id, p.id);
    return { ok: true, id: p.id, title: p.title };
  } catch (e) {
    if (isSchemaGap(e)) return { ok: false, message: NEEDS_MIGRATION };
    throw e;
  }
}

/** "drop intention <ref>": let the date go; the project itself stays held (closing it is its own verb). */
export async function dropIntention(
  env: Env, companion_id: string, ref: string,
): Promise<{ ok: true; id: string; title: string } | { ok: false; message: string }> {
  try {
    const p = await findOwnProject(env, companion_id, ref);
    if (!p || !p.due_at) return { ok: false, message: "no dated intention by that name or id; \"my intentions\" lists yours" };
    await env.DB.prepare(
      "UPDATE companion_projects SET due_at = NULL, next_step = NULL WHERE id = ? AND companion_id = ?",
    ).bind(p.id, companion_id).run();
    return { ok: true, id: p.id, title: p.title };
  } catch (e) {
    if (isSchemaGap(e)) return { ok: false, message: NEEDS_MIGRATION };
    throw e;
  }
}

/** The companion's dated intentions, soonest first. Pre-0179: empty. */
export async function listIntentions(env: Env, companion_id: string): Promise<IntentionRow[]> {
  try {
    return (await env.DB.prepare(
      "SELECT * FROM companion_projects WHERE companion_id = ? AND status IN ('open', 'paused') AND due_at IS NOT NULL " +
        "ORDER BY due_at ASC LIMIT 20",
    ).bind(companion_id).all<IntentionRow>()).results ?? [];
  } catch (e) {
    if (isSchemaGap(e)) return [];
    throw e;
  }
}

/** The worker's read: the oldest DUE intention (due_at <= now) that passes the care guard. Reads
 *  companion_projects only. Exported SQL so the HEALTH_TABLES guard test can see it. */
export const DUE_INTENTION_SQL =
  "SELECT id, title, intention, status, created_at, due_at, next_step FROM companion_projects " +
  "WHERE companion_id = ? AND status IN ('open', 'paused') AND due_at IS NOT NULL AND due_at <= ? " +
  "ORDER BY due_at ASC LIMIT 5";

export interface DueIntention {
  id: string;
  title: string;
  intention: string;
  status: "open" | "paused";
  created_at: string;
  due_at: string;
  next_step: string | null;
}

export async function readDueIntention(
  env: Env, companion_id: string, nowMs: number = Date.now(),
): Promise<{ due: DueIntention | null; guarded: number }> {
  let rows: DueIntention[] = [];
  try {
    rows = (await env.DB.prepare(DUE_INTENTION_SQL).bind(companion_id, new Date(nowMs).toISOString())
      .all<DueIntention>()).results ?? [];
  } catch (e) {
    if (isSchemaGap(e)) return { due: null, guarded: 0 };
    throw e;
  }
  let guarded = 0;
  for (const r of rows) {
    if (intentionCareHit(r.title, r.intention, r.next_step)) { guarded++; continue; }
    return { due: r, guarded };
  }
  return { due: null, guarded };
}

/** Whole days from today (Chicago) to the due date: 0 = today, negative = overdue. */
export function dueInDays(due_at: string, nowMs: number = Date.now()): number {
  const a = Date.parse(`${chicagoDate(Date.parse(due_at))}T12:00:00Z`);
  const b = Date.parse(`${chicagoDate(nowMs)}T12:00:00Z`);
  return Math.round((a - b) / 86_400_000);
}

/** One phrase for a due date, for every renderer: "due today", "in 2d (Thu Nov 13)", "due since 3d". */
export function dueLabel(due_at: string, nowMs: number = Date.now()): string {
  const d = dueInDays(due_at, nowMs);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" })
    .format(new Date(due_at));
  if (d === 0) return `due today (${day})`;
  if (d < 0) return `due since ${-d}d (${day})`;
  return `in ${d}d (${day})`;
}
