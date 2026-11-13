// Discord-stated fact proposals (GAP-MAP A3, 2026-11-11).
//
// Pins: a proposal lands OPEN (never active) with provenance and the 0.5 open trust; a health, care,
// body or diagnosis fact is refused at write and nothing is written or embedded; a correction points
// at the fact it would replace WITHOUT retiring it; confirming (Hearth PATCH, or a supersede of the
// proposal) applies the correction and lifts trust to 1.0; retiring the proposal leaves the old fact.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
vi.mock("../mcp/embed.js", () => ({
  embedText: vi.fn(async () => [0.1, 0.2, 0.3]),
  storeVector: vi.fn(async () => {}),
  EMBEDDING_MODEL: "test",
}));

import { proposeArchitectFact, factProposalCareCategory, CORRECTION_MATCH_MIN } from "../lib/architect-fact-proposal.js";
import { writeArchitectFact, deriveFactTrust, PROPOSAL_SOURCE_PREFIX } from "../lib/architect-fact-write.js";
import { postArchitectFactProposal, patchArchitectFactStatus } from "../handlers/architect-facts.js";
import { embedText, storeVector } from "../mcp/embed.js";

interface Row { id: string; fact: string; status: string; source: string | null; supersedes_id: string | null; trust?: number | null; companion_id?: string | null }

/** In-memory architect_facts: just the SQL shapes the proposal, write core and PATCH use. */
function makeEnv(rows: Row[], vectorMatches: Array<{ id: string; score: number }> = []) {
  const sqlLog: Array<{ sql: string; args: unknown[] }> = [];
  const deleted: string[] = [];
  const apply = (sql: string, args: unknown[]) => {
    sqlLog.push({ sql, args });
    if (sql.startsWith("INSERT INTO architect_facts")) {
      const withTrust = sql.includes("trust");
      if (sql.includes("'open'")) {
        const [id, fact, , companion_id, source, supersedes_id, trust] = args as [string, string, string, string, string, string | null, number];
        rows.push({ id, fact, status: "open", companion_id, source, supersedes_id: supersedes_id ?? null, trust: withTrust ? Number(trust) : null });
      } else {
        const [id, fact, , status, companion_id, source, supersedes_id, , trust] = args as [string, string, string, string, string, string, string | null, number, number];
        rows.push({ id, fact, status, companion_id, source, supersedes_id: supersedes_id ?? null, trust: withTrust ? trust : null });
      }
    } else if (sql.includes("SET status = 'retired'")) {
      const r = rows.find(x => x.id === args[0]); if (r) r.status = "retired";
    } else if (sql.startsWith("UPDATE architect_facts SET")) {
      const id = args[args.length - 1];
      const r = rows.find(x => x.id === id)!;
      const sets = sql.slice("UPDATE architect_facts SET ".length, sql.indexOf(", updated_at")).split(", ");
      sets.forEach((s, i) => { (r as unknown as Record<string, unknown>)[s.split(" = ")[0]!] = args[i]; });
    }
  };
  const stmt = (sql: string, args: unknown[] = []): Record<string, unknown> => ({
    sql, args,
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => {
      if (sql.includes("WHERE source LIKE ?")) {
        const p = String(args[0]).replace(/%$/, "");
        return rows.find(r => (r.source ?? "").startsWith(p)) ?? null;
      }
      if (sql.includes("WHERE id = ?")) return rows.find(r => r.id === args[0]) ?? null;
      return null;
    },
    all: async () => {
      if (sql.includes("WHERE id IN (") && sql.includes("status != 'retired'")) {
        return { results: rows.filter(r => args.includes(r.id) && r.status !== "retired") };
      }
      return { results: [] };
    },
    run: async () => { apply(sql, args); return {}; },
  });
  const env = {
    DB: {
      prepare: (sql: string) => stmt(sql),
      batch: async (stmts: Array<{ sql: string; args: unknown[] }>) => { for (const s of stmts) apply(s.sql, s.args); return []; },
    },
    VECTORIZE: {
      query: async () => ({ matches: vectorMatches.map(m => ({ id: `architect_facts:${m.id}`, score: m.score })) }),
      deleteByIds: async (ids: string[]) => { deleted.push(...ids); },
    },
  } as never;
  return { env, rows, sqlLog, deleted };
}

const base = { companionId: "drevan", channelId: "0000000000000000000", messageId: "0000000000000000001", statedAt: "2026-11-11T20:00:00Z" };

beforeEach(() => { vi.clearAllMocks(); });

describe("the hard guard: no health, care or body fact is ever proposed", () => {
  const dropped = [
    "Principal takes their meds at 9pm",
    "Principal's blood sugar was 208 this morning",
    "Principal's ankle is swollen again",
    "Principal sprained their wrist on Sunday",
    "Principal slept four hours last night",
    "Principal has OCD",
    "Principal was diagnosed with ADHD in 2019",
    "Principal has DID",
    "Principal had a meltdown at the store",
    "Principal sees their therapist on Thursdays",
    "Principal has a doctor's appointment on Friday",
    "Principal is sick with the flu",
    "Principal was exhausted after work",
    "Principal's spoons were low today",
  ];
  for (const t of dropped) {
    it(`refuses: ${t}`, () => { expect(factProposalCareCategory(t)).not.toBeNull(); });
  }
  const kept = [
    "Hope is Principal's dog; PersonP was a friend, not a dog",
    "Hope is a black lab mix",
    "Principal did the dishes before Spouse got home",
    "Principal prefers tea over coffee",
    "Principal's sister lives in Denver",
    "Principal plans to visit Rome next spring",
  ];
  for (const t of kept) {
    it(`keeps: ${t}`, () => { expect(factProposalCareCategory(t)).toBeNull(); });
  }

  it("a refused proposal writes nothing and embeds nothing", async () => {
    const { env, rows, sqlLog } = makeEnv([]);
    const out = await proposeArchitectFact(env, { ...base, fact: "Principal's ankle is swollen again", correction: false });
    expect(out).toEqual({ kind: "refused", category: "health" });
    expect(rows).toHaveLength(0);
    expect(sqlLog.some(s => s.sql.startsWith("INSERT"))).toBe(false);
    expect(embedText).not.toHaveBeenCalled();
    expect(storeVector).not.toHaveBeenCalled();
  });

  it("the HTTP route answers 422 with the category only, never the text", async () => {
    const { env, rows } = makeEnv([]);
    const res = await postArchitectFactProposal(new Request("http://x/identity/architect-facts/proposals", {
      method: "POST", body: JSON.stringify({ fact: "Principal takes their meds at 9pm", companion_id: "cypher", channel_id: base.channelId, message_id: base.messageId }),
    }), env);
    expect(res.status).toBe(422);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toEqual({ ok: false, outcome: "refused", category: "medicine" });
    expect(JSON.stringify(body)).not.toMatch(/9pm/);
    expect(rows).toHaveLength(0);
  });
});

describe("a stated fact lands as a proposal, not a fact", () => {
  it("open, provenance in source, companion who heard it, trust 0.5, indexed", async () => {
    const { env, rows } = makeEnv([]);
    const out = await proposeArchitectFact(env, { ...base, fact: "Principal's sister lives in Denver", category: "people", correction: false });
    expect(out.kind).toBe("proposed");
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.status).toBe("open");
    expect(r.companion_id).toBe("drevan");
    expect(r.source).toBe(`${PROPOSAL_SOURCE_PREFIX}${base.channelId}/${base.messageId} heard_by=drevan at=2026-11-11T20:00:00.000Z`);
    expect(r.trust).toBe(0.5);
    expect(r.supersedes_id).toBeNull();
    expect(storeVector).toHaveBeenCalledOnce();
  });

  it("one proposal per Discord message (a second bot or a retry is a duplicate)", async () => {
    const { env, rows } = makeEnv([]);
    await proposeArchitectFact(env, { ...base, fact: "Principal's sister lives in Denver", correction: false });
    const again = await proposeArchitectFact(env, { ...base, companionId: "cypher", fact: "Principal's sister lives in Denver.", correction: false });
    expect(again.kind).toBe("duplicate");
    expect(rows).toHaveLength(1);
  });

  it("a fact already active is known; a held open proposal saying the same is held", async () => {
    const active = makeEnv([{ id: "a1", fact: "Principal prefers tea", status: "active", source: "principal", supersedes_id: null }], [{ id: "a1", score: 0.97 }]);
    expect((await proposeArchitectFact(active.env, { ...base, fact: "Principal prefers tea over coffee", correction: false })).kind).toBe("known");
    const held = makeEnv([{ id: "o1", fact: "Principal prefers tea", status: "open", source: "x", supersedes_id: null }], [{ id: "o1", score: 0.85 }]);
    expect((await proposeArchitectFact(held.env, { ...base, fact: "Principal likes tea", correction: false })).kind).toBe("held");
  });

  it("only cypher/drevan/gaia and real Discord ids", async () => {
    const { env } = makeEnv([]);
    expect((await proposeArchitectFact(env, { ...base, companionId: "spouse", fact: "x y z", correction: false })).kind).toBe("invalid");
    expect((await proposeArchitectFact(env, { ...base, messageId: "1%", fact: "x y z", correction: false })).kind).toBe("invalid");
  });
});

describe("a correction points at the wrong fact and only retires it on confirm", () => {
  const personp = (): Row => ({ id: "personp-dog-0001", fact: "PersonP is Principal's dog", status: "active", source: "drevan", supersedes_id: null, trust: 0.6, companion_id: "drevan" });

  it("targets the nearest active fact without retiring it, even above the 0.95 restatement bar", async () => {
    const { env, rows, sqlLog } = makeEnv([personp()], [{ id: "personp-dog-0001", score: 0.96 }]);
    const out = await proposeArchitectFact(env, { ...base, fact: "Hope is Principal's dog; PersonP was a friend, not a dog", correction: true });
    expect(out).toMatchObject({ kind: "proposed", correctsId: "personp-dog-0001" });
    const proposal = rows.find(r => r.status === "open")!;
    expect(proposal.supersedes_id).toBe("personp-dog-0001");
    expect(rows.find(r => r.id === "personp-dog-0001")!.status).toBe("active");
    expect(sqlLog.some(s => s.sql.includes("SET status = 'retired'"))).toBe(false);
  });

  it("no target below the match floor (still proposed, just unpointed)", async () => {
    const { env } = makeEnv([personp()], [{ id: "personp-dog-0001", score: CORRECTION_MATCH_MIN - 0.05 }]);
    const out = await proposeArchitectFact(env, { ...base, fact: "Hope is Principal's dog", correction: true });
    expect(out).toMatchObject({ kind: "proposed", correctsId: null });
  });

  it("Hearth Confirm (PATCH open -> active) retires the corrected fact and lifts trust to 1.0", async () => {
    const { env, rows, deleted } = makeEnv([personp()], [{ id: "personp-dog-0001", score: 0.9 }]);
    const out = await proposeArchitectFact(env, { ...base, fact: "Hope is Principal's dog; PersonP was a friend", correction: true });
    const id = (out as { id: string }).id;
    const res = await patchArchitectFactStatus(new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "active" }) }), env, { id });
    const body = await res.json() as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, corrected: "personp-dog-0001", trust: 1.0, status: "active" });
    expect(rows.find(r => r.id === id)!.status).toBe("active");
    expect(rows.find(r => r.id === id)!.trust).toBe(1.0);
    expect(rows.find(r => r.id === "personp-dog-0001")!.status).toBe("retired");
    expect(deleted).toContain("architect_facts:personp-dog-0001");
  });

  it("retiring the proposal leaves the old fact standing", async () => {
    const { env, rows } = makeEnv([personp()], [{ id: "personp-dog-0001", score: 0.9 }]);
    const out = await proposeArchitectFact(env, { ...base, fact: "Hope is Principal's dog; PersonP was a friend", correction: true });
    const id = (out as { id: string }).id;
    await patchArchitectFactStatus(new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "retired" }) }), env, { id });
    expect(rows.find(r => r.id === id)!.status).toBe("retired");
    expect(rows.find(r => r.id === "personp-dog-0001")!.status).toBe("active");
  });

  it("superseding the proposal into an active fact (Hearth Fix, a companion re-write) applies it too", async () => {
    const { env, rows } = makeEnv([personp()], [{ id: "personp-dog-0001", score: 0.9 }]);
    const out = await proposeArchitectFact(env, { ...base, fact: "Hope is Principal's dog; PersonP was a friend", correction: true });
    const id = (out as { id: string }).id;
    const w = await writeArchitectFact(env, { fact: "Hope is Principal's dog. PersonP was a friend.", status: "active", companionId: "drevan", source: "drevan", supersedesId: id });
    expect(w.kind).toBe("written");
    expect(rows.find(r => r.id === id)!.status).toBe("retired");
    expect(rows.find(r => r.id === "personp-dog-0001")!.status).toBe("retired");
    const fresh = rows.find(r => r.id === (w as { id: string }).id)!;
    expect(fresh.status).toBe("active");
    expect(fresh.trust).toBe(1.0); // Principal's own words, confirmed
  });

  it("a plain (non-correction) confirm retires nothing else", async () => {
    const { env, rows, sqlLog } = makeEnv([personp()], []);
    const out = await proposeArchitectFact(env, { ...base, fact: "Principal's sister lives in Denver", correction: false });
    const id = (out as { id: string }).id;
    await patchArchitectFactStatus(new Request("http://x", { method: "PATCH", body: JSON.stringify({ status: "active" }) }), env, { id });
    expect(rows.find(r => r.id === "personp-dog-0001")!.status).toBe("active");
    expect(sqlLog.filter(s => s.sql.includes("SET status = 'retired'"))).toHaveLength(0);
  });
});

describe("trust derivation for the proposal source", () => {
  it("Principal-stated: 0.5 while open, 1.0 once active", () => {
    const source = `${PROPOSAL_SOURCE_PREFIX}1/2 heard_by=gaia at=x`;
    expect(deriveFactTrust({ source, companionId: "gaia", status: "open" })).toBe(0.5);
    expect(deriveFactTrust({ source, companionId: "gaia", status: "active" })).toBe(1.0);
  });
});

describe("HEALTH_TABLES: the proposal feed reads no care, med, biometric or somatic table", () => {
  it("no table in HEALTH_TABLES is named in the proposal module's source", async () => {
    const { HEALTH_TABLES } = await import("../director/supply-query.js");
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(`${process.cwd()}/src/lib/architect-fact-proposal.ts`, "utf8");
    expect(HEALTH_TABLES.length).toBeGreaterThan(0);
    for (const t of HEALTH_TABLES) expect(src).not.toMatch(new RegExp(`\b${t}\b`));
  });
});
