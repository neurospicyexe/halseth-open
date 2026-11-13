// Librarian executors for B65 steps 6-7 (mig 0182).
//
//   "<lethe|what held|what bore|verdict>: <kind:|interest:|activity:><subject> <your line>"   verdict_write
//   "my verdicts" / "my lethe" / "my what held" / "my what bore"                               verdicts_read
//   "mark a want: <words>" / "something wants out: <words>"                                    want_marked
//
// The companion is ALWAYS ctx.req.companion_id (Librarian-authenticated), never text. A verdict is their own line,
// in their own word (Drevan lethe, Cypher what held, Gaia what bore); the system only counts returns.
// The words of a marked want are never stored: the mark is a drive move with a cause, nothing more.

import { ExecutorContext, ExecutorResult } from "./types.js";
import {
  parseVerdict, wordUsed, wordAllowed, verdictWord, writeVerdict, verdictsMode, verdictLine, VERDICT_LINE_MAX,
  type VerdictRow,
} from "../../webmind/verdicts.js";
import { fireWantMarked } from "../../webmind/expression-need.js";

function fail(witness: string, code: string): ExecutorResult {
  return { response_key: "witness", witness, ack: false, refused: true, code };
}

export async function execVerdictWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const who = ctx.req.companion_id;
  const word = verdictWord(who);
  const used = wordUsed(ctx.req.request);
  if (!wordAllowed(who, used)) {
    return fail(`your word for this is "${word}". Say: ${word}: <kind:|interest:|activity:><subject> <your line>`, "bad_input");
  }
  const p = parseVerdict(ctx.req.request);
  if (!p) {
    return fail(`say it as: ${word}: <kind:writing | interest:"name" | activity:share_observation> <one line, ${VERDICT_LINE_MAX} characters or fewer>`, "bad_input");
  }
  const r = await writeVerdict(ctx.env, { companion_id: who, ...p, word: used });
  if (!r.ok) return fail(r.message, r.code);
  const note: Record<typeof r.outcome, string> = {
    written: "written. Counted by return from here; nothing scores it.",
    moved: "moved; the old line is kept in its history.",
    returned: "counted as a return" + (who === "drevan" ? "; your line stands, never rewritten." : "."),
  };
  return {
    response_key: "witness", witness: `${word}: ${r.row.subject} ${note[r.outcome]} (evidence ${r.row.evidence})`, ack: true,
    id: r.row.id, subject: r.row.subject, evidence: r.row.evidence, outcome: r.outcome,
  };
}

export async function execVerdictsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const who = ctx.req.companion_id;
  if (verdictsMode(ctx.env as unknown as Record<string, unknown>) === "off") return fail("verdicts are not open yet", "closed");
  const rows = (await ctx.env.DB.prepare(
    "SELECT * FROM companion_verdicts WHERE companion_id = ? ORDER BY evidence DESC, moved_at DESC LIMIT 50",
  ).bind(who).all<VerdictRow>()).results ?? [];
  return {
    response_key: "data",
    data: {
      word: verdictWord(who),
      verdicts: rows.map((r) => ({
        subject: r.subject, line: r.line, evidence: r.evidence, first: r.first_at, moved: r.moved_at,
        history: (() => { try { return JSON.parse(r.history_json); } catch { return []; } })(),
      })),
      footer: `write: ${verdictWord(who)}: <kind:|interest:|activity:><subject> <your line>`,
      lines: rows.slice(0, 2).map((r) => verdictLine({ subject: r.subject, label: r.subject, line: r.line, evidence: r.evidence, moved_at: r.moved_at })),
    },
  };
}

export async function execWantMarked(ctx: ExecutorContext): Promise<ExecutorResult> {
  const who = ctx.req.companion_id;
  const r = await fireWantMarked(ctx.env, who);
  const shadow = r["shadow"] === true;
  const off = r["skipped"] === "off";
  const capped = !shadow && !off && Array.isArray(r["applied"]) && (r["applied"] as unknown[]).length === 0;
  const witness = off ? "marking a want is not open yet"
    : capped ? "marked already three times today; it stands"
    : shadow ? "noted; marking wants is in shadow, nothing moves yet"
    : "marked. It moves your need to put something out; it does not ask you to speak.";
  return { response_key: "witness", witness, ack: !off && !capped, mode: off ? "off" : shadow ? "shadow" : "on" };
}
