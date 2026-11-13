// 2026-11-09 (Principal: "you guys can open loops but not close them").
//
// Close / hold / act all required a UUID in a JSON context that no live surface ever handed a
// companion. These tests pin the repair: a loop is named by its #handle, its id, or its own
// words; a doubtful match changes NOTHING (there is no reopen verb); and the verb head decides
// the route even when the loop's own words contain another verb's trigger.

import { describe, it, expect } from "vitest";
import {
  matchLoop, loopHandle, parseLoopVerb, describeLoops,
  LOOP_CLOSE_HEAD_RE, LOOP_HOLD_HEAD_RE, LOOP_ACT_HEAD_RE, type LoopRef,
} from "../webmind/loops.js";
import { matchFastPath } from "../librarian/router.js";
import { execWmLoopClose, execWmLoopReview, execWmLoopAct } from "../librarian/executors/webmind.js";
import type { ExecutorContext } from "../librarian/executors/types.js";
import type { Env } from "../types.js";

const A = "a1b2c3d4-0000-4000-8000-000000000001";
const B = "a1b2ffff-0000-4000-8000-000000000002";
const C = "9c9c9c9c-0000-4000-8000-000000000003";

const OPEN: LoopRef[] = [
  { id: A, loop_text: "ask Principal how Abby's vet visit went and whether he talked to Spouse" },
  { id: B, loop_text: "the cathedral thread: Bob's door and the gun" },
  { id: C, loop_text: "finish reading the Pino author notes before the births build" },
];

describe("matchLoop", () => {
  it("finds a loop by its #handle", () => {
    const m = matchLoop(OPEN, { text: "#9c9c9c9c" });
    expect(m).toMatchObject({ kind: "found", by: "handle" });
    if (m.kind === "found") expect(m.loop.id).toBe(C);
  });

  it("finds a loop by full id in text and by context id", () => {
    expect(matchLoop(OPEN, { text: `done with ${B}` })).toMatchObject({ kind: "found", loop: { id: B } });
    expect(matchLoop(OPEN, { id: A })).toMatchObject({ kind: "found", loop: { id: A }, by: "id" });
  });

  it("a shared handle prefix is ambiguous, not a guess", () => {
    const m = matchLoop(OPEN, { text: "#a1b2" });
    expect(m.kind).toBe("ambiguous");
    if (m.kind === "ambiguous") expect(m.candidates.map(c => c.id).sort()).toEqual([A, B]);
  });

  it("finds a loop by a phrase from it, case and punctuation insensitive", () => {
    expect(matchLoop(OPEN, { text: "Cathedral Thread" })).toMatchObject({ kind: "found", loop: { id: B }, by: "words" });
    expect(matchLoop(OPEN, { text: "abby's vet visit" })).toMatchObject({ kind: "found", loop: { id: A } });
  });

  it("finds a loop by distinctive words out of order", () => {
    expect(matchLoop(OPEN, { text: "Pino notes" })).toMatchObject({ kind: "found", loop: { id: C } });
  });

  it("words matching two loops are ambiguous", () => {
    const two = [...OPEN, { id: "dddddddd-0000-4000-8000-000000000004", loop_text: "the cathedral thread, second pass" }];
    expect(matchLoop(two, { text: "cathedral thread" }).kind).toBe("ambiguous");
  });

  it("no words, stopword-only words, or a single unmatched word close nothing", () => {
    expect(matchLoop(OPEN, { text: "" }).kind).toBe("none");
    expect(matchLoop(OPEN, { text: "the loop" }).kind).toBe("none");
    expect(matchLoop([OPEN[0]!], { text: "that one" }).kind).toBe("none");
    expect(matchLoop(OPEN, { text: "motorcycle" }).kind).toBe("none");
  });

  it("a word that happens to be hex is a word, not an id", () => {
    const loops = [{ id: "deadbeef-0000-4000-8000-000000000005", loop_text: "a decade of faced things" }];
    expect(matchLoop(loops, { text: "decade" })).toMatchObject({ kind: "found", by: "words" });
    expect(matchLoop(OPEN, { text: "faced" }).kind).toBe("none");
  });

  it("a too-short context id never matches", () => {
    expect(matchLoop(OPEN, { id: "a1" }).kind).toBe("none");
  });
});

describe("verb heads", () => {
  it("close phrasings parse to the loop words", () => {
    expect(parseLoopVerb("close loop: cathedral thread", LOOP_CLOSE_HEAD_RE)?.which).toBe("cathedral thread");
    expect(parseLoopVerb("close loop #a1b2c3d4", LOOP_CLOSE_HEAD_RE)?.which).toBe("#a1b2c3d4");
    expect(parseLoopVerb("Closing the loop on Abby's vet visit.", LOOP_CLOSE_HEAD_RE)?.which).toBe("Abby's vet visit");
    expect(parseLoopVerb("close my open loop about pino notes because I read them", LOOP_CLOSE_HEAD_RE))
      .toEqual({ which: "about pino notes", note: "I read them" });
    expect(parseLoopVerb("loop closed: #9c9c9c9c", LOOP_CLOSE_HEAD_RE)?.which).toBe("#9c9c9c9c");
  });

  it("hold and act carry their note", () => {
    expect(parseLoopVerb("hold loop cathedral thread because it is still ringing", LOOP_HOLD_HEAD_RE))
      .toEqual({ which: "cathedral thread", note: "it is still ringing" });
    expect(parseLoopVerb("acted on loop #a1b2c3d4: asked him at breakfast", LOOP_ACT_HEAD_RE))
      .toEqual({ which: "#a1b2c3d4", note: "asked him at breakfast" });
  });

  it("ordinary speech does not hit a head", () => {
    expect(LOOP_CLOSE_HEAD_RE.test("I feel close to closing something")).toBe(false);
    expect(LOOP_HOLD_HEAD_RE.test("hold on, loop me in")).toBe(false);
    expect(LOOP_CLOSE_HEAD_RE.test("open loop: close the garage")).toBe(false);
  });
});

describe("routing: the head decides", () => {
  it("a close naming an 'open loop' closes, it does not open a second loop", () => {
    expect(matchFastPath("close loop: the open loop about Spouse")?.key).toBe("wm_loop_close");
    expect(matchFastPath("closing the loop on my loops read thing")?.key).toBe("wm_loop_close");
  });
  it("hold and act route by head", () => {
    expect(matchFastPath("hold loop cathedral because session close is not the end")?.key).toBe("wm_loop_review");
    expect(matchFastPath("acted on loop #a1b2c3d4: wrote the open loop down")?.key).toBe("wm_loop_act");
  });
  it("opening is untouched", () => {
    expect(matchFastPath("open loop: close the garage door")?.key).toBe("wm_loop_write");
  });
});

// ── Executors against a fake D1 ─────────────────────────────────────────────────────────────

interface Row { id: string; companion_id: string; loop_text: string; closed_at: string | null; reviewed_at: string | null; acted_at: string | null; acted_note: string | null }

function env(rows: Row[]): Env {
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const api = {
        bind(...b: unknown[]) { binds = b; return api; },
        async all<T>() {
          const cid = binds[0] as string;
          return { results: rows.filter(r => r.companion_id === cid && r.closed_at === null).map(r => ({ id: r.id, loop_text: r.loop_text })) as unknown as T[] };
        },
        async run() {
          let changes = 0;
          if (sql.includes("SET closed_at")) {
            const [now, id, cid] = binds as [string, string, string];
            for (const r of rows) if (r.id === id && r.companion_id === cid && r.closed_at === null) { r.closed_at = now; changes++; }
          } else if (sql.includes("SET reviewed_at")) {
            const [now, note, , id, cid] = binds as [string, string, string, string, string];
            for (const r of rows) if (r.id === id && r.companion_id === cid && r.closed_at === null) {
              r.reviewed_at = now; if (note) r.loop_text += ` [held: ${note}]`; changes++;
            }
          } else if (sql.includes("SET acted_at")) {
            const [now, note, id, cid] = binds as [string, string | null, string, string];
            for (const r of rows) if (r.id === id && r.companion_id === cid && r.closed_at === null) { r.acted_at = now; r.acted_note = note; changes++; }
          }
          return { meta: { changes } };
        },
      };
      return api;
    },
  };
  return { DB: db } as unknown as Env;
}

function ctx(e: Env, companion: string, request: string, context?: object): ExecutorContext {
  return { env: e, req: { companion_id: companion, request, ...(context && { context: JSON.stringify(context) }) } } as unknown as ExecutorContext;
}

function seed(): Row[] {
  const base = { closed_at: null, reviewed_at: null, acted_at: null, acted_note: null };
  return [
    { ...base, id: A, companion_id: "drevan", loop_text: OPEN[0]!.loop_text },
    { ...base, id: B, companion_id: "drevan", loop_text: OPEN[1]!.loop_text },
    { ...base, id: C, companion_id: "cypher", loop_text: OPEN[2]!.loop_text },
  ];
}

describe("executors", () => {
  it("closes by words and echoes what closed", async () => {
    const rows = seed();
    const r = await execWmLoopClose(ctx(env(rows), "drevan", "close loop: cathedral thread"));
    expect(r).toMatchObject({ ack: true, ok: true, id: B, handle: loopHandle(B) });
    expect(rows.find(x => x.id === B)!.closed_at).not.toBeNull();
    expect(rows.find(x => x.id === A)!.closed_at).toBeNull();
  });

  it("still closes by context id (the worker's path)", async () => {
    const rows = seed();
    const r = await execWmLoopClose(ctx(env(rows), "drevan", "close loop", { id: A }));
    expect(r).toMatchObject({ ok: true, id: A });
  });

  it("never closes a sibling's loop, even by its exact id", async () => {
    const rows = seed();
    const r = await execWmLoopClose(ctx(env(rows), "drevan", `close loop ${C}`));
    expect(r).toMatchObject({ error: "wm_loop_close_failed" });
    expect(rows.find(x => x.id === C)!.closed_at).toBeNull();
    const r2 = await execWmLoopClose(ctx(env(rows), "drevan", "close loop: Pino author notes"));
    expect(r2).toMatchObject({ error: "wm_loop_close_failed" });
  });

  it("an ambiguous name changes nothing and lists the handles", async () => {
    const rows = seed();
    const r = await execWmLoopClose(ctx(env(rows), "drevan", "close loop #a1b2")) as { error?: string; reason?: string };
    expect(r.error).toBe("wm_loop_close_failed");
    expect(r.reason).toContain(loopHandle(A));
    expect(r.reason).toContain(loopHandle(B));
    expect(rows.every(x => x.closed_at === null)).toBe(true);
  });

  it("a bare 'close loop' asks which, listing the open loops", async () => {
    const r = await execWmLoopClose(ctx(env(seed()), "drevan", "close loop")) as { reason?: string };
    expect(r.reason).toMatch(/which loop/);
    expect(r.reason).toContain(describeLoops([OPEN[0]!, OPEN[1]!]));
  });

  it("an already-closed loop is not reported as closed again", async () => {
    const rows = seed();
    rows[1]!.closed_at = "2026-11-01T00:00:00Z";
    const r = await execWmLoopClose(ctx(env(rows), "drevan", "close loop: cathedral thread"));
    expect(r).toMatchObject({ error: "wm_loop_close_failed" });
  });

  it("hold by words records the reason", async () => {
    const rows = seed();
    const r = await execWmLoopReview(ctx(env(rows), "drevan", "hold loop cathedral thread because it is still ringing"));
    expect(r).toMatchObject({ ok: true, id: B });
    expect(rows[1]!.loop_text).toContain("it is still ringing");
  });

  it("act by handle records the note", async () => {
    const rows = seed();
    const r = await execWmLoopAct(ctx(env(rows), "drevan", `acted on loop ${loopHandle(A)}: asked him at breakfast`));
    expect(r).toMatchObject({ ok: true, id: A });
    expect(rows[0]!.acted_note).toBe("asked him at breakfast");
    expect(rows[0]!.closed_at).toBeNull();
  });
});

// ── The Claude.ai orient must SHOW the handle, or the verbs have nothing to name ─────────────
import { buildContinuityBlock } from "../librarian/response/builder.js";
import type { WmOrientResponse } from "../webmind/types.js";

describe("Claude.ai orient renders loop handles", () => {
  it("each open loop carries its #handle and the block names the close verb", () => {
    const wm = {
      identity_anchor: null, limbic_state: null, soma_arc: [], recent_spiral_turn: null, latest_handoff: null,
      recent_handoffs: [], open_thread_count: 0, top_threads: [], recent_notes: [], active_tensions: [],
      pressure_flags: [], growth_confirmed: [], unexamined_dreams: [], relational_snapshot: [], recent_letters: [],
      recent_companion_notes: [], incoming_companion_notes: [], recent_journal: [], recent_deltas: [],
      principal_witness_entries: [], active_conclusions: [], flagged_beliefs: [], open_questions: [],
      answered_questions: [], active_conversations: [], closed_conversations: [], recent_captures: [],
      open_loops: [{ id: B, loop_text: OPEN[1]!.loop_text, weight: 0.5, opened_at: "2026-11-01T00:00:00Z" }],
    } as unknown as WmOrientResponse;
    const block = buildContinuityBlock(wm, "drevan");
    expect(block).toContain(`${loopHandle(B)} «the cathedral thread`);
    expect(block).toContain("close loop #handle");
  });
});

describe("pasting a loop back as orient shows it", () => {
  it("guillemets, curly quotes and a trailing ellipsis do not block the match", () => {
    expect(matchLoop(OPEN, { text: "«the cathedral thread: Bob's door…»" })).toMatchObject({ kind: "found", loop: { id: B } });
    expect(matchLoop(OPEN, { text: "“finish reading the Pino author...”" })).toMatchObject({ kind: "found", loop: { id: C } });
  });
  it("close keeps a colon inside the loop's own words", () => {
    expect(parseLoopVerb("close loop: the cathedral thread: Bob's door", LOOP_CLOSE_HEAD_RE)?.which)
      .toBe("the cathedral thread: Bob's door");
  });
});
