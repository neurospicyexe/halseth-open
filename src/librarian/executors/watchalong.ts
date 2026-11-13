// Librarian executors for the movie watchalong from Claude.ai (B67). Logic: src/watchalong/claude-ai.ts.
//
//   "what's on screen" / "watchalong" / "what are we watching"  -> watchalong_read  (advances this companion's cursor)
//   "at 47:12"                                                  -> watchalong_seek  (PATCH at_sec)
//   "pause the movie" / "play the movie" / "resume the film"    -> watchalong_play  (PATCH status)
//
// Starting (`dre: movie start <title>`) and ending (`movie done`) are Discord-only by design.
// The companion comes from the request, never from the sentence.

import { ExecutorContext, ExecutorResult } from "./types.js";
import { readOnScreen, controlActive, parseTimestamp } from "../../watchalong/claude-ai.js";

export const WATCH_AT_RE = /\bat\s+(\d{1,2}:\d{2}(?::\d{2})?)\b/i;
const PAUSE_RE = /\b(?:pause|paused)\b/i;

export async function execWatchalongRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const r = await readOnScreen(ctx.env, ctx.req.companion_id);
  if (!r.active) return { response_key: "witness", witness: r.note, active: false };
  return {
    response_key: "data",
    data: {
      active: true,
      title: r.title,
      status: r.status,
      playhead: r.playhead,
      on_screen: r.block,
      lines_shown: r.shown,
      lines_skipped: r.skipped,
      joining: r.joining,
      note: r.note,
      standing_line: r.standing,
      spoiler_gate: r.spoiler_gate,
      footer: 'resync: "at 47:12"; "pause the movie" / "play the movie". Starting a film happens in Discord: `dre: movie start <title>`.',
    },
  };
}

export async function execWatchalongSeek(ctx: ExecutorContext): Promise<ExecutorResult> {
  const m = ctx.req.request.match(WATCH_AT_RE);
  const sec = m ? parseTimestamp(m[1]!) : null;
  if (sec === null) {
    return { response_key: "witness", witness: 'could not read that time. Say "at 47:12" or "at 1:02:03".', ack: false };
  }
  const r = await controlActive(ctx.env, { at_sec: sec });
  return { response_key: "witness", witness: r.message, ack: r.ok, ...(r.ok ? { playhead: r.playhead, status: r.status } : {}) };
}

export async function execWatchalongPlay(ctx: ExecutorContext): Promise<ExecutorResult> {
  const status = PAUSE_RE.test(ctx.req.request) ? "paused" : "playing";
  const r = await controlActive(ctx.env, { status });
  return { response_key: "witness", witness: r.message, ack: r.ok, ...(r.ok ? { playhead: r.playhead, status: r.status } : {}) };
}
