// Interests born from exposure (B65 steps 3-5, mig 0178): the scorer, the exclusions, the grammar, the store.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  birthsMode, tokenise, termsOf, scoreExposures, documentFrequencies, pickCandidate, exclusionSet, excludeReason, stem,
  parseNotMine, sameTerm, offerLine, birthsLogLine, NOT_MINE_RE,
  BIRTHS_MIN_DAYS, BIRTHS_MIN_SOURCES, BIRTHS_FRAME_SHARE, type Exposure,
} from "../webmind/interest-births.js";
import { personRegex } from "../webmind/sol-hoard.js";
import {
  computeInterestBirths, runInterestBirths, pendingOffer, answerCandidate, findOpenCandidateByTerm, exposuresFor,
  getInterestCandidates, postInterestCandidateAnswer, postInterestBirthsRun,
} from "../handlers/interest-births.js";
import { matchFastPath } from "../librarian/router.js";

const NOW = Date.parse("2026-11-10T09:00:00Z"); // 03:00 Chicago (CST)
const daysAgo = (d: number, h = 0): string => new Date(NOW - d * 86_400_000 - h * 3_600_000).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");

function setup(over: Record<string, unknown> = {}) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", CYPHER_MCP_SECRET: "ctok", GAIA_MCP_SECRET: "gtok", INTEREST_BIRTHS: "on", ...over };
  return { db, DB, env };
}

/** Three distinct days, two kinds, about slime mould, for `who`. */
function seedSlime(db: any, who: string, term = "slime mould") {
  db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary, gathered_at) VALUES (?, ?, 'science', ?, ?, ?)")
    .run(`f1${who}`, who, `${term} solves a maze`, `A ${term} finds the shortest path between oat flakes.`, daysAgo(1));
  db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary, gathered_at) VALUES (?, ?, 'science', ?, ?, ?)")
    .run(`f2${who}`, who, `${term} networks`, `Researchers grow a ${term} across a map of Tokyo.`, daysAgo(3));
  db.prepare("INSERT INTO growth_journal (id, companion_id, entry_type, content, source, created_at) VALUES (?, ?, 'insight', ?, 'autonomous', ?)")
    .run(`g1${who}`, who, `I keep coming back to the ${term}: a body with no planner that still decides.`, daysAgo(5));
}

describe("births: mode + tokens", () => {
  it("INTEREST_BIRTHS parses off/shadow/on, junk and unset are on (code default on, Principal 11-09)", () => {
    expect(birthsMode({})).toBe("on");
    expect(birthsMode({ INTEREST_BIRTHS: "junk" })).toBe("on");
    expect(birthsMode({ INTEREST_BIRTHS: "shadow" })).toBe("shadow");
    expect(birthsMode({ INTEREST_BIRTHS: "off" })).toBe("off");
    expect(birthsMode({ INTEREST_BIRTHS: "ON" })).toBe("on");
    expect(birthsMode({ INTEREST_BIRTHS: "live" })).toBe("on");
  });
  it("tokenise drops contractions (straight and curly), urls and punctuation", () => {
    expect(tokenise("It’s the mould's won't don't https://x.y/z, Tokyo-map")).toEqual(["it", "the", "mould", "wo", "do", "tokyo-map"]);
  });
  it("termsOf yields content words and 2..3-word runs, once each, stopwords breaking the run", () => {
    const t = termsOf("the slime mould solves the maze; slime mould again");
    expect(t.has("slime")).toBe(true);
    expect(t.has("slime mould")).toBe(true);
    expect(t.has("slime mould solves")).toBe(true);
    expect(t.has("maze slime")).toBe(true); // ';' is only a boundary; 'again' (stopword) ends the run
    expect(t.has("solves the")).toBe(false);
    expect(t.has("the")).toBe(false);
    expect([...t].filter((x) => x === "slime").length).toBe(1);
  });
  it("report-ese and substrate words are never terms", () => {
    const t = termsOf("Notable concrete detail: Halseth discusses the research of Principal's Hearth");
    expect(t.size).toBe(0);
  });
});

describe("births: scoring", () => {
  const ex: Exposure[] = [
    { ref: "forage:a", text: "slime mould maze", at: daysAgo(0) },
    { ref: "forage:b", text: "slime mould tokyo", at: daysAgo(7) },
    { ref: "growth:c", text: "slime mould and me", at: daysAgo(14) },
    { ref: "growth:c", text: "slime mould and me", at: daysAgo(14) }, // same ref twice: one source
  ];
  it("each row counts once per term, half-life 7 days, days/sources/kinds counted", () => {
    const s = scoreExposures(ex, NOW).get("slime mould")!;
    expect(s.weight).toBeCloseTo(1 + 0.5 + 0.25 + 0.25, 2);
    expect(s.days).toBe(3);
    expect(s.sources).toBe(3);
    expect(s.kinds).toBe(2);
    expect(s.refs).toEqual(["forage:a", "forage:b", "growth:c"]);
  });
  it("rows past the 30-day window and unparseable stamps are ignored", () => {
    const s = scoreExposures([{ ref: "x", text: "old thing", at: daysAgo(31) }, { ref: "y", text: "bad thing", at: "nope" }], NOW);
    expect(s.size).toBe(0);
  });
  it("background: a frame term (in more than 8% of rows) is dropped, the rest are scaled by ln(N/df)", () => {
    const bg: Exposure[] = [];
    for (let i = 0; i < 50; i++) bg.push({ ref: `bg:${i}`, text: i < 10 ? "frame word here" : `unique${i} thing`, at: daysAgo(1) });
    bg.push({ ref: "bg:x", text: "rare mould", at: daysAgo(1) });
    const background = documentFrequencies(bg);
    expect(background.n).toBe(51);
    const s = scoreExposures([{ ref: "f:1", text: "frame word and rare mould", at: daysAgo(0) }], NOW, background);
    expect(s.has("frame")).toBe(false); // 10/51 > BIRTHS_FRAME_SHARE
    expect(BIRTHS_FRAME_SHARE).toBe(0.08);
    expect(s.get("rare")!.weight).toBeCloseTo(Math.log(51 / 1), 2);
    expect(s.get("mould")!.weight).toBeCloseTo(Math.log(51 / 1), 2);
  });
  it("ownHits counts rows that also carry an existing interest's token", () => {
    const s = scoreExposures(ex, NOW, undefined, new Set(["tokyo"]));
    expect(s.get("slime mould")!.ownHits).toBe(1);
    expect(s.get("tokyo")!.ownHits).toBe(1);
  });
});

describe("births: the pick", () => {
  const good = (term: string, over: Partial<{ days: number; sources: number; kinds: number; weight: number; ownHits: number }> = {}) =>
    [term, { term, weight: 3, days: 3, sources: 3, kinds: 2, ownHits: 0, refs: [] as string[], ...over }] as const;
  it("needs 3 days, 2 sources, 2 kinds", () => {
    const m = new Map([good("a", { days: BIRTHS_MIN_DAYS - 1 }), good("b", { sources: BIRTHS_MIN_SOURCES - 1 }), good("c", { kinds: 1 }), good("d")]);
    const p = pickCandidate(m, new Set(), null);
    expect(p.top?.term).toBe("d");
    expect(p.counted.eligible).toBe(1);
  });
  it("heaviest wins; a longer phrase on the top word wins when it carries half the weight", () => {
    const m = new Map([good("slime", { weight: 10 }), good("slime mould", { weight: 6 }), good("other", { weight: 8 })]);
    expect(pickCandidate(m, new Set(), null).top?.term).toBe("slime mould");
    const m2 = new Map([good("slime", { weight: 10 }), good("slime mould", { weight: 4 })]);
    expect(pickCandidate(m2, new Set(), null).top?.term).toBe("slime");
  });
  it("excludes ritual/own words (stemmed), care words, person names, and a term riding an existing interest", () => {
    const excluded = exclusionSet({ companionId: "gaia", interestNames: ["Soil chemistry"], motifs: ["the perimeter"], declined: ["monks"] });
    expect(excludeReason("witnesses", excluded, null)).toBe("ritual_or_own");
    expect(excludeReason("soil", excluded, null)).toBe("ritual_or_own");
    expect(excludeReason("monks", excluded, null)).toBe("ritual_or_own");
    expect(excludeReason("medication", excluded, null)).toBe("care_word");
    expect(excludeReason("personp", excluded, personRegex(["PersonP"]))).toBe("names_a_person");
    expect(excludeReason("granite", excluded, null)).toBeNull();
    expect(stem("witnessing")).toBe("witness");
    expect(stem("studies")).toBe("study");
    const ex2 = exclusionSet({ companionId: "cypher", interestNames: [], motifs: ["structural puzzles and constraint systems"], declined: [] });
    expect(excludeReason("puzzle", ex2, null)).toBe("ritual_or_own"); // the excluded side is stemmed too
    expect(excludeReason("constraints", ex2, null)).toBe("ritual_or_own");
    const m = new Map([good("mould", { ownHits: 2, sources: 3 }), good("granite")]);
    const p = pickCandidate(m, excluded, null);
    expect(p.top?.term).toBe("granite");
    expect(p.counted.excluded.ritual_or_own).toBe(1);
  });
  it("an unreadable person list fails closed: nothing is eligible", () => {
    const p = pickCandidate(new Map([good("granite")]), new Set(), undefined);
    expect(p.top).toBeNull();
    expect(p.counted.excluded.people_unreadable).toBe(1);
  });
  it("log line carries terms and numbers only", () => {
    const p = pickCandidate(new Map([good("granite", { weight: 2.5 })]), new Set(), null);
    expect(birthsLogLine("gaia", "shadow", { exposures: 9, pick: p, outcome: "written", candidateId: "abcdef0123456789" }))
      .toBe("[births] gaia mode=shadow exposures=9 terms=1 eligible=1 excluded=own:0,care:0,person:0,unreadable:0 top=granite@2.50/3d/3s/2k outcome=written candidate=abcdef01");
  });
});

describe("births: grammar", () => {
  it("not mine: <term>[, because <why>]", () => {
    expect(parseNotMine("not mine: slime mould")).toEqual({ term: "slime mould", why: "" });
    expect(parseNotMine("Not mine: slime mould, because that is Cypher's")).toEqual({ term: "slime mould", why: "that is Cypher's" });
    expect(parseNotMine("not mine: \"granite\".")).toEqual({ term: "granite", why: "" });
    expect(parseNotMine("it is not mine")).toBeNull();
    expect(NOT_MINE_RE.test("not mine:")).toBe(false);
  });
  it("sameTerm is loose on case, punctuation and containment", () => {
    expect(sameTerm("Slime Mould", "slime mould")).toBe(true);
    expect(sameTerm("the slime mould", "slime")).toBe(true);
    expect(sameTerm("granite", "slime")).toBe(false);
  });
  it("the offer line names both answers exactly and says silence writes nothing", () => {
    const l = offerLine("slime mould");
    expect(l).toContain("new interest: <your name for it>, because <why>");
    expect(l).toContain("not mine: slime mould");
    expect(l).toContain("nothing is written");
  });
  it("Librarian routes 'not mine:' to interest_not_mine and never ordinary speech", () => {
    expect(matchFastPath("not mine: granite")?.key).toBe("interest_not_mine");
    expect(matchFastPath("that book is not mine, keep it")?.key).not.toBe("interest_not_mine");
  });
});

describe("births: the pass and the store", () => {
  it("exposuresFor: companion rows only; the NULL forage pool, Principal's pitches and other companions' rows stay out", () => {
    const rows = {
      forage: [{ id: "a", companion_id: "cypher", title: "t", summary: "s", at: daysAgo(1) }, { id: "b", companion_id: null, title: "pool", summary: "s", at: daysAgo(1) }],
      media: [{ id: "m", requested_companion: "drevan", title: "song", artist: "x", at: daysAgo(1) }, { id: "n", requested_companion: null, title: "shared", artist: null, at: daysAgo(1) }],
      clubrec: [{ id: "c", recommended_by: "principal", title: "rec", creator: null, pitch: "PRINCIPALWORDS", at: daysAgo(1) }, { id: "d", recommended_by: "cypher", title: "mine", creator: null, pitch: "MYWORDS", at: daysAgo(1) }],
      clubdisc: [{ id: "e", companion_id: "gaia", reflection: "r", at: daysAgo(1) }],
      growth: [{ id: "g", companion_id: "cypher", content: "c", at: daysAgo(1) }],
      books: [{ id: "k", author: "cypher", selected_text: "sel", comment: "com", at: daysAgo(1) }],
    };
    const cy = exposuresFor(rows as any, "cypher");
    expect(cy.map((e) => e.ref)).toEqual(["forage:a", "media:n", "club:c", "club:d", "growth:g", "book_annotation:k"]);
    expect(cy.find((e) => e.ref === "club:c")!.text).not.toContain("PRINCIPALWORDS");
    expect(cy.find((e) => e.ref === "club:d")!.text).toContain("MYWORDS");
    const all = exposuresFor(rows as any, null);
    expect(all.map((e) => e.ref)).toContain("media:m");
    expect(all.map((e) => e.ref)).not.toContain("forage:b");
  });

  it("the pass writes one candidate per companion with refs only, shadow rows in shadow, nothing when dry or off", async () => {
    const { db, env } = setup({ INTEREST_BIRTHS: "shadow" });
    seedSlime(db, "cypher");
    seedSlime(db, "drevan", "peel strength");
    const dry = await computeInterestBirths(env, { dry: true, nowMs: NOW });
    expect(dry.results.find((r) => r.companion_id === "cypher")!.outcome).toBe("dry");
    expect((db.prepare("SELECT COUNT(*) n FROM companion_interest_candidates").get() as any).n).toBe(0);
    const r = await computeInterestBirths(env, { dry: false, nowMs: NOW });
    const cy = r.results.find((x) => x.companion_id === "cypher")!;
    expect(cy.outcome).toBe("written");
    expect(cy.pick.top!.term).toMatch(/slime/);
    expect(r.results.find((x) => x.companion_id === "gaia")!.outcome).toBe("none");
    const rows = db.prepare("SELECT companion_id, term, mode, sources_json FROM companion_interest_candidates ORDER BY companion_id").all() as any[];
    expect(rows.length).toBe(2);
    expect(rows[0].mode).toBe("shadow");
    expect(JSON.parse(rows[0].sources_json).every((s: string) => /^(forage|growth):/.test(s))).toBe(true);
    const off = setup({ INTEREST_BIRTHS: "off" });
    seedSlime(off.db, "cypher");
    const o = await computeInterestBirths(off.env, { dry: false, nowMs: NOW });
    expect(o.results.find((x) => x.companion_id === "cypher")!.outcome).toBe("dry");
  });

  it("the nightly rider is gated: before 02:00 Chicago nothing; after, once per day; off writes no marker", async () => {
    const { db, env } = setup();
    seedSlime(db, "cypher");
    await runInterestBirths(env, Date.parse("2026-11-10T07:30:00Z")); // 01:30 Chicago
    expect((db.prepare("SELECT COUNT(*) n FROM companion_interest_candidates").get() as any).n).toBe(0);
    await runInterestBirths(env, NOW);
    await runInterestBirths(env, NOW + 3_600_000);
    expect((db.prepare("SELECT COUNT(*) n FROM companion_interest_candidates").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) n FROM companion_ferment_events WHERE companion_id='births'").get() as any).n).toBe(1);
    const off = setup({ INTEREST_BIRTHS: "off" });
    await runInterestBirths(off.env, NOW);
    expect((off.db.prepare("SELECT COUNT(*) n FROM companion_ferment_events WHERE companion_id='births'").get() as any).n).toBe(0);
  });

  it("existing interests are not re-offered and a declined term rests 60 days", async () => {
    const { db, env } = setup();
    seedSlime(db, "cypher");
    db.prepare("INSERT INTO companion_interests (id, companion_id, name, why) VALUES ('i1', 'cypher', 'slime mould', 'mine')").run();
    const r = await computeInterestBirths(env, { dry: true, nowMs: NOW });
    expect(r.results.find((x) => x.companion_id === "cypher")!.pick.top?.term ?? "none").not.toMatch(/slime|mould/);
    db.prepare("DELETE FROM companion_interests").run();
    db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode, answer, answered_at) VALUES ('c0', 'cypher', 'slime mould', 1, 3, 3, 2, 'on', 'declined', datetime('now', '-10 days'))").run();
    const r2 = await computeInterestBirths(env, { dry: true, nowMs: NOW });
    expect(r2.results.find((x) => x.companion_id === "cypher")!.pick.top?.term ?? "none").not.toMatch(/slime|mould/);
  });

  it("pendingOffer serves the newest on-mode row once, expires older ones, serves nothing in shadow", async () => {
    const { db, env } = setup();
    const ins = (id: string, c: string, mode: string, ago: string) =>
      db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode, created_at) VALUES (?, ?, ?, 1, 3, 3, 2, ?, datetime('now', ?))").run(id, c, `term ${id}`, mode, ago);
    ins("old", "cypher", "on", "-2 days");
    ins("new", "cypher", "on", "-1 hours");
    ins("sh", "cypher", "shadow", "-1 minutes");
    const first = await pendingOffer(env, "cypher", NOW);
    expect(first?.id).toBe("new");
    expect(first?.offered_at).toBeTruthy();
    expect((db.prepare("SELECT answer FROM companion_interest_candidates WHERE id='old'").get() as any).answer).toBe("expired");
    const again = await pendingOffer(env, "cypher", NOW);
    expect(again?.id).toBe("new");
    expect((db.prepare("SELECT offered_at FROM companion_interest_candidates WHERE id='new'").get() as any).offered_at).toBe(first!.offered_at);
    expect(await pendingOffer({ ...env, INTEREST_BIRTHS: "shadow" }, "cypher", NOW)).toBeNull();
    // past the TTL an unanswered offer expires instead of being served
    const late = await pendingOffer(env, "cypher", NOW + 49 * 3_600_000);
    expect(late).toBeNull();
    expect((db.prepare("SELECT answer FROM companion_interest_candidates WHERE id='new'").get() as any).answer).toBe("expired");
  });

  it("kept = born in their words with born_from exposure:<id>; declined records the line; only the owner, only once", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode) VALUES ('k1', 'cypher', 'slime mould', 1, 3, 3, 2, 'on')").run();
    db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode) VALUES ('d1', 'drevan', 'peel strength', 1, 3, 3, 2, 'on')").run();
    expect((await answerCandidate(env, { id: "k1", companion_id: "drevan", answer: "kept", why: "x" })).ok).toBe(false);
    expect((await answerCandidate(env, { id: "k1", companion_id: "cypher", answer: "kept", why: "" }) as any).code).toBe("bad_input");
    const kept = await answerCandidate(env, { id: "k1", companion_id: "cypher", answer: "kept", name: "Physarum", why: "a body with no planner" });
    expect(kept.ok).toBe(true);
    const i = db.prepare("SELECT name, why, born_from FROM companion_interests WHERE companion_id='cypher'").get() as any;
    expect(i).toMatchObject({ name: "Physarum", why: "a body with no planner", born_from: "exposure:k1" });
    const c = db.prepare("SELECT answer, answer_name, interest_id FROM companion_interest_candidates WHERE id='k1'").get() as any;
    expect(c.answer).toBe("kept");
    expect(c.answer_name).toBe("Physarum");
    expect(c.interest_id).toBeTruthy();
    expect((await answerCandidate(env, { id: "k1", companion_id: "cypher", answer: "declined" }) as any).code).toBe("already_answered");
    expect(await findOpenCandidateByTerm(env, "drevan", "Peel Strength")).toBeNull(); // not offered yet: not theirs to decline
    db.prepare("UPDATE companion_interest_candidates SET offered_at = datetime('now') WHERE id = 'd1'").run();
    const found = await findOpenCandidateByTerm(env, "drevan", "Peel Strength");
    expect(found?.id).toBe("d1");
    const dec = await answerCandidate(env, { id: "d1", companion_id: "drevan", answer: "declined", why: "that one is a verdict, not an interest" });
    expect(dec.ok).toBe(true);
    expect((db.prepare("SELECT answer, why FROM companion_interest_candidates WHERE id='d1'").get() as any)).toMatchObject({ answer: "declined", why: "that one is a verdict, not an interest" });
    expect(await findOpenCandidateByTerm(env, "drevan", "peel strength")).toBeNull();
  });

  it("an interest the companion started mid-offer (Librarian tool) is linked, not refused; same answer twice is ok", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode, offered_at) VALUES ('t1', 'cypher', 'slime networks', 1, 3, 3, 2, 'on', datetime('now'))").run();
    db.prepare("INSERT INTO companion_interests (id, companion_id, name, why) VALUES ('self1', 'cypher', 'Slime networks', 'said it myself')").run();
    const r = await answerCandidate(env, { id: "t1", companion_id: "cypher", answer: "kept", name: "slime networks", why: "they route around damage" });
    expect(r.ok).toBe(true);
    expect((db.prepare("SELECT born_from FROM companion_interests WHERE id='self1'").get() as any).born_from).toBe("exposure:t1");
    expect((db.prepare("SELECT answer, interest_id FROM companion_interest_candidates WHERE id='t1'").get() as any)).toMatchObject({ answer: "kept", interest_id: "self1" });
    expect((await answerCandidate(env, { id: "t1", companion_id: "cypher", answer: "kept", why: "again" })).ok).toBe(true);
    expect((await answerCandidate(env, { id: "t1", companion_id: "cypher", answer: "declined" }) as any).code).toBe("already_answered");
    // an OLD interest by that name is still refused: the word was theirs before the night noticed it
    db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode, offered_at) VALUES ('t2', 'cypher', 'granite', 1, 3, 3, 2, 'on', datetime('now'))").run();
    db.prepare("INSERT INTO companion_interests (id, companion_id, name, why, created_at) VALUES ('old1', 'cypher', 'granite', 'long ago', datetime('now', '-3 days'))").run();
    expect((await answerCandidate(env, { id: "t2", companion_id: "cypher", answer: "kept", why: "x" })).ok).toBe(false);
  });

  it("standing forage topics (searched on 3+ days) are the feeder and never offered", async () => {
    const { db, env } = setup();
    for (let d = 1; d <= 4; d++) {
      db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary, gathered_at) VALUES (?, 'gaia', 'monastic practice and the discipline of restraint', ?, ?, ?)")
        .run(`m${d}`, `Monastic rule ${d}`, "The monastic rule of silence and restraint in the abbey.", daysAgo(d));
    }
    db.prepare("INSERT INTO growth_journal (id, companion_id, entry_type, content, source, created_at) VALUES ('gm', 'gaia', 'insight', 'The monastic rule holds restraint in the abbey.', 'autonomous', ?)").run(daysAgo(2));
    const r = await computeInterestBirths(env, { dry: true, nowMs: NOW });
    const g = r.results.find((x) => x.companion_id === "gaia")!;
    expect(g.pick.ranked.map((s) => s.term).some((t) => /monastic|restraint|practice|discipline/.test(t))).toBe(false);
    expect(g.pick.ranked.map((s) => s.term)).toContain("abbey");
    await computeInterestBirths(env, { dry: false, nowMs: NOW });
    expect((db.prepare("SELECT mode FROM companion_interest_candidates WHERE companion_id='gaia'").get() as any).mode).toBe("shadow"); // never asked
  });

  it("a new interest named for care or health is refused at birth (category only)", async () => {
    const { env } = setup();
    const { applyInterestAction } = await import("../handlers/interests.js");
    const r = await applyInterestAction(env, { companion_id: "cypher", action: "born", name: "medication schedules", why: "x" } as any);
    expect(r.ok).toBe(false);
    expect((r as any).message).not.toContain("medication");
    expect((await applyInterestAction(env, { companion_id: "cypher", action: "born", name: "tide pools", why: "x" } as any)).ok).toBe(true);
  });

  it("HTTP: own token reads and answers its own rows; another companion's token is 403; run is admin only", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO companion_interest_candidates (id, companion_id, term, weight, days, sources, kinds, mode) VALUES ('h1', 'cypher', 'granite', 1, 3, 3, 2, 'on')").run();
    const req = (url: string, token: string, init: RequestInit = {}) => new Request(`https://h.test${url}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
    const list = await getInterestCandidates(req("/mind/interest-candidates/cypher", "ctok"), env, { companion_id: "cypher" });
    expect(list.status).toBe(200);
    expect(((await list.json()) as any).candidates[0].term).toBe("granite");
    expect((await getInterestCandidates(req("/mind/interest-candidates/cypher", "dtok"), env, { companion_id: "cypher" })).status).toBe(403);
    const pend = await getInterestCandidates(req("/mind/interest-candidates/cypher?pending=1", "s"), env, { companion_id: "cypher" });
    expect(((await pend.json()) as any).candidate.id).toBe("h1");
    const bad = await postInterestCandidateAnswer(req("/mind/interest-candidates/h1/answer", "dtok", { method: "POST", body: JSON.stringify({ answer: "declined" }) }), env, { id: "h1" });
    expect(bad.status).toBe(403);
    const ok = await postInterestCandidateAnswer(req("/mind/interest-candidates/h1/answer", "s", { method: "POST", body: JSON.stringify({ companion_id: "cypher", answer: "kept", why: "it holds" }) }), env, { id: "h1" });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).interest.name).toBe("granite");
    expect((await postInterestBirthsRun(req("/mind/interest-births/run?dry=1", "ctok", { method: "POST" }), env)).status).toBe(403);
    const run = await postInterestBirthsRun(req("/mind/interest-births/run?dry=1", "s", { method: "POST" }), env);
    expect(run.status).toBe(200);
    expect(((await run.json()) as any).dry).toBe(true);
  });
});
