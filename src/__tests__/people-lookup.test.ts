// People PULL path (2026-11-02): `who is <name>` reads Principal's note on a person on his list.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { addPerson } from "../graph/people.js";
import { addKeepOff } from "../graph/keep-off.js";
import { lookupPerson, parsePersonLookup, personLookupApplies, PERSON_LOOKUP_RE } from "../people/lookup.js";
import { execPersonWhoIs } from "../librarian/executors/people.js";
import { matchFastPath, ANCHORED_GUARDS } from "../librarian/router.js";
import {
  INTEREST_BORN_RE, INTEREST_RETURN_RE, INTEREST_MADE_RE, INTEREST_PUT_DOWN_RE, INTEREST_PICK_UP_RE,
  INTERESTS_READ_RE, INTEREST_TRAIL_RE,
} from "../webmind/interests.js";

const NOTE = "  Spouse is my person.\n  She said \"call me at 2am\"  and I   meant it. Spaces   stay.  ";

async function world() {
  const { db, DB } = makeSqliteD1();
  const env = { DB, ADMIN_SECRET: "s" } as any;
  await addPerson(env, { label: "Spouse", match_names: ["Spouse Jay"], kind: "person", relation: "partner", frame_line: "Principal's person", note: NOTE, added_by: "principal" });
  await addPerson(env, { label: "MemberF", match_names: ["Spouse's MemberF", "MemberF"], shares_name_with: "Pirates of the Caribbean", kind: "person", relation: "friend", note: "the introject", added_by: "principal" });
  await addPerson(env, { label: "MemberA", kind: "self", note: "private system note", added_by: "principal" });
  await addPerson(env, { label: "MemberM", kind: "person", note: "MemberM takes her medication at night", added_by: "principal" });
  await addPerson(env, { label: "MemberD", kind: "person", note: "MemberD is nice", added_by: "principal" });
  return { db, env };
}
const ask = (env: any, req: string) =>
  execPersonWhoIs({ env, req: { companion_id: "cypher", request: req }, entry: {} as any, frontState: null, pluralAvailable: true });

describe("parsePersonLookup", () => {
  it("reads the four grammars, strips ?/. and whitespace", () => {
    expect(parsePersonLookup("who is  Spouse ?")).toEqual({ name: "Spouse", verb: "who" });
    expect(parsePersonLookup("Who's Spouse.")).toEqual({ name: "Spouse", verb: "who" });
    expect(parsePersonLookup("look up person   Spouse Jay")).toEqual({ name: "Spouse Jay", verb: "who" });
    expect(parsePersonLookup("tell me about Spouse?")).toEqual({ name: "Spouse", verb: "tell" });
  });
  it("is start-anchored and name-shaped", () => {
    expect(parsePersonLookup("i wonder who is Spouse")).toBeNull();
    expect(parsePersonLookup("who is " + "x".repeat(70))).toBeNull();
  });
  it("leaves front state and plural search alone", () => {
    for (const r of ["who is fronting", "who's fronting?", "who is currently fronting", "who's here", "who's been fronting", "look up member Spouse", "look up Spouse", "who is in the system"]) {
      const m = matchFastPath(r)!;
      if (r === "who is in the system") expect(m.key).toBe("person_who_is"); // candidate only; the list check decides
      else expect(m?.key, r).not.toBe("person_who_is");
    }
    expect(matchFastPath("who is fronting")!.key).not.toBe("roster_who_is");
    expect(matchFastPath("look up member Spouse")!.key).toBe("search_members");
  });
});

describe("lookupPerson resolution", () => {
  it("resolves by label, spelling and case, with whitespace normalised", async () => {
    const { env } = await world();
    for (const n of ["Spouse", "spouse", "  SPOUSE  ", "spouse jay", "Spouse   Jay"]) {
      const r = await lookupPerson(env, n);
      expect(r.status, n).toBe("found");
      if (r.status === "found") expect(r.person.label).toBe("Spouse");
    }
  });
  it("unknown names are none, and fall through to the old route", async () => {
    const { env } = await world();
    expect((await lookupPerson(env, "MemberH")).status).toBe("none");
    expect(await personLookupApplies(env, "tell me about the weather")).toBe(false);
    expect(await personLookupApplies(env, "who is fronting")).toBe(false);
    expect(await personLookupApplies(env, "who is MemberH")).toBe(false);
    expect(await personLookupApplies(env, "who is Spouse")).toBe(true);
    // with the guard skipped, the pre-existing handler answers
    expect(matchFastPath("who is MemberH", new Set(["person_who_is"]))!.key).toBe("roster_who_is");
    expect(matchFastPath("who is fronting", new Set(["person_who_is"]))!.key).not.toBe("person_who_is");
  });
  it("archived rows never resolve", async () => {
    const { env, db } = await world();
    db.exec("UPDATE graph_people SET archived = 1 WHERE label = 'MemberD'");
    expect((await lookupPerson(env, "MemberD")).status).toBe("none");
  });
  it("a shared name: the person's own spelling answers and says so; bare answers only for who-forms", async () => {
    const { env } = await world();
    const own = await lookupPerson(env, "Spouse's MemberF");
    expect(own.status === "found" && own.person.shares_name_with).toBe("Pirates of the Caribbean");
    const out: any = (await ask(env, "who is Spouse's MemberF")).data;
    expect(out.name_caution).toMatch(/also Pirates of the Caribbean; the film\/book character is not them/);
    // "MemberF" is a listed spelling too (it is in match_names): a spelling of its own, not bare.
    expect((await lookupPerson(env, "MemberF", "who")).status).toBe("found");
    const bare: any = (await ask(env, "who is MemberF")).data;
    expect(bare.name_caution).toMatch(/bare name/);
    expect((await lookupPerson(env, "MemberF", "tell")).status).toBe("none");
    expect(await personLookupApplies(env, "tell me about MemberF")).toBe(false);
  });
});

describe("response", () => {
  it("carries Principal's note verbatim (outer whitespace trimmed only), labelled", async () => {
    const { env } = await world();
    const res: any = await ask(env, "who is Spouse?");
    expect(res.response_key).toBe("data");
    expect(res.data.note).toBe(NOTE.trim());
    expect(res.data.note_label).toBe("Principal's note (written by Principal about this person)");
    expect(res.data.label).toBe("Spouse");
    expect(res.data.kind).toBe("person");
    expect(res.data.relation).toBe("partner");
    expect(res.data.frame_line).toBe("Spouse, Principal's partner. Principal's person");
    expect(res.data.spellings).toEqual(["Spouse", "Spouse Jay"]);
    expect(res.data.mentions).toBe(0);
  });
  it("centre and self answer 'is Principal' with no note", async () => {
    const { env } = await world();
    for (const [q, label] of [["who is Principal", "Principal"], ["who's Crash", "Principal"], ["who is MemberA", "MemberA"]] as const) {
      const res: any = await ask(env, q);
      expect(res.data.is_principal).toBe(true);
      expect(res.data.answer).toContain("is Principal");
      expect(res.data.label).toBe(label);
      expect(res.data.note).toBeUndefined();
      expect(JSON.stringify(res)).not.toContain("private system note");
    }
    expect(((await ask(env, "who is MemberA")).data as any).answer).toBe("MemberA is Principal (one of Principal's names)");
  });
  it("withholds a note that touches care words, with a category and never the term", async () => {
    const { env } = await world();
    const res: any = await ask(env, "who is MemberM");
    expect(res.data.note).toBeNull();
    expect(res.data.note_withheld).toMatch(/medicine words/);
    expect(JSON.stringify(res)).not.toMatch(/medication/i);
  });
  it("touches no care or biometric table", async () => {
    const { env } = await world();
    const seen: string[] = [];
    const spy = { ...env, DB: { prepare: (sql: string) => { seen.push(sql); return env.DB.prepare(sql); } } };
    await ask(spy, "who is Spouse");
    for (const sql of seen) expect(sql).not.toMatch(/care_actions|med_|biometric|care_escalations/i);
  });
});

describe("keep-off fails closed", () => {
  it("a kept-off label, spelling or owner answers nothing", async () => {
    const { env } = await world();
    await addKeepOff(env, { term: "MemberD", by: "principal" });
    expect((await lookupPerson(env, "MemberD")).status).toBe("none");
    expect(await personLookupApplies(env, "who is MemberD")).toBe(false);
    expect(((await ask(env, "who is MemberD")) as any).witness).toMatch(/nobody by that name/);
    await addKeepOff(env, { term: "Spouse Jay", by: "principal" });
    expect((await lookupPerson(env, "Spouse")).status).toBe("none"); // one of Spouse's spellings is kept off
  });
  it("a kept-off term in the note withholds the note, not the person", async () => {
    const { env } = await world();
    await addKeepOff(env, { term: "2am", by: "principal" });
    const res: any = await ask(env, "who is Spouse");
    expect(res.data.note).toBeNull();
    expect(res.data.note_withheld).toMatch(/keep-off/);
    expect(res.data.label).toBe("Spouse");
  });
  it("an unreadable keep-off list answers nothing about anyone", async () => {
    const { env } = await world();
    const broken = { ...env, DB: { prepare: (sql: string) => { if (/map_keep_off/.test(sql)) throw new Error("boom"); return env.DB.prepare(sql); } } };
    expect((await lookupPerson(broken, "Spouse")).status).toBe("none");
    expect(await personLookupApplies(broken, "who is Spouse")).toBe(false);
    expect((await lookupPerson(broken, "Principal")).status).toBe("none");
  });
});

describe("routing order against the interest guards (B62)", () => {
  const interestRes = [INTEREST_BORN_RE, INTEREST_RETURN_RE, INTEREST_MADE_RE, INTEREST_PUT_DOWN_RE, INTEREST_PICK_UP_RE, INTERESTS_READ_RE, INTEREST_TRAIL_RE];
  const keyOf = (re: RegExp) => ANCHORED_GUARDS.find((g) => g.regex === re)!.pattern_key;
  it("the who-is guard is its own row, after the interest guards", () => {
    const rows = ANCHORED_GUARDS.map((g) => g.pattern_key);
    expect(rows.filter((k) => k === "person_who_is")).toHaveLength(1);
    expect(rows.indexOf("person_who_is")).toBeGreaterThan(Math.max(...interestRes.map((re) => rows.indexOf(keyOf(re)))));
  });
  it("no interest guard captures a lookup", () => {
    for (const q of ["who is Spouse", "who's Spouse", "look up person Spouse", "tell me about Spouse", "who is fronting"]) {
      for (const re of interestRes) expect(re.test(q), `${q} vs ${re}`).toBe(false);
    }
  });
  it("the lookup guard captures no interest line", () => {
    for (const q of ["new interest: moths, because they glow", "back to moths because they are back", "putting down moths because done",
      "picking moths back up because they returned", "my interests", "list my interests", "interest trail moths"]) {
      expect(PERSON_LOOKUP_RE.test(q), q).toBe(false);
    }
  });
  it("interest lines still route to their own keys", () => {
    expect(matchFastPath("new interest: moths, because they glow")!.key).toBe("interest_born");
    expect(matchFastPath("my interests")!.key).toBe("interests_read");
    expect(matchFastPath("interest trail moths")!.key).toBe("interest_trail");
  });
  it("a lookup routes to the people verb by the anchored guard", () => {
    for (const q of ["who is Spouse", "who's Spouse?", "look up person Spouse", "tell me about Spouse", "Please who is Spouse"]) {
      expect(matchFastPath(q)!.key, q).toBe("person_who_is");
    }
  });
});

describe("note is editable on update", () => {
  const post = async (env: any, id: string, body: unknown) => {
    const { postMindPersonUpdate } = await import("../handlers/people.js");
    const res = await postMindPersonUpdate(new Request("https://x/mind/people/" + id, { method: "POST", headers: { Authorization: "Bearer s" }, body: JSON.stringify(body) }), env, { id });
    return { status: res.status, body: (await res.json()) as any };
  };
  const idOf = (db: any, label: string) => (db.prepare("SELECT id FROM graph_people WHERE label = ?").get(label) as any).id as string;
  const noteOf = (db: any, label: string) => (db.prepare("SELECT note FROM graph_people WHERE label = ?").get(label) as any).note as string | null;

  it("updates (trimmed, verbatim inside), returns it, and the lookup reads it", async () => {
    const { env, db } = await world();
    const r = await post(env, idOf(db, "MemberD"), { note: "  new  words\nhere  " });
    expect(r.status).toBe(200);
    expect(r.body.person.note).toBe("new  words\nhere");
    expect(noteOf(db, "MemberD")).toBe("new  words\nhere");
    expect(((await ask(env, "who is MemberD")).data as any).note).toBe("new  words\nhere");
  });
  it("clears on null, empty and whitespace", async () => {
    for (const v of [null, "", "   "]) {
      const { env, db } = await world();
      const r = await post(env, idOf(db, "MemberD"), { note: v });
      expect(r.status).toBe(200);
      expect(r.body.person.note).toBeNull();
      expect(noteOf(db, "MemberD")).toBeNull();
    }
  });
  it("omitted note is unchanged, also when other fields change", async () => {
    const { env, db } = await world();
    const r = await post(env, idOf(db, "MemberD"), { match_names: ["MemberD"] });
    expect(r.body.person.note).toBe("MemberD is nice");
    const r2 = await post(env, idOf(db, "MemberD"), { relation: "friend" });
    expect(r2.status).toBe(200);
    expect(noteOf(db, "MemberD")).toBe("MemberD is nice");
    // a non-string, non-null note is ignored, not coerced
    await post(env, idOf(db, "MemberD"), { note: 5 });
    expect(noteOf(db, "MemberD")).toBe("MemberD is nice");
  });
  it("note rides along with an extras change", async () => {
    const { env, db } = await world();
    const r = await post(env, idOf(db, "MemberD"), { relation: "friend", note: "both" });
    expect(r.status).toBe(200);
    expect(noteOf(db, "MemberD")).toBe("both");
  });
  it("refuses over the cap, on update and on add, and changes nothing", async () => {
    const { env, db } = await world();
    const r = await post(env, idOf(db, "MemberD"), { note: "x".repeat(1001) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/at most 1000/);
    expect(noteOf(db, "MemberD")).toBe("MemberD is nice");
    expect((await post(env, idOf(db, "MemberD"), { note: "x".repeat(1000) })).status).toBe(200);
    const add = await addPerson(env, { label: "MemberI", note: "y".repeat(1001), added_by: "principal" });
    expect(add.ok).toBe(false);
  });
});
