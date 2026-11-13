// Wire nudge (contract 0.32.0, 2026-11-11): the tray nudge line and open-loop ages reach the Discord bot
// wire, and the tray / intention verbs route from a Discord-origin Librarian request.

import { describe, it, expect } from "vitest";
import { botWireFromMindState } from "../mind/adapters/bot-wire.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import { CONTRACT_CHANGELOG, cmpVersion } from "../mind/changelog.js";
import { trayNudgeForOrient } from "../webmind/tray-nudge.js";
import { matchFastPath } from "../librarian/router.js";
import type { MindState } from "../mind/contract.js";

const msWith = (open_loops: unknown[]) => ({ contract_version: "x", companion_id: "drevan", loom: "discord", loaded_at: "2026-11-11T00:00:00Z",
  identity: { anchor: null, shared_kernel: null, companion_kernel: null, self_model: [], architect_facts: [], preferences: [], refusals: [], agency_affordance: "" },
  felt: { limbic: null, soma_floats: [], drives: [], ferment_events: [], ferment_at: null, soma_provenance: [], soma_arc: [], biometrics_latest: null, house: null },
  continuity: { latest_handoff: null, recent_handoffs: [], open_thread_count: 0, top_threads: [], surfaced_notes: [], recent_notes: [], archived_digests: [], spiral_turn: null, session_narrative: null, conversations: [], closed_conversations: [], recent_captures: [] },
  carried: { dreams_unexamined: [], open_loops, tensions: [], sits: [], feelings_recent: [] },
  beliefs: { conclusions: [], flagged: [], resurfaced: null, supersede_candidates: [] },
  relational: { snapshot: [], deltas_recent: [], witness_principal: [], triad_incoming: [], triad_outgoing: [], letters: [], journal_recent: [], siblings: [], recent_witness: [] },
  growth: { journal_recent: [], patterns: [], markers: [], reflection: null, seeds: [], clearing_count: 0, drifts_open: [], projects: [], budget: null },
  oversight: { pressure_flags: [], growth_confirmed: [], guardian_cards: [], tripwires: [], questions: [], answered_questions: [], growth_unconfirmed: [] },
  world: { home_recent: [], club: null, commons: [], commons_life: [], change_notes: [], shelf: [], collection: { forage: [], media: [], top: [] }, forage: { pool: [], active: [] }, listens: [], motifs: { active: [], resurrection_candidates: [] }, sol: null, creatures: [], imps_active: [], watching: [], departures: [], principal_state: null },
  graph: { neighborhoods: [], seeds: [] }, ledger: { open: [], waiting: 0 },
  meta: { datetime_iso: "2026-11-11T00:00:00Z", datetime_local: "2026-11-11", not_yet_loaded: [], degraded: [] } }) as unknown as MindState;

const base = { synthesis_summary: null, rag_excerpts: [], history_excerpts: [], continuity_notes: [], owner: "Principal" };

describe("tray_nudge on the bot wire", () => {
  it("carries the extras string; null when absent or empty", () => {
    const ms = msWith([]);
    expect(botWireFromMindState(ms, { ...base, tray_nudge: "[Tray]\n20 drafts waiting in your tray, oldest 4d." }, "drevan").tray_nudge).toContain("20 drafts waiting");
    expect(botWireFromMindState(ms, base, "drevan")).toHaveProperty("tray_nudge", null);
    expect(botWireFromMindState(ms, { ...base, tray_nudge: "" }, "drevan")).toHaveProperty("tray_nudge", null);
  });
});

describe("open_loops age on the bot wire", () => {
  it("adds opened_ago, keeps id + loop_text", () => {
    const opened = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const w: any = botWireFromMindState(msWith([{ id: "abc12345-x", loop_text: "finish the thing", opened_at: opened }]), base, "drevan");
    expect(w.open_loops).toHaveLength(1);
    expect(w.open_loops[0]).toMatchObject({ id: "abc12345-x", loop_text: "finish the thing" });
    expect(w.open_loops[0].opened_ago).toMatch(/3 days/);
  });
  it("a loop with no opened_at gets no age (never a fake one)", () => {
    const w: any = botWireFromMindState(msWith([{ id: "a", loop_text: "x", opened_at: null }]), base, "drevan");
    expect(w.open_loops[0].opened_ago).toBeNull();
  });
});

describe("trayNudgeForOrient gating (shared with the wire)", () => {
  const db = (n: number) => ({ prepare: () => ({ bind: () => ({ first: async () => ({ n, oldest: "2026-10-01T00:00:00Z" }) }) }) }) as any;
  it("shadow renders nothing, on renders the line, off nothing", async () => {
    expect(await trayNudgeForOrient({ DB: db(20), TRAY_NUDGE_MODE: "shadow" } as any, "drevan")).toBe("");
    expect(await trayNudgeForOrient({ DB: db(20), TRAY_NUDGE_MODE: "off" } as any, "drevan")).toBe("");
    expect(await trayNudgeForOrient({ DB: db(20), TRAY_NUDGE_MODE: "on" } as any, "drevan")).toContain("drafts waiting in your tray");
  });
});

describe("verbs reach the Librarian fast path from Discord (route is surface-independent)", () => {
  it("tray verbs", () => {
    expect(matchFastPath("my tray")?.key).toBe("tray_read");
    expect(matchFastPath("keep draft 0f3a9c1e")?.key).toBe("tray_keep");
    expect(matchFastPath("drop draft 0f3a9c1e")?.key).toBe("tray_drop");
  });
  it("intention verbs", () => {
    expect(matchFastPath("intend: finish the garden notes by Friday")?.key).toBe("intention_set");
    expect(matchFastPath("my intentions")?.key).toBeTruthy();
  });
});

describe("contract 0.32.0", () => {
  it("is announced", () => {
    expect(cmpVersion(MINDSTATE_CONTRACT_VERSION, "0.32.0")).toBeGreaterThanOrEqual(0);
    expect(CONTRACT_CHANGELOG["0.32.0"]).toContain("tray");
  });
});
