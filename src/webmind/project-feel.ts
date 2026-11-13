// src/webmind/project-feel.ts -- what holding, working, finishing and dropping a project FEELS like
// (2026-11-11; Principal: "starting dropping cost something like it would for me but in ai terms").
//
// ONE thin, never-throwing wrapper over fireStimulus for the PROJECT_STIMULI map (webmind/fermentation.ts), called
// from the single chokepoint in handlers/projects.ts that every path (HTTP, Librarian, MCP, worker, intentions)
// goes through. Mode is PROJECT_FEEL (off | shadow | on, CODE DEFAULT shadow), NOT LOOP_STIMULI_MODE.
//
// The principle (the reason the weights sit where they do): honest letting go must never be the expensive path.
// Cost sits on churn (start-then-drop, scaled by recent early drops), load on carrying many (3rd/4th open), lift on
// working and finishing. `project_let_go` and pause move NOTHING. R7: float deltas only, no ceiling, nothing
// ratchets, and the machine never releases a project.
//
// CAUSE LABELS name the KIND and the project id, never the title (titles are not care-guarded and these labels
// reach the vibe check and the reflection record).

import type { Env } from "../types.js";
import { fireStimulus } from "../handlers/fermentation.js";
import { insertFermentEventSql, stimulusMode, type StimulusMode, type CompanionId } from "./fermentation.js";
import { isTriad } from "./loop-stimuli.js";

/** An early drop: opened under this many days ago with fewer than EARLY_DROP_MAX_LOG work entries. */
export const EARLY_DROP_DAYS = 7;
export const EARLY_DROP_MAX_LOG = 2;
/** Churn window and weight: x(1 + 0.5 * the companion's OTHER early drops in the last 14 days), capped x2. */
export const CHURN_WINDOW_DAYS = 14;
export const CHURN_STEP = 0.5;
export const CHURN_CAP = 2.0;
/** project_load: the stimulus carries 0.03 (the 3rd open project); the 4th is 0.05, i.e. x(5/3). */
export const LOAD_FOURTH_SCALE = 0.05 / 0.03;

export const PROJECT_LABELS: Record<string, string> = {
  project_finished: "finished a project",
  project_dropped_early: "let go of a project early",
  project_let_go: "let a project go, no cost",
  project_worked: "worked a project",
  project_load: "carrying more than two projects",
};

export function projectFeelMode(env: Env): StimulusMode {
  return stimulusMode("project_worked", env as unknown as Record<string, unknown>);
}

/** Churn multiplier from the count of the companion's OTHER early drops in the last 14 days. */
export function churnScale(otherEarlyDrops: number): number {
  const n = Math.max(0, Math.floor(otherEarlyDrops));
  return Math.min(CHURN_CAP, 1 + CHURN_STEP * n);
}

/** The cause detail: a kind label plus the project id. NEVER the title. */
/** True when the companion said why they set it down. Any non-blank note counts: the cost is for the
 *  silent drop, and a false stone teaches hiding the honest kind of letting go. */
export function gaveWhy(note: string | null | undefined): boolean {
  return typeof note === "string" && note.trim().length > 0;
}

export function projectDetail(stimulus: string, projectId: string, extra?: string): string {
  const label = extra ?? PROJECT_LABELS[stimulus] ?? stimulus;
  return `${label} (project:${projectId})`;
}

/**
 * Fire one project-feel stimulus. Never throws (a failure here can never undo the project write it rides on).
 * shadow: the ferment machinery writes its kind='shadow' rows and moves nothing; off: nothing at all.
 */
export async function fireProjectFeel(
  env: Env,
  stimulus: string,
  companion: string,
  projectId: string,
  opts: { scale?: number; label?: string } = {},
): Promise<boolean> {
  try {
    if (!isTriad(companion)) return false;
    const mode = projectFeelMode(env);
    if (mode === "off") return false;
    const scale = opts.scale ?? 1;
    const detail = projectDetail(stimulus, projectId, opts.label);
    console.log(`[project-feel] ${stimulus} companion=${companion} mode=${mode} scale=${Number(scale.toFixed(3))}`);
    if (stimulus === "project_let_go") {
      // No float, no drive: logged as an event so the cause trail shows an honest letting go (shadow row in shadow).
      await env.DB.prepare(insertFermentEventSql()).bind(
        crypto.randomUUID().replace(/-/g, ""), companion, mode === "shadow" ? "shadow" : "stimulus", stimulus, null, null,
        mode === "shadow" ? `would_fire ${detail}` : detail,
      ).run();
      return true;
    }
    await fireStimulus(env, stimulus, companion as CompanionId, detail, { scale });
    return true;
  } catch (err) {
    console.error(`[project-feel] ${stimulus} failed`, { companion, error: String(err) });
    return false;
  }
}
