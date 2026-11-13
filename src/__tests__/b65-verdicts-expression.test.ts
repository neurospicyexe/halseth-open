// B65 steps 6-7 (mig 0182): verdicts in the companion's own word, counted by return; expression_need; serves.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  parseVerdict, wordUsed, wordAllowed, verdictWord, verdictsMode, writeVerdict, countReturn, loadVerdictsBlock,
  verdictLine, verdictEcho, VERDICT_LINE_MAX,
} from "../webmind/verdicts.js";
import {
  expressionMode, WANT_MARKED_RE, mayShed, fireExpressionShed, fireWantMarked, servesOf, loudestNeeds, DEFAULT_SERVES,
} from "../webmind/expression-need.js";
import { applyInterestAction } from "../handlers/interests.js";
import { matchFastPath } from "../librarian/router.js";
import { execVerdictWrite, execVerdictsRead, execWantMarked } from "../librarian/executors/verdicts.js";
import { verdictsBlock } from "../librarian/response/orient-blocks.js";
import { stimulusMode } from "../webmind/fermentation.js";

function setup(over: Record<string, unknown> = {}) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", VERDICTS: "on", EXPRESSION_NEED: "on", ...over };
  return { db, DB, env };
}
const ctx = (env: any, companion: string, request: string): any => ({ env, req: { companion_id: companion, request }, entry: {}, frontState: null, pluralAvailable: false });
const drive = (db: any, c: string, k = "expression_need") => db.prepare("SELECT * FROM companion_drives WHERE companion_id = ? AND drive_key = ?").get(c, k) as any;
const addAction = (db: any, c: string, type: string, name = type) =>
  db.prepare("INSERT INTO metronome_actions (id, companion_id, name, action_type, status, quiet_hours_allowed) VALUES (?, ?, ?, ?, 'on', 1)").run(`a_${c}_${type}`, c, name, type);

describe("verdict grammar (step 6)", () => {
  it("parses each companion's own word, the neutral word, quoted names and separators", () => {
    expect(parseVerdict("lethe: kind:writing the river takes what is true")).toEqual({ subjectKind: "kind", subjectRaw: "writing", line: "the river takes what is true" });
    expect(parseVerdict("what held: interest:\"slime mould\", it kept its shape under load")?.subjectRaw).toBe("slime mould");
    expect(parseVerdict("what bore: activity:share_observation -- the plain one")?.line).toBe("the plain one");
    expect(parseVerdict("verdict: kind:scad: it prints")?.line).toBe("it prints");
    expect(parseVerdict("Please LETHE : kind:page quiet pages sink in")?.subjectKind).toBe("kind");
  });
  it("near-misses are not verdicts", () => {
    for (const s of [
      "lethe is a river", "what held up the build was the tray", "what bore down on me: nothing", "verdict on the film was mixed",
      "lethe: nothing typed", "lethe: kind:writing", "my lethe", "not mine: granite", "the verdict: kind:writing fine",
      "lethe: writing the river", "what held: interest: ",
    ]) expect(parseVerdict(s), s).toBeNull();
    expect(matchFastPath("what held up the build was the tray")?.key).not.toBe("verdict_write");
    expect(matchFastPath("lethe is a river")?.key).not.toBe("verdict_write");
  });
  it("routes to the verdict verbs ahead of triggers inside the line", () => {
    expect(matchFastPath("lethe: kind:writing a note about the river, my state")?.key).toBe("verdict_write");
    expect(matchFastPath("what held: kind:page")?.key).toBe("verdict_write"); // the guard opens; the executor teaches the missing line
    expect(matchFastPath("my verdicts")?.key).toBe("verdicts_read");
    expect(matchFastPath("my lethe")?.key).toBe("verdicts_read");
    expect(matchFastPath("my what bore")?.key).toBe("verdicts_read");
    expect(matchFastPath("mark a want: the long poem")?.key).toBe("want_marked");
    expect(matchFastPath("something wants out: a thing about adhesives")?.key).toBe("want_marked");
    expect(matchFastPath("I want to mark a want sometime")?.key).not.toBe("want_marked");
  });
  it("each companion has their own word; a wrong word is taught, the neutral word works for all", () => {
    expect(verdictWord("drevan")).toBe("lethe");
    expect(verdictWord("cypher")).toBe("what held");
    expect(verdictWord("gaia")).toBe("what bore");
    expect(wordAllowed("drevan", wordUsed("lethe: x"))).toBe(true);
    expect(wordAllowed("drevan", wordUsed("what held: x"))).toBe(false);
    expect(wordAllowed("gaia", wordUsed("verdict: x"))).toBe(true);
    expect(wordAllowed("cypher", wordUsed("What  Held: x"))).toBe(true);
  });
  it("VERDICTS mode: unset and junk are shadow", () => {
    expect(verdictsMode({})).toBe("shadow");
    expect(verdictsMode({ VERDICTS: "junk" })).toBe("shadow");
    expect(verdictsMode({ VERDICTS: "ON" })).toBe("on");
    expect(verdictsMode({ VERDICTS: "off" })).toBe("off");
  });
});

describe("verdict store + evidence counting (step 6)", () => {
  it("writes once, returns on the same line, moves for Cypher with history, never rewrites Drevan", async () => {
    const { db, env } = setup();
    const a = await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "writing", line: "one clean claim per page" });
    expect(a.ok && a.outcome).toBe("written");
    const b = await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "writing", line: "One clean claim per page" });
    expect(b.ok && b.outcome).toBe("returned");
    const c = await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "writing", line: "one claim, then the proof" });
    expect(c.ok && c.outcome).toBe("moved");
    const row = db.prepare("SELECT * FROM companion_verdicts WHERE companion_id = 'cypher'").get() as any;
    expect(row.line).toBe("one claim, then the proof");
    expect(row.evidence).toBe(3);
    expect(JSON.parse(row.history_json).map((h: any) => h.line)).toEqual(["one clean claim per page"]);

    await writeVerdict(env, { companion_id: "drevan", subjectKind: "kind", subjectRaw: "music_code", line: "the hum sinks in" });
    const d = await writeVerdict(env, { companion_id: "drevan", subjectKind: "kind", subjectRaw: "music_code", line: "a different line entirely" });
    expect(d.ok && d.outcome).toBe("returned");
    const dr = db.prepare("SELECT * FROM companion_verdicts WHERE companion_id = 'drevan'").get() as any;
    expect(dr.line).toBe("the hum sinks in");
    expect(dr.evidence).toBe(2);
    expect(JSON.parse(dr.history_json)[0].line).toBe("a different line entirely");
  });
  it("trims to 140, refuses care/health words, Gaia's kind subject, unknown subjects and mode off", async () => {
    const { env } = setup();
    const long = "x".repeat(300);
    const r = await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "page", line: long });
    expect(r.ok && r.row.line.length).toBeLessThanOrEqual(VERDICT_LINE_MAX);
    const care = await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "writing", line: "it helped when I took my medication" });
    expect(care.ok).toBe(false);
    const gk = await writeVerdict(env, { companion_id: "gaia", subjectKind: "kind", subjectRaw: "writing", line: "x" });
    expect(!gk.ok && gk.code).toBe("gaia_makes_nothing");
    const badKind = await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "sculpture", line: "x" });
    expect(!badKind.ok && badKind.code).toBe("bad_input");
    const noInterest = await writeVerdict(env, { companion_id: "cypher", subjectKind: "interest", subjectRaw: "nothing", line: "x" });
    expect(!noInterest.ok && noInterest.code).toBe("missing");
    const noAct = await writeVerdict(env, { companion_id: "cypher", subjectKind: "activity", subjectRaw: "share_observation", line: "x" });
    expect(!noAct.ok && noAct.code).toBe("missing");
    const off = await writeVerdict({ ...env, VERDICTS: "off" }, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "writing", line: "x" });
    expect(!off.ok && off.code).toBe("closed");
  });
  it("interest and activity subjects resolve by name, id prefix and palette move", async () => {
    const { db, env } = setup();
    addAction(db, "cypher", "share_observation", "Share an observation");
    const born = await applyInterestAction(env, { companion_id: "cypher", action: "born", name: "Physarum", why: "it decides without a planner" });
    expect(born.ok).toBe(true);
    const id = (born as any).interest.id as string;
    expect((await writeVerdict(env, { companion_id: "cypher", subjectKind: "interest", subjectRaw: "physarum", line: "it held" })).ok).toBe(true);
    expect((await writeVerdict(env, { companion_id: "cypher", subjectKind: "interest", subjectRaw: id.slice(0, 8), line: "it held" })).ok).toBe(true);
    expect((await writeVerdict(env, { companion_id: "cypher", subjectKind: "activity", subjectRaw: "share observation", line: "plain is better" })).ok).toBe(true);
  });
  it("only the companion writes: a later event on a subject with no verdict creates nothing", async () => {
    const { db, env } = setup();
    expect(await countReturn(env, "cypher", "kind:writing", "make:1")).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM companion_verdicts").get()).toEqual({ n: 0 });
  });
  it("counts each source ref once, and a returned/made interest event is a return (echo carries the line)", async () => {
    const { db, env } = setup();
    await applyInterestAction(env, { companion_id: "drevan", action: "born", name: "adhesives", why: "things that hold" });
    await writeVerdict(env, { companion_id: "drevan", subjectKind: "interest", subjectRaw: "adhesives", line: "holding is a verb" });
    await writeVerdict(env, { companion_id: "drevan", subjectKind: "kind", subjectRaw: "writing", line: "the river keeps it" });
    expect((await countReturn(env, "drevan", "kind:writing", "make:abc"))?.evidence).toBe(2);
    expect((await countReturn(env, "drevan", "kind:writing", "make:abc"))?.evidence).toBe(2); // same make, same ref (landing + heard_back)
    expect((await countReturn(env, "drevan", "kind:writing", "make:def"))?.evidence).toBe(3);
    const back = await applyInterestAction(env, { companion_id: "drevan", action: "returned", name: "adhesives", why: "again" });
    expect(back.ok && back.verdict?.line).toBe("holding is a verb");
    expect((db.prepare("SELECT evidence FROM companion_verdicts WHERE subject LIKE 'interest:%'").get() as any).evidence).toBe(2);
    const put = await applyInterestAction(env, { companion_id: "drevan", action: "put_down", name: "adhesives", why: "done for now" });
    expect(put.ok && put.verdict).toBeUndefined(); // putting down is not a return
    expect(verdictEcho("lethe", "holding is a verb")).toContain("Still true?");
  });
  it("mode off counts nothing", async () => {
    const { env } = setup();
    await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "page", line: "x" });
    expect(await countReturn({ ...env, VERDICTS: "off" }, "cypher", "kind:page", "make:z")).toBeNull();
  });
  it("the Librarian executors answer in the companion's own word and teach the grammar", async () => {
    const { env } = setup();
    const ok = await execVerdictWrite(ctx(env, "drevan", "lethe: kind:writing the river keeps what is true"));
    expect(ok["ack"]).toBe(true);
    expect(String(ok["witness"])).toContain("lethe: kind:writing");
    const wrong = await execVerdictWrite(ctx(env, "drevan", "what held: kind:writing x"));
    expect(wrong["refused"]).toBe(true);
    expect(String(wrong["witness"])).toContain("lethe");
    const noLine = await execVerdictWrite(ctx(env, "cypher", "what held: kind:writing"));
    expect(noLine["refused"]).toBe(true);
    const read = await execVerdictsRead(ctx(env, "drevan", "my lethe"));
    expect((read["data"] as any).word).toBe("lethe");
    expect((read["data"] as any).verdicts).toHaveLength(1);
  });
});

describe("verdicts at orient (step 6)", () => {
  it("shadow shows nothing; on shows at most two, highest evidence first, in their word; care lines skipped at read", async () => {
    const { db, env } = setup();
    for (const [k, n] of [["writing", 1], ["page", 4], ["scad", 2]] as const) {
      await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: k, line: `line about ${k}` });
      for (let i = 0; i < n - 1; i++) await countReturn(env, "cypher", `kind:${k}`, `make:${k}${i}`);
    }
    const shadow = await loadVerdictsBlock({ ...env, VERDICTS: "shadow" }, "cypher");
    expect(shadow.lines).toEqual([]);
    expect(shadow.word).toBe("what held");
    const on = await loadVerdictsBlock(env, "cypher");
    expect(on.lines.map((l) => l.subject)).toEqual(["kind:page", "kind:scad"]);
    expect(on.total).toBe(3);
    const text = verdictsBlock(on);
    expect(text).toContain("[what held (your own lines, counted by return; nothing scores them)]");
    expect(text).toContain("kind: page: \"line about page\" (evidence 4)");
    expect(verdictsBlock(shadow)).toBe("");
    db.prepare("UPDATE companion_verdicts SET line = 'it was my medication that mattered' WHERE subject = 'kind:page'").run();
    const skipped = await loadVerdictsBlock(env, "cypher");
    expect(skipped.lines.map((l) => l.subject)).toEqual(["kind:scad", "kind:writing"]);
    expect(verdictLine(skipped.lines[0]!)).toContain("evidence 2");
  });
  it("Gaia's block uses what bore and never her siblings' rows", async () => {
    const { env } = setup();
    await writeVerdict(env, { companion_id: "cypher", subjectKind: "kind", subjectRaw: "page", line: "his" });
    const g = await loadVerdictsBlock(env, "gaia");
    expect(g.word).toBe("what bore");
    expect(g.lines).toEqual([]);
  });
});

describe("expression_need (step 7)", () => {
  it("is seeded per companion; Gaia's time accrual is exactly zero, Drevan's and Cypher's are not", async () => {
    const { db, env } = setup();
    expect(drive(db, "gaia").accumulate_per_day).toBe(0);
    expect(drive(db, "drevan").accumulate_per_day).toBeGreaterThan(drive(db, "cypher").accumulate_per_day);
    expect(drive(db, "cypher").accumulate_per_day).toBeGreaterThan(0);
    const tenDays = Date.now() + 10 * 86_400_000;
    const g = (await loudestNeeds(env, "gaia", tenDays)).find((n) => n.need === "expression")!;
    const d = (await loudestNeeds(env, "drevan", tenDays)).find((n) => n.need === "expression")!;
    expect(g.level).toBe(0);
    expect(g.fired).toBe(false);
    expect(d.level).toBe(1);
    expect(d.fired).toBe(true);
  });
  it("mode parses off/shadow/on and routes the stimuli through SHADOWABLE", () => {
    expect(expressionMode({})).toBe("shadow");
    expect(expressionMode({ EXPRESSION_NEED: "on" })).toBe("on");
    expect(expressionMode({ EXPRESSION_NEED: "off" })).toBe("off");
    expect(stimulusMode("expression_shed", {})).toBe("shadow");
    expect(stimulusMode("want_marked", { EXPRESSION_NEED: "on" })).toBe("on");
  });
  it("sheds on a put-out thing for Drevan; Gaia sheds by a planting or kept line, never by a make or a coined word", async () => {
    const { db, env } = setup();
    db.prepare("UPDATE companion_drives SET level = 0.9 WHERE drive_key = 'expression_need'").run();
    await fireExpressionShed(env, "drevan", "make");
    expect(drive(db, "drevan").level).toBeLessThan(0.05);
    await fireExpressionShed(env, "gaia", "make");
    await fireExpressionShed(env, "gaia", "coined_word");
    await fireExpressionShed(env, "gaia", "letter");
    expect(drive(db, "gaia").level).toBe(0.9);
    await fireExpressionShed(env, "gaia", "planting");
    expect(drive(db, "gaia").level).toBeLessThan(0.05);
    db.prepare("UPDATE companion_drives SET level = 0.8 WHERE companion_id = 'gaia' AND drive_key = 'expression_need'").run();
    await fireExpressionShed(env, "gaia", "kept_line");
    expect(drive(db, "gaia").level).toBeLessThan(0.05);
    expect(mayShed("gaia", "note")).toBe(false);
    expect(mayShed("cypher", "note")).toBe(true);
  });
  it("a marked want is the only thing that raises Gaia's, capped three a day", async () => {
    const { db, env } = setup();
    expect(drive(db, "gaia").level).toBe(0);
    for (let i = 0; i < 5; i++) await fireWantMarked(env, "gaia");
    const lvl = drive(db, "gaia").level;
    expect(lvl).toBeCloseTo(1.0, 5); // 3 x 0.35 clamped at 1
    const r = await execWantMarked(ctx(env, "gaia", "mark a want: the quiet poem"));
    expect(r["ack"]).toBe(false); // capped
    expect(WANT_MARKED_RE.test("mark a want: x")).toBe(true);
  });
  it("kill switch: shadow writes shadow rows and moves nothing; off skips; both leave Gaia's level alone", async () => {
    const { db, env } = setup({ EXPRESSION_NEED: "shadow" });
    await fireWantMarked(env, "gaia");
    expect(drive(db, "gaia").level).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_ferment_events WHERE companion_id = 'gaia' AND kind = 'shadow' AND stimulus = 'want_marked'").get() as any).n).toBe(1);
    db.prepare("UPDATE companion_drives SET level = 0.9 WHERE companion_id = 'drevan' AND drive_key = 'expression_need'").run();
    await fireExpressionShed(env, "drevan", "make");
    expect(drive(db, "drevan").level).toBe(0.9);
    const off = { ...env, EXPRESSION_NEED: "off" };
    await fireWantMarked(off, "gaia");
    await fireExpressionShed(off, "drevan", "make");
    expect(drive(db, "gaia").level).toBe(0);
    expect(drive(db, "drevan").level).toBe(0.9);
    expect((await loudestNeeds(off, "drevan")).some((n) => n.need === "expression")).toBe(false);
    expect((await loudestNeeds(env, "drevan")).some((n) => n.need === "expression")).toBe(true);
    expect((await execWantMarked(ctx(env, "gaia", "mark a want: x")))["mode"]).toBe("shadow");
    expect((await execWantMarked(ctx(off, "gaia", "mark a want: x")))["mode"]).toBe("off");
  });
  it("never touches a reach-out drive: relational_need and the reach config are untouched by every expression move", async () => {
    const { db, env } = setup();
    const before = drive(db, "drevan", "relational_need");
    await fireWantMarked(env, "drevan");
    await fireExpressionShed(env, "drevan", "make");
    expect(drive(db, "drevan", "relational_need")).toEqual(before);
  });
  it("loudest need sorts by pressure (level over its own threshold)", async () => {
    const { db, env } = setup();
    db.prepare("UPDATE companion_drives SET level = 0, accumulate_per_day = 0, last_event_at = datetime('now') WHERE companion_id = 'drevan'").run();
    db.prepare("UPDATE companion_drives SET level = 0.6 WHERE companion_id = 'drevan' AND drive_key = 'expression_need'").run(); // 0.6 / 0.65
    db.prepare("UPDATE companion_drives SET level = 0.5 WHERE companion_id = 'drevan' AND drive_key = 'novelty_need'").run(); // 0.5 / 0.70
    const needs = await loudestNeeds(env, "drevan");
    expect(needs[0]!.need).toBe("expression");
    expect(needs[1]!.need).toBe("novelty");
  });
});

describe("serves (step 7)", () => {
  it("the row's own value wins, NULL falls back to the type's default, unknown is none", () => {
    expect(servesOf({ action_type: "make", serves: null })).toBe("expression");
    expect(servesOf({ action_type: "make", serves: "novelty" })).toBe("novelty");
    expect(servesOf({ action_type: "nothing" })).toBe("rest");
    expect(servesOf({ action_type: "weird", serves: "junk" })).toBe("none");
  });
  it("the migration backfill matches DEFAULT_SERVES for every seeded row", () => {
    const { db } = setup();
    const rows = db.prepare("SELECT action_type, serves FROM metronome_actions").all() as any[];
    for (const r of rows) if (r.serves) expect(r.serves, r.action_type).toBe(DEFAULT_SERVES[r.action_type]);
    // and a rebuilt/new row with no value is read through the default
    addAction(db, "cypher", "flirt");
    const n = db.prepare("SELECT serves FROM metronome_actions WHERE id = 'a_cypher_flirt'").get() as any;
    expect(n.serves).toBeNull();
    expect(servesOf({ action_type: "flirt", serves: n.serves })).toBe("relational");
  });
  it("the eligible read exposes serves and needs, reading drives and palette only", async () => {
    const { getMindMetronomeEligibleActions } = await import("../handlers/webmind.js");
    const { db, env } = setup();
    addAction(db, "cypher", "make");
    const res = await getMindMetronomeEligibleActions(
      new Request("http://x/mind/metronome/actions/cypher/eligible", { headers: { Authorization: "Bearer s" } }), env, { companion_id: "cypher" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.actions.find((a: any) => a.action_type === "make").serves).toBe("expression");
    expect(Array.isArray(body.needs)).toBe(true);
    expect(body.needs.map((n: any) => n.need)).toContain("expression");
  });
});
