// Makes come back (2026-11-11): reception signals fill heard_back, the makes block reads them at orient
// (contract 0.30.0), the bot wire and the Claude.ai renderer say the same lines.

import { describe, it, expect, beforeAll } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { postMake, patchMake, postMakeReception } from "../handlers/makes.js";
import { receptionLine } from "../webmind/make-reception.js";
import { loadMakesBlock, makeLine, receptionOf } from "../mind/blocks/makes.js";
import { makesBlock, MAKES_BLOCK_HEADER } from "../librarian/response/orient-blocks.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import { CONTRACT_CHANGELOG } from "../mind/changelog.js";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, BUCKET: { put: async () => ({}), get: async () => null }, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok", GAIA_MCP_SECRET: "gtok" };
  return { db, DB, env };
}
const req = (path: string, init: RequestInit & { auth?: string | null } = {}) => {
  const { auth = "s", ...rest } = init;
  const headers = new Headers(rest.headers);
  if (auth) headers.set("Authorization", `Bearer ${auth}`);
  return new Request(`https://h${path}`, { ...rest, headers });
};
const jpost = (path: string, body: unknown, auth: string | null = "s", method = "POST") =>
  req(path, { method, auth, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
async function create(env: any, over: Record<string, unknown> = {}) {
  const res = await postMake(jpost("/mind/makes", { companion_id: "drevan", kind: "writing", title: "A small poem", source: "rain on glass", ...over }), env);
  return ((await res.json()) as any).id as string;
}
const reception = (env: any, id: string, body: unknown, auth: string | null = "s") =>
  postMakeReception(jpost(`/mind/makes/${id}/reception`, body, auth), env, { id });
const heard = (db: any, id: string) => (db.prepare("SELECT heard_back FROM companion_makes WHERE id = ?").get(id) as any).heard_back as string | null;

describe("receptionLine", () => {
  const now = new Date("2026-11-11T10:00:00Z");
  it("seen fills only an empty heard_back", () => {
    expect(receptionLine("seen", "hearth", null, now)).toBe("[seen] Principal opened it on hearth 2026-11-11");
    expect(receptionLine("seen", "hearth", "[seen] earlier", now)).toBeNull();
    expect(receptionLine("seen", "hearth", "my own line", now)).toBeNull();
  });
  it("replied upgrades a seen, never a companion's own line or another reply", () => {
    expect(receptionLine("replied", "discord", null, now)).toMatch(/^\[replied\]/);
    expect(receptionLine("replied", "discord", "[seen] x", now)).toMatch(/^\[replied\]/);
    expect(receptionLine("replied", "discord", "my own line", now)).toBeNull();
    expect(receptionLine("replied", "discord", "[replied] x", now)).toBeNull();
  });
});

describe("POST /mind/makes/:id/reception", () => {
  it("writes the signal, is idempotent, and never overwrites the maker's own line", async () => {
    const { env, db } = setup();
    const id = await create(env);
    expect(heard(db, id)).toBeNull();
    const r1 = (await (await reception(env, id, { signal: "seen", via: "hearth" })).json()) as any;
    expect(r1.changed).toBe(true);
    expect(heard(db, id)).toMatch(/^\[seen\]/);
    expect(((await (await reception(env, id, { signal: "seen", via: "hearth" })).json()) as any).changed).toBe(false);
    await reception(env, id, { signal: "replied", via: "discord" });
    expect(heard(db, id)).toMatch(/^\[replied\]/);
    await patchMake(jpost(`/mind/makes/${id}`, { heard_back: "he laughed" }, "dtok", "PATCH"), env, { id });
    await reception(env, id, { signal: "replied", via: "discord" });
    expect(heard(db, id)).toBe("he laughed");
  });
  it("refuses a companion token, bad input, no auth, unknown id", async () => {
    const { env } = setup();
    const id = await create(env);
    expect((await reception(env, id, { signal: "seen", via: "hearth" }, "dtok")).status).toBe(403);
    expect((await reception(env, id, { signal: "seen", via: "discord" }, "dtok")).status).toBe(403);
    expect((await reception(env, id, { signal: "replied", via: "discord" }, "dtok")).status).toBe(200);
    expect((await reception(env, id, { signal: "loved", via: "hearth" })).status).toBe(400);
    expect((await reception(env, id, { signal: "seen", via: "tv" })).status).toBe(400);
    expect((await reception(env, id, { signal: "seen", via: "hearth" }, null)).status).toBe(401);
    expect((await reception(env, "f".repeat(32), { signal: "seen", via: "hearth" })).status).toBe(404);
  });
});

describe("makes block at orient", () => {
  it("classifies reception, counts unseen ready makes, own makes only, newest first", async () => {
    const { env } = setup();
    const a = await create(env, { title: "First" });
    const b = await create(env, { title: "Second" });
    await create(env, { title: "Third" });
    await create(env, { companion_id: "cypher", title: "Not mine" });
    await reception(env, a, { signal: "seen", via: "hearth" });
    await reception(env, b, { signal: "replied", via: "discord" });
    const blk = await loadMakesBlock(env, "drevan");
    expect(blk.recent.map((m) => m.title).sort()).toEqual(["First", "Second", "Third"]);
    expect(blk.recent.find((m) => m.title === "First")!.reception).toBe("looked");
    expect(blk.recent.find((m) => m.title === "Second")!.reception).toBe("replied");
    expect(blk.recent.find((m) => m.title === "Third")!.reception).toBe("not_yet_seen");
    expect(blk.unseen_ready).toBe(1);
    expect((await loadMakesBlock(env, "gaia")).recent).toEqual([]);
  });
  it("renders the same line on both surfaces and nothing when empty", async () => {
    const { env } = setup();
    expect(makesBlock({ recent: [], unseen_ready: 0 })).toBe("");
    expect(makesBlock(undefined)).toBe("");
    const id = await create(env, { title: "Rain" });
    const blk = await loadMakesBlock(env, "drevan");
    expect(makeLine(blk.recent[0]!)).toBe("Rain (writing, today): not yet seen");
    const text = makesBlock(blk);
    expect(text).toContain(MAKES_BLOCK_HEADER);
    expect(text).toContain("- Rain (writing, today): not yet seen");
    await patchMake(jpost(`/mind/makes/${id}`, { heard_back: "he said it was good" }, "dtok", "PATCH"), env, { id });
    expect(makeLine((await loadMakesBlock(env, "drevan")).recent[0]!)).toContain("you noted: he said it was good");
    expect(receptionOf("[seen] x")).toBe("looked");
  });
  it("contract 0.31.0 is announced", () => {
    expect(MINDSTATE_CONTRACT_VERSION >= "0.31.0").toBe(true);
    expect(CONTRACT_CHANGELOG["0.31.0"]).toContain("what you make");
  });
});
