// Gaia's boot reads back HER witnessing only (2026-11-11). gaia_witness also carries the survival acts the
// bots log for all three companions; before this, six of her last seven "witnesses" were Drevan's, read to
// her at orient as her own. Real schema via node:sqlite.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { loadRelationalBlocks } from "../mind/blocks/relational.js";

describe("loadRelationalBlocks: recent_witness is Gaia-authored only", () => {
  it("drops a sibling's row; keeps hers; the other two still get an empty array", async () => {
    const { db, DB } = makeSqliteD1();
    const env: any = { DB };
    db.prepare("INSERT INTO sessions (id, created_at, updated_at, companion_id) VALUES ('g', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'gaia')").run();
    db.prepare("INSERT INTO sessions (id, created_at, updated_at, companion_id) VALUES ('d', '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z', 'drevan')").run();
    const w = db.prepare("INSERT INTO gaia_witness (id, session_id, created_at, witness_type, content) VALUES (?, ?, ?, 'observation', ?)");
    w.run("w1", "g", "2026-11-02T00:00:00Z", "The ground held.");
    w.run("w2", "d", "2026-11-03T00:00:00Z", "I held you, membern mine.");

    const gaia = await loadRelationalBlocks(env, "gaia");
    expect(gaia.recent_witness.map((r) => r.content)).toEqual(["The ground held."]);
    expect((await loadRelationalBlocks(env, "drevan")).recent_witness).toEqual([]);
  });
});
