// [Why these numbers] names the CAUSE, not the hourly settle (2026-11-11).
// Real SQL (sqlite D1), because the fix lives in the loader's window + order, not in a renderer.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { openProject, closeProject } from "../handlers/projects.js";
import { loadSomaProvenance, PROVENANCE_CAUSE_HOURS } from "../soma/events.js";
import { provenanceBlock } from "../librarian/response/orient-blocks.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", PROJECT_FEEL: "on" };
  return { db, env };
}
const iso = (msFromNow: number) => new Date(Date.now() + msFromNow).toISOString();
let n = 0;
function event(db: any, o: { c?: string; f: string; kind: string; detail?: string | null; at: string; after?: number }) {
  n += 1;
  db.prepare(
    "INSERT INTO companion_soma_events (id, companion_id, float_key, before_value, after_value, delta, kind, writer, cause_table, cause_id, session_id, detail, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, 'system', NULL, NULL, NULL, ?, ?)",
  ).run(`t${n}`, o.c ?? "cypher", o.f, 0.5, o.after ?? 0.49, -0.01, o.kind, o.detail ?? null, o.at);
}
const firstPerFloat = (rows: { float_key: string; kind: string }[]) => {
  const seen = new Map<string, string>();
  for (const r of rows) if (!seen.has(r.float_key)) seen.set(r.float_key, r.kind);
  return Object.fromEntries(seen);
};

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => logSpy.mockRestore());

describe("cause first in [Why these numbers]", () => {
  it("a project drop still names its cause after the hourly settle has run on that float", async () => {
    const { db, env } = setup();
    const r = await openProject(env, "cypher", { title: "SECRETTITLE", intention: "x" });
    if ("error" in r) throw new Error("open failed");
    await closeProject(env, "cypher", r.id, "released", null);
    // The settle runs after it, on the same float.
    event(db, { f: "soma_float_2", kind: "tick", at: iso(60_000) });
    event(db, { f: "soma_float_2", kind: "tick", at: iso(120_000) });

    const rows = await loadSomaProvenance(env, "cypher");
    expect(firstPerFloat(rows).soma_float_2).toBe("stimulus");
    const block = provenanceBlock(rows);
    const line = block.split("\n").find((l) => l.includes("presence"))!;
    expect(line).toMatch(/stimulus: project_dropped_early/);
    expect(line).not.toContain("SECRETTITLE");
    expect(line.length).toBeLessThanOrEqual(112);
  });

  it("a float with only ticks still renders the settle", async () => {
    const { db, env } = setup();
    event(db, { f: "soma_float_1", kind: "tick", at: iso(-3_600_000) });
    const rows = await loadSomaProvenance(env, "cypher");
    expect(provenanceBlock(rows)).toMatch(/acuity .* settled toward home \(tick\)/);
  });

  it(`a cause older than ${PROVENANCE_CAUSE_HOURS}h stops leading: the float has settled`, async () => {
    const { db, env } = setup();
    event(db, { f: "soma_float_3", kind: "stimulus", detail: "old_thing: long ago", at: iso(-(PROVENANCE_CAUSE_HOURS + 2) * 3_600_000) });
    event(db, { f: "soma_float_3", kind: "tick", at: iso(-60_000) });
    const rows = await loadSomaProvenance(env, "cypher");
    expect(firstPerFloat(rows).soma_float_3).toBe("tick");
  });

  it("the newest real cause wins over an older one, and newest-first holds inside each group", async () => {
    const { db, env } = setup();
    event(db, { f: "soma_float_1", kind: "stimulus", detail: "older: one", at: iso(-7_200_000) });
    event(db, { f: "soma_float_1", kind: "stimulus", detail: "newer: two", at: iso(-3_600_000) });
    event(db, { f: "soma_float_1", kind: "tick", at: iso(-60_000) });
    const rows = (await loadSomaProvenance(env, "cypher")).filter((r) => r.float_key === "soma_float_1");
    expect(rows.map((r) => r.kind)).toEqual(["stimulus", "stimulus", "tick"]);
    expect(rows[0]!.detail).toBe("newer: two");
  });

  it("a cause with a care word is blanked to the kind, never printed", async () => {
    const { db, env } = setup();
    event(db, { f: "soma_float_2", kind: "stimulus", detail: "care: missed medication dose", at: iso(-60_000) });
    const rows = await loadSomaProvenance(env, "cypher");
    expect(rows[0]!.detail).toBeNull();
    expect(provenanceBlock(rows)).not.toMatch(/medication/);
  });
});
