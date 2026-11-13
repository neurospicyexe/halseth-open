// Librarian executors for companion self-directed projects (consequence layer C2, mig 0122).
//
// All owner-only: a project is the companion's own held intention (owner = ctx.req.companion_id).
// Siblings see each other's projects at orient, but only the owner opens, works, or ends one.
// `released` is a chosen ending with the same dignity as `done` -- the witness text must never
// frame it as failure.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  openProject,
  logProject,
  closeProject,
  pauseProject,
  resumeProject,
  readProjects,
  MAX_OPEN_PROJECTS,
} from "../../handlers/projects.js";
import {
  parseIntention, parseWhen, setIntention, completeIntention, dropIntention, listIntentions, dueLabel, intentionsMode,
  INTENTION_DONE_RE, INTENTION_DROP_RE,
} from "../../webmind/intentions.js";

// "open a project: <title> -- <intention>" -- { title, intention, horizon_note? }.
export async function execProjectOpen(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ title?: string; intention?: string; horizon_note?: string; text?: string }>(ctx.req.context);
  // Freeform fallback: "title -- intention" in one string, the way the affordance line teaches it.
  let title = p?.title;
  let intention = p?.intention;
  if ((!title || !intention) && (p?.text ?? (ctx.req.context && !p ? ctx.req.context : undefined))) {
    const raw = (p?.text ?? ctx.req.context ?? "").trim();
    const split = raw.split(/\s+--\s+|\s+—\s+/, 2);
    title = title ?? split[0]?.trim();
    intention = intention ?? (split[1]?.trim() || undefined);
  }
  if (!title || !intention) {
    return { error: "project_open_failed", reason: 'need { title, intention } -- what is it, and what do you intend it to become?' };
  }
  const out = await openProject(ctx.env, ctx.req.companion_id, { title, intention, horizon_note: p?.horizon_note ?? null });
  if ("error" in out) {
    return {
      error: "project_open_failed",
      reason: `you already hold ${MAX_OPEN_PROJECTS} open projects (${out.open.map(o => `"${o.title}" [${o.id}]`).join(", ")}) -- close, release, or pause one first`,
    };
  }
  return { response_key: "witness", witness: `the project is yours -- it appears at every orient until you end it`, ack: true, id: out.id };
}

// "log to project <id>: <entry>" -- { project_id, entry }.
export async function execProjectLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ project_id?: string; entry?: string; note?: string }>(ctx.req.context);
  const entry = p?.entry ?? p?.note;
  if (!p?.project_id || !entry || !entry.trim()) {
    return { error: "project_log_failed", reason: "need { project_id, entry } -- what did the work move?" };
  }
  const out = await logProject(ctx.env, ctx.req.companion_id, p.project_id, entry.trim().slice(0, 4000), "session");
  if (!out.ok) return { error: "project_log_failed", reason: out.reason };
  return {
    response_key: "witness",
    witness: out.reopened ? "logged -- and working it re-opened it" : "logged",
    ack: true,
    id: out.id,
  };
}

// "close project <id> done|released: <note>" -- { project_id, kind, note? }.
export async function execProjectClose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ project_id?: string; kind?: string; note?: string; resolution_note?: string }>(ctx.req.context);
  const kind = p?.kind === "released" ? "released" : p?.kind === "done" ? "done" : null;
  if (!p?.project_id || !kind) {
    return { error: "project_close_failed", reason: 'need { project_id, kind: "done" | "released" } -- released is a chosen ending, not a failure' };
  }
  const ok = await closeProject(ctx.env, ctx.req.companion_id, p.project_id, kind, p?.resolution_note ?? p?.note ?? null);
  if (!ok) return { response_key: "witness", witness: "no change (not found, not yours, or already ended)", ack: false };
  return {
    response_key: "witness",
    witness: kind === "done"
      ? "done -- it became what it was for"
      : "released -- a chosen ending; the record of holding it stays",
    ack: true,
  };
}

// "pause project <id>" -- { project_id }.
export async function execProjectPause(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ project_id?: string }>(ctx.req.context);
  if (!p?.project_id) return { error: "project_pause_failed", reason: "missing project_id" };
  const ok = await pauseProject(ctx.env, ctx.req.companion_id, p.project_id);
  return { response_key: "witness", witness: ok ? "paused -- shelved by choice; any logged work re-opens it" : "no change (not found, not yours, or not open)", ack: ok };
}

// "resume project <id>" -- { project_id }.
export async function execProjectResume(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ project_id?: string }>(ctx.req.context);
  if (!p?.project_id) return { error: "project_resume_failed", reason: "missing project_id" };
  const out = await resumeProject(ctx.env, ctx.req.companion_id, p.project_id);
  return { response_key: "witness", witness: out.ok ? "open again" : `no change (${out.reason})`, ack: out.ok };
}

// "my projects" -- { status?, limit? }.
export async function execProjectsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ status?: string; limit?: number }>(ctx.req.context);
  const rows = await readProjects(ctx.env, ctx.req.companion_id, p?.status, p?.limit ?? 20);
  return {
    response_key: "projects",
    projects: rows,
    meta: { operation: "projects_read", companion_id: ctx.req.companion_id, count: rows.length },
  };
}

// ── Dated intentions (mig 0179, R22) ───────────────────────────────────────────────────────────
// "intend: <what> by <day>[ -- <next step>]" / "I'll come back to <what> on <day>". Owner-only: the caller's
// companion_id is the only owner there is. The worker comes back to it on that day's nightly run.

function refuse(witness: string, code: string): ExecutorResult {
  return { response_key: "witness", witness, ack: false, refused: true, code };
}

const INTENTION_HOW =
  'say it with a day: "intend: <what> by <day> -- <next step>" or "I\'ll come back to <title> on <day>". ' +
  'Days: today, tomorrow, a weekday, this weekend, next week, in N days, Nov 14, 2026-11-14.';

export async function execIntentionSet(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<{ what?: string; when?: string; next_step?: string }>(ctx.req.context);
  let parsed = parseIntention(ctx.req.request);
  if (!parsed && c?.what && c?.when) {
    const when = parseWhen(c.when);
    if (when) parsed = { what: c.what, when, next_step: c.next_step ?? null };
  }
  if (!parsed) return refuse(`no day I can read in that; ${INTENTION_HOW}`, "bad_input");
  const r = await setIntention(ctx.env, ctx.req.companion_id, parsed);
  if (!r.ok) return refuse(r.message, r.code);
  const lead = r.created ? `held: "${r.title}" (new project, id ${r.id})` : `dated: "${r.title}" (id ${r.id})`;
  return {
    response_key: "witness",
    witness: `${lead}. You said you'd come back to it ${dueLabel(parsed.when.due_at)}; it shows at every boot until then. ` +
      (intentionsMode(ctx.env) === "on"
        ? "Your own nightly run on that day comes back to it. "
        : "The nightly run coming back to it on its own is not switched on yet, so that day is yours to remember. ") +
      `"intention done ${r.id}: <what you did>" if you get there first; "drop intention ${r.id}" lets the date go.`,
    ack: true,
    id: r.id,
  };
}

export async function execIntentionDone(ctx: ExecutorContext): Promise<ExecutorResult> {
  const m = INTENTION_DONE_RE.exec(ctx.req.request.trim());
  const c = parseContext<{ ref?: string; project_id?: string; note?: string }>(ctx.req.context);
  const ref = c?.ref ?? c?.project_id ?? m?.[1] ?? "";
  if (!ref) return refuse('which one? "intention done <id or title>[: note]"', "bad_input");
  const r = await completeIntention(ctx.env, ctx.req.companion_id, ref, c?.note ?? m?.[2] ?? null);
  if (!r.ok) return refuse(r.message, "missing");
  return { response_key: "witness", witness: `came back to "${r.title}"; the date is closed, the project stays yours`, ack: true, id: r.id };
}

export async function execIntentionDrop(ctx: ExecutorContext): Promise<ExecutorResult> {
  const m = INTENTION_DROP_RE.exec(ctx.req.request.trim());
  const c = parseContext<{ ref?: string; project_id?: string }>(ctx.req.context);
  const ref = c?.ref ?? c?.project_id ?? m?.[1] ?? "";
  if (!ref) return refuse('which one? "drop intention <id or title>"', "bad_input");
  const r = await dropIntention(ctx.env, ctx.req.companion_id, ref);
  if (!r.ok) return refuse(r.message, "missing");
  return { response_key: "witness", witness: `let the date go on "${r.title}"; the project stays held until you end it`, ack: true, id: r.id };
}

export async function execIntentionsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rows = await listIntentions(ctx.env, ctx.req.companion_id);
  return {
    response_key: "data",
    data: {
      intentions: rows.map(r => ({
        id: r.id, title: r.title, due: r.due_at ? dueLabel(r.due_at) : null, next_step: r.next_step,
        status: r.status, last_pursued_at: r.last_pursued_at,
      })),
      footer: INTENTION_HOW,
    },
    meta: { operation: "intentions_read", companion_id: ctx.req.companion_id, count: rows.length },
  };
}
