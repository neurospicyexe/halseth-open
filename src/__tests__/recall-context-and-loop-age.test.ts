// GAP-MAP A4 + A5 (2026-11-11): own-notes recall takes optional conversation context (dual query,
// same shape as the vault path), and open loops show their age at orient.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/embed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp/embed.js")>();
  return {
    ...actual,
    embedText: vi.fn(async (_env: unknown, text: string) => (text.includes("Recent conversation context") ? [9, 9, 9] : [1, 1, 1])),
  };
});

import { embedText } from "../mcp/embed.js";
import { recallNotesByMeaning } from "../webmind/notes.js";
import { buildContinuityBlock } from "../librarian/response/builder.js";

function makeEnv(byVector: Record<string, Array<{ score: number; row_id: string }>>) {
  return {
    VECTORIZE: {
      query: vi.fn(async (v: number[], q: { filter: { table: string } }) => ({
        matches: q.filter.table === "wm_continuity_notes"
          ? (byVector[v.join(",")] ?? []).map(m => ({ score: m.score, metadata: { table: "wm_continuity_notes", row_id: m.row_id, companion_id: "drevan" } }))
          : [],
      })),
    },
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => sql.includes("SELECT note_id")
            ? { results: args.slice(1).map(id => ({ note_id: id, content: `note ${id}`, created_at: "2026-07-01T00:00:00Z", salience: "normal", thread_key: null, source: "conversation_capture" })) }
            : { results: [] },
          run: async () => ({ meta: { changes: 1 } }),
        }),
      }),
    },
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("recallNotesByMeaning with recentContext", () => {
  it("without context behaves as before: one embed, one vector", async () => {
    const env = makeEnv({ "1,1,1": [{ score: 0.6, row_id: "a" }] });
    const out = await recallNotesByMeaning(env, "drevan", "the ankle", 4);
    expect(out.map(n => n.note_id)).toEqual(["a"]);
    expect(embedText).toHaveBeenCalledTimes(1);
  });

  it("with context, a note only the context vector finds is recalled, and a shared hit is not duplicated", async () => {
    const env = makeEnv({
      "1,1,1": [{ score: 0.5, row_id: "shared" }],
      "9,9,9": [{ score: 0.7, row_id: "shared" }, { score: 0.6, row_id: "ctx-only" }],
    });
    const out = await recallNotesByMeaning(env, "drevan", "what about the other one?", 4, "life", "I hurt my ankle last night");
    expect(embedText).toHaveBeenCalledTimes(2);
    expect(out.map(n => n.note_id).sort()).toEqual(["ctx-only", "shared"]);
    expect(out.find(n => n.note_id === "shared")!.score).toBe(0.7);
  });

  it("a failing context embed degrades to the primary recall", async () => {
    (embedText as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => [1, 1, 1]).mockImplementationOnce(async () => { throw new Error("quota"); });
    const env = makeEnv({ "1,1,1": [{ score: 0.6, row_id: "a" }] });
    const out = await recallNotesByMeaning(env, "drevan", "q", 4, "life", "ctx");
    expect(out.map(n => n.note_id)).toEqual(["a"]);
  });
});

describe("open loops show their age", () => {
  const wm = (loops: unknown[]) => ({
    identity_anchor: null, limbic_state: null, soma_arc: [], recent_spiral_turn: null, latest_handoff: null,
    recent_handoffs: [], open_thread_count: 0, top_threads: [], recent_notes: [], active_tensions: [],
    pressure_flags: [], growth_confirmed: [], unexamined_dreams: [], relational_snapshot: [], recent_letters: [],
    recent_companion_notes: [], incoming_companion_notes: [], recent_journal: [], recent_deltas: [],
    principal_witness_entries: [], active_conclusions: [], flagged_beliefs: [], open_loops: loops, open_questions: [],
    answered_questions: [], active_conversations: [], closed_conversations: [], recent_captures: [],
  }) as never;

  it("stamps each loop with its age", () => {
    const opened = new Date(Date.now() - 3 * 86400_000).toISOString();
    const block = buildContinuityBlock(wm([{ id: "abcdef123456", loop_text: "call the vet", weight: 1, opened_at: opened }]));
    expect(block).toContain("«call the vet»");
    expect(block).toMatch(/3 days ago[^|]*«call the vet»|«call the vet»[^|]*3 days ago/);
  });

  it("a loop without opened_at still renders", () => {
    const block = buildContinuityBlock(wm([{ id: "abcdef123456", loop_text: "no stamp", weight: 1 }]));
    expect(block).toContain("«no stamp»");
  });
});
