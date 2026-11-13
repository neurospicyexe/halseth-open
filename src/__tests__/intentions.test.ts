// Dated intentions (mig 0179, STATUS R22). Real schema via node:sqlite for the D1 halves; the grammar,
// the day parser and the renderers are pure.
import { describe, it, expect, vi } from "vitest";

// Each D1 test builds the full schema (every migration) in memory; the loops build several.
vi.setConfig({ testTimeout: 60_000 });
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  parseWhen, parseIntention, chicagoMidnightIso, setIntention, completeIntention, dropIntention,
  listIntentions, readDueIntention, dueInDays, dueLabel, intentionsMode, DUE_INTENTION_SQL,
  INTENTION_SET_RE,
} from "../webmind/intentions.js";
import { logProject, getDueIntention, postProjectLog } from "../handlers/projects.js";
import { execIntentionSet, execIntentionDone, execIntentionDrop, execIntentionsRead } from "../librarian/executors/projects.js";
import { matchFastPath } from "../librarian/router.js";
import { HEALTH_TABLES } from "../director/supply-query.js";
import { loadGrowthBlocks, decorateProject } from "../mind/blocks/growth.js";
import { projectsBlock, PROJECT_AFFORDANCE } from "../librarian/response/orient-blocks.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import { CONTRACT_CHANGELOG } from "../mind/changelog.js";

// Wednesday 2026-11-11, 15:00 Chicago (CST, UTC-6).
const NOW = Date.parse("2026-11-11T21:00:00.000Z");

function envOf(mode?: string, upTo?: number) {
  const { db, DB } = makeSqliteD1(upTo === undefined ? {} : { upTo });
  const env: any = { DB, ADMIN_SECRET: "admin", MCP_AUTH_SECRET: "m", INTENTIONS: mode };
  return { db, env };
}
const ctx = (env: any, companion_id: string, request: string, context?: unknown) =>
  ({ env, req: { companion_id, request, context: context === undefined ? undefined : JSON.stringify(context) } }) as any;

describe("parseWhen (America/Chicago days)", () => {
  it("today / tomorrow / weekday strictly ahead / next week / weekend", () => {
    expect(parseWhen("today", NOW)?.date).toBe("2026-11-11");
    expect(parseWhen("tomorrow", NOW)?.date).toBe("2026-11-12");
    expect(parseWhen("Thursday", NOW)?.date).toBe("2026-11-12");
    expect(parseWhen("wednesday", NOW)?.date).toBe("2026-11-18"); // today is Wednesday: the next one
    expect(parseWhen("next friday", NOW)?.date).toBe("2026-11-13");
    expect(parseWhen("next week", NOW)?.date).toBe("2026-11-18");
    expect(parseWhen("this weekend", NOW)?.date).toBe("2026-11-14");
  });
  it("in N days/weeks, ISO dates, month-day (rolls to next year when past)", () => {
    expect(parseWhen("in 3 days", NOW)?.date).toBe("2026-11-14");
    expect(parseWhen("in two weeks", NOW)?.date).toBe("2026-11-25");
    expect(parseWhen("2026-12-01", NOW)?.date).toBe("2026-12-01");
    expect(parseWhen("Nov 14", NOW)?.date).toBe("2026-11-14");
    expect(parseWhen("March 3rd", NOW)?.date).toBe("2027-03-03");
  });
  it("a past date or a non-day is null", () => {
    expect(parseWhen("2026-11-01", NOW)).toBeNull();
    expect(parseWhen("whenever", NOW)).toBeNull();
    expect(parseWhen("", NOW)).toBeNull();
  });
  it("due_at is 00:00 Chicago on both sides of DST", () => {
    expect(chicagoMidnightIso("2026-11-12")).toBe("2026-11-12T06:00:00.000Z"); // CST
    expect(chicagoMidnightIso("2026-07-01")).toBe("2026-07-01T05:00:00.000Z"); // CDT
    expect(parseWhen("tomorrow", NOW)?.due_at).toBe("2026-11-12T06:00:00.000Z");
  });
  it("dueInDays and dueLabel", () => {
    expect(dueInDays("2026-11-12T06:00:00.000Z", NOW)).toBe(1);
    expect(dueInDays("2026-11-11T06:00:00.000Z", NOW)).toBe(0);
    expect(dueInDays("2026-11-08T06:00:00.000Z", NOW)).toBe(-3);
    expect(dueLabel("2026-11-12T06:00:00.000Z", NOW)).toBe("in 1d (Thu, Nov 12)");
    expect(dueLabel("2026-11-11T06:00:00.000Z", NOW)).toMatch(/^due today/);
    expect(dueLabel("2026-11-08T06:00:00.000Z", NOW)).toMatch(/^due since 3d/);
  });
});

describe("parseIntention grammar", () => {
  it("intend: <what> by <day> -- <next step>", () => {
    const p = parseIntention("intend: the bone map by Friday -- the jaw joint", NOW)!;
    expect(p.what).toBe("the bone map");
    expect(p.when.date).toBe("2026-11-13");
    expect(p.next_step).toBe("the jaw joint");
  });
  it("I'll come back to <what> on <day>: <next step>, splitting at the LAST day phrase", () => {
    const p = parseIntention("I'll come back to the house by the river on Thursday: the cellar stairs", NOW)!;
    expect(p.what).toBe("the house by the river");
    expect(p.when.date).toBe("2026-11-12");
    expect(p.next_step).toBe("the cellar stairs");
  });
  it("bare tail day and 'in N days'", () => {
    expect(parseIntention("come back to tide tables tomorrow", NOW)?.what).toBe("tide tables");
    const p = parseIntention("intend: rook calls in 3 days", NOW)!;
    expect(p.what).toBe("rook calls");
    expect(p.when.date).toBe("2026-11-14");
  });
  it("no day = null", () => {
    expect(parseIntention("intend: the bone map", NOW)).toBeNull();
    expect(parseIntention("I'll come back to that", NOW)).toBeNull();
  });
});

describe("routing (anchored ahead of project triggers)", () => {
  it("intend: routes to intention_set even when the words contain a project trigger", () => {
    expect(matchFastPath("intend: finish project notes by Friday")?.key).toBe("intention_set");
    expect(matchFastPath("I'll come back to the bone map on Thursday")?.key).toBe("intention_set");
    expect(matchFastPath("intention done abc123: did the jaw")?.key).toBe("intention_done");
    expect(matchFastPath("drop intention abc123")?.key).toBe("intention_drop");
    expect(matchFastPath("my intentions")?.key).toBe("intentions_read");
  });
  it("'come back to' with no day is ordinary speech, not an intention", () => {
    expect(INTENTION_SET_RE.test("I'll come back to that")).toBe(false);
    expect(matchFastPath("I'll come back to that")?.key).not.toBe("intention_set");
  });
});

describe("the care guard (HEALTH_TABLES + careCategory)", () => {
  it("the worker's due read touches no health table", () => {
    for (const t of HEALTH_TABLES) expect(DUE_INTENTION_SQL).not.toContain(t);
  });
  it("an intention about meds/health is refused at write, by category only", async () => {
    const { env } = envOf("on");
    const r = await setIntention(env, "drevan", parseIntention("intend: check the meds schedule by Friday", NOW)!);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("care");
      expect(r.message).not.toContain("meds");
    }
  });
  it("a care word that reached the row anyway is skipped at the worker's read", async () => {
    const { db, env } = envOf("on");
    db.prepare("INSERT INTO companion_projects (id, companion_id, title, intention, status, created_at, due_at) VALUES ('p1','cypher','pill sorter','x','open','2026-11-01T00:00:00Z','2026-11-10T06:00:00.000Z')").run();
    const { due, guarded } = await readDueIntention(env, "cypher", NOW);
    expect(due).toBeNull();
    expect(guarded).toBe(1);
  });
});

describe("set / complete / drop (owner only, real schema)", () => {
  it("a new thing opens a held project with the date; an existing title gets the date", async () => {
    const { db, env } = envOf("on");
    const r = await setIntention(env, "drevan", parseIntention("intend: the bone map by Friday -- the jaw joint", NOW)!);
    expect(r.ok && r.created).toBe(true);
    const row = db.prepare("SELECT * FROM companion_projects WHERE companion_id = 'drevan'").get() as any;
    expect(row.title).toBe("the bone map");
    expect(row.due_at).toBe("2026-11-13T06:00:00.000Z");
    expect(row.next_step).toBe("the jaw joint");
    expect(row.status).toBe("open");

    const again = await setIntention(env, "drevan", parseIntention("I'll come back to The Bone Map next week", NOW)!);
    expect(again.ok && !again.created).toBe(true);
    const moved = db.prepare("SELECT due_at, next_step FROM companion_projects WHERE id = ?").get(row.id) as any;
    expect(moved.due_at).toBe("2026-11-18T06:00:00.000Z");
    expect(moved.next_step).toBe("the jaw joint"); // kept when the move names none
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_projects").get() as any).n).toBe(1);
  });

  it("the open-project rail applies to NEW projects only, and the refusal says how to date an existing one", async () => {
    const { env } = envOf("on");
    await setIntention(env, "cypher", parseIntention("intend: one by Friday", NOW)!);
    await setIntention(env, "cypher", parseIntention("intend: two by Friday", NOW)!);
    await setIntention(env, "cypher", parseIntention("intend: three by Friday", NOW)!);
    await setIntention(env, "cypher", parseIntention("intend: four by Friday", NOW)!);
    const fifth = await setIntention(env, "cypher", parseIntention("intend: five by Friday", NOW)!);
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) {
      expect(fifth.code).toBe("limit");
      expect(fifth.message).toContain("come back to <title> on <day>");
      expect(fifth.message).toContain("4 open projects");
    }
    const dated = await setIntention(env, "cypher", parseIntention("I'll come back to two on Saturday", NOW)!);
    expect(dated.ok).toBe(true);
  });

  it("a sibling cannot date, complete or drop another's project", async () => {
    const { env } = envOf("on");
    const r = await setIntention(env, "drevan", parseIntention("intend: the bone map by Friday", NOW)!);
    if (!r.ok) throw new Error("setup");
    expect((await completeIntention(env, "cypher", r.id, null)).ok).toBe(false);
    expect((await dropIntention(env, "gaia", r.id)).ok).toBe(false);
    // Cypher naming the same title opens HIS OWN project; Drevan's date is untouched.
    const cy = await setIntention(env, "cypher", parseIntention("intend: the bone map by Saturday", NOW)!);
    expect(cy.ok && cy.created).toBe(true);
    expect((await listIntentions(env, "drevan"))[0]!.due_at).toBe("2026-11-13T06:00:00.000Z");
  });

  it("intention done closes the date, stamps last_pursued_at, logs the note; drop clears date and next step", async () => {
    const { db, env } = envOf("on");
    const a = await setIntention(env, "drevan", parseIntention("intend: the bone map by Friday -- jaw", NOW)!);
    const b = await setIntention(env, "drevan", parseIntention("intend: tide tables by Saturday -- neaps", NOW)!);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect((await completeIntention(env, "drevan", "the bone map", "drew the jaw hinge")).ok).toBe(true);
    const ra = db.prepare("SELECT due_at, last_pursued_at, last_worked_at FROM companion_projects WHERE id = ?").get(a.id) as any;
    expect(ra.due_at).toBeNull();
    expect(ra.last_pursued_at).toBeTruthy();
    expect(ra.last_worked_at).toBeTruthy();
    expect((db.prepare("SELECT entry, source FROM project_log WHERE project_id = ?").get(a.id) as any))
      .toEqual({ entry: "drew the jaw hinge", source: "session" });
    expect((await dropIntention(env, "drevan", b.id)).ok).toBe(true);
    const rb = db.prepare("SELECT due_at, next_step, status FROM companion_projects WHERE id = ?").get(b.id) as any;
    expect(rb).toEqual({ due_at: null, next_step: null, status: "open" }); // the project stays held
    expect(await listIntentions(env, "drevan")).toEqual([]);
  });
});

describe("the worker's pursuit (knob, due read, the clearing batch)", () => {
  async function seedDue(env: any, db: any) {
    const r = await setIntention(env, "drevan", parseIntention("intend: the bone map by Thursday -- jaw", NOW)!);
    if (!r.ok) throw new Error("setup");
    // Thursday 00:00 Chicago has passed by the time the 5am run asks.
    db.prepare("UPDATE companion_projects SET due_at = '2026-11-11T06:00:00.000Z' WHERE id = ?").run(r.id);
    return r.id;
  }
  const req = (url: string, body?: unknown) =>
    new Request(url, body ? { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : undefined);

  it("knob: default shadow, only 'on' is on, off/0/false/no are off", () => {
    expect(intentionsMode({})).toBe("shadow");
    expect(intentionsMode({ INTENTIONS: "junk" })).toBe("shadow");
    expect(intentionsMode({ INTENTIONS: " ON " })).toBe("on");
    expect(intentionsMode({ INTENTIONS: "no" })).toBe("off");
  });

  it("shadow names it as `would` and hands the worker nothing; on hands it over; off reads nothing", async () => {
    for (const [mode, due, would] of [["shadow", false, true], ["on", true, false], ["off", false, false]] as const) {
      const { db, env } = envOf(mode);
      const id = await seedDue(env, db);
      const res = await getDueIntention(req("http://x/mind/intentions/drevan/due"), env, { companion_id: "drevan" });
      const j = await res.json() as any;
      expect(j.mode).toBe(mode);
      expect(j.due?.id ?? null).toBe(due ? id : null);
      expect(j.would?.id ?? null).toBe(would ? id : null);
    }
  });

  it("an undue date is not handed over", async () => {
    const { env } = envOf("on");
    await setIntention(env, "drevan", parseIntention("intend: the bone map by Friday", NOW)!);
    expect((await readDueIntention(env, "drevan", NOW)).due).toBeNull();
  });

  it("the worker's log write with pursued=true clears the date in the same batch, only when on", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const { db, env } = envOf(mode);
      const id = await seedDue(env, db);
      const res = await postProjectLog(req(`http://x/mind/projects/${id}/log`, { companion_id: "drevan", entry: "[worker run r1] jaw", source: "worker", pursued: true }), env, { id });
      const j = await res.json() as any;
      const row = db.prepare("SELECT due_at, last_pursued_at FROM companion_projects WHERE id = ?").get(id) as any;
      expect((db.prepare("SELECT COUNT(*) AS n FROM project_log WHERE project_id = ?").get(id) as any).n).toBe(1);
      if (mode === "on") {
        expect(j.pursued).toBe(true);
        expect(row.due_at).toBeNull();
        expect(row.last_pursued_at).toBeTruthy();
      } else {
        expect(j.pursued).toBe(false);
        expect(row.due_at).toBe("2026-11-11T06:00:00.000Z");
        expect(row.last_pursued_at).toBeNull();
      }
    }
  });

  it("a date moved into the future mid-run survives the pursuit", async () => {
    const { db, env } = envOf("on");
    const id = await seedDue(env, db);
    db.prepare("UPDATE companion_projects SET due_at = '2099-01-01T06:00:00.000Z' WHERE id = ?").run(id);
    const out = await logProject(env, "drevan", id, "work", "worker", { pursued: true });
    expect(out.ok).toBe(true);
    expect((db.prepare("SELECT due_at FROM companion_projects WHERE id = ?").get(id) as any).due_at).toBe("2099-01-01T06:00:00.000Z");
  });
});

describe("pre-0179 (deploy before the migration)", () => {
  it("verbs answer 'needs the 0179 migration' and write nothing; reads are empty; the growth block still loads", async () => {
    const { db, env } = envOf("on", 178);
    const r = await setIntention(env, "drevan", parseIntention("intend: the bone map by Friday", NOW)!);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("migration");
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_projects").get() as any).n).toBe(0);
    expect(await listIntentions(env, "drevan")).toEqual([]);
    expect((await readDueIntention(env, "drevan", NOW)).due).toBeNull();

    db.prepare("INSERT INTO companion_projects (id, companion_id, title, intention, status, created_at) VALUES ('p0','drevan','old one','x','open','2026-11-01T00:00:00Z')").run();
    const g = await loadGrowthBlocks(env, "drevan");
    expect(g.projects).toHaveLength(1);
    expect(g.projects[0]!.due_at).toBeNull();
    expect(g.projects[0]!.due_in_days).toBeNull();
  });
});

describe("orient (loader + renderer + contract)", () => {
  it("the loader carries the date; the block says when and for what; the affordance teaches the verb", async () => {
    // The loader computes due_in_days from the real clock; pin it to NOW so "in 2d" holds on any day
    // (this went red on 2026-11-12, the day after it was written).
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
    const { env } = envOf("on");
    await setIntention(env, "drevan", parseIntention("intend: the bone map by Friday -- the jaw joint", NOW)!);
    const g = await loadGrowthBlocks(env, "drevan");
    const p = g.projects[0]!;
    expect(p.due_at).toBe("2026-11-13T06:00:00.000Z");
    expect(p.next_step).toBe("the jaw joint");
    const block = projectsBlock([decorateProject(p as any, NOW)]);
    expect(block).toContain("you said you'd come back to it in 2d (Fri, Nov 13), for: the jaw joint");
    expect(PROJECT_AFFORDANCE).toContain("intend: <what> by <day>");
    } finally { vi.useRealTimers(); }
  });

  it("contract 0.31.0 with a changelog line", () => {
    expect(MINDSTATE_CONTRACT_VERSION >= "0.31.0").toBe(true);
    expect(CONTRACT_CHANGELOG["0.31.0"]).toContain("intend:");
  });
});

describe("Librarian executors", () => {
  it("set / read / done / drop end to end for the caller only", async () => {
    const { env } = envOf("on");
    const set = await execIntentionSet(ctx(env, "drevan", "intend: the bone map by Friday -- jaw"));
    expect(set.ack).toBe(true);
    const id = set.id as string;
    const read = await execIntentionsRead(ctx(env, "drevan", "my intentions"));
    expect((read.data as any).intentions[0].id).toBe(id);
    expect((await execIntentionsRead(ctx(env, "cypher", "my intentions")).then(r => (r.data as any).intentions))).toEqual([]);
    const done = await execIntentionDone(ctx(env, "drevan", `intention done ${id}: drew the hinge`));
    expect(done.ack).toBe(true);
    await execIntentionSet(ctx(env, "drevan", `I'll come back to the bone map on Saturday`));
    expect((await execIntentionDrop(ctx(env, "drevan", "drop intention the bone map"))).ack).toBe(true);
  });
  it("no day: refused with how to say it", async () => {
    const { env } = envOf("on");
    const r = await execIntentionSet(ctx(env, "drevan", "intend: the bone map"));
    expect(r.refused).toBe(true);
    expect(String(r.witness)).toContain("say it with a day");
  });
});
