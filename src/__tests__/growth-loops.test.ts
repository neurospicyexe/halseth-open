// Growth loops (2026-11-11): seed pick window + weekly graduation candidate + standing dispositions.
import { describe, it, expect } from "vitest";
import { getAutonomySeeds } from "../handlers/autonomy";
import { pickGraduationCandidate } from "../webmind/self-model-graduation";
import { graduatedBlock } from "../librarian/response/orient-blocks";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract";
import { CONTRACT_CHANGELOG } from "../mind/changelog";

function db(handler: (sql: string, args: unknown[]) => { first?: unknown; all?: unknown[] }) {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  return {
    calls,
    prepare(sql: string) {
      let args: unknown[] = [];
      const st = {
        bind(...a: unknown[]) { args = a; return st; },
        async first() { calls.push({ sql, args }); return handler(sql, args).first ?? null; },
        async all() { calls.push({ sql, args }); return { results: handler(sql, args).all ?? [] }; },
      };
      return st;
    },
  };
}
const env = (d: unknown) => ({ DB: d, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "s" }) as never;
const req = (q: string) => new Request(`https://x/mind/autonomy/seeds/cypher${q}`, { headers: { Authorization: "Bearer s" } });

const cmpVer = (a: string, b: string) => { const x = a.split(".").map(Number), y = b.split(".").map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!; return 0; };
describe("seed pick window", () => {
  it("default query is unchanged (oldest first, no window)", async () => {
    const d = db(() => ({ all: [] }));
    await getAutonomySeeds(req(""), env(d), { companion_id: "cypher" });
    expect(d.calls[0]!.sql).toContain("priority DESC, created_at ASC");
    expect(d.calls[0]!.sql).not.toContain("datetime('now', ?)");
  });
  it("order=fresh + max_age_days windows and serves newest first, never mutates", async () => {
    const d = db(() => ({ all: [] }));
    await getAutonomySeeds(req("?order=fresh&max_age_days=7&limit=5"), env(d), { companion_id: "cypher" });
    const c = d.calls[0]!;
    expect(c.sql).toContain("created_at >= datetime('now', ?)");
    expect(c.sql).toContain("created_at DESC");
    expect(c.sql.startsWith("SELECT")).toBe(true);
    expect(c.args).toEqual(["cypher", "-7 days", 5]);
  });
});

describe("weekly graduation candidate", () => {
  it("none inside 7 days of the last graduation", async () => {
    const d = db(sql => (sql.includes("status = 'graduated'") ? { first: { x: 1 } } : { all: [] }));
    expect(await pickGraduationCandidate(env(d), "drevan")).toEqual({ candidate: null, reason: "recent_graduation" });
  });
  it("top ready by confidence; never reads anything but ready; skips care wording", async () => {
    const d = db(sql => (sql.includes("status = 'graduated'") ? {} : {
      all: [
        { id: "a", observation: "my meds slipped and I notice the dose", confidence: 1.0, kind: "preference" },
        { id: "b", observation: "I trust a plain sentence over a clever one", confidence: 0.9, kind: "preference" },
      ],
    }));
    const v = await pickGraduationCandidate(env(d), "cypher");
    expect(v.candidate?.id).toBe("b");
    const sel = d.calls.find(c => c.sql.includes("status = 'ready'"))!;
    expect(sel.sql).toContain("confidence DESC");
    expect(sel.sql).not.toMatch(/UPDATE|DELETE/);
  });
  it("none ready", async () => {
    const d = db(() => ({}));
    expect((await pickGraduationCandidate(env(d), "gaia")).reason).toBe("none_ready");
  });
});

describe("standing dispositions", () => {
  it("renders stamped lines, nothing when empty", () => {
    expect(graduatedBlock([])).toBe("");
    const t = graduatedBlock([{ observation: "plain over clever", graduated_at: "2026-11-11 03:00:00" }]);
    expect(t).toContain("Standing dispositions");
    expect(t).toContain("(graduated 2026-11-11)");
  });
  it("contract 0.32.0 carries the growth-loops changelog note", () => {
    expect(cmpVer(MINDSTATE_CONTRACT_VERSION, "0.32.0")).toBeGreaterThanOrEqual(0);
    expect(CONTRACT_CHANGELOG["0.32.0"]).toContain("Standing dispositions");
  });
});
