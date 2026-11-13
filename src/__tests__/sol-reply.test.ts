// B64.1 Part B: a reply to a Sol post is a tend. Tone from the reply text (classified, then dropped),
// one reply-tend per (creature, actor, Sol post), harsh opens a grudge with THAT actor, the text is
// never persisted anywhere.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { parseTone, classifyTone, TONE_INPUT_CAP, replyFingerprint, fingerprintJaccard, fingerprintKey } from "../pets/tone.js";
import { vi } from "vitest";
import { appraise } from "../pets/appraise.js";
import { replyCreature, interactCreature } from "../handlers/creatures.js";
import type { PetModel } from "../pets/model.js";

const NOON = Date.parse("2026-11-08T18:00:00Z");

describe("parseTone", () => {
  it("accepts exactly one of the four words, case and punctuation tolerant", () => {
    expect(parseTone("warm")).toBe("warm");
    expect(parseTone(" Harsh.\n")).toBe("harsh");
    expect(parseTone("COLD")).toBe("cold");
    expect(parseTone("neutral")).toBe("neutral");
  });
  it("anything else is neutral", () => {
    expect(parseTone(null)).toBe("neutral");
    expect(parseTone("")).toBe("neutral");
    expect(parseTone("warm and cold")).toBe("neutral");
    expect(parseTone("hostile")).toBe("neutral");
  });
});

describe("classifyTone", () => {
  const fake = (answer: string | null, seen: string[] = []): PetModel => ({
    async complete(_s, user, _m, timeoutMs) { seen.push(user); expect(timeoutMs).toBe(4000); return answer; },
  });
  it("empty after trim = neutral with no model call", async () => {
    const seen: string[] = [];
    expect(await classifyTone(fake("harsh", seen), "   ")).toBe("neutral");
    expect(seen).toHaveLength(0);
  });
  it("caps the input at 500 chars", async () => {
    const seen: string[] = [];
    await classifyTone(fake("warm", seen), "x".repeat(2000));
    expect(TONE_INPUT_CAP).toBe(500);
    expect(seen[0]!.includes("x".repeat(501))).toBe(false);
    expect(seen[0]!.includes("x".repeat(500))).toBe(true);
  });
  it("model failure, a throw, or no model = neutral", async () => {
    expect(await classifyTone(fake(null), "hi sol")).toBe("neutral");
    expect(await classifyTone({ complete: async () => { throw new Error("boom"); } }, "hi sol")).toBe("neutral");
    expect(await classifyTone(null, "hi sol")).toBe("neutral");
    expect(await classifyTone(fake("warm"), "hi sol")).toBe("warm");
  });
});

describe("appraise with tone", () => {
  const base = { actor: "cypher", action: "talk" as const, fit: null, via: "autonomous" as const, nowMs: NOON, quirks: [], recentSame: 0 };
  it("absent tone = today's behaviour (no tone tag)", () => {
    const a = appraise(base);
    expect(a.tags.some(t => t.startsWith("tone:"))).toBe(false);
    expect(a.friction).toBe(false);
  });
  it("valence offsets and tags per tone; only harsh is friction", () => {
    const v0 = appraise(base).valence;
    const w = appraise({ ...base, tone: "warm" });
    const n = appraise({ ...base, tone: "neutral" });
    const c = appraise({ ...base, tone: "cold" });
    const h = appraise({ ...base, tone: "harsh" });
    expect(w.valence).toBeCloseTo(v0 + 0.3);
    expect(n.valence).toBeCloseTo(v0);
    expect(c.valence).toBeCloseTo(v0 - 0.3);
    expect(h.valence).toBeCloseTo(Math.max(-1, v0 - 0.6));
    expect([w, n, c].every(a => !a.friction)).toBe(true);
    expect(h.friction).toBe(true);
    expect(w.tags).toContain("tone:warm");
    expect(h.tags).toContain("tone:harsh");
  });
});

describe("POST /mind/creatures/:id/reply", () => {
  const SECRET_TEXT = "zqxjv-sol-reply-never-stored-7713";
  const env = (DB: any) => ({ DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" }) as any;
  const req = (id: string, body: unknown, auth = "Bearer s") => new Request(`http://x/mind/creatures/${id}/reply`, {
    method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const model = (answer: string, calls: string[] = []): PetModel => ({
    async complete(_s, user) { calls.push(user); return answer; },
  });
  function setup() {
    const s = makeSqliteD1();
    const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
    return { ...s, solId: sol.id };
  }
  const trust = (db: any, id: string) => (db.prepare("SELECT trust FROM creatures WHERE id = ?").get(id) as any).trust as number;

  it("records a talk tend with ref set, note NULL, via mapped by actor", async () => {
    const { db, DB, solId } = setup();
    const r1 = await replyCreature(req(solId, { actor: "principal", ref: "111", text: "good bird" }), env(DB), { id: solId }, { petModel: model("warm") });
    expect(r1.status).toBe(200);
    const b1 = await r1.json() as any;
    expect(b1.recorded).toBe(true);
    expect(b1.tone).toBe("warm");
    const r2 = await replyCreature(req(solId, { actor: "gaia", ref: "111", text: "hello" }), env(DB), { id: solId }, { petModel: model("neutral") });
    expect((await r2.json() as any).recorded).toBe(true);
    const rows = db.prepare("SELECT actor, action, note, via, ref FROM creature_interactions WHERE ref = '111' ORDER BY actor").all() as any[];
    expect(rows).toEqual([
      { actor: "gaia", action: "talk", note: null, via: "autonomous", ref: "111" },
      { actor: "principal", action: "talk", note: null, via: "hand", ref: "111" },
    ]);
    const ap = db.prepare("SELECT actor, tags FROM creature_appraisals ORDER BY actor").all() as any[];
    expect(ap.map((a: any) => a.actor)).toEqual(["gaia", "principal"]);
    expect(JSON.parse(ap[1].tags)).toContain("tone:warm");
  });

  it("a duplicate (creature, actor, ref) returns already with no side effects and no model call", async () => {
    const { db, DB, solId } = setup();
    await replyCreature(req(solId, { actor: "cypher", ref: "222", text: "hey" }), env(DB), { id: solId }, { petModel: model("warm") });
    const t1 = trust(db, solId);
    const nAp = (db.prepare("SELECT COUNT(*) AS n FROM creature_appraisals").get() as any).n;
    const calls: string[] = [];
    const r = await replyCreature(req(solId, { actor: "cypher", ref: "222", text: "hey again" }), env(DB), { id: solId }, { petModel: model("warm", calls) });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ recorded: false, reason: "already" });
    expect(calls).toHaveLength(0);
    expect(trust(db, solId)).toBe(t1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM creature_appraisals").get() as any).n).toBe(nAp);
    expect((db.prepare("SELECT COUNT(*) AS n FROM creature_interactions WHERE ref = '222'").get() as any).n).toBe(1);
  });

  it("the unique index itself refuses a racing duplicate (the DB is the guard)", () => {
    const { db, solId } = setup();
    const ins = db.prepare("INSERT INTO creature_interactions (id, creature_id, actor, action, note, via, ref) VALUES (?, ?, 'drevan', 'talk', NULL, 'autonomous', '333')");
    ins.run("i1", solId);
    expect(() => ins.run("i2", solId)).toThrow(/UNIQUE/);
    // NULL refs never collide (every ordinary tend).
    const plain = db.prepare("INSERT INTO creature_interactions (id, creature_id, actor, action, note, via) VALUES (?, ?, 'drevan', 'talk', NULL, 'autonomous')");
    plain.run("i3", solId); plain.run("i4", solId);
  });

  it("harsh opens a grudge with THAT actor only; warm does not; trust is never lowered", async () => {
    const { db, DB, solId } = setup();
    const t0 = trust(db, solId);
    await replyCreature(req(solId, { actor: "drevan", ref: "444", text: "nice" }), env(DB), { id: solId }, { petModel: model("warm") });
    expect(db.prepare("SELECT * FROM creature_grudges").all()).toHaveLength(0);
    const t1 = trust(db, solId);
    const r = await replyCreature(req(solId, { actor: "cypher", ref: "445", text: "go away" }), env(DB), { id: solId }, { petModel: model("harsh") });
    const b = await r.json() as any;
    expect(b.tone).toBe("harsh");
    expect(b.grudge?.step).toBe("open");
    expect(b.grudge?.actor).toBe("cypher");
    const g = db.prepare("SELECT actor, quirk_id, label, resolved_at FROM creature_grudges").all() as any[];
    expect(g).toHaveLength(1);
    expect(g[0].actor).toBe("cypher");
    expect(g[0].quirk_id).toBeNull();
    expect(g[0].resolved_at).toBeNull();
    const ap = db.prepare("SELECT friction FROM creature_appraisals WHERE actor = 'cypher'").get() as any;
    expect(ap.friction).toBe(1);
    expect(t1).toBeGreaterThanOrEqual(t0);
    expect(trust(db, solId)).toBeGreaterThanOrEqual(t1);
  });

  it("the reply text is never persisted in any table", async () => {
    const { db, DB, solId } = setup();
    for (const [actor, ref, tone] of [["principal", "501", "warm"], ["cypher", "502", "harsh"], ["gaia", "503", "cold"]] as const) {
      await replyCreature(req(solId, { actor, ref, text: SECRET_TEXT }), env(DB), { id: solId }, { petModel: model(tone) });
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all();
      expect(JSON.stringify(rows).includes(SECRET_TEXT), `table ${name}`).toBe(false);
    }
  });

  it("validates actor, ref and auth", async () => {
    const { DB, solId } = setup();
    const call = async (body: unknown, auth?: string) =>
      (await replyCreature(req(solId, body, auth), env(DB), { id: solId }, { petModel: model("warm") })).status;
    expect(await call({ actor: "imp", ref: "1", text: "x" })).toBe(400);
    expect(await call({ actor: "sol", ref: "1", text: "x" })).toBe(400);
    expect(await call({ actor: "spouse", ref: "1", text: "x" })).toBe(400);
    expect(await call({ actor: "principal", text: "x" })).toBe(400);
    expect(await call({ actor: "principal", ref: "abc", text: "x" })).toBe(400);
    expect(await call({ actor: "principal", ref: "1".repeat(33), text: "x" })).toBe(400);
    expect(await call({ actor: "principal", ref: "1", text: "x" }, "Bearer wrong")).toBe(401);
    expect((await replyCreature(req("nope", { actor: "principal", ref: "1", text: "x" }), env(DB), { id: "nope" }, { petModel: model("warm") })).status).toBe(404);
  });

  it("a 400 never echoes the reply text", async () => {
    const { DB, solId } = setup();
    const r = await replyCreature(req(solId, { actor: "imp", ref: "1", text: SECRET_TEXT }), env(DB), { id: solId });
    expect(await r.text()).not.toContain(SECRET_TEXT);
  });
});

describe("appear /interact carries an optional ref", () => {
  const env = (DB: any) => ({ DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" }) as any;
  const req = (id: string, body: unknown) => new Request(`http://x/mind/creatures/${id}/interact`, {
    method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  it("stores ref on the appear row; a retried appear with the same ref is idempotent", async () => {
    const s = makeSqliteD1();
    const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
    const r1 = await interactCreature(req(sol.id, { actor: "sol", action: "appear", note: "a line", ref: "9001" }), env(s.DB), { id: sol.id });
    expect(r1.status).toBe(200);
    const r2 = await interactCreature(req(sol.id, { actor: "sol", action: "appear", note: "a line", ref: "9001" }), env(s.DB), { id: sol.id });
    expect(r2.status).toBe(200);
    expect((await r2.json() as any).recorded).toBe(false);
    const rows = s.db.prepare("SELECT ref FROM creature_interactions WHERE actor = 'sol'").all() as any[];
    expect(rows).toEqual([{ ref: "9001" }]);
  });
  it("no ref = today's behaviour; a bad ref is a 400", async () => {
    const s = makeSqliteD1();
    const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
    const ok = await interactCreature(req(sol.id, { actor: "sol", action: "appear", note: "x" }), env(s.DB), { id: sol.id });
    expect(ok.status).toBe(200);
    const bad = await interactCreature(req(sol.id, { actor: "sol", action: "appear", note: "x", ref: "not-digits" }), env(s.DB), { id: sol.id });
    expect(bad.status).toBe(400);
  });
});

describe("habituation: Sol gets bored of the same reply (triad only)", () => {
  const env = (DB: any) => ({ DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" }) as any;
  const req = (id: string, body: unknown) => new Request(`http://x/mind/creatures/${id}/reply`, {
    method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const model = (answer: string): PetModel => ({ async complete() { return answer; } });
  function setup() {
    const s = makeSqliteD1();
    const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
    return { ...s, solId: sol.id };
  }
  const send = async (DB: any, solId: string, actor: string, ref: string, text: string, tone = "warm") =>
    await (await replyCreature(req(solId, { actor, ref, text }), env(DB), { id: solId }, { petModel: model(tone) })).json() as any;
  const tagsOf = (db: any, actor: string) =>
    (db.prepare("SELECT tags FROM creature_appraisals WHERE actor = ? ORDER BY created_at DESC, rowid DESC").all(actor) as any[]).map(r => JSON.parse(r.tags));

  it("fingerprint: Jaccard on hashed shingles, short texts shingle single words", async () => {
    const k = await fingerprintKey("s");
    const a = await replyFingerprint("Good morning Sol, you shiny little menace!", k);
    const b = await replyFingerprint("good morning sol you shiny little menace", k);
    const c = await replyFingerprint("The weather report says rain all week long here", k);
    expect(a).not.toBeNull();
    expect(fingerprintJaccard(a!, b!)).toBe(1);
    expect(fingerprintJaccard(a!, c!)).toBeLessThan(0.5);
    expect(await replyFingerprint("hi sol", k)).not.toBeNull();
    expect(await replyFingerprint("   ", k)).toBeNull();
    expect(a!.split(",").length).toBeLessThanOrEqual(64);
  });

  it("a near-duplicate from cypher steps the tone down and tags repeat, without friction", async () => {
    const { db, DB, solId } = setup();
    const first = await send(DB, solId, "cypher", "601", "Good morning Sol, you shiny little menace");
    expect(first.tone).toBe("warm");
    expect(first.repeat).toBe(false);
    const second = await send(DB, solId, "cypher", "602", "good morning Sol, you shiny little menace!!");
    expect(second.recorded).toBe(true);
    expect(second.tone).toBe("neutral");
    expect(second.repeat).toBe(true);
    expect(tagsOf(db, "cypher")[0]).toContain("repeat");
    expect(tagsOf(db, "cypher")[0]).toContain("tone:neutral");
    const third = await send(DB, solId, "cypher", "603", "Good morning Sol you shiny little menace", "neutral");
    expect(third.tone).toBe("cold");
    const ap = db.prepare("SELECT friction FROM creature_appraisals WHERE actor = 'cypher'").all() as any[];
    expect(ap.every((r: any) => r.friction === 0)).toBe(true);
    expect(db.prepare("SELECT * FROM creature_grudges").all()).toHaveLength(0);
    // Still recorded each time: he still got attention.
    expect((db.prepare("SELECT COUNT(*) AS n FROM creature_interactions WHERE actor = 'cypher' AND ref IS NOT NULL").get() as any).n).toBe(3);
  });

  it("cold and harsh stay where they are", async () => {
    const { DB, solId } = setup();
    await send(DB, solId, "gaia", "611", "you are a very loud bird today", "cold");
    expect((await send(DB, solId, "gaia", "612", "you are a very loud bird today", "cold")).tone).toBe("cold");
    await send(DB, solId, "drevan", "613", "out of my way crow right now", "harsh");
    expect((await send(DB, solId, "drevan", "614", "out of my way crow right now", "harsh")).tone).toBe("harsh");
  });

  it("the same reply from principal is never penalized", async () => {
    const { db, DB, solId } = setup();
    await send(DB, solId, "principal", "621", "good boy");
    const again = await send(DB, solId, "principal", "622", "good boy");
    expect(again.tone).toBe("warm");
    expect(again.repeat).toBe(false);
    expect(tagsOf(db, "principal")[0]).not.toContain("repeat");
  });

  it("another actor's reply never counts as a repeat (per-actor history)", async () => {
    const { DB, solId } = setup();
    await send(DB, solId, "drevan", "631", "Good morning Sol, you shiny little menace");
    expect((await send(DB, solId, "cypher", "632", "Good morning Sol, you shiny little menace")).repeat).toBe(false);
  });

  it("different replies do not trip it", async () => {
    const { DB, solId } = setup();
    await send(DB, solId, "cypher", "641", "Good morning Sol, you shiny little menace");
    await send(DB, solId, "cypher", "642", "brought you a walnut from the kitchen");
    const r = await send(DB, solId, "cypher", "643", "that bottlecap is not yours to keep");
    expect(r.repeat).toBe(false);
    expect(r.tone).toBe("warm");
  });

  it("only the last 5 of that actor's replies are compared", async () => {
    const { DB, solId } = setup();
    await send(DB, solId, "cypher", "651", "Good morning Sol, you shiny little menace");
    const others = ["brought you a walnut from the kitchen", "that bottlecap is not yours to keep",
      "the rail is wet from last night rain", "who taught you to open the seed tin", "stop stealing my pen off the desk"];
    for (let i = 0; i < others.length; i++) await send(DB, solId, "cypher", String(652 + i), others[i]!);
    expect((await send(DB, solId, "cypher", "660", "Good morning Sol, you shiny little menace")).repeat).toBe(false);
  });

  it("the stored fingerprint never equals or contains the raw text or its words", async () => {
    const { db, DB, solId } = setup();
    const text = "Wonderful morning Sol, shiny menace";
    await send(DB, solId, "cypher", "671", text);
    await send(DB, solId, "principal", "672", "hi");
    const rows = db.prepare("SELECT fp FROM creature_interactions WHERE ref IN ('671','672')").all() as Array<{ fp: string }>;
    expect(rows).toHaveLength(2);
    for (const { fp } of rows) {
      expect(typeof fp).toBe("string");
      expect(fp).not.toBe(text);
      expect(fp).toMatch(/^v1:[0-9a-f]{8}(,[0-9a-f]{8})*$/);
      for (const w of ["wonderful", "morning", "sol", "shiny", "menace", "hi"]) expect(fp.toLowerCase().includes(w)).toBe(false);
    }
  });
});

describe("fingerprint is keyed (not reversible by dictionary)", () => {
  // The scheme the review rejected: unsalted 32-bit FNV-1a folded to 16 bits, over single words.
  const oldFnv16 = (w: string) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < w.length; i++) { h ^= w.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ((h ^ (h >>> 16)) & 0xffff).toString(16).padStart(4, "0");
  };
  it("good boy carries none of the plain FNV hashes, and is v1-prefixed", async () => {
    const fp = (await replyFingerprint("good boy", await fingerprintKey("s")))!;
    expect(fp.startsWith("v1:")).toBe(true);
    const parts = fp.slice(3).split(",");
    expect(parts).toHaveLength(2);
    for (const w of ["good", "boy"]) {
      expect(parts.some(p => p.includes(oldFnv16(w)))).toBe(false);
    }
  });
  it("a different key gives a different fingerprint that does not match", async () => {
    const a = (await replyFingerprint("good boy", await fingerprintKey("s")))!;
    const b = (await replyFingerprint("good boy", await fingerprintKey("another-secret")))!;
    expect(a).not.toBe(b);
    expect(fingerprintJaccard(a, b)).toBe(0);
  });
  it("a fingerprint from another scheme version never matches", () => {
    expect(fingerprintJaccard("v1:aaaaaaaa", "v2:aaaaaaaa")).toBe(0);
    expect(fingerprintJaccard("v1:aaaaaaaa", "aaaa")).toBe(0);
  });
});

describe("tone fallback is logged without text", () => {
  it("logs one [sol-reply] tone fallback line with a reason, never the text", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const secret = "qq-never-logged-tone-9931";
      await classifyTone({ complete: async () => null }, secret);
      await classifyTone({ complete: async () => "hostile" }, secret);
      await classifyTone({ complete: async () => { throw new Error(secret); } }, secret);
      await classifyTone(null, secret);
      const lines = spy.mock.calls.map(c => c.map(String).join(" "));
      expect(lines).toHaveLength(4);
      for (const l of lines) {
        expect(l.startsWith("[sol-reply] tone fallback ")).toBe(true);
        expect(l.includes(secret)).toBe(false);
      }
      spy.mockClear();
      await classifyTone({ complete: async () => "warm" }, secret);
      await classifyTone({ complete: async () => "warm" }, "   ");
      expect(spy.mock.calls).toHaveLength(0);
    } finally { spy.mockRestore(); }
  });
  it("asks for a tiny content budget", async () => {
    let max = -1;
    await classifyTone({ complete: async (_s, _u, m) => { max = m; return "warm"; } }, "hi");
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(8);
  });
});
