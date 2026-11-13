// Contract 0.29.0: the companion's own interests at orient (Principal 11-09: "I love it when you guys bring stuff").
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { loadInterestsBlock, interestLine, EMPTY_INTERESTS, ORIENT_INTERESTS } from "../mind/blocks/interests.js";
import { interestsBlock, INTERESTS_BLOCK_HEADER } from "../librarian/response/orient-blocks.js";
import { loadMindState } from "../mind/loader.js";
import { botWireFromMindState } from "../mind/adapters/bot-wire.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import { CONTRACT_CHANGELOG } from "../mind/changelog.js";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const ts = (daysAgo: number) => new Date(NOW - daysAgo * 86_400_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

function seed() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  const ins = (id: string, c: string, name: string, heat: number, status: string, created: number, extra: Partial<{ why_private: number; born_from: string }> = {}) =>
    db.prepare("INSERT INTO companion_interests (id, companion_id, name, why, why_private, born_from, heat, heat_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, c, name, `why ${name}`, extra.why_private ?? 0, extra.born_from ?? null, heat, ts(0), status, ts(created));
  ins("a", "cypher", "Physarum", 0.9, "active", 10);
  ins("b", "cypher", "networks", 0.6, "active", 1, { born_from: "exposure:c123" });
  ins("c", "cypher", "secret garden", 0.7, "active", 20, { why_private: 1 });
  ins("d", "cypher", "knots", 0.5, "active", 30);
  ins("e", "cypher", "trains", 0.3, "resting", 40);
  ins("f", "cypher", "old thing", 0.8, "put_down", 50);
  ins("g", "drevan", "adhesives", 0.9, "active", 5);
  db.prepare("INSERT INTO companion_interest_events (id, interest_id, companion_id, kind, why, created_at) VALUES ('ev1', 'a', 'cypher', 'returned', 'saw a maze', ?)").run(ts(1));
  return { db, env };
}

describe("orient interests (0.29.0)", () => {
  it("loads up to 3 ACTIVE interests warmest first, own companion only, counts active and resting", async () => {
    const { env } = seed();
    const b = await loadInterestsBlock(env, "cypher", NOW);
    expect(ORIENT_INTERESTS).toBe(3);
    expect(b.warm.map((i) => i.name)).toEqual(["Physarum", "secret garden", "networks"]);
    expect(b.active).toBe(4);
    expect(b.resting).toBe(1);
    expect(b.warm.find((i) => i.name === "networks")).toMatchObject({ is_new: true, from_exposure: true });
    expect(b.warm.find((i) => i.name === "Physarum")).toMatchObject({ is_new: false, last_kind: "returned" });
  });
  it("a private why is null (Hearth reads this same state)", async () => {
    const { env } = seed();
    const b = await loadInterestsBlock(env, "cypher", NOW);
    expect(b.warm.find((i) => i.name === "secret garden")!.why).toBeNull();
  });
  it("renders one line each, a 'more' hint, and nothing when empty", async () => {
    const { env } = seed();
    const b = await loadInterestsBlock(env, "cypher", NOW);
    const r = interestsBlock(b);
    expect(r).toContain(INTERESTS_BLOCK_HEADER);
    expect(r).toContain("- networks (warm, new, kept from what you were reading)");
    expect(r).toContain("(1 more active; \"my interests\" lists them)");
    expect(r).toContain("back to <name> because <why>");
    expect(r).not.toContain("why: null");
    expect(interestsBlock(EMPTY_INTERESTS)).toBe("");
    expect(interestsBlock(undefined)).toBe("");
    expect(interestLine({ name: "x", band: "cold", heat: 0.1, why: "w".repeat(200), last_kind: null, last_at: null, is_new: false, from_exposure: false }).length).toBeLessThan(170);
  });
  it("rides loadMindState and the bot wire as the same lines; contract bumped with a changelog note", async () => {
    const { env } = seed();
    const ms = await loadMindState(env, "cypher", "discord");
    expect(ms.contract_version).toBe(MINDSTATE_CONTRACT_VERSION);
    // 0.29.0 or any later MINOR (a later bump must not break this test; 0.31.0 = makes + dated intentions).
    expect(MINDSTATE_CONTRACT_VERSION).toMatch(/^0\.(29|[3-9]\d)\.\d+$/);
    expect(CONTRACT_CHANGELOG["0.29.0"]).toContain("interests");
    expect(ms.interests?.warm[0]?.name).toBe("Physarum");
    expect(ms.meta.degraded ?? []).not.toContain("interests");
    const wire = botWireFromMindState(ms, { synthesis_summary: null, rag_excerpts: [], history_excerpts: [], continuity_notes: [], owner: "principal" } as any, "cypher") as Record<string, unknown>;
    expect(Array.isArray(wire["interests"])).toBe(true);
    expect((wire["interests"] as string[])[0]).toBe(interestLine(ms.interests!.warm[0]!));
  });
  it("never reads the night's candidates", async () => {
    const { db, env } = seed();
    db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode) VALUES ('cx', 'cypher', 'granite', 1, 3, 3, 2, 'on')").run();
    const ms = await loadMindState(env, "cypher", "claude");
    expect(JSON.stringify(ms.interests)).not.toContain("granite");
  });
});
