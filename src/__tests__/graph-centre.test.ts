// One centre (mig 0150, Principal 2026-10-29): Principal (also Crash) is a single node; system names are
// Principal fronting, never separate people; the centre links from rows ABOUT Principal, not every mention.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { rebuildGraphDetailed } from "../graph/rebuild.js";
import { addPerson, archivePerson, CENTRE_ID, listPeople } from "../graph/people.js";
import { neighborhoodBlock } from "../librarian/response/orient-blocks.js";
import { isLabeledTable } from "../graph/labels.js";
import { getMindPeople } from "../handlers/people.js";

const at = "2026-10-20T00:00:00Z";
function envWith() {
  const { db, DB } = makeSqliteD1();
  // mig 0040 seeds boot-continuity stances toward Principal; each test states its own rows.
  db.prepare("DELETE FROM companion_relational_state").run();
  return { db, env: { DB, ADMIN_SECRET: "s" } as any };
}
const peopleEdges = (db: any) =>
  db.prepare("SELECT src_table, src_id, dst_id, edge_type, provenance FROM graph_edges WHERE dst_table = 'graph_people' ORDER BY src_table, src_id").all();

describe("the centre", () => {
  it("exists once, first on the list, and cannot be archived", async () => {
    const { env } = envWith();
    const people = await listPeople(env);
    expect(people[0]).toMatchObject({ id: CENTRE_ID, label: "Principal", kind: "centre", match_names: ["Crash"] });
    expect(await archivePerson(env, CENTRE_ID)).toBe(false);
    expect((await addPerson(env, { label: "Crash", added_by: "principal" })).ok).toBe(false);
  });

  it("is never linked by Principal's own names", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'Principal and Crash both laughed', ?)").run(at);
    await rebuildGraphDetailed(env);
    expect(peopleEdges(db)).toEqual([]);
  });

  it("links from active facts and from stances toward Principal or Crash, by whoever holds them", async () => {
    const { db, env } = envWith();
    db.prepare("INSERT INTO architect_facts (id, fact, category, status, companion_id, created_at, updated_at) VALUES ('f1', 'PDA: show the board', 'how', 'active', 'drevan', ?, ?), ('f2', 'old fact', 'how', 'retired', 'cypher', ?, ?)").run(at, at, at, at);
    db.prepare("INSERT INTO companion_relational_state (id, companion_id, toward, state_text, noted_at) VALUES ('r1', 'gaia', 'Crash', 'steady', ?), ('r2', 'gaia', 'sol', 'fond', ?)").run(at, at);
    await rebuildGraphDetailed(env);
    expect(peopleEdges(db)).toEqual([
      { src_table: "architect_facts", src_id: "f1", dst_id: CENTRE_ID, edge_type: "about", provenance: "mechanical" },
      { src_table: "companion_relational_state", src_id: "r1", dst_id: CENTRE_ID, edge_type: "toward", provenance: "mechanical" },
    ]);
  });
});

describe("system names are Principal", () => {
  it("a self name links to the centre with the front kept, never to a node of its own", async () => {
    const { db, env } = envWith();
    await addPerson(env, { label: "MemberA", match_names: ["MemberA M."], kind: "self", added_by: "principal" });
    await addPerson(env, { label: "MemberL", kind: "headmate", added_by: "principal" }); // 0149's word, read as self
    await addPerson(env, { label: "Spouse", kind: "person", added_by: "principal" });
    db.prepare("INSERT INTO companion_journal (id, agent, note_text, created_at) VALUES ('j1', 'drevan', 'MemberA and MemberL on the couch with Spouse', ?), ('j2', 'gaia', 'MemberA M. fronted', ?)").run(at, at);
    await rebuildGraphDetailed(env);
    const spouse = (await listPeople(env)).find((p) => p.label === "Spouse")!;
    expect(peopleEdges(db)).toEqual([
      { src_table: "companion_journal", src_id: "j1", dst_id: spouse.id, edge_type: "mentions", provenance: "mechanical:person" },
      { src_table: "companion_journal", src_id: "j1", dst_id: CENTRE_ID, edge_type: "mentions", provenance: "mechanical:front:MemberA,MemberL" },
      { src_table: "companion_journal", src_id: "j2", dst_id: CENTRE_ID, edge_type: "mentions", provenance: "mechanical:front:MemberA" },
    ]);

    const list: any = await (await getMindPeople(new Request("https://x/mind/people", { headers: { Authorization: "Bearer s" } }), env)).json();
    const by = Object.fromEntries(list.people.map((p: any) => [p.label, p.mentions]));
    expect(by).toEqual({ Principal: 2, Spouse: 1, MemberL: 1, MemberA: 2 });
  });

  it("the boot says it in words a literal model cannot misread", () => {
    const out = neighborhoodBlock([{
      src_table: "companion_journal", src_id: "j1", dst_table: "graph_people", dst_id: CENTRE_ID,
      edge_type: "mentions", writer: "drevan", provenance: "mechanical:front:MemberA", created_at: "2026-09-24T00:00:00Z", hop: 1,
    }], {
      seeds: ["companion_journal/j1"],
      nodes: new Map([["companion_journal/j1", { label: "couch night" }], [`graph_people/${CENTRE_ID}`, { label: "Principal" }]]),
      isLabeledTable,
    });
    expect(out).toBe('\n[Linked]\n• "couch night" -- with Principal, fronting as MemberA (drevan 09-24)');
    expect(out).not.toMatch(/mentions:? MemberA/);
  });
});
