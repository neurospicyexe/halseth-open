// src/handlers/projects.ts -- companion self-directed projects (consequence layer C2, mig 0122).
//
// The first structure where a companion OWNS a multi-week intention. Opened, worked, and ENDED by
// the companion; the worker only ever works an already-open project on a project day. `released`
// is a chosen ending with the same dignity as `done` -- no sweep, no cron, no auto-close ever.
//
// Rails (all in this file, so the whole story is auditable in one place):
//   - max 4 OPEN projects per companion (paused ones do not count against the cap; raised from 2 on
//     2026-11-11, with the felt cost of churn/load/finish in webmind/project-feel.ts);
//   - logging work always stamps last_worked_at, and working a paused project re-opens it --
//     resuming is done by working, not by ceremony;
//   - a project idle 30+ days is SURFACED as "release or resume?" (computed at read; nothing is
//     ever closed by machine). Rails without decay are ratchets; this rail is a question, not a hand.

import { Env } from "../types";
import { generateId } from "../db/queries";
import { assertWritten } from "../lib/result.js";
import { intentionsMode, readDueIntention, listIntentions } from "../webmind/intentions.js";
import {
  fireProjectFeel, churnScale, gaveWhy, LOAD_FOURTH_SCALE, EARLY_DROP_DAYS, EARLY_DROP_MAX_LOG, CHURN_WINDOW_DAYS,
} from "../webmind/project-feel.js";

/** The open-project rail. A CODE constant on purpose (no env override: a stale toml must not revert it). */
export const MAX_OPEN_PROJECTS = 4;
/** Idle this long, the orient block asks "release or resume?" -- the companion's call. */
export const PROJECT_STALE_DAYS = 30;

export interface ProjectRow {
  id: string;
  companion_id: string;
  title: string;
  intention: string;
  status: "open" | "paused" | "done" | "released";
  horizon_note: string | null;
  resolution_note: string | null;
  created_at: string;
  last_worked_at: string | null;
  closed_at: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── Core (owner = the companion; the worker acts AS the companion via its id) ─────────────────

export async function openProject(
  env: Env,
  companion_id: string,
  input: { title: string; intention: string; horizon_note?: string | null },
): Promise<{ id: string; created_at: string } | { error: "limit"; open: Array<{ id: string; title: string }> }> {
  // The cap is a rail, not a quota: four intentions is as many as anyone holds well. Paused
  // projects are shelved by choice and do not block a new one.
  const open = (await env.DB.prepare(
    "SELECT id, title FROM companion_projects WHERE companion_id = ? AND status = 'open' ORDER BY created_at ASC",
  ).bind(companion_id).all<{ id: string; title: string }>()).results ?? [];
  if (open.length >= MAX_OPEN_PROJECTS) return { error: "limit", open };

  const id = generateId();
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO companion_projects (id, companion_id, title, intention, status, horizon_note, created_at) " +
      "VALUES (?, ?, ?, ?, 'open', ?, ?)",
  ).bind(id, companion_id, input.title, input.intention, input.horizon_note ?? null, now).run();
  assertWritten(res, { op: "project_open", companion_id });
  await feelProjectOpened(env, companion_id, id, open.length + 1);
  return { id, created_at: now };
}

// ── Felt cost (PROJECT_FEEL; webmind/project-feel.ts). Every project path ends in this file, so every
//    stimulus fires from here: open / log / close, plus the two intentions.ts writes that bypass openProject
//    and logProject (a NEW dated project, an `intention done` note) which call the two exported helpers. ──

/** Opening made this the companion's `openAfter`-th open project: the 3rd accrues load, the 4th more. 1st/2nd free. */
export async function feelProjectOpened(env: Env, companion_id: string, project_id: string, openAfter: number): Promise<void> {
  if (openAfter < 3) return;
  await fireProjectFeel(env, "project_load", companion_id, project_id, {
    scale: openAfter >= 4 ? LOAD_FOURTH_SCALE : 1,
    label: openAfter >= 4 ? "carrying a fourth project" : "carrying a third project",
  });
}

/** A work-log entry landed on this companion's project. */
export async function feelProjectWorked(env: Env, companion_id: string, project_id: string): Promise<void> {
  await fireProjectFeel(env, "project_worked", companion_id, project_id);
}

/** Opened under EARLY_DROP_DAYS ago with fewer than EARLY_DROP_MAX_LOG work entries. */
async function isEarlyDrop(env: Env, project_id: string, created_at: string, nowMs: number): Promise<boolean> {
  const created = Date.parse(created_at);
  if (!Number.isFinite(created) || nowMs - created >= EARLY_DROP_DAYS * 86_400_000) return false;
  const logs = await env.DB.prepare("SELECT COUNT(*) AS n FROM project_log WHERE project_id = ?")
    .bind(project_id).first<{ n: number }>();
  return (logs?.n ?? 0) < EARLY_DROP_MAX_LOG;
}

/** The companion's OTHER early drops in the churn window (released, opened < 7d before release, < 2 log entries). */
async function otherEarlyDrops(env: Env, companion_id: string, project_id: string, nowMs: number): Promise<number> {
  const since = new Date(nowMs - CHURN_WINDOW_DAYS * 86_400_000).toISOString();
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companion_projects p WHERE p.companion_id = ? AND p.status = 'released' AND p.id <> ? " +
      "AND p.closed_at >= ? AND (julianday(p.closed_at) - julianday(p.created_at)) < ? " +
      "AND (SELECT COUNT(*) FROM project_log l WHERE l.project_id = p.id) < ?",
  ).bind(companion_id, project_id, since, EARLY_DROP_DAYS, EARLY_DROP_MAX_LOG).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Append a work entry. Stamps last_worked_at; working a PAUSED project re-opens it (resuming is
 *  done by working). Closed projects refuse -- an ended thing stays ended unless re-opened by a
 *  human decision, which does not exist as a verb on purpose. */
export async function logProject(
  env: Env,
  companion_id: string,
  project_id: string,
  entry: string,
  source: "worker" | "session" | "discord" = "session",
  opts: { pursued?: boolean } = {},
): Promise<{ ok: true; id: string; reopened: boolean; pursued: boolean } | { ok: false; reason: string }> {
  const row = await env.DB.prepare(
    "SELECT companion_id, status FROM companion_projects WHERE id = ?",
  ).bind(project_id).first<{ companion_id: string; status: ProjectRow["status"] }>();
  if (!row) return { ok: false, reason: "project not found" };
  if (row.companion_id !== companion_id) return { ok: false, reason: `that project belongs to ${row.companion_id}` };
  if (row.status === "done" || row.status === "released") {
    return { ok: false, reason: `project is ${row.status} -- an ended thing stays ended` };
  }

  const id = generateId();
  const now = new Date().toISOString();
  const reopened = row.status === "paused";
  // Working a paused project re-opens it, so it carries load like any opening (PROJECT_FEEL project_load).
  const openBefore = reopened
    ? (await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM companion_projects WHERE companion_id = ? AND status = 'open'",
      ).bind(companion_id).first<{ n: number }>())?.n ?? 0
    : 0;
  // One batch: the schema promises "last_worked_at is stamped by every project_log write", and
  // only an atomic write keeps that promise -- a crash between two statements would leave a log
  // row whose project still reads as untouched (migration-reviewer advisory, 0122).
  const stmts = [
    env.DB.prepare(
      "INSERT INTO project_log (id, project_id, companion_id, entry, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, project_id, companion_id, entry, source, now),
    env.DB.prepare(
      "UPDATE companion_projects SET last_worked_at = ?, status = 'open' WHERE id = ?",
    ).bind(now, project_id),
  ];
  // Mig 0179: a worker run that pursued a DUE intention closes the date in the SAME batch as its log row,
  // so the date can never outlive the work (it would otherwise be the topic every night). Only a date that
  // has actually come due is cleared: one the companion moved forward mid-run stays.
  if (opts.pursued) {
    stmts.push(env.DB.prepare(
      "UPDATE companion_projects SET last_pursued_at = ?, due_at = NULL WHERE id = ? AND due_at IS NOT NULL AND due_at <= ?",
    ).bind(now, project_id, now));
  }
  const [logRes] = await env.DB.batch(stmts);
  assertWritten(logRes, { op: "project_log", companion_id });
  if (reopened) await feelProjectOpened(env, companion_id, project_id, openBefore + 1);
  await feelProjectWorked(env, companion_id, project_id);
  return { ok: true, id, reopened, pursued: Boolean(opts.pursued) };
}

/** End a project: done (it became what it was for) or released (a chosen ending -- same dignity,
 *  different shape). The note is the companion's words; machine text has no business here. */
export async function closeProject(
  env: Env,
  companion_id: string,
  project_id: string,
  kind: "done" | "released",
  resolution_note: string | null,
): Promise<boolean> {
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // Classify BEFORE the write (felt cost, PROJECT_FEEL): the churn count must not see this project, and the
  // release shape (early vs honest) is a fact about the project as it stood. A failed read just means no feel.
  let feel: { stimulus: string; scale: number } | null = null;
  try {
    const pre = await env.DB.prepare(
      "SELECT created_at FROM companion_projects WHERE id = ? AND companion_id = ? AND status IN ('open', 'paused')",
    ).bind(project_id, companion_id).first<{ created_at: string }>();
    if (pre) {
      if (kind === "done") feel = { stimulus: "project_finished", scale: 1 };
      // A reason given = a learned wrong door, never a cost (Drevan 3bcee72a: under-charge rather than mis-charge;
      // Gaia 64acb5f1: set down with a why costs nothing). Only an early drop with NO why is the stone.
      else if (!gaveWhy(resolution_note) && (await isEarlyDrop(env, project_id, pre.created_at, nowMs))) {
        const scale = companion_id === "gaia" ? 1 : churnScale(await otherEarlyDrops(env, companion_id, project_id, nowMs));
        feel = { stimulus: "project_dropped_early", scale };
      } else feel = { stimulus: "project_let_go", scale: 1 };
    }
  } catch (err) {
    console.warn("[project-feel] classify failed", { project_id, error: String(err) });
  }
  const r = await env.DB.prepare(
    "UPDATE companion_projects SET status = ?, resolution_note = ?, closed_at = ? " +
      "WHERE id = ? AND companion_id = ? AND status IN ('open', 'paused')",
  ).bind(kind, resolution_note, now, project_id, companion_id).run();
  const changed = (r.meta?.changes ?? 0) > 0;
  if (changed && feel) await fireProjectFeel(env, feel.stimulus, companion_id, project_id, { scale: feel.scale });
  return changed;
}

/** Shelve without ending. Doesn't count against the open cap; any logged work re-opens it. */
export async function pauseProject(env: Env, companion_id: string, project_id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE companion_projects SET status = 'paused' WHERE id = ? AND companion_id = ? AND status = 'open'",
  ).bind(project_id, companion_id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Ceremony-free resume for when the companion wants the project open again without logging work
 *  yet. Respects the open cap -- resuming a third project is opening a third project. */
export async function resumeProject(
  env: Env, companion_id: string, project_id: string,
): Promise<{ ok: boolean; reason?: string }> {
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companion_projects WHERE companion_id = ? AND status = 'open'",
  ).bind(companion_id).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_PROJECTS) return { ok: false, reason: `${MAX_OPEN_PROJECTS} projects are already open -- close or pause one first` };
  const r = await env.DB.prepare(
    "UPDATE companion_projects SET status = 'open' WHERE id = ? AND companion_id = ? AND status = 'paused'",
  ).bind(project_id, companion_id).run();
  const ok = (r.meta?.changes ?? 0) > 0;
  // Resuming is opening (the comment above): a paused-then-resumed project carries the same load as a new
  // one, or pause/resume becomes the free way around project_load.
  if (ok) await feelProjectOpened(env, companion_id, project_id, (open?.n ?? 0) + 1);
  return { ok, ...(ok ? {} : { reason: "not found, not yours, or not paused" }) };
}

export async function readProjects(
  env: Env, companion_id: string, status?: string, limit = 20,
): Promise<ProjectRow[]> {
  const capped = Math.min(Math.max(1, limit), 100);
  const stmt = status
    ? env.DB.prepare(
        "SELECT * FROM companion_projects WHERE companion_id = ? AND status = ? " +
          "ORDER BY COALESCE(last_worked_at, created_at) ASC LIMIT ?",
      ).bind(companion_id, status, capped)
    : env.DB.prepare(
        "SELECT * FROM companion_projects WHERE companion_id = ? " +
          "ORDER BY (status IN ('open','paused')) DESC, COALESCE(last_worked_at, created_at) ASC LIMIT ?",
      ).bind(companion_id, capped);
  return (await stmt.all<ProjectRow>()).results ?? [];
}

export async function readProjectLog(
  env: Env, project_id: string, limit = 20,
): Promise<Array<{ id: string; entry: string; source: string; created_at: string }>> {
  const capped = Math.min(Math.max(1, limit), 100);
  return (await env.DB.prepare(
    "SELECT id, entry, source, created_at FROM project_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
  ).bind(project_id, capped).all<{ id: string; entry: string; source: string; created_at: string }>()).results ?? [];
}

// ── HTTP surface (the worker's lane + Hearth/Principal reads) ────────────────────────────────────

/** GET /mind/projects/:companion_id?status=open -- the worker's project-day read and Hearth's list. */
export async function getProjects(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companionId = params.companion_id;
  if (!companionId) return json({ error: "missing companion_id" }, 400);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const rows = await readProjects(env, companionId, status);
  return json({ projects: rows });
}

/** GET /mind/projects/:id/log -- the work trail, newest first. Principal's read. */
export async function getProjectLog(_request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  const rows = await readProjectLog(env, id);
  return json({ log: rows });
}

/** POST /mind/projects/:id/log { companion_id, entry, source? } -- the worker's write after a
 *  project-day run. Same rails as the verb: ownership checked, ended projects refuse. */
export async function postProjectLog(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  let body: { companion_id?: string; entry?: string; source?: string; pursued?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companionId = String(body.companion_id ?? "");
  const entry = String(body.entry ?? "").trim();
  if (!companionId || !entry) return json({ error: "need { companion_id, entry }" }, 400);
  const source = body.source === "worker" || body.source === "discord" ? body.source : "session";
  // `pursued` (mig 0179) is honoured only when INTENTIONS=on: in shadow/off the worker was handed nothing
  // to pursue, and pre-0179 the columns do not exist.
  const pursued = body.pursued === true && source === "worker" && intentionsMode(env) === "on";
  const out = await logProject(env, companionId, id, entry.slice(0, 4000), source, { pursued });
  if (!out.ok) return json({ error: "project_log_failed", reason: out.reason }, 409);
  return json({ ok: true, id: out.id, reopened: out.reopened, pursued: out.pursued });
}

/** GET /mind/intentions/:companion_id/due -- the worker's nightly read (mig 0179). A pure read: it never
 *  stamps anything (the pursuit's log write does). off: nothing. shadow: `would` names it, `due` stays null.
 *  on: `due` is the oldest due intention that passes the care guard. */
export async function getDueIntention(_request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companionId = params.companion_id;
  if (!companionId) return json({ error: "missing companion_id" }, 400);
  const mode = intentionsMode(env);
  if (mode === "off") return json({ mode, due: null, would: null });
  const { due, guarded } = await readDueIntention(env, companionId);
  console.log(`[intentions] due companion=${companionId} mode=${mode} found=${due ? due.id : "none"} guarded=${guarded}`);
  return json({ mode, due: mode === "on" ? due : null, would: mode === "shadow" ? due : null });
}

/** GET /mind/intentions/:companion_id -- the companion's dated intentions, soonest first (Hearth/Principal). */
export async function getIntentions(_request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companionId = params.companion_id;
  if (!companionId) return json({ error: "missing companion_id" }, 400);
  return json({ intentions: await listIntentions(env, companionId), mode: intentionsMode(env) });
}
