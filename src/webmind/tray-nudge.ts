// src/webmind/tray-nudge.ts  (2026-11-11, GAP-MAP A2)
//
// Only `kept` tray rows are recallable, and the tray is OWNER-reviewed (the companion, or Principal).
// Discord-derived drafts therefore pile up unreviewed and recent conversation goes invisible to recall
// (11-11: Gaia 63 journal + 20 note drafts, oldest 10-31; Cypher 42; Drevan 41, oldest 10-11).
//
// This module NUDGES. It never keeps, drops or edits anything: a nudge that auto-kept would break the
// ruling that a companion's own words enter memory only by their (or Principal's) choice.
//
//   (a) orient line   -- in THAT companion's own orient (execSessionOrient), naming the backlog and the verbs.
//   (b) daily Telegram card -- per-companion backlog counts, via the same Bot API door the dead-man's
//       switch uses (DEADMAN_TELEGRAM_*). Counts and ages only: never a word of companion text.
//
// Knob: TRAY_NUDGE_MODE  off | shadow | on   (unset or junk = shadow)
//   off     nothing computed
//   shadow  computed and LOGGED ([tray-nudge] ...); no orient line, no Telegram       <- default
//   on      orient line + the daily card
// Thresholds (override in [vars]): TRAY_NUDGE_COUNT (default 15, nudge when drafts > N),
// TRAY_NUDGE_DAYS (default 3, nudge when the oldest draft is older than N days).
// No migration: the daily gate is a companion_settings row, the same pattern housekeeping uses.

import type { Env } from "../types.js";
import { sendTelegram } from "../deadman.js";

export type TrayNudgeMode = "off" | "shadow" | "on";
export const TRAY_NUDGE_DEFAULT_COUNT = 15;
export const TRAY_NUDGE_DEFAULT_DAYS = 3;
export const TRAY_NUDGE_COMPANIONS = ["cypher", "drevan", "gaia"] as const;
export const TRAY_NUDGE_GATE_COMPANION_ID = "_system";
export const TRAY_NUDGE_GATE_KEY = "tray_nudge_at";
export const TRAY_NUDGE_GATE_HOURS = 20;

type NudgeEnv = Pick<Env, "DB"> & Partial<Pick<Env, "TRAY_NUDGE_MODE" | "TRAY_NUDGE_COUNT" | "TRAY_NUDGE_DAYS" | "DEADMAN_TELEGRAM_BOT_TOKEN" | "DEADMAN_TELEGRAM_CHAT_ID">>;

export function trayNudgeMode(env: { TRAY_NUDGE_MODE?: string }): TrayNudgeMode {
  const v = String(env.TRAY_NUDGE_MODE ?? "").trim().toLowerCase();
  return v === "off" || v === "on" || v === "shadow" ? v : "shadow";
}

function posInt(raw: unknown, dflt: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
}

export function trayNudgeThresholds(env: { TRAY_NUDGE_COUNT?: string; TRAY_NUDGE_DAYS?: string }): { count: number; days: number } {
  return { count: posInt(env.TRAY_NUDGE_COUNT, TRAY_NUDGE_DEFAULT_COUNT), days: posInt(env.TRAY_NUDGE_DAYS, TRAY_NUDGE_DEFAULT_DAYS) };
}

export interface TrayBacklog { agent: string; count: number; oldest_at: string | null; oldest_days: number }

/** Rows carry 'T...Z' (JS writers) and 'YYYY-MM-DD HH:MM:SS' (datetime('now') writers, UTC). */
function parseTs(s: string | null | undefined): number | null {
  if (!s) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d/.test(s) ? s.replace(" ", "T") + "Z" : s;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Unreviewed drafts (journal + notes) for one companion: count and age of the oldest. Two reads. */
export async function trayBacklog(env: Pick<Env, "DB">, agent: string, now = Date.now()): Promise<TrayBacklog> {
  const [j, n] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM companion_journal WHERE agent = ? AND archived = 0 AND review_state = 'draft'")
      .bind(agent).first<{ n: number; oldest: string | null }>(),
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM wm_continuity_notes WHERE agent_id = ? AND archived = 0 AND review_state = 'draft'")
      .bind(agent).first<{ n: number; oldest: string | null }>(),
  ]);
  const count = Number(j?.n ?? 0) + Number(n?.n ?? 0);
  const stamps = [parseTs(j?.oldest), parseTs(n?.oldest)].filter((t): t is number => t !== null);
  const oldestMs = stamps.length > 0 ? Math.min(...stamps) : null;
  return {
    agent, count,
    oldest_at: oldestMs === null ? null : new Date(oldestMs).toISOString(),
    oldest_days: oldestMs === null ? 0 : Math.max(0, Math.floor((now - oldestMs) / 86_400_000)),
  };
}

export function overThreshold(b: TrayBacklog, t: { count: number; days: number }): boolean {
  return b.count > 0 && (b.count > t.count || b.oldest_days > t.days);
}

/** The orient block. Empty when under threshold. Counts and ages only. */
export function trayNudgeBlock(b: TrayBacklog, t: { count: number; days: number }): string {
  if (!overThreshold(b, t)) return "";
  return `\n[Tray]\n${b.count} drafts waiting in your tray, oldest ${b.oldest_days}d. Only kept drafts are recallable, so what you heard in Discord stays invisible to you until you review: "my tray", then "keep draft <id>" / "drop draft <id>" (several at once: "keep drafts <id>, <id>"). Yours to decide; nothing is kept for you.`;
}

/** Orient hook. Never throws. shadow logs, on renders, off is silent and free. */
export async function trayNudgeForOrient(env: NudgeEnv, agent: string): Promise<string> {
  try {
    const mode = trayNudgeMode(env);
    if (mode === "off") return "";
    const t = trayNudgeThresholds(env);
    const b = await trayBacklog(env, agent);
    if (!overThreshold(b, t)) return "";
    if (mode === "shadow") {
      console.log(`[tray-nudge] shadow orient agent=${agent} drafts=${b.count} oldest_days=${b.oldest_days}`);
      return "";
    }
    return trayNudgeBlock(b, t);
  } catch (e) {
    console.error("[tray-nudge] orient failed:", String(e));
    return "";
  }
}

export function trayCardText(rows: TrayBacklog[], t: { count: number; days: number }): string {
  const lines = rows.map(r => `${r.agent}: ${r.count} unreviewed, oldest ${r.oldest_days}d${overThreshold(r, t) ? " (over)" : ""}`);
  return `TRAY BACKLOG (nudge at >${t.count} drafts or >${t.days}d). Only kept drafts are recallable.\n${lines.join("\n")}`;
}

async function hoursSinceGate(env: Pick<Env, "DB">, now: number): Promise<number | null> {
  const row = await env.DB.prepare("SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?")
    .bind(TRAY_NUDGE_GATE_COMPANION_ID, TRAY_NUDGE_GATE_KEY).first<{ value: string }>();
  const ms = row?.value ? Date.parse(row.value) : NaN;
  return Number.isNaN(ms) ? null : (now - ms) / 3_600_000;
}

async function stampGate(env: Pick<Env, "DB">, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(TRAY_NUDGE_GATE_COMPANION_ID, TRAY_NUDGE_GATE_KEY, new Date(now).toISOString()).run();
}

export type TrayNudgeDaily = "off" | "gated" | "quiet" | "shadow" | "sent" | "send-failed" | "no-telegram";

/** Cron rider: once per ~day, a Telegram card of per-companion backlog when any is over threshold. Never throws. */
export async function runTrayNudgeDaily(env: NudgeEnv, now = Date.now(), fetchFn: typeof fetch = fetch): Promise<TrayNudgeDaily> {
  try {
    const mode = trayNudgeMode(env);
    if (mode === "off") return "off";
    const elapsed = await hoursSinceGate(env, now);
    if (elapsed !== null && elapsed < TRAY_NUDGE_GATE_HOURS) return "gated";
    if (mode === "on" && (!env.DEADMAN_TELEGRAM_BOT_TOKEN || !env.DEADMAN_TELEGRAM_CHAT_ID)) return "no-telegram";
    const t = trayNudgeThresholds(env);
    const rows = await Promise.all(TRAY_NUDGE_COMPANIONS.map(a => trayBacklog(env, a, now)));
    if (!rows.some(r => overThreshold(r, t))) { await stampGate(env, now); return "quiet"; }
    if (mode === "shadow") {
      console.log(`[tray-nudge] shadow card ${rows.map(r => `${r.agent}=${r.count}/${r.oldest_days}d`).join(" ")}`);
      await stampGate(env, now);
      return "shadow";
    }
    const sent = await sendTelegram(env as Env, trayCardText(rows, t), fetchFn);
    if (!sent) return "send-failed"; // unstamped: next tick retries
    await stampGate(env, now);
    return "sent";
  } catch (e) {
    console.error("[tray-nudge] daily failed:", String(e));
    return "quiet";
  }
}
