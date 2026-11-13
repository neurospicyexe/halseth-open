// Weekly graduation candidate for the self-model ladder (growth loops, 2026-11-11).
// The ladder was a pile: 19-21 observations sat at "ready" for Cypher and Drevan and none graduated
// in 14 days, because graduation only happened if a companion thought to say the verb. The worker's
// reflection run now OFFERS the top ready observation once a week; the companion confirms in their
// own words (the existing PATCH /mind/self-model/:id {action:"graduate"}). Additive only: this never
// demotes, retires or lowers anything (R7), and silence changes nothing.
import type { Env } from "../types.js";
import { careCategory } from "../people/care-guard.js";

export const GRADUATION_INTERVAL_DAYS = 7;

export interface GraduationCandidate { id: string; observation: string; confidence: number; kind: string }
export interface GraduationVerdict {
  candidate: GraduationCandidate | null;
  /** why there is none: "recent_graduation" | "none_ready" | "care_guard" | "unreadable" */
  reason: string | null;
}

export async function pickGraduationCandidate(env: Env, companionId: string): Promise<GraduationVerdict> {
  try {
    const recent = await env.DB.prepare(
      `SELECT 1 AS x FROM companion_self_model
        WHERE companion_id = ? AND status = 'graduated' AND graduated_at >= datetime('now', ?) LIMIT 1`,
    ).bind(companionId, `-${GRADUATION_INTERVAL_DAYS} days`).first();
    if (recent) return { candidate: null, reason: "recent_graduation" };
    // Evidence = the confidence the companion's own confirms built; the longest-held one wins a tie.
    const rows = await env.DB.prepare(
      `SELECT id, observation, confidence, kind FROM companion_self_model
        WHERE companion_id = ? AND status = 'ready'
        ORDER BY confidence DESC, created_at ASC LIMIT 8`,
    ).bind(companionId).all<GraduationCandidate>();
    const list = rows.results ?? [];
    if (list.length === 0) return { candidate: null, reason: "none_ready" };
    const safe = list.find(r => !careCategory(r.observation));
    return safe ? { candidate: safe, reason: null } : { candidate: null, reason: "care_guard" };
  } catch {
    return { candidate: null, reason: "unreadable" };
  }
}
