// src/watchalong/claude-ai.ts
//
// B67: the movie watchalong reachable from Claude.ai companions through the Librarian.
//
// The Discord path keys a session on channel_id and each bot keeps its own delivered-through cursor in
// memory (nullsafe-discord packages/shared/src/watchalong.ts). Claude.ai has no channel id, so here:
//   - "the live film" = the most recently CREATED session whose status is not 'ended';
//   - the cursor is a D1 row per (session, companion, surface) (migration 0181), surface 'claude_ai'.
//
// The cut is the same load-bearing property as GET /mind/watchalong/active: no cue past the computed
// playhead ever leaves this module. The rendering mirrors the bots (header `[ON SCREEN: <title>, a -> b,
// status]`, the 10-minute join window on a first delivery, the standing line, the spoiler gate wording).
// Cue volume is capped by count and by characters, and the answer says how many were skipped.
//
// Starting a film (the OpenSubtitles key lives on the VPS) and ending one stay in Discord. Nothing here
// touches care, meds or biometrics.

import type { Env } from "../types.js";
import { computePlayhead, type PlayheadRow } from "../handlers/watchalong.js";

export const CLAUDE_AI_SURFACE = "claude_ai";
/** Same numbers as the bots: a first delivery deeper than this into a film shows the last ten minutes. */
export const JOIN_WINDOW_SEC = 600;
export const DEFAULT_MAX_CUES = 80;
export const JOIN_MAX_CUES = 300;
/** A Claude.ai tool result is read in one go; keep the block comfortably small. */
export const MAX_BLOCK_CHARS = 6000;

export type WatchStatus = "playing" | "paused" | "ended";

export interface LiveSession extends PlayheadRow {
  id: string;
  title: string;
  channel_id: string;
  cue_count: number;
  created_at: string;
}

export interface CueRow { start_sec: number; kind: string; speaker: string | null; text: string }

/** 2832 -> "47:12"; 3723 -> "1:02:03". Negative/NaN -> "0:00". */
export function formatPlayhead(sec: number): string {
  const t = Number.isFinite(sec) && sec > 0 ? Math.floor(sec) : 0;
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "47:12" / "1:02:03" -> seconds. Null for anything else (the Librarian pattern only passes these shapes). */
export function parseTimestamp(input: string): number | null {
  const s = input.trim();
  let m = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) {
    const [h, mi, se] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return mi < 60 && se < 60 ? h * 3600 + mi * 60 + se : null;
  }
  m = s.match(/^(\d{1,3}):(\d{2})$/);
  if (m) {
    const [mi, se] = [Number(m[1]), Number(m[2])];
    return se < 60 ? mi * 60 + se : null;
  }
  return null;
}

/** One cue as a screenplay-ish line, identical to the bots' formatCueLine. */
export function formatCueLine(c: CueRow): string {
  const at = `[${formatPlayhead(c.start_sec)}]`;
  const text = c.text.trim();
  if (c.kind === "sound" || (c.kind === "music" && !/[♪♫♩♬]/.test(text))) {
    const body = /^\[.*\]$/.test(text) ? text : `[${text}]`;
    return `${at} ${c.speaker ? `${c.speaker}: ` : ""}${body}`;
  }
  return `${at} ${c.speaker ? `${c.speaker}: ` : ""}${text}`;
}

export function formatOnScreenBlock(args: {
  title: string; status: WatchStatus; fromSec: number; toSec: number;
  cues: CueRow[]; skipped: number; joining: boolean;
}): string | null {
  if (args.cues.length === 0) return null;
  const out = [`[ON SCREEN: ${args.title}, ${formatPlayhead(args.fromSec)} → ${formatPlayhead(args.toSec)}, ${args.status}]`];
  if (args.joining) out.push(`(you're joining ${formatPlayhead(args.toSec)} in; the last ten minutes:)`);
  if (args.skipped > 0) out.push(`(… ${args.skipped} earlier lines not shown)`);
  for (const c of args.cues) out.push(formatCueLine(c));
  return out.join("\n");
}

export const SPOILER_GATE = "Only what's been on screen is yours; don't reach for what you know comes later, and don't search the film.";
export const START_IN_DISCORD = "Starting a film happens in Discord: `dre: movie start <title>`.";

/** Standing line: title, playhead, status, plus the soft spoiler gate. Same wording as the bots. */
export function standingLine(s: { title: string; status: string; playhead_sec: number }): string {
  return `[Watchalong: ${s.title}, ${formatPlayhead(s.playhead_sec)} in, ${s.status}. ` +
    `A first viewing alongside Principal: you follow it through its captions, which reach you as [ON SCREEN] blocks. ` +
    `${SPOILER_GATE}]`;
}

/** The live film: most recently created session that is not ended. No channel id needed. */
export async function findActiveSession(env: Env): Promise<LiveSession | null> {
  const row = await env.DB.prepare(
    `SELECT id, title, channel_id, status, playhead_sec, playhead_set_at, duration_sec, cue_count, created_at
       FROM watchalong_sessions WHERE status != 'ended'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).first<LiveSession>();
  return row ?? null;
}

async function readCursor(env: Env, sessionId: string, companion: string): Promise<number | null> {
  const r = await env.DB.prepare(
    "SELECT through_sec FROM watchalong_cursors WHERE session_id = ? AND companion_id = ? AND surface = ?"
  ).bind(sessionId, companion, CLAUDE_AI_SURFACE).first<{ through_sec: number }>();
  return r ? Number(r.through_sec) : null;
}

async function writeCursor(env: Env, sessionId: string, companion: string, sec: number, nowIso: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO watchalong_cursors (session_id, companion_id, surface, through_sec, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (session_id, companion_id, surface)
     DO UPDATE SET through_sec = excluded.through_sec, updated_at = excluded.updated_at`
  ).bind(sessionId, companion, CLAUDE_AI_SURFACE, sec, nowIso).run();
}

export interface OnScreenResult {
  active: boolean;
  title?: string;
  status?: string;
  playhead: string;
  playhead_sec: number;
  block: string | null;
  shown: number;
  skipped: number;
  joining: boolean;
  standing: string | null;
  spoiler_gate: string;
  note: string;
}

/**
 * What is on screen for this companion: cues between its claude_ai cursor and the playhead, honouring the
 * join window on a first delivery, then advancing the cursor. Never returns a cue past the playhead.
 */
export async function readOnScreen(env: Env, companion: string, nowMs: number = Date.now()): Promise<OnScreenResult> {
  const s = await findActiveSession(env);
  if (!s) {
    return {
      active: false, playhead: "0:00", playhead_sec: 0, block: null, shown: 0, skipped: 0, joining: false,
      standing: null, spoiler_gate: SPOILER_GATE,
      note: `Nothing is playing. ${START_IN_DISCORD}`,
    };
  }
  const playhead = computePlayhead(s, nowMs);
  const cursor = await readCursor(env, s.id, companion);
  const first = cursor === null;
  const since = first ? -1 : cursor;
  const joining = first && playhead > JOIN_WINDOW_SEC;
  const lowerBound = joining ? playhead - JOIN_WINDOW_SEC : since;

  const countRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM watchalong_cues WHERE session_id = ? AND start_sec > ? AND start_sec <= ?"
  ).bind(s.id, lowerBound, playhead).first<{ n: number }>();
  const total = Number(countRow?.n ?? 0);

  // The LAST max_cues in range: what just happened matters more than what scrolled past.
  const maxCues = first ? JOIN_MAX_CUES : DEFAULT_MAX_CUES;
  const recent = await env.DB.prepare(
    `SELECT start_sec, kind, speaker, text FROM watchalong_cues
      WHERE session_id = ? AND start_sec > ? AND start_sec <= ?
      ORDER BY start_sec DESC, idx DESC LIMIT ?`
  ).bind(s.id, lowerBound, playhead, maxCues).all<CueRow>();
  let cues = (recent.results ?? []).slice().reverse();

  // Character budget: drop the OLDEST lines until the block fits.
  let chars = cues.reduce((n, c) => n + formatCueLine(c).length + 1, 0);
  while (cues.length > 1 && chars > MAX_BLOCK_CHARS) {
    chars -= formatCueLine(cues[0]!).length + 1;
    cues = cues.slice(1);
  }
  const skipped = Math.max(0, total - cues.length);

  const status = s.status as WatchStatus;
  const block = formatOnScreenBlock({
    title: s.title, status, fromSec: joining ? playhead - JOIN_WINDOW_SEC : Math.max(0, since), toSec: playhead,
    cues, skipped, joining,
  });

  // Advance. A seek backwards never moves the cursor back (those lines were already delivered).
  await writeCursor(env, s.id, companion, Math.max(playhead, since), new Date(nowMs).toISOString());

  const note = block
    ? (skipped > 0 ? `${cues.length} lines shown, ${skipped} skipped.` : `${cues.length} lines shown.`)
    : `Nothing new on screen since ${formatPlayhead(Math.max(0, since))}${status === "playing" ? "" : ` (the film is ${status})`}.`;
  return {
    active: true, title: s.title, status, playhead: formatPlayhead(playhead), playhead_sec: playhead,
    block, shown: cues.length, skipped, joining, standing: standingLine({ title: s.title, status, playhead_sec: playhead }),
    spoiler_gate: SPOILER_GATE, note,
  };
}

export interface ControlResult {
  ok: boolean;
  message: string;
  title?: string;
  status?: string;
  playhead?: string;
}

/** Seek ("at 47:12") and/or play/pause the live film. Never ends a session (that stays in Discord). */
export async function controlActive(
  env: Env, change: { at_sec?: number; status?: "playing" | "paused" }, nowMs: number = Date.now(),
): Promise<ControlResult> {
  const s = await findActiveSession(env);
  if (!s) return { ok: false, message: `Nothing is playing. ${START_IN_DISCORD}` };

  // Materialise the running clock first, then seek: pausing freezes where the film actually is.
  const current = computePlayhead(s, nowMs);
  let playhead = change.at_sec !== undefined ? Math.max(0, change.at_sec) : current;
  if (s.duration_sec !== null && s.duration_sec !== undefined && Number.isFinite(Number(s.duration_sec))) {
    playhead = Math.min(playhead, Number(s.duration_sec));
  }
  const status = change.status ?? s.status;
  const nowIso = new Date(nowMs).toISOString();
  const res = await env.DB.prepare(
    `UPDATE watchalong_sessions SET status = ?, playhead_sec = ?, playhead_set_at = ?
      WHERE id = ? AND status != 'ended'`
  ).bind(status, playhead, nowIso, s.id).run();
  if (!res.meta.changes) return { ok: false, message: "That film just ended in Discord. Nothing is playing now." };

  const verb = change.at_sec !== undefined
    ? `playhead set to ${formatPlayhead(playhead)}${change.status ? `, ${status}` : ""}`
    : status === "paused" ? `paused at ${formatPlayhead(playhead)}` : `playing from ${formatPlayhead(playhead)}`;
  return { ok: true, title: s.title, status, playhead: formatPlayhead(playhead), message: `${s.title}: ${verb}.` };
}
