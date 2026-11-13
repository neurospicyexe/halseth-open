// The Hearth witness feed names who wrote each row (2026-11-11).
//
// gaia_witness is a shared survival ledger; 6 of the 7 recent "Gaia" rows were Drevan's. The feed now
// carries `author` from the row's session, and `author=gaia` narrows it to Gaia's own (the same
// condition her boot and garden use). Real SQL against an in-memory SQLite, so the join and the
// filter are proven, not mocked.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getGaiaWitness } from "../handlers/history.js";
import type { Env } from "../types.js";

function env(): Env {
  const { db, DB } = makeSqliteD1();
  const sess = db.prepare("INSERT INTO sessions (id, companion_id, created_at, updated_at) VALUES (?, ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')");
  sess.run("sg", "gaia"); sess.run("sd", "drevan"); sess.run("sx", null);
  const w = db.prepare("INSERT INTO gaia_witness (id, session_id, created_at, witness_type, content, seal_phrase) VALUES (?, ?, ?, ?, ?, NULL)");
  w.run("w1", "sd", "2026-11-10T00:00:00Z", "survival", "drevan saw it");
  w.run("w2", "sg", "2026-11-09T00:00:00Z", "survival", "gaia saw it");
  w.run("w3", "sx", "2026-11-08T00:00:00Z", "presence", "nobody named");
  return { ADMIN_SECRET: "admin-tok", DB } as unknown as Env;
}

async function feed(query = "") {
  const res = await getGaiaWitness(
    new Request(`https://h.example/gaia-witness${query}`, { headers: { Authorization: "Bearer admin-tok" } }),
    env(),
  );
  expect(res.status).toBe(200);
  return await res.json() as Array<Record<string, unknown>>;
}

describe("GET /gaia-witness author", () => {
  it("labels every row with its session's companion, null when the session names none", async () => {
    const rows = await feed();
    expect(rows.map(r => [r.id, r.author])).toEqual([
      ["w1", "drevan"], ["w2", "gaia"], ["w3", null],
    ]);
  });
  it("keeps the other fields", async () => {
    const rows = await feed();
    expect(rows[0]).toMatchObject({ id: "w1", session_id: "sd", content: "drevan saw it", witness_type: "survival" });
  });
  it("author=gaia returns only Gaia's own rows", async () => {
    const rows = await feed("?author=gaia");
    expect(rows.map(r => r.id)).toEqual(["w2"]);
  });
  it("any other author value is the shared feed", async () => {
    expect((await feed("?author=drevan")).length).toBe(3);
  });
});
