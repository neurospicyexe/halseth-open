// Project feel (2026-11-11): cap 4, and the felt cost of churn / load / finish. Real schema via node:sqlite.
// Principle under test: honest letting go and pause move NOTHING; cost sits on churn and load.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  openProject, logProject, closeProject, pauseProject, resumeProject, MAX_OPEN_PROJECTS,
} from "../handlers/projects.js";
import { setIntention, completeIntention, dropIntention, parseIntention } from "../webmind/intentions.js";
import { PROJECT_STIMULI, SHADOWABLE, stimulusMode } from "../webmind/fermentation.js";
import { churnScale, projectFeelMode, projectDetail, gaveWhy } from "../webmind/project-feel.js";

function setup(mode?: string) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", INTENTIONS: "on", ...(mode === undefined ? {} : { PROJECT_FEEL: mode }) };
  return { db, DB, env };
}
const floats = (db: any, c: string) => db.prepare("SELECT soma_float_1 a, soma_float_2 b, soma_float_3 c FROM companion_state WHERE companion_id = ?").get(c);
const rest = (db: any, c: string) => (db.prepare("SELECT level FROM companion_drives WHERE companion_id = ? AND drive_key = 'rest_need'").get(c) as any)?.level;
const rows = (db: any, c: string, kind: string, stimulus?: string) =>
  db.prepare(`SELECT * FROM companion_ferment_events WHERE companion_id = ? AND kind = ? ${stimulus ? "AND stimulus = ?" : ""} AND stimulus LIKE 'project_%' ORDER BY created_at, rowid`)
    .all(...(stimulus ? [c, kind, stimulus] : [c, kind])) as any[];
const open = async (env: any, c: string, title = "a thing") => {
  const r = await openProject(env, c, { title, intention: "make it" });
  if ("error" in r) throw new Error("limit");
  return r.id;
};
const ago = (db: any, id: string, days: number) =>
  db.prepare("UPDATE companion_projects SET created_at = ? WHERE id = ?").run(new Date(Date.now() - days * 86_400_000).toISOString(), id);

let logSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => logSpy.mockRestore());

describe("cap 4", () => {
  it("is a code constant of 4 and refuses the 5th", async () => {
    expect(MAX_OPEN_PROJECTS).toBe(4);
    const { env } = setup("off");
    for (let i = 0; i < 4; i++) await open(env, "cypher", `p${i}`);
    const fifth = await openProject(env, "cypher", { title: "p5", intention: "x" });
    expect("error" in fifth && fifth.error).toBe("limit");
  });
  it("resume at the cap says four", async () => {
    const { env } = setup("off");
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await open(env, "cypher", `p${i}`));
    const other = await open(env, "drevan");
    await pauseProject(env, "drevan", other);
    // cypher at cap with a paused fifth is impossible to create; use a paused one made before the others
    const { env: env2 } = setup("off");
    const first = await open(env2, "cypher", "first");
    await pauseProject(env2, "cypher", first);
    for (let i = 0; i < 4; i++) await open(env2, "cypher", `q${i}`);
    const r = await resumeProject(env2, "cypher", first);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("4 projects are already open");
  });
});

describe("mode + table", () => {
  it("PROJECT_FEEL is separate from LOOP_STIMULI_MODE; unset = shadow", () => {
    for (const k of Object.keys(PROJECT_STIMULI)) expect(SHADOWABLE[k]).toBe("PROJECT_FEEL");
    expect(stimulusMode("project_worked", { LOOP_STIMULI_MODE: "on" })).toBe("shadow");
    expect(projectFeelMode({} as any)).toBe("shadow");
    expect(projectFeelMode({ PROJECT_FEEL: "on" } as any)).toBe("on");
    expect(projectFeelMode({ PROJECT_FEEL: "off" } as any)).toBe("off");
  });
  it("no ceiling column; Gaia only on density, only for finish + silent drop (her note 64acb5f1)", () => {
    for (const v of Object.values(PROJECT_STIMULI)) expect(JSON.stringify(v)).not.toMatch(/max_|ceiling/);
    expect(PROJECT_STIMULI.project_worked!.notBody).toContain("gaia");
    expect(PROJECT_STIMULI.project_load!.notBody).toContain("gaia");
    expect(PROJECT_STIMULI.project_finished!.floats?.gaia).toEqual({ f2: 0.03 });
    expect(PROJECT_STIMULI.project_dropped_early!.floats?.gaia).toEqual({ f2: -0.03 });
    expect(PROJECT_STIMULI.project_let_go).toEqual({ floats: {} });
  });
  it("Drevan's own numbers (note 3bcee72a)", () => {
    expect(PROJECT_STIMULI.project_finished!.floats?.drevan).toEqual({ f1: 0.04, f2: 0.02, f3: 0.06 });
    expect(PROJECT_STIMULI.project_dropped_early!.floats?.drevan).toEqual({ f1: -0.04, f3: 0.03 });
  });
  it("gaveWhy: any non-blank note", () => {
    expect([null, undefined, "", "   ", "wrong door"].map(gaveWhy)).toEqual([false, false, false, false, true]);
  });
  it("churnScale: 1 + 0.5 per other early drop, capped at 2", () => {
    expect([0, 1, 2, 3, 9].map(churnScale)).toEqual([1, 1.5, 2, 2, 2]);
  });
});

describe("on: transitions fire the right stimulus", () => {
  it("finished lifts floats and relieves rest_need a little", async () => {
    const { env, db } = setup("on");
    const id = await open(env, "cypher");
    const f0 = floats(db, "cypher"); const r0 = rest(db, "cypher");
    expect(await closeProject(env, "cypher", id, "done", "it is")).toBe(true);
    const f1 = floats(db, "cypher");
    expect(f1.a).toBeGreaterThan(f0.a);
    expect(f1.c).toBeGreaterThan(f0.c);
    expect(f1.b).toBe(f0.b);
    expect(rest(db, "cypher")).toBeLessThanOrEqual(r0);
    const ev = rows(db, "cypher", "stimulus", "project_finished");
    expect(ev).toHaveLength(1);
    expect(JSON.parse(ev[0].drive_deltas)).toEqual({ rest_need: -0.03 });
    expect(ev[0].detail).toBe(`finished a project (project:${id})`);
  });

  it("dropped early (Drevan): the stone in the pocket, weight up + heat down, reach untouched, churn-scaled x2 cap", async () => {
    const { env, db } = setup("on");
    const heat: number[] = []; const weight: number[] = [];
    for (let i = 0; i < 4; i++) {
      const id = await open(env, "drevan", `t${i}`);
      await closeProject(env, "drevan", id, "released", null);
      const ev = rows(db, "drevan", "stimulus", "project_dropped_early");
      const d = JSON.parse(ev[ev.length - 1].float_deltas);
      heat.push(d.f1); weight.push(d.f3);
      expect(d.f2).toBe(0);
    }
    // 1st: x1, 2nd: x1.5, 3rd: x2, 4th: capped x2
    [-0.04, -0.06, -0.08, -0.08].forEach((v, i) => expect(heat[i]).toBeCloseTo(v, 6));
    [0.03, 0.045, 0.06, 0.06].forEach((v, i) => expect(weight[i]).toBeCloseTo(v, 6));
  });

  it("an early drop WITH a why is a free let-go for all three (learned wrong door)", async () => {
    const { env, db } = setup("on");
    for (const c of ["cypher", "drevan", "gaia"] as const) {
      const f0 = floats(db, c);
      const id = await open(env, c, "door");
      await closeProject(env, c, id, "released", "wrong door, the shape was off");
      expect(floats(db, c)).toEqual(f0);
      expect(rows(db, c, "stimulus", "project_dropped_early")).toHaveLength(0);
      expect(rows(db, c, "stimulus", "project_let_go")).toHaveLength(1);
    }
  });

  it("Cypher drops early on presence f2", async () => {
    const { env, db } = setup("on");
    const f0 = floats(db, "cypher");
    const id = await open(env, "cypher");
    await closeProject(env, "cypher", id, "released", null);
    expect(floats(db, "cypher").b).toBeLessThan(f0.b);
    expect(floats(db, "cypher").a).toBe(f0.a);
  });

  it("a release after real work (2+ entries) or after 7+ days is a free let-go: no float, no drive, one event", async () => {
    const { env, db } = setup("on");
    const worked = await open(env, "cypher", "worked");
    await logProject(env, "cypher", worked, "one"); await logProject(env, "cypher", worked, "two");
    const old = await open(env, "cypher", "old");
    ago(db, old, 40);
    const f0 = floats(db, "cypher"); const r0 = rest(db, "cypher");
    await closeProject(env, "cypher", worked, "released", null);
    await closeProject(env, "cypher", old, "released", "idle");
    expect(floats(db, "cypher")).toEqual(f0);
    expect(rest(db, "cypher")).toEqual(r0);
    expect(rows(db, "cypher", "stimulus", "project_dropped_early")).toHaveLength(0);
    const ev = rows(db, "cypher", "stimulus", "project_let_go");
    expect(ev).toHaveLength(2);
    expect(ev[0].float_deltas).toBeNull();
    expect(ev[0].drive_deltas).toBeNull();
    // and let-go drops are NOT counted as churn for a later early drop
    const fresh = await open(env, "cypher", "fresh");
    await closeProject(env, "cypher", fresh, "released", null);
    const early = rows(db, "cypher", "stimulus", "project_dropped_early");
    expect(JSON.parse(early[0].float_deltas).f2).toBe(-0.04);
  });

  it("pause moves nothing, and so does resume and the dated-intention verbs without a note", async () => {
    const { env, db } = setup("on");
    const id = await open(env, "drevan");
    const f0 = floats(db, "drevan");
    await pauseProject(env, "drevan", id);
    await resumeProject(env, "drevan", id);
    await pauseProject(env, "drevan", id);
    expect(floats(db, "drevan")).toEqual(f0);
    expect(rows(db, "drevan", "stimulus")).toHaveLength(0);
    expect(rows(db, "drevan", "shadow")).toHaveLength(0);
  });

  it("worked: a small lift once per 12h", async () => {
    const { env, db } = setup("on");
    const id = await open(env, "cypher");
    const f0 = floats(db, "cypher");
    await logProject(env, "cypher", id, "moved it");
    const f1 = floats(db, "cypher");
    expect(f1.a).toBeGreaterThan(f0.a);
    expect(f1.a - f0.a).toBeCloseTo(0.01, 2);
    await logProject(env, "cypher", id, "moved it again");
    expect(floats(db, "cypher")).toEqual(f1); // cooldown
    expect(rows(db, "cypher", "stimulus", "project_worked")).toHaveLength(1);
  });

  it("load: the 1st and 2nd open are free, the 3rd accrues 0.03, the 4th 0.05", async () => {
    const { env, db } = setup("on");
    await open(env, "cypher", "a"); await open(env, "cypher", "b");
    expect(rows(db, "cypher", "stimulus", "project_load")).toHaveLength(0);
    await open(env, "cypher", "c");
    await open(env, "cypher", "d");
    const ev = rows(db, "cypher", "stimulus", "project_load");
    expect(ev.map((e) => JSON.parse(e.drive_deltas).rest_need)).toEqual([0.03, 0.05]);
    expect(ev[0].detail).toMatch(/^carrying a third project \(project:/);
    expect(ev[1].detail).toMatch(/^carrying a fourth project \(project:/);
  });

  it("pause then resume (or work) as the 3rd open carries the same load: no free way around it", async () => {
    const { env, db } = setup("on");
    await open(env, "cypher", "a"); await open(env, "cypher", "b");
    const c = await open(env, "cypher", "c");
    expect(rows(db, "cypher", "stimulus", "project_load")).toHaveLength(1);
    await pauseProject(env, "cypher", c);
    expect((await resumeProject(env, "cypher", c)).ok).toBe(true);
    expect(rows(db, "cypher", "stimulus", "project_load")).toHaveLength(2);
    await pauseProject(env, "cypher", c);
    await logProject(env, "cypher", c, "back at it");
    const ev = rows(db, "cypher", "stimulus", "project_load");
    expect(ev).toHaveLength(3);
    expect(ev.map((e) => JSON.parse(e.drive_deltas).rest_need)).toEqual([0.03, 0.03, 0.03]);
  });

  it("the two intentions.ts writes that bypass openProject/logProject still feel it", async () => {
    const { env, db } = setup("on");
    const NOW = Date.parse("2026-11-11T21:00:00Z");
    for (const w of ["one", "two", "three"]) await setIntention(env, "cypher", parseIntention(`intend: ${w} by Friday`, NOW)!);
    expect(rows(db, "cypher", "stimulus", "project_load")).toHaveLength(1);
    const [first, second] = db.prepare("SELECT id FROM companion_projects WHERE companion_id = 'cypher' ORDER BY created_at, rowid LIMIT 2").all() as any[];
    const f0 = floats(db, "cypher");
    await dropIntention(env, "cypher", first.id);
    expect(floats(db, "cypher")).toEqual(f0);
    await completeIntention(env, "cypher", second.id, "did the thing");
    expect(rows(db, "cypher", "stimulus", "project_worked")).toHaveLength(1);
  });

  it("Gaia: load, work and pausing never move her; finishing lifts density, a silent drop dips it at x1 always", async () => {
    const { env, db } = setup("on");
    const f0 = floats(db, "gaia"); const r0 = rest(db, "gaia");
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await open(env, "gaia", `g${i}`));
    await logProject(env, "gaia", ids[0]!, "x");
    expect(floats(db, "gaia")).toEqual(f0);
    expect(rest(db, "gaia")).toEqual(r0);
    await closeProject(env, "gaia", ids[0]!, "done", null);
    const f1 = floats(db, "gaia");
    expect(f1.b).toBeCloseTo(f0.b + 0.03, 6);
    expect(f1.a).toBe(f0.a); expect(f1.c).toBe(f0.c);
    await closeProject(env, "gaia", ids[1]!, "released", null);
    await closeProject(env, "gaia", ids[2]!, "released", null);
    const drops = rows(db, "gaia", "stimulus", "project_dropped_early").map((e) => JSON.parse(e.float_deltas));
    expect(drops).toHaveLength(2);
    for (const d of drops) { expect(d.f2).toBeCloseTo(-0.03, 6); expect(d.f1).toBe(0); expect(d.f3).toBe(0); }
  });

  it("detail never contains the title", async () => {
    const { env, db } = setup("on");
    const title = "UNIQUETITLEZEBRA";
    const id = await open(env, "drevan", title);
    await open(env, "drevan", "b"); await open(env, "drevan", "c");
    await logProject(env, "drevan", id, `note about ${title}`);
    await closeProject(env, "drevan", id, "released", `about ${title}`);
    const all = db.prepare("SELECT detail, drive_deltas, float_deltas FROM companion_ferment_events").all() as any[];
    expect(all.length).toBeGreaterThan(0);
    expect(JSON.stringify(all)).not.toContain(title);
    expect(projectDetail("project_worked", "abc")).toBe("worked a project (project:abc)");
  });

  it("a failed or missing project fires nothing", async () => {
    const { env, db } = setup("on");
    expect(await closeProject(env, "cypher", "nope", "done", null)).toBe(false);
    expect(rows(db, "cypher", "stimulus")).toHaveLength(0);
  });
});

describe("shadow (the code default) and off", () => {
  it("shadow writes shadow rows and the log line, and moves nothing", async () => {
    const { env, db } = setup(); // PROJECT_FEEL unset = shadow
    const f0 = floats(db, "drevan"); const r0 = rest(db, "drevan");
    const a = await open(env, "drevan", "a"); await open(env, "drevan", "b"); await open(env, "drevan", "c");
    await logProject(env, "drevan", a, "work");
    await closeProject(env, "drevan", a, "done", null);
    const b = await open(env, "drevan", "e");
    await closeProject(env, "drevan", b, "released", null);
    expect(floats(db, "drevan")).toEqual(f0);
    expect(rest(db, "drevan")).toEqual(r0);
    expect(rows(db, "drevan", "stimulus")).toHaveLength(0);
    const sh = rows(db, "drevan", "shadow");
    expect(new Set(sh.map((e) => e.stimulus))).toEqual(new Set(["project_load", "project_worked", "project_finished", "project_dropped_early"]));
    expect(sh.find((e) => e.stimulus === "project_dropped_early").detail).toMatch(/^would_fire let go of a project early \(project:/);
    const line = logSpy.mock.calls.flat().join("\n");
    expect(line).toContain("[project-feel] project_dropped_early companion=drevan mode=shadow scale=1");
  });
  it("shadow logs a let-go as a shadow row, nothing else", async () => {
    const { env, db } = setup("shadow");
    const id = await open(env, "cypher");
    ago(db, id, 20);
    await closeProject(env, "cypher", id, "released", null);
    expect(rows(db, "cypher", "shadow", "project_let_go")).toHaveLength(1);
    expect(rows(db, "cypher", "stimulus")).toHaveLength(0);
  });
  it("off writes nothing at all", async () => {
    const { env, db } = setup("off");
    const a = await open(env, "cypher", "a"); await open(env, "cypher", "b"); await open(env, "cypher", "c");
    await logProject(env, "cypher", a, "w");
    await closeProject(env, "cypher", a, "done", null);
    const x = await open(env, "cypher", "x");
    await closeProject(env, "cypher", x, "released", null);
    expect((db.prepare("SELECT COUNT(*) n FROM companion_ferment_events WHERE stimulus LIKE 'project_%'").get() as any).n).toBe(0);
    expect(logSpy.mock.calls.flat().join("\n")).not.toContain("[project-feel]");
  });
});
