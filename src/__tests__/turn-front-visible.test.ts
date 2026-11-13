// The fronting member is visible on the turn (2026-07-31).
//
// PRINCIPAL'S REASON, in his words: "the front team members should be visible on the memories, because then
// there's not random 'oh, so and so said this' and then we have to freak out and think that we just don't
// remember saying it."
//
// That is the actual cost being avoided. In a plural system, a memory that records HE said something when
// a different member was fronting makes him doubt his own recall of his own life. Not a labelling nicety.
//
// THE SPLIT IS THE DESIGN, and these tests exist to keep it:
//   * `thread_ledger.author` carries the front-qualified speaker -- per TURN, because fronting changes
//     mid-conversation.
//   * `conversation_threads.participants` keeps the COARSE token (`principal`, `spouse`, `guest`, companion
//     ids), because that is what the attribution logic reads to ask "was Principal here at all". Forking it
//     into `principal (MemberA)` would break that question and every consumer that renders the token.

import { describe, it, expect, vi } from "vitest";
import { appendTurn } from "../webmind/conversations.js";
import type { Env } from "../types.js";

interface Cap { sql: string; binds: unknown[] }

function envWith(thread: Record<string, unknown> | null) {
  const caps: Cap[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => ({
          first: async () => (sql.includes("SELECT * FROM conversation_threads") ? thread : null),
          run: async () => { caps.push({ sql, binds }); return { meta: { changes: 1 } }; },
          all: async () => {
            caps.push({ sql, binds });
            return { meta: { changes: 1 }, results: [{ state: "moving", participants: '["principal","drevan"]' }] };
          },
        }),
      }),
    },
  } as unknown as Env;
  return { env, caps };
}

const THREAD = {
  id: "t1", channel_id: "chan", state: "open", participants: '["principal"]',
  turn_count: 1, last_turn_at: "2026-07-31T00:00:00Z", created_at: "2026-07-31T00:00:00Z",
};
const ledgerInsert = (caps: Cap[]) => caps.find(c => c.sql.includes("INSERT") && c.sql.includes("thread_ledger"));
const participantsUpdate = (caps: Cap[]) => caps.find(c => c.sql.includes("UPDATE conversation_threads"));

describe("appendTurn -- front on the turn, coarse token in participants", () => {
  it("records the fronting member on the LEDGER row", async () => {
    const { env, caps } = envWith(THREAD);
    await appendTurn(env, "t1", { author: "principal", gist: "said a thing", message_id: "m1", front: "MemberA" });
    expect(ledgerInsert(caps)!.binds).toContain("principal (MemberA)");
  });

  it("keeps `participants` on the COARSE token -- the attribution question must keep working", async () => {
    // If the front leaked into participants, `set.has("principal")` would fail and every note from this
    // conversation would claim "Principal was NOT in this one" -- inverting the exact protection it exists
    // for.
    const { env, caps } = envWith(THREAD);
    await appendTurn(env, "t1", { author: "principal", gist: "x", message_id: "m1", front: "MemberA" });
    const upd = participantsUpdate(caps)!;
    expect(upd.binds).toContain("principal");
    expect(upd.binds.some(b => typeof b === "string" && b.includes("MemberA"))).toBe(false);
  });

  it("omits the front when there isn't one -- no empty parentheses in a memory", async () => {
    const { env, caps } = envWith(THREAD);
    await appendTurn(env, "t1", { author: "drevan", gist: "x", message_id: "m1" });
    expect(ledgerInsert(caps)!.binds).toContain("drevan");
    expect(ledgerInsert(caps)!.binds.some(b => typeof b === "string" && b.includes("("))).toBe(false);
  });

  it("does not repeat the name when the front IS the author -- 'principal (principal)' reads as a bug", async () => {
    const { env, caps } = envWith(THREAD);
    await appendTurn(env, "t1", { env: undefined, author: "principal", gist: "x", message_id: "m1", front: "Principal" } as never);
    expect(ledgerInsert(caps)!.binds).toContain("principal");
  });

  it("tolerates junk fronts rather than writing them into a memory verbatim", async () => {
    const { env, caps } = envWith(THREAD);
    await appendTurn(env, "t1", { author: "principal", gist: "x", message_id: "m1", front: "   " });
    expect(ledgerInsert(caps)!.binds).toContain("principal");
  });

  it("caps a long front so a hostile display name cannot bloat every ledger row", async () => {
    const { env, caps } = envWith(THREAD);
    await appendTurn(env, "t1", { author: "principal", gist: "x", message_id: "m1", front: "M".repeat(300) });
    const author = ledgerInsert(caps)!.binds.find(b => typeof b === "string" && b.startsWith("principal (")) as string;
    expect(author.length).toBeLessThan(80);
  });
});
