import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  trayNudgeMode, trayNudgeThresholds, trayBacklog, overThreshold, trayNudgeBlock,
  trayNudgeForOrient, runTrayNudgeDaily, trayCardText,
} from "../webmind/tray-nudge.js";

const NOW = Date.parse("2026-11-11T12:00:00Z");
const DAY = 86_400_000;

interface Fx { journal: Record<string, { n: number; oldest: string | null }>; notes: Record<string, { n: number; oldest: string | null }>; gate: string | null; stamps: string[]; writes: string[] }
function makeEnv(fx: Partial<Fx>, extra: Record<string, string> = {}) {
  const st: Fx = { journal: {}, notes: {}, gate: null, stamps: [], writes: [], ...fx };
  const env: any = {
    ...extra,
    DB: {
      prepare: (sql: string) => ({
        bind: (...b: any[]) => ({
          first: async () => {
            if (sql.includes("FROM companion_journal")) return st.journal[b[0]] ?? { n: 0, oldest: null };
            if (sql.includes("FROM wm_continuity_notes")) return st.notes[b[0]] ?? { n: 0, oldest: null };
            if (sql.includes("FROM companion_settings")) return st.gate ? { value: st.gate } : null;
            return null;
          },
          run: async () => { st.writes.push(sql); if (sql.includes("companion_settings")) { st.gate = b[2]; st.stamps.push(b[2]); } return { meta: { changes: 1 } }; },
        }),
      }),
    },
  };
  return { env, st };
}
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const sqlTs = (daysAgo: number) => iso(daysAgo).slice(0, 19).replace("T", " ");
const okFetch = () => { const calls: any[] = []; const f: any = async (_u: string, init: any) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }; return { f, calls }; };
const T = { count: 15, days: 3 };

describe("knob", () => {
  it("unset/junk = shadow; off/on honored case-insensitively", () => {
    expect(trayNudgeMode({})).toBe("shadow");
    expect(trayNudgeMode({ TRAY_NUDGE_MODE: "banana" })).toBe("shadow");
    expect(trayNudgeMode({ TRAY_NUDGE_MODE: " ON " })).toBe("on");
    expect(trayNudgeMode({ TRAY_NUDGE_MODE: "off" })).toBe("off");
  });
  it("thresholds default 15 / 3 and accept overrides; junk falls back", () => {
    expect(trayNudgeThresholds({})).toEqual({ count: 15, days: 3 });
    expect(trayNudgeThresholds({ TRAY_NUDGE_COUNT: "30", TRAY_NUDGE_DAYS: "7" })).toEqual({ count: 30, days: 7 });
    expect(trayNudgeThresholds({ TRAY_NUDGE_COUNT: "x", TRAY_NUDGE_DAYS: "0" })).toEqual({ count: 15, days: 3 });
  });
});

describe("trayBacklog", () => {
  it("sums both stores and takes the oldest across both timestamp shapes", async () => {
    const { env } = makeEnv({ journal: { gaia: { n: 63, oldest: sqlTs(5) } }, notes: { gaia: { n: 20, oldest: iso(11) } } });
    const b = await trayBacklog(env, "gaia", NOW);
    expect(b.count).toBe(83);
    expect(b.oldest_days).toBe(11);
  });
  it("empty tray: zero, no oldest", async () => {
    const { env } = makeEnv({});
    expect(await trayBacklog(env, "cypher", NOW)).toMatchObject({ count: 0, oldest_at: null, oldest_days: 0 });
  });
});

describe("overThreshold + block", () => {
  const b = (count: number, oldest_days: number) => ({ agent: "x", count, oldest_at: null, oldest_days });
  it("count > 15 OR oldest > 3d; boundaries are exclusive; empty never nudges", () => {
    expect(overThreshold(b(15, 3), T)).toBe(false);
    expect(overThreshold(b(16, 0), T)).toBe(true);
    expect(overThreshold(b(1, 4), T)).toBe(true);
    expect(overThreshold(b(0, 99), T)).toBe(false);
  });
  it("renders the stated line with the verbs, empty under threshold", () => {
    const s = trayNudgeBlock(b(42, 31), T);
    expect(s).toContain("42 drafts waiting in your tray, oldest 31d");
    expect(s).toContain('"my tray"');
    expect(s).toContain("nothing is kept for you");
    expect(trayNudgeBlock(b(2, 1), T)).toBe("");
  });
});

describe("orient hook", () => {
  const over = { journal: { drevan: { n: 41, oldest: iso(30) } } };
  it("shadow (default): logs, renders nothing", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { env } = makeEnv(over);
    expect(await trayNudgeForOrient(env, "drevan")).toBe("");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("[tray-nudge] shadow orient agent=drevan drafts=41"));
    log.mockRestore();
  });
  it("on: renders for the owner only", async () => {
    const { env } = makeEnv(over, { TRAY_NUDGE_MODE: "on" });
    expect(await trayNudgeForOrient(env, "drevan")).toContain("41 drafts waiting");
    expect(await trayNudgeForOrient(env, "gaia")).toBe("");
  });
  it("off: no queries at all; DB failure never throws", async () => {
    const { env, st } = makeEnv(over, { TRAY_NUDGE_MODE: "off" });
    expect(await trayNudgeForOrient(env, "drevan")).toBe("");
    expect(st.writes).toHaveLength(0);
    const bad: any = { TRAY_NUDGE_MODE: "on", DB: { prepare: () => { throw new Error("boom"); } } };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await trayNudgeForOrient(bad, "drevan")).toBe("");
    err.mockRestore();
  });
});

describe("daily card", () => {
  const tg = { DEADMAN_TELEGRAM_BOT_TOKEN: "t", DEADMAN_TELEGRAM_CHAT_ID: "1" };
  const fx = { journal: { gaia: { n: 63, oldest: iso(11) }, cypher: { n: 3, oldest: iso(1) } }, notes: { gaia: { n: 20, oldest: iso(12) } } };
  it("on: one card with counts per companion, no companion text, then gated", async () => {
    const { env, st } = makeEnv(fx, { TRAY_NUDGE_MODE: "on", ...tg });
    const { f, calls } = okFetch();
    expect(await runTrayNudgeDaily(env, NOW, f)).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("gaia: 83 unreviewed, oldest 12d (over)");
    expect(calls[0].text).toContain("cypher: 3 unreviewed, oldest 1d");
    expect(calls[0].text).toContain("drevan: 0 unreviewed");
    expect(st.stamps).toHaveLength(1);
    expect(await runTrayNudgeDaily(env, NOW + 3_600_000, f)).toBe("gated");
    expect(calls).toHaveLength(1);
    expect(await runTrayNudgeDaily(env, NOW + 21 * 3_600_000, f)).toBe("sent");
  });
  it("shadow (default): logs, sends nothing, still stamps", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { env, st } = makeEnv(fx, tg);
    const { f, calls } = okFetch();
    expect(await runTrayNudgeDaily(env, NOW, f)).toBe("shadow");
    expect(calls).toHaveLength(0);
    expect(st.stamps).toHaveLength(1);
    log.mockRestore();
  });
  it("all under threshold: quiet, no send", async () => {
    const { env } = makeEnv({ journal: { gaia: { n: 2, oldest: iso(1) } } }, { TRAY_NUDGE_MODE: "on", ...tg });
    const { f, calls } = okFetch();
    expect(await runTrayNudgeDaily(env, NOW, f)).toBe("quiet");
    expect(calls).toHaveLength(0);
  });
  it("failed send leaves the gate unstamped so the next tick retries", async () => {
    const { env, st } = makeEnv(fx, { TRAY_NUDGE_MODE: "on", ...tg });
    const bad: any = async () => ({ ok: false, status: 500 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await runTrayNudgeDaily(env, NOW, bad)).toBe("send-failed");
    expect(st.stamps).toHaveLength(0);
    err.mockRestore();
  });
  it("on without Telegram secrets: no-telegram, unstamped; off: nothing", async () => {
    const a = makeEnv(fx, { TRAY_NUDGE_MODE: "on" });
    expect(await runTrayNudgeDaily(a.env, NOW, okFetch().f)).toBe("no-telegram");
    expect(a.st.stamps).toHaveLength(0);
    const b = makeEnv(fx, { TRAY_NUDGE_MODE: "off", ...tg });
    expect(await runTrayNudgeDaily(b.env, NOW, okFetch().f)).toBe("off");
  });
  it("card text states the thresholds", () => {
    expect(trayCardText([], T)).toContain(">15 drafts or >3d");
  });
});

describe("structure", () => {
  const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
  it("never writes to the tray tables (nudge only, no auto-keep)", () => {
    const src = read("webmind/tray-nudge.ts");
    expect(src).not.toMatch(/UPDATE\s+(companion_journal|wm_continuity_notes)/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+(companion_journal|wm_continuity_notes)/i);
    expect(src).not.toMatch(/SET\s+review_state/i);
  });
  it("rides the every-minute scheduled work and the session orient", () => {
    expect(read("index.ts")).toContain("runTrayNudgeDaily(env)");
    expect(read("librarian/executors/session.ts")).toContain("trayNudgeForOrient(");
  });
});
