// B67: the movie watchalong from Claude.ai through the Librarian (mig 0181).
// Real SQLite with every migration applied (helpers/sqlite-d1), so the cursor table, the `<=` playhead
// cut and the newest-live lookup are the real ones.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { postWatchalong, patchWatchalong } from "../handlers/watchalong.js";
import {
  findActiveSession, readOnScreen, controlActive, parseTimestamp, formatPlayhead,
  JOIN_WINDOW_SEC, MAX_BLOCK_CHARS,
} from "../watchalong/claude-ai.js";
import { execWatchalongRead, execWatchalongSeek, execWatchalongPlay } from "../librarian/executors/watchalong.js";
import { matchFastPath, ANCHORED_GUARDS } from "../librarian/router.js";
import type { Env } from "../types.js";

const SECRET = "<redacted:SECRET>";
const T0 = Date.parse("2026-11-12T20:00:00.000Z");

function setup() {
  const d1 = makeSqliteD1();
  const env = { DB: d1.DB, ADMIN_SECRET: SECRET } as unknown as Env;
  return { ...d1, env };
}
function req(method: string, path: string, body?: unknown): Request {
  return new Request(`https://x${path}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
  });
}
const cue = (s: number, text: string, kind = "line") => ({ start_sec: s, end_sec: s + 2, kind, text });

async function create(env: Env, channel: string, title: string, cues: unknown[], now: number) {
  const res = await postWatchalong(req("POST", "/mind/watchalong", { title, channel_id: channel, source: "attachment", duration_sec: 20000, cues }), env, now);
  return (await res.json() as { id: string }).id;
}
async function patch(env: Env, id: string, body: unknown, now: number) {
  await patchWatchalong(req("PATCH", `/mind/watchalong/${id}`, body), env, id, now);
}
const ctx = (env: Env, request: string, companion = "cypher"): any => ({ env, req: { companion_id: companion, request }, entry: {}, frontState: null, pluralAvailable: false });

describe("helpers", () => {
  it("parses and formats timestamps", () => {
    expect(parseTimestamp("47:12")).toBe(2832);
    expect(parseTimestamp("1:02:03")).toBe(3723);
    expect(parseTimestamp("47:75")).toBeNull();
    expect(parseTimestamp("47")).toBeNull();
    expect(formatPlayhead(2832)).toBe("47:12");
    expect(formatPlayhead(3723)).toBe("1:02:03");
  });
});

describe("findActiveSession -- no channel id", () => {
  it("returns null with nothing live, ignores ended", async () => {
    const { env } = setup();
    expect(await findActiveSession(env)).toBeNull();
    const id = await create(env, "c1", "A", [cue(0, "x")], T0);
    await patch(env, id, { status: "ended" }, T0 + 1000);
    expect(await findActiveSession(env)).toBeNull();
  });
  it("picks the most recently started live session across channels", async () => {
    const { env } = setup();
    await create(env, "c1", "Older", [cue(0, "x")], T0);
    await create(env, "c2", "Newer", [cue(0, "x")], T0 + 60_000);
    expect((await findActiveSession(env))!.title).toBe("Newer");
    // a paused session still counts (status != ended)
    expect((await findActiveSession(env))!.status).toBe("paused");
  });
});

describe("readOnScreen", () => {
  it("answers plainly when nothing is playing", async () => {
    const { env } = setup();
    const r = await readOnScreen(env, "cypher", T0);
    expect(r.active).toBe(false);
    expect(r.note).toContain("Nothing is playing");
    expect(r.note).toContain("dre: movie start <title>");
  });

  it("delivers cues up to the playhead only, then a delta, per companion", async () => {
    const { env } = setup();
    const id = await create(env, "c1", "Skinamarink", [cue(0, "[hum]", "sound"), cue(10, "Where's Dad?"), cue(30, "I'm scared."), cue(90, "FUTURE")], T0);
    await patch(env, id, { status: "playing", at_sec: 0 }, T0);
    // 35s in: cues at 0, 10, 30 are visible; 90 is not.
    const a = await readOnScreen(env, "cypher", T0 + 35_000);
    expect(a.block).toContain("[ON SCREEN: Skinamarink, 0:00 → 0:35, playing]");
    expect(a.block).toContain("[0:10] Where's Dad?");
    expect(a.block).toContain("[0:00] [hum]");
    expect(a.block).not.toContain("FUTURE");
    expect(a.joining).toBe(false);
    expect(a.standing).toContain("Skinamarink, 0:35 in, playing");
    expect(a.spoiler_gate).toContain("Only what's been on screen is yours");
    // Same companion, 10s later, nothing new (next cue is at 90).
    const b = await readOnScreen(env, "cypher", T0 + 45_000);
    expect(b.block).toBeNull();
    expect(b.note).toContain("Nothing new on screen since 0:35");
    // A different companion has its own cursor: it gets the whole thing.
    const c = await readOnScreen(env, "drevan", T0 + 45_000);
    expect(c.block).toContain("[0:10] Where's Dad?");
    // At 95s the future cue lands, and only it, for cypher.
    const d = await readOnScreen(env, "cypher", T0 + 95_000);
    expect(d.block).toContain("FUTURE");
    expect(d.block).not.toContain("Where's Dad?");
  });

  it("never returns a cue past the playhead (boundary is inclusive)", async () => {
    const { env } = setup();
    const id = await create(env, "c1", "F", [cue(10, "AT"), cue(10.5, "AFTER")], T0);
    await patch(env, id, { at_sec: 10 }, T0);
    const r = await readOnScreen(env, "gaia", T0);
    expect(r.block).toContain("AT");
    expect(r.block).not.toContain("AFTER");
  });

  it("honours the join window on a first delivery deep into the film, with a note", async () => {
    const { env } = setup();
    const cues = [cue(100, "EARLY"), cue(1500, "INWINDOW"), cue(1700, "LATE")];
    const id = await create(env, "c1", "Long", cues, T0);
    await patch(env, id, { at_sec: 1800 }, T0); // paused at 30:00
    const r = await readOnScreen(env, "cypher", T0);
    expect(r.joining).toBe(true);
    expect(r.block).toContain("you're joining 30:00 in; the last ten minutes");
    expect(r.block).toContain("INWINDOW");
    expect(r.block).toContain("LATE");
    expect(r.block).not.toContain("EARLY");
    expect(JOIN_WINDOW_SEC).toBe(600);
    // second read is a delta, not a join
    const again = await readOnScreen(env, "cypher", T0);
    expect(again.joining).toBe(false);
  });

  it("caps volume by count and reports skipped", async () => {
    const { env } = setup();
    const cues = Array.from({ length: 200 }, (_, i) => cue(i, `line ${i}`));
    const id = await create(env, "c1", "Busy", cues, T0);
    await patch(env, id, { at_sec: 199 }, T0);
    // first delivery, playhead < join window: JOIN_MAX_CUES=300 covers all 200.
    const first = await readOnScreen(env, "cypher", T0);
    expect(first.shown).toBe(200);
    expect(first.skipped).toBe(0);
    // another companion later at the same point but via a fresh session with 500 cues
    const many = Array.from({ length: 500 }, (_, i) => cue(i, `x${i}`));
    const id2 = await create(env, "c2", "Busier", many, T0 + 1000);
    await patch(env, id2, { at_sec: 499 }, T0 + 1000);
    const r = await readOnScreen(env, "drevan", T0 + 1000);
    expect(r.shown).toBe(300);
    expect(r.skipped).toBe(200);
    expect(r.block).toContain("(… 200 earlier lines not shown)");
    expect(r.note).toContain("200 skipped");
    expect(r.block).toContain("x499");
  });

  it("caps by characters, dropping the oldest and counting them", async () => {
    const { env } = setup();
    const long = "w".repeat(400);
    const cues = Array.from({ length: 40 }, (_, i) => cue(i, long + i));
    const id = await create(env, "c1", "Wordy", cues, T0);
    await patch(env, id, { at_sec: 100 }, T0);
    const r = await readOnScreen(env, "cypher", T0);
    expect(r.block!.length).toBeLessThanOrEqual(MAX_BLOCK_CHARS + 400);
    expect(r.shown).toBeLessThan(40);
    expect(r.skipped).toBe(40 - r.shown);
    expect(r.block).toContain(long + "39");
  });

  it("a seek backwards never rewinds the cursor", async () => {
    const { env, DB } = setup();
    const id = await create(env, "c1", "F", [cue(10, "a"), cue(500, "b")], T0);
    await patch(env, id, { at_sec: 600 }, T0);
    await readOnScreen(env, "cypher", T0);
    await patch(env, id, { at_sec: 20 }, T0 + 1000);
    const back = await readOnScreen(env, "cypher", T0 + 1000);
    expect(back.block).toBeNull();
    const cur: any = await DB.prepare("SELECT through_sec, surface FROM watchalong_cursors WHERE session_id = ? AND companion_id = 'cypher'").bind(id).first();
    expect(cur.through_sec).toBe(600);
    expect(cur.surface).toBe("claude_ai");
  });

  it("a new session starts a fresh cursor", async () => {
    const { env } = setup();
    const a = await create(env, "c1", "One", [cue(10, "one")], T0);
    await patch(env, a, { at_sec: 20 }, T0);
    await readOnScreen(env, "cypher", T0);
    await create(env, "c1", "Two", [cue(5, "two")], T0 + 5000); // ends the channel's prior session
    const s = await create(env, "c1", "Three", [cue(5, "three")], T0 + 6000);
    await patch(env, s, { at_sec: 20 }, T0 + 6000);
    const r = await readOnScreen(env, "cypher", T0 + 6000);
    expect(r.title).toBe("Three");
    expect(r.block).toContain("three");
  });
});

describe("controlActive", () => {
  it("seeks, pauses, plays; refuses with nothing live", async () => {
    const { env } = setup();
    expect((await controlActive(env, { at_sec: 10 }, T0)).ok).toBe(false);
    const id = await create(env, "c1", "F", [cue(0, "x")], T0);
    await patch(env, id, { status: "playing", at_sec: 0 }, T0);
    const seek = await controlActive(env, { at_sec: 2832 }, T0 + 1000);
    expect(seek.message).toContain("playhead set to 47:12");
    const paused = await controlActive(env, { status: "paused" }, T0 + 11_000);
    expect(paused.status).toBe("paused");
    expect(paused.playhead).toBe("47:22"); // clock materialised before freezing
    const played = await controlActive(env, { status: "playing" }, T0 + 20_000);
    expect(played.message).toContain("playing from 47:22");
  });
  it("never ends a session", async () => {
    const { env } = setup();
    const id = await create(env, "c1", "F", [cue(0, "x")], T0);
    await controlActive(env, { status: "paused" }, T0);
    expect((await findActiveSession(env))!.id).toBe(id);
  });
});

describe("executors", () => {
  it("read: data shape for a live film, witness when none", async () => {
    const { env } = setup();
    const none: any = await execWatchalongRead(ctx(env, "watchalong"));
    expect(none).toMatchObject({ response_key: "witness", active: false });
    expect(none.witness).toContain("dre: movie start");
    const id = await create(env, "c1", "Hereditary", [cue(5, "hi")], T0);
    await patch(env, id, { at_sec: 30 }, T0);
    const r: any = await execWatchalongRead(ctx(env, "what's on screen"));
    expect(r.response_key).toBe("data");
    expect(r.data).toMatchObject({ active: true, title: "Hereditary", status: "paused", playhead: "0:30", lines_shown: 1, lines_skipped: 0 });
    expect(r.data.on_screen).toContain("[0:05] hi");
    expect(r.data.standing_line).toContain("Hereditary");
    expect(r.data.spoiler_gate).toContain("don't search the film");
  });
  it("seek and play/pause through the request text", async () => {
    const { env } = setup();
    await create(env, "c1", "F", [cue(0, "x")], T0);
    const s: any = await execWatchalongSeek(ctx(env, "at 1:02:03"));
    expect(s).toMatchObject({ response_key: "witness", ack: true, playhead: "1:02:03" });
    const bad: any = await execWatchalongSeek(ctx(env, "at 99:99"));
    expect(bad.ack).toBe(false);
    const p: any = await execWatchalongPlay(ctx(env, "pause the movie"));
    expect(p).toMatchObject({ ack: true, status: "paused" });
    const pl: any = await execWatchalongPlay(ctx(env, "resume the film"));
    expect(pl).toMatchObject({ ack: true, status: "playing" });
    const none = setup();
    expect(((await execWatchalongPlay(ctx(none.env, "play the movie"))) as any).ack).toBe(false);
  });
});

describe("patterns", () => {
  const key = (t: string) => matchFastPath(t)?.key;
  it("routes the verbs", () => {
    for (const t of ["what's on screen", "What’s on screen?", "what is on screen now", "watchalong", "Watchalong status", "where are we in the movie", "what's happening in the film"]) {
      expect(key(t), t).toBe("watchalong_read");
    }
    for (const t of ["at 47:12", "at 1:02:03", "At 47:12.", "the movie is at 12:30", "film at 5:00", "watchalong at 1:00:00"]) {
      expect(key(t), t).toBe("watchalong_seek");
    }
    for (const t of ["pause the movie", "play the film", "resume the movie", "pause watchalong", "movie pause", "please resume the film", "unpause the movie"]) {
      expect(key(t), t).toBe("watchalong_play");
    }
  });
  it("does not swallow ordinary sentences", () => {
    const near = [
      "I'll be at 5:30 tomorrow", "meet me at 5:30", "at 5pm", "at 5", "look at 12:30 in the log",
      "pause the timer", "play some music", "play the movie soundtrack", "pause the movie night plan",
      "I want to watch a movie", "what are we watching", "what are we watching tonight", "what are we watching for movie night?",
      "the watchalong was great", "what's on screen in the doc I sent", "movie at 8", "film at the cinema",
    ];
    for (const t of near) {
      expect(["watchalong_read", "watchalong_seek", "watchalong_play"], t).not.toContain(key(t));
    }
  });
  it("is anchored and registered", () => {
    for (const k of ["watchalong_read", "watchalong_seek", "watchalong_play"]) {
      expect(ANCHORED_GUARDS.some(g => g.pattern_key === k)).toBe(true);
    }
  });
  it("has no start/done verb (Discord only)", () => {
    expect(["movie start Skinamarink", "movie done", "end the movie"].map(t => key(t))).not.toContain("watchalong_play");
  });
});
