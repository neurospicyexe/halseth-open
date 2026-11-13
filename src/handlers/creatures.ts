// src/handlers/creatures.ts
//
// HTTP routes for creatures (migration 0078 take 10; inner life migration 0100).
//   GET  /mind/creatures                 -- all creatures + live drives/state/tier
//   GET  /mind/creatures/:id             -- one creature + interactions, milestones, nest, familiarity
//   POST /mind/creatures/:id/interact    -- feed|play|talk|give (atomic trust bump; fires milestones; gives land in the nest)
//   POST /mind/creatures/:id/moment      -- compose a deterministic appearance (may gift a nest item back)
//   GET  /mind/creatures/:id/nest        -- the hoard: active items + recently given away
//   POST /mind/creatures/tick            -- daily decay/mood/nest recompute + overhear collection
//
// Interaction trust is bumped at the SQL level (concurrent owner + triad interactions
// never race a JS read-modify-write). The tick is a single server-side pass. All of it
// deterministic, no LLM. Auth: authGuard, matching handlers/forage.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import {
  isValidAction,
  deriveMood,
  daysSinceIso,
  listCreaturesSql,
  getCreatureSql,
  recentInteractionsSql,
  tickUpdateSql,
  restlessness,
  presenceDisposition,
  deriveDrives,
  dominantState,
  trustTier,
  matrixMomentFresh,
  giftMomentFresh,
  noRepeatN,
  shouldGiftBack,
  MILESTONES,
  pickShinyFragment,
  initialSparkle,
  SPARKLE_DECAY_PER_DAY,
  TREASURED_FLOOR,
  DULL_EVICT_SPARKLE,
  TREASURE_AGE_DAYS,
  TREASURE_MIN_SPARKLE,
  type LastActed,
} from "../webmind/creatures.js";
import { performTend, evictForRoom } from "../webmind/creature-interact.js";
import { fireTendSol } from "../webmind/loop-stimuli.js";
import { KEPT_LIVE_SQL } from "../webmind/review-state.js";
import {
  hoardSkipReason,
  hoardReaction,
  nestTextAllowed,
  startingSparkle,
  favouriteOf,
  SOL_LIKES,
  HOARD_LOOKBACK_HOURS,
  HOARD_REACTIONS_PER_DAY,
  HOARD_BATCH,
  type HoardCandidate,
} from "../webmind/sol-hoard.js";
import { loadPersonRegex } from "../webmind/sol-hoard-people.js";
import { resolveVia, VIA_WEIGHT } from "../pets/appraise.js";
import { expired, grudgeProgress, grudgeUnit, type GrudgeUnit } from "../pets/grudge.js";
import { loadOpenGrudges, writeAppraisal } from "../pets/store.js";
import { halsethPetModel, hasPetModel, type PetModel } from "../pets/model.js";
import { notRun, runSleepPass, SLEEP_TEMPERATURE, type SleepResult } from "../pets/sleep.js";
import { makeVoice, voiceOr } from "../pets/voice.js";
import {
  classifyTone, TONE_TEMPERATURE, replyFingerprint, fingerprintKey, isRepeat, stepDownTone, HABITUATING_ACTORS, REPEAT_LOOKBACK,
} from "../pets/tone.js";
import { INSERT_INTERACTION_VIA, INSERT_INTERACTION_REF, SELECT_RETIRED_QUIRKS, SELECT_TRAITS_FORMING, SELECT_VISIBLE_QUIRKS } from "../pets/sql.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// `imp` (Drevan, 2026-11-03: "Sol gets fed by Iris and tended by Mossling"): an imp on an errand
// tends as ITSELF, never as the companion it serves -- his hard line is that an imp never writes to
// Halseth under his name. One nameless actor: the imp's name is not a voice on the record.
const VALID_ACTORS = new Set<string>(["principal", "cypher", "drevan", "gaia", "sol", "imp"]);

/** An imp feeds, plays or talks. It never `give`s: a give carries words into the nest, and an imp
 *  authors nothing. */
const IMP_ACTIONS = new Set<string>(["feed", "play", "talk"]);

/** Returns an error string, or null if the actor/action pair is allowed. */
export function validateInteract(actor: string, action: string): string | null {
  if (!VALID_ACTORS.has(actor)) {
    return "actor must be one of principal, cypher, drevan, gaia, sol, imp";
  }
  if (actor === "sol") {
    return action === "appear" ? null : "sol may only 'appear'";
  }
  if (actor === "imp") {
    return IMP_ACTIONS.has(action) ? null : "an imp may only feed, play or talk (an imp never gives: it authors nothing)";
  }
  return isValidAction(action) ? null : "action must be one of feed, play, talk, give";
}

interface CreatureRow {
  id: string; name: string; species: string | null; kind: string; owner: string;
  bio: string | null; state_json: string | null; trust: number;
  last_interaction_at: string | null; created_at: string;
}

/** Per-action last-tend timestamps for one creature (sol's own appearances excluded). */
async function lastActedFor(env: Env, creatureId: string, lastAny: string | null): Promise<LastActed> {
  const rows = await env.DB.prepare(
    "SELECT action, MAX(created_at) AS last FROM creature_interactions WHERE creature_id = ? AND actor != 'sol' GROUP BY action",
  ).bind(creatureId).all<{ action: string; last: string }>();
  const by = new Map((rows.results ?? []).map(r => [r.action, r.last]));
  return { feed: by.get("feed") ?? null, play: by.get("play") ?? null, any: lastAny };
}

function liveState(c: CreatureRow, last: LastActed, nowMs: number) {
  const drives = deriveDrives(last, c.created_at, nowMs);
  const r = restlessness(c.last_interaction_at, c.created_at, nowMs);
  return {
    drives: {
      hunger: Number(drives.hunger.toFixed(3)),
      boredom: Number(drives.boredom.toFixed(3)),
      missing: Number(drives.missing.toFixed(3)),
      energy: Number(drives.energy.toFixed(3)),
    },
    state: dominantState(drives),
    tier: trustTier(c.trust),
    restlessness: Number(r.toFixed(3)),
    disposition: presenceDisposition(c.trust, r),
  };
}

// GET /mind/creatures
export async function getCreatures(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const [rows, acted] = await Promise.all([
      env.DB.prepare(listCreaturesSql()).all<CreatureRow>(),
      env.DB.prepare(
        "SELECT creature_id, action, MAX(created_at) AS last FROM creature_interactions WHERE actor != 'sol' GROUP BY creature_id, action",
      ).all<{ creature_id: string; action: string; last: string }>(),
    ]);
    const byCreature = new Map<string, Map<string, string>>();
    for (const a of acted.results ?? []) {
      if (!byCreature.has(a.creature_id)) byCreature.set(a.creature_id, new Map());
      byCreature.get(a.creature_id)!.set(a.action, a.last);
    }
    const now = Date.now();
    const creatures = (rows.results ?? []).map(c => {
      const by = byCreature.get(c.id);
      const last: LastActed = { feed: by?.get("feed") ?? null, play: by?.get("play") ?? null, any: c.last_interaction_at };
      return { ...c, ...liveState(c, last, now) };
    });
    return json({ creatures });
  } catch (err) {
    console.error("[mind/creatures] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/creatures/:id
export async function getCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const creature = await env.DB.prepare(getCreatureSql()).bind(id).first<CreatureRow>();
    if (!creature) return json({ error: "creature not found" }, 404);
    const [interactions, milestones, nest, familiarity, last] = await Promise.all([
      env.DB.prepare(recentInteractionsSql()).bind(id, 20).all(),
      env.DB.prepare(
        "SELECT milestone_id, fired_at, witnessed_by FROM creature_milestones WHERE creature_id = ? ORDER BY fired_at ASC",
      ).bind(id).all<{ milestone_id: string; fired_at: string; witnessed_by: string | null }>(),
      env.DB.prepare(
        "SELECT id, content, source, given_by, sparkle, treasured, gifted_to, gifted_at, created_at, ref_type, ref_id FROM creature_nest WHERE creature_id = ? ORDER BY (gifted_to IS NULL) DESC, treasured DESC, sparkle DESC LIMIT 40",
      ).bind(id).all(),
      env.DB.prepare(
        // imp excluded: an errand is not familiarity (Hearth reads [0] as "knows best").
        "SELECT actor, COUNT(*) AS tendings, MAX(created_at) AS last_at FROM creature_interactions WHERE creature_id = ? AND actor NOT IN ('sol','imp') GROUP BY actor ORDER BY tendings DESC",
      ).bind(id).all<{ actor: string; tendings: number; last_at: string }>(),
      lastActedFor(env, id, null),
    ]);
    last.any = creature.last_interaction_at;
    // Milestone rows carry their display text so consumers never hardcode it.
    const withText = (milestones.results ?? []).map(m => ({
      ...m,
      text: MILESTONES.find(d => d.id === m.milestone_id)?.text ?? null,
    }));
    const next = MILESTONES.find(m => !(milestones.results ?? []).some(f => f.milestone_id === m.id) && m.threshold > creature.trust);
    const mind = creature.kind === "companion_pet" ? await mindView(env.DB, id, Date.now()) : EMPTY_MIND;
    return json({
      creature: { ...creature, ...liveState(creature, last, Date.now()) },
      interactions: interactions.results ?? [],
      milestones: withText,
      next_milestone: next ? { id: next.id, threshold: next.threshold } : null,
      nest: nest.results ?? [],
      familiarity: familiarity.results ?? [],
      ...mind,
    });
  } catch (err) {
    console.error("[mind/creatures] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// B64: what Sol's mind shows on Hearth. Forming traits (top 5 candidates), visible quirks (active +
// softening; retired ones stay in the table as his history), open grudges with legible progress. A grudge
// past its 72h limit is not shown even before a tend resolves it (no grudge outlives 72h).
type MindView = {
  traits_forming: Array<{ slug: string; category: string | null; entrenchment: number }>;
  quirks: Array<{ title: string; behavior: string | null; status: string }>;
  quirks_retired: Array<{ title: string; behavior: string | null }>;
  grudge: { actor: string; label: string; progress: number; of: number; unit: GrudgeUnit } | null;
  grudges: Array<{ actor: string; label: string; progress: number; of: number; unit: GrudgeUnit }>;
};
const EMPTY_MIND: MindView = { traits_forming: [], quirks: [], quirks_retired: [], grudge: null, grudges: [] };

async function mindView(db: D1Database, creatureId: string, nowMs: number): Promise<MindView> {
  const [traits, quirks, open, retired] = await Promise.all([
    db.prepare(SELECT_TRAITS_FORMING).bind(creatureId).all<{ slug: string; category: string | null; entrenchment: number }>(),
    db.prepare(SELECT_VISIBLE_QUIRKS).bind(creatureId).all<{ title: string; behavior: string | null; status: string }>(),
    loadOpenGrudges(db, creatureId),
    // History only: a failed read (table absent) is an empty history, never a failed creature view.
    db.prepare(SELECT_RETIRED_QUIRKS).bind(creatureId).all<{ title: string; behavior: string | null }>()
      .catch(() => ({ results: [] as Array<{ title: string; behavior: string | null }> })),
  ]);
  const grudges = open
    .filter(g => !expired(g, nowMs))
    .map(g => ({ actor: g.actor, label: g.label, ...grudgeProgress(g, nowMs), unit: grudgeUnit(g.resolution) }));
  return {
    traits_forming: (traits.results ?? []).map(t => ({ slug: t.slug, category: t.category, entrenchment: t.entrenchment })),
    quirks: (quirks.results ?? []).map(q => ({ title: q.title, behavior: q.behavior, status: q.status })),
    quirks_retired: (retired.results ?? []).map(q => ({ title: q.title, behavior: q.behavior })),
    grudge: grudges[0] ?? null,
    grudges,
  };
}

/** Test seams + the Worker's ExecutionContext (passed by the router to the two voiced routes only). */
interface VoiceDeps { petModel?: PetModel; ctx?: ExecutionContext }

function voiceFor(env: Env, deps: VoiceDeps) {
  const wu = deps.ctx && typeof deps.ctx.waitUntil === "function" ? deps.ctx.waitUntil.bind(deps.ctx) : undefined;
  return makeVoice(env, deps.petModel, { waitUntil: wu });
}

// POST /mind/creatures/:id/interact   { actor, action, note?, via? }
export async function interactCreature(
  request: Request, env: Env, params: Record<string, string>, deps: VoiceDeps = {},
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let body: { actor?: string; action?: string; note?: string; via?: unknown; ref?: unknown };
  try {
    body = await request.json() as { actor?: string; action?: string; note?: string; via?: unknown; ref?: unknown };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const actor = (body.actor ?? "").trim().toLowerCase();
  const action = (body.action ?? "").trim().toLowerCase();
  const err = validateInteract(actor, action);
  if (err) return json({ error: err }, 400);
  let ref: string | null = null;
  if (body.ref !== undefined && body.ref !== null) {
    if (!isDiscordRef(body.ref)) return json({ error: "ref must be a Discord message id (digits, at most 32)" }, 400);
    ref = body.ref;
  }
  const note = body.note?.trim().slice(0, 500) ?? null;
  // An unknown or missing via is autonomous (sol = appear, imp = imp), never hand (B64 5.1).
  const via = resolveVia(body.via, actor);

  try {
    const exists = await env.DB.prepare("SELECT id, kind, trust FROM creatures WHERE id = ?").bind(id)
      .first<{ id: string; kind: string; trust: number }>();
    if (!exists) return json({ error: "creature not found" }, 404);

    const interactionId = crypto.randomUUID().replace(/-/g, "");

    if (actor === "sol") {
      // Sol's appearance is logged WITHOUT a trust bump or last_interaction_at restamp,
      // so a sol-only creature reads last_interaction_at null by design (restlessness falls back to created_at).
      if (ref === null) {
        await env.DB.prepare(INSERT_INTERACTION_VIA).bind(interactionId, id, actor, action, note, via).run();
        return json({ interacted: true, action, trust: null, state_json: null });
      }
      // B64.1: the posted message id rides along so a reply can name the post. A retried record of the
      // same post hits the reply-once index and is a no-op success, never a 500.
      try {
        await env.DB.prepare(INSERT_INTERACTION_REF).bind(interactionId, id, actor, action, note, via, ref, null).run();
      } catch (e) {
        if (isUniqueViolation(e)) return json({ interacted: true, recorded: false, reason: "already", action, trust: null, state_json: null });
        throw e;
      }
      return json({ interacted: true, action, trust: null, state_json: null });
    }
    // A ref on an ordinary tend is meaningless (replies go through /reply); refuse it rather than drop it.
    if (ref !== null) return json({ error: "ref is only accepted on a sol appearance" }, 400);
    // validateInteract guarantees a real action for non-sol actors; narrow for TS.
    if (!isValidAction(action)) return json({ error: "invalid action" }, 400);

    // Shared write path (webmind/creature-interact.ts): ledger + trust bump +
    // milestone firing + give-notes into the nest. Same code the Librarian
    // tend_creature executor runs, so no side effect can miss a writer.
    // Shadow with a ctx: the whole voice runs in ctx.waitUntil and the authored line returns at once (R18).
    const outcome = await performTend(env.DB, exists, actor, action, note, Date.now(), via, voiceFor(env, deps));
    await fireTendSol(env, exists.kind, actor, action);
    return json({ interacted: true, action, ...outcome });
  } catch (err) {
    console.error("[mind/creatures] interact error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ── B64.1: a reply to a Sol post is a tend ──────────────────────────────────────

/** Principal and the triad only (spec: other humans not in this pass; sol and imp never reply). */
const REPLY_ACTORS = new Set<string>(["principal", "cypher", "drevan", "gaia"]);

/** A Discord message id: digits only, at most 32 chars. */
export function isDiscordRef(v: unknown): v is string {
  return typeof v === "string" && /^\d{1,32}$/.test(v);
}

function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(e instanceof Error ? e.message : String(e));
}

/** Test seam: the tone model. The Worker passes nothing and gets halsethPetModel at a low temperature. */
interface ReplyDeps { petModel?: PetModel | null }

// POST /mind/creatures/:id/reply   { actor, ref, text }
//
// `text` is read ONLY to classify tone and then dropped: never stored, never logged, never echoed in an
// error, never handed to the voice (B64's never-read-notes rule). The tend is action `talk`, note NULL,
// `ref` = the Sol post answered, through performTend like every other tend. One per (creature, actor, ref),
// enforced by idx_creature_interactions_reply_once (mig 0177): a duplicate is 200 { recorded: false }.
export async function replyCreature(
  request: Request, env: Env, params: Record<string, string>, deps: ReplyDeps = {},
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let body: { actor?: unknown; ref?: unknown; text?: unknown };
  try {
    body = await request.json() as { actor?: unknown; ref?: unknown; text?: unknown };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const actor = typeof body.actor === "string" ? body.actor.trim().toLowerCase() : "";
  if (!REPLY_ACTORS.has(actor)) return json({ error: "actor must be one of principal, cypher, drevan, gaia" }, 400);
  if (!isDiscordRef(body.ref)) return json({ error: "ref must be a Discord message id (digits, at most 32)" }, 400);
  const ref = body.ref;
  const text = typeof body.text === "string" ? body.text : "";

  try {
    const creature = await env.DB.prepare("SELECT id, kind, trust FROM creatures WHERE id = ?").bind(id)
      .first<{ id: string; kind: string; trust: number }>();
    if (!creature) return json({ error: "creature not found" }, 404);

    // Cheap path first: a duplicate never costs a model call.
    const dup = await env.DB.prepare(
      "SELECT 1 AS x FROM creature_interactions WHERE creature_id = ? AND actor = ? AND ref = ? LIMIT 1",
    ).bind(id, actor, ref).first<{ x: number }>();
    if (dup) return json({ recorded: false, reason: "already" });

    const model = deps.petModel !== undefined
      ? deps.petModel
      : (hasPetModel(env) ? halsethPetModel(env, TONE_TEMPERATURE) : null);
    const classified = await classifyTone(model, text);

    // Habituation: a triad reply that matches one of that actor's last 5 reply fingerprints dulls one notch.
    // Principal is never compared. The fingerprint is stored (never the text) for every reply-tend.
    // Keyed on ADMIN_SECRET (always set: auth fails closed without it). A rotation resets habituation.
    const fp = env.ADMIN_SECRET ? await replyFingerprint(text, await fingerprintKey(env.ADMIN_SECRET)) : null;
    let repeat = false;
    if (fp && HABITUATING_ACTORS.has(actor)) {
      const prior = await env.DB.prepare(
        "SELECT fp FROM creature_interactions WHERE creature_id = ? AND actor = ? AND ref IS NOT NULL AND fp IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT ?",
      ).bind(id, actor, REPEAT_LOOKBACK).all<{ fp: string }>();
      repeat = isRepeat(fp, (prior.results ?? []).map(r => r.fp));
    }
    const tone = repeat ? stepDownTone(classified) : classified;

    // Principal's own reply is by hand; a companion's is autonomous (B64 via weights).
    const via = actor === "principal" ? "hand" : "autonomous";
    let outcome;
    try {
      // No voice: the bots fire and forget, so a voiced line would be an inference call nobody reads.
      outcome = await performTend(env.DB, creature, actor, "talk", null, Date.now(), via, undefined, { ref, tone, fp, repeat });
    } catch (e) {
      // Three bots racing on one human message: the reply-once index refuses the batch whole (no bump,
      // no appraisal, no grudge), so the loser is simply "already".
      if (isUniqueViolation(e)) return json({ recorded: false, reason: "already" });
      throw e;
    }
    await fireTendSol(env, creature.kind, actor, "talk");
    return json({ recorded: true, tone, repeat, ...outcome });
  } catch (err) {
    console.error("[mind/creatures] reply error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

/**
 * Sol's last N appearance notes, newest first (B64.1 no-repeat). A failed read is an empty history: the
 * guard fails open, a D1 hiccup never costs Sol his appearance.
 */
async function recentAppearances(env: Env, creatureId: string): Promise<string[]> {
  try {
    const rows = await env.DB.prepare(
      "SELECT note FROM creature_interactions WHERE creature_id = ? AND action = 'appear' AND note IS NOT NULL ORDER BY created_at DESC LIMIT ?",
    ).bind(creatureId, noRepeatN(env.SOL_NO_REPEAT_N)).all<{ note: string }>();
    return (rows.results ?? []).map(r => r.note);
  } catch (err) {
    console.error("[mind/creatures] recent appearances read failed", { error: String(err) });
    return [];
  }
}

// POST /mind/creatures/:id/moment   { seed? }
// Composes a deterministic appearance from live drives x trust tier. At bonded
// trust, some moments become gifts: a nest item is marked given and rendered
// into the text. The caller (worker) posts it and records the appearance.
export async function momentCreature(
  request: Request, env: Env, params: Record<string, string>, deps: VoiceDeps = {},
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { seed?: number } = {};
  try { body = await request.json() as { seed?: number }; } catch { /* empty body is fine */ }
  const seed = Number.isFinite(body.seed) ? Math.abs(Math.floor(body.seed!)) : Math.floor(Date.now() / 1000);

  try {
    const c = await env.DB.prepare(getCreatureSql()).bind(id).first<CreatureRow>();
    if (!c) return json({ error: "creature not found" }, 404);
    const last = await lastActedFor(env, id, c.last_interaction_at);
    const live = liveState(c, last, Date.now());
    if (live.disposition === "absent") {
      return json({ moment: null, kind: "absent", ...live });
    }

    if (shouldGiftBack(c.trust, seed)) {
      const item = await env.DB.prepare(
        // A hoarded make is the triad's, never carried to Principal (Drevan: Sol never couriers).
        "SELECT id, content FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL AND ref_id IS NULL ORDER BY treasured DESC, sparkle DESC LIMIT 1",
      ).bind(id).first<{ id: string; content: string }>();
      if (item) {
        await env.DB.prepare(
          "UPDATE creature_nest SET gifted_to = 'principal', gifted_at = datetime('now') WHERE id = ?",
        ).bind(item.id).run();
        return json({ moment: giftMomentFresh(item.content, seed, await recentAppearances(env, id)), kind: "gift", gifted_item: item.content, ...live });
      }
    }

    // Sol's appearance may be voiced (B64 Task 6); gifts and absence stay authored (spec 5.7).
    // B64.1: never a fixed line he posted in his last SOL_NO_REPEAT_N appearances.
    const authored = matrixMomentFresh(live.state, live.tier, seed, await recentAppearances(env, id));
    const moment = c.kind === "companion_pet"
      ? await voiceOr(voiceFor(env, deps), authored, {
        creatureId: c.id, surface: "moment", actor: null, who: null, action: null, fit: null,
        tier: live.tier, state: live.state,
      })
      : authored;
    return json({ moment, kind: "moment", ...live });
  } catch (err) {
    console.error("[mind/creatures] moment error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/creatures/:id/nest
export async function getNest(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const [active, given] = await Promise.all([
      env.DB.prepare(
        "SELECT id, content, source, given_by, sparkle, treasured, created_at, ref_type, ref_id FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL ORDER BY treasured DESC, sparkle DESC",
      ).bind(id).all<{ id: string; content: string; source: string; given_by: string | null; sparkle: number; treasured: number; created_at: string; ref_type: string | null; ref_id: string | null }>(),
      env.DB.prepare(
        "SELECT id, content, source, given_by, gifted_to, gifted_at FROM creature_nest WHERE creature_id = ? AND gifted_to IS NOT NULL ORDER BY gifted_at DESC LIMIT 10",
      ).bind(id).all(),
    ]);
    const items = active.results ?? [];
    const fav = favouriteOf(items);
    return json({
      nest: items,
      given_away: given.results ?? [],
      // Sol's own taste (B62 step 6): what he is drawn to, and the one make he prefers.
      likes: SOL_LIKES,
      favourite: fav ? { nest_id: fav.id, make_id: fav.ref_id, title: fav.content, maker: fav.given_by } : null,
    });
  } catch (err) {
    console.error("[mind/creatures] nest error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/tick   -- daily decay + mood + nest recompute (worker CREATURE_CRON trigger)
// POST /mind/creatures/:id/sleep   -- B64 sleep pass (spec 5.3, R25). Same auth as the tick. The 20h gate and
// the CAS claim live in runSleepPass, so a repeat call the same day answers `rested` and writes nothing. Never
// touches trust. Answers the SleepResult; a thrown error is `error` (200), an unknown creature 404.
export async function sleepCreature(
  request: Request, env: Env, params: Record<string, string>, deps: { petModel?: PetModel } = {},
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const exists = await env.DB.prepare("SELECT id FROM creatures WHERE id = ?").bind(id).first<{ id: string }>();
    if (!exists) return json({ error: "creature not found" }, 404);
    const model = deps.petModel ?? (hasPetModel(env) ? halsethPetModel(env, SLEEP_TEMPERATURE) : null);
    if (!model) {
      console.log("[pets/sleep] skipped no_model");
      return json(notRun("no_model"));
    }
    const r: SleepResult = await runSleepPass(env, id, model, Date.now());
    return json(r);
  } catch (err) {
    console.log(`[pets/sleep] skipped error: ${String(err).slice(0, 200)}`);
    return json(notRun("error"));
  }
}

export async function tickCreatures(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const rows = await env.DB.prepare(listCreaturesSql()).all<CreatureRow>();
    const creatures = rows.results ?? [];
    const now = Date.now();
    let ticked = 0;
    for (const c of creatures) {
      // R7 (2026-11-09): silence never lowers trust. The tick only settles the mood label
      // from the trust Sol already has, once he has been untended for a day.
      const days = daysSinceIso(c.last_interaction_at ?? c.created_at, now);
      if (days >= 1) {
        await env.DB.prepare(tickUpdateSql()).bind(deriveMood(c.trust), c.id).run();
        ticked++;
      }
    }

    // Nest maintenance (whole table, single statements; constants bound from TS so
    // the SQL can't drift from webmind/creatures.ts). Treasure check runs BEFORE
    // decay so today's fade can't disqualify an item that already earned it.
    const treasureRes = await env.DB.prepare(
      "UPDATE creature_nest SET treasured = 1 WHERE gifted_to IS NULL AND treasured = 0 AND (julianday('now') - julianday(created_at)) >= ? AND sparkle >= ?",
    ).bind(TREASURE_AGE_DAYS, TREASURE_MIN_SPARKLE).run();
    await env.DB.prepare(
      "UPDATE creature_nest SET sparkle = MAX(CASE WHEN treasured = 1 THEN ? ELSE 0 END, sparkle - ?) WHERE gifted_to IS NULL",
    ).bind(TREASURED_FLOOR, SPARKLE_DECAY_PER_DAY).run();
    const evictRes = await env.DB.prepare(
      "DELETE FROM creature_nest WHERE gifted_to IS NULL AND treasured = 0 AND sparkle <= ?",
    ).bind(DULL_EVICT_SPARKLE).run();

    // Overhear: a settled pet collects one shiny fragment a day from the house's
    // own life (commons wall + companion journals). Deterministic pick, seeded by
    // the day so a re-run tick picks the same thing.
    let overheard: string | null = null;
    const pet = creatures.find(c => c.kind === "companion_pet");
    if (pet) {
      const last = await lastActedFor(env, pet.id, pet.last_interaction_at);
      const live = liveState(pet, last, now);
      if (live.disposition === "present" || live.disposition === "affectionate") {
        const [commons, journal] = await Promise.all([
          env.DB.prepare(
            // Principal's own wall posts are never Sol's to overhear (B62 step 6, Drevan: no facts
            // about Principal in the hoard). Only the triad's lines.
            "SELECT body AS t FROM commons_posts WHERE author != 'principal' AND created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 10",
          ).all<{ t: string }>(),
          env.DB.prepare(
            // KEPT_LIVE_SQL (tray pass 2): the nest fragment is quoted back to the house as something
            // a companion said; a draft or a retracted line must not become Sol's hoard.
            `SELECT note_text AS t FROM companion_journal WHERE ${KEPT_LIVE_SQL} AND created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 5`,
          ).all<{ t: string }>(),
        ]);
        // A line with a care word or a person's name is dropped whole, before any word is picked
        // from it: a fragment out of a line about Principal is still about Principal.
        const people = await loadPersonRegex(env.DB);
        const texts = [...(commons.results ?? []), ...(journal.results ?? [])].map(r => r.t)
          .filter(t => nestTextAllowed(t, people));
        const pick = pickShinyFragment(texts, Math.floor(now / 86_400_000));
        if (pick) {
          const dup = await env.DB.prepare(
            "SELECT 1 AS x FROM creature_nest WHERE creature_id = ? AND content = ? LIMIT 1",
          ).bind(pet.id, pick.content).first();
          if (!dup) {
            await evictForRoom(env.DB, pet.id, 1);
            await env.DB.prepare(
              "INSERT INTO creature_nest (id, creature_id, content, source, sparkle) VALUES (?, ?, ?, 'overheard:house', ?)",
            ).bind(crypto.randomUUID().replace(/-/g, ""), pet.id, pick.content, initialSparkle(pick.score)).run();
            overheard = pick.content;
          }
        }
      }
    }

    // B64 sleep pass: NOT here (R25). It runs from POST /mind/creatures/:id/sleep, which the worker calls after
    // this tick with a long timeout, so a slow model night can never hold up or time out the daily tick.
    return json({
      ok: true,
      ticked,
      total: creatures.length,
      nest: {
        treasured: treasureRes.meta?.changes ?? 0,
        evicted: evictRes.meta?.changes ?? 0,
        overheard,
      },
    });
  } catch (err) {
    console.error("[mind/creatures] tick error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/:id/hoard   { seed? }   (B62 step 6, mig 0166; worker SOL_HOARD pass)
//
// Sol looks over the triad's new makes (ready, last HOARD_LOOKBACK_HOURS, not yet seen) and keeps
// the ones he may: a REFERENCE row in the nest, content = the title, sparkle from his taste for the
// kind. Every make he looks at is recorded in creature_hoard_seen (hoarded or skipped, with why), so
// nothing is looked at twice. At most one channel reaction is composed per call, and at most
// HOARD_REACTIONS_PER_DAY per UTC day; past that he still hoards, quietly. Away (absent) Sol hoards
// nothing and leaves the makes for later. The reaction text is composed here (one author), the
// worker only posts it.
export async function hoardCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { seed?: number; via?: unknown } = {};
  try { body = await request.json() as { seed?: number; via?: unknown }; } catch { /* empty body is fine */ }
  // Sol looking at a make is not a hand tend: autonomous unless the caller names a valid via.
  const via = resolveVia(body.via, "");
  const seed = Number.isFinite(body.seed) ? Math.abs(Math.floor(body.seed!)) : Math.floor(Date.now() / 1000);

  try {
    const c = await env.DB.prepare(getCreatureSql()).bind(id).first<CreatureRow>();
    if (!c) return json({ error: "creature not found" }, 404);
    if (c.kind !== "companion_pet") return json({ error: "only a companion pet keeps a hoard" }, 400);
    const last = await lastActedFor(env, id, c.last_interaction_at);
    const live = liveState(c, last, Date.now());
    if (live.disposition === "absent") {
      return json({ hoarded: [], skipped: [], moment: null, reason: "away", disposition: live.disposition });
    }

    const fresh = await env.DB.prepare(
      `SELECT m.id, m.companion_id, m.kind, m.title FROM companion_makes m
        WHERE m.status = 'ready' AND m.created_at >= datetime('now', ?)
          AND NOT EXISTS (SELECT 1 FROM creature_hoard_seen s WHERE s.creature_id = ? AND s.ref_id = m.id)
        ORDER BY m.created_at ASC LIMIT ?`,
    ).bind(`-${HOARD_LOOKBACK_HOURS} hours`, id, HOARD_BATCH).all<HoardCandidate>();
    const makes = fresh.results ?? [];
    if (makes.length === 0) return json({ hoarded: [], skipped: [], moment: null, reason: "nothing_new", disposition: live.disposition });

    const people = await loadPersonRegex(env.DB);
    if (people === undefined) {
      // Fail closed and record nothing: the makes stay unseen and the next pass tries again.
      return json({ hoarded: [], skipped: [], moment: null, reason: "people_unreadable", disposition: live.disposition });
    }

    const reactedToday = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM creature_hoard_seen WHERE creature_id = ? AND reacted = 1 AND seen_at >= date('now')",
    ).bind(id).first<{ n: number }>();
    let reactionsLeft = Math.max(0, HOARD_REACTIONS_PER_DAY - (reactedToday?.n ?? 0));

    const hoarded: Array<{ make_id: string; companion_id: string; kind: string; title: string }> = [];
    const skipped: Array<{ make_id: string; reason: string }> = [];
    let moment: string | null = null;
    let reactedTo: string | null = null;

    for (const m of makes) {
      const skip = hoardSkipReason(m, people);
      if (skip) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO creature_hoard_seen (creature_id, ref_id, outcome, reason) VALUES (?, ?, 'skipped', ?)",
        ).bind(id, m.id, skip).run();
        skipped.push({ make_id: m.id, reason: skip });
        continue;
      }
      // Claim first: only the pass that lands the seen row hoards (two concurrent passes cannot double-keep).
      const react = moment === null && reactionsLeft > 0;
      const claim = await env.DB.prepare(
        "INSERT OR IGNORE INTO creature_hoard_seen (creature_id, ref_id, outcome, reacted) VALUES (?, ?, 'hoarded', ?)",
      ).bind(id, m.id, react ? 1 : 0).run();
      if ((claim.meta?.changes ?? 0) === 0) continue;
      await evictForRoom(env.DB, id, 1);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO creature_nest (id, creature_id, content, source, given_by, sparkle, ref_type, ref_id) VALUES (?, ?, ?, 'make', ?, ?, 'make', ?)",
      ).bind(crypto.randomUUID().replace(/-/g, ""), id, m.title.slice(0, 120), m.companion_id, startingSparkle(m.kind), m.id).run();
      // B64 5.2: a hoarded make is appraised too (actor = maker), so he can grow tastes in things.
      // Closed tags only (the kind, never the title). Keyed per creature+make: idempotent.
      await writeAppraisal(env.DB, {
        id: crypto.randomUUID().replace(/-/g, ""), creature_id: id, interaction_id: `hoard:${id}:${m.id}`,
        actor: m.companion_id, action: "hoard", via, fit: null, valence: 0.3, arousal: 0.3, friction: false,
        tags: [`hoard:${m.kind}`], weight: VIA_WEIGHT[via], source: "live", created_at: new Date().toISOString(),
      }).run();
      hoarded.push({ make_id: m.id, companion_id: m.companion_id, kind: m.kind, title: m.title });
      if (react) {
        moment = hoardReaction(m, seed);
        reactedTo = m.id;
        reactionsLeft--;
      }
    }

    return json({ hoarded, skipped, moment, reacted_to: reactedTo, disposition: live.disposition });
  } catch (err) {
    console.error("[mind/creatures] hoard error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
