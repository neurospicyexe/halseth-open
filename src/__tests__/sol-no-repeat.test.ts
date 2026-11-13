// B64.1 Part A: Sol stops repeating himself. The /moment composer skips any fixed line Sol posted in his
// last SOL_NO_REPEAT_N appearances; same seed + same history = same line.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { pickFresh, matrixMomentFresh, giftMomentFresh, matrixMoment, giftMoment, solLineKey } from "../webmind/creatures.js";
import { momentCreature } from "../handlers/creatures.js";

describe("pickFresh", () => {
  const pool = ["a", "b", "c"];
  it("with no history behaves like a plain seeded pick", () => {
    for (let s = 0; s < 6; s++) expect(pickFresh(pool, s, [])).toBe(pool[s % 3]);
  });
  it("never returns a line in recent history while another exists", () => {
    for (let s = 0; s < 10; s++) {
      const got = pickFresh(pool, s, ["a", "c"]);
      expect(got).toBe("b");
    }
    for (let s = 0; s < 10; s++) expect(["b", "c"]).toContain(pickFresh(pool, s, ["a"]));
  });
  it("is deterministic for the same seed and history", () => {
    expect(pickFresh(pool, 7, ["b"])).toBe(pickFresh(pool, 7, ["b"]));
  });
  it("takes the least recently used when every line was used recently", () => {
    // newest first: c was used last, then a, then b (oldest) -> b
    expect(pickFresh(pool, 0, ["c", "a", "b"])).toBe("b");
    expect(pickFresh(pool, 5, ["b", "b", "c", "a"])).toBe("a");
  });
  it("an empty pool throws nothing and a single-line pool returns its line", () => {
    expect(pickFresh(["x"], 3, ["x"])).toBe("x");
  });
});

describe("matrix + gift fresh picks", () => {
  it("matrixMomentFresh avoids the line matrixMoment would repeat", () => {
    const first = matrixMoment("bored", "warming", 4);
    const next = matrixMomentFresh("bored", "warming", 4, [first]);
    expect(next).not.toBe(first);
  });
  it("gift moments are exempt only when the rendered text differs", () => {
    const g = giftMoment("a spouse bead", 0);
    expect(giftMomentFresh("a spouse bead", 0, [g])).not.toBe(g);
    // A different item renders different text, so the same template is fine.
    expect(giftMomentFresh("a red bead", 0, [g])).toBe(giftMoment("a red bead", 0));
  });
});

describe("POST /mind/creatures/:id/moment no-repeat", () => {
  const env = (DB: any, extra: Record<string, string> = {}) =>
    ({ DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", ...extra }) as any;
  const req = (seed: number) => new Request("http://x/mind/creatures/id/moment", {
    method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
    body: JSON.stringify({ seed }),
  });

  function setup() {
    const s = makeSqliteD1();
    const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
    // Seen recently so he is not absent.
    s.db.prepare("UPDATE creatures SET last_interaction_at = datetime('now'), trust = 0.9 WHERE id = ?").run(sol.id);
    // High tier: every high pool has two lines (some low/mid pools have one, where a repeat is unavoidable). Seeds avoid the gift gate.
    return { ...s, solId: sol.id };
  }
  const appear = (db: any, solId: string, note: string, i: number) =>
    // Prod format (mig 0078 default datetime('now')); a higher i is newer.
    db.prepare("INSERT INTO creature_interactions (id, creature_id, actor, action, note, via, created_at) VALUES (?, ?, 'sol', 'appear', ?, 'appear', datetime('now', ?))")
      .run(`ap${i}`, solId, note, `-${100 - i} minutes`);

  it("does not return the line Sol just posted, and is stable for the same seed", async () => {
    const { db, DB, solId } = setup();
    const r1 = await (await momentCreature(req(1), env(DB), { id: solId })).json() as any;
    expect(r1.kind).toBe("moment");
    appear(db, solId, r1.moment, 1);
    const r2 = await (await momentCreature(req(1), env(DB), { id: solId })).json() as any;
    expect(r2.moment).not.toBe(r1.moment);
    const r3 = await (await momentCreature(req(1), env(DB), { id: solId })).json() as any;
    expect(r3.moment).toBe(r2.moment);
  });

  it("SOL_NO_REPEAT_N bounds how far back it looks", async () => {
    const { db, DB, solId } = setup();
    const r1 = await (await momentCreature(req(2), env(DB), { id: solId })).json() as any;
    appear(db, solId, r1.moment, 1);
    appear(db, solId, "something else entirely", 2);
    // N=1: only the newest appearance counts, so the seeded line comes back.
    const r2 = await (await momentCreature(req(2), env(DB, { SOL_NO_REPEAT_N: "1" }), { id: solId })).json() as any;
    expect(r2.moment).toBe(r1.moment);
  });
});

describe("no-repeat compares the line as the worker records it (cleanSolLine)", () => {
  const PREENS = "*Sol preens on the chair back, unhurried, muttering the occasional low* prruk *at nothing. The house is his and it is in order.*";
  it("solLineKey mirrors cleanSolLine(line, 500): outer italics kept, inner markdown stripped", () => {
    expect(solLineKey(PREENS)).toBe("*Sol preens on the chair back, unhurried, muttering the occasional low prruk at nothing. The house is his and it is in order.*");
    expect(solLineKey("  plain   line\nwith  space ")).toBe("plain line with space");
    expect(solLineKey("x".repeat(600)).length).toBe(500);
    // Idempotent: a recorded (cleaned) note keys to itself.
    expect(solLineKey(solLineKey(PREENS))).toBe(solLineKey(PREENS));
  });
  it("a line recorded in cleaned form is excluded on the next pick", () => {
    const pool = ["*Sol tucks one foot up.*", PREENS];
    const recorded = solLineKey(PREENS);
    for (let s = 0; s < 6; s++) expect(pickFresh(pool, s, [recorded])).toBe("*Sol tucks one foot up.*");
  });
  it("a gift moment recorded in cleaned form is excluded too", () => {
    const g = giftMoment("a spouse bead", 0);
    const next = giftMomentFresh("a spouse bead", 0, [solLineKey(g)]);
    expect(solLineKey(next)).not.toBe(solLineKey(g));
  });
  it("matrix pick through the composer: content/high never repeats the cleaned preens line", () => {
    const recorded = solLineKey(PREENS);
    for (let s = 0; s < 6; s++) expect(matrixMomentFresh("content", "bonded", s, [recorded])).not.toBe(PREENS);
  });
});
