/**
 * architect_facts -- the companions' own store of what is durably true about Principal.
 *
 * WHY THIS EXISTS (2026-08-12)
 * The facts used to live only in Hermes's built-in USER.md: capped at 1,375 chars, behind a
 * write-approval gate nobody staffed. 197 proposed writes queued from 2026-07-04 and never applied,
 * so the triad re-derived the same facts up to 23 times and drifted wrong doing it. Principal's three
 * constraints, in his words, and where each is answered:
 *
 *   "I don't wanna lose things and have this happen every time"
 *       -> writes land in D1 and return a result. There is no queue to silently fill.
 *   "I don't wanna write to infinity"
 *       -> the STORE is unbounded, the RENDER is bounded. Retiring is `superseded_by`, never DELETE.
 *   "What if things changed?"
 *       -> a change is a NEW row superseding the old. His OT-vs-BCBA decision will replace the
 *          "still weighing it" row without erasing that he weighed it.
 *
 * The render is what gets injected into every surface, so it is the thing that must stay small and
 * readable. Facts sort by (category, weight) and `status='open'` renders as a QUESTION TO ASK, never
 * as a fact -- that distinction is load-bearing: on 2026-08-12 a companion recorded a dog as living
 * because a conversation about him read as present tense, and stating an uncertain thing flatly is
 * how a wrong fact becomes unfalsifiable.
 */
import { writeArchitectFact, MAX_FACT_CHARS, PROPOSAL_SOURCE_PREFIX, pendingCorrectionTarget } from "../lib/architect-fact-write.js";
import { proposeArchitectFact } from "../lib/architect-fact-proposal.js";
import type { Env } from "../types.js";
import { gateOpenFacts, heldOpenFactsLine, gateActiveFacts, heldActiveFactsLine, activeFactsTailBudget } from "../lib/open-facts-gate.js";
import { authGuard } from "../lib/auth.js";
import { schemaGap } from "../care/schema-gap.js";
import { embedText, EMBEDDING_MODEL } from "../mcp/embed.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface FactRow {
  id: string;
  fact: string;
  category: string;
  status: string;
  companion_id: string | null;
  source: string | null;
  weight: number;
  created_at: string;
  /** 1 = always-on "Core" fact (mig 0146). Optional so pre-0146 fixtures still type. */
  core?: number;
  /** On an OPEN Discord-stated correction: the ACTIVE fact Confirm would retire (GAP-MAP A3). The
   *  target is active, so it is in this same list; Hearth shows "replaces: <its text>" from it. */
  supersedes_id?: string | null;
}

/** Ordered so the render reads like prose: how to treat him first, biography after. */
const CATEGORY_TITLES: Record<string, string> = {
  addressing: "HOW THEY ARE ADDRESSED",
  plural: "PLURAL SYSTEM",
  people: "THE PEOPLE",
  triad: "THE TRIAD",
  intimacy: "INTIMACY",
  work: "WORK AND SCHOOL",
  body: "BODY AND REGULATION",
  health: "HEALTH",
  animals: "THE ANIMALS",
  anchors: "WHAT THEY BRING",
  interests: "INTERESTS",
  living_situation: "LIVING SITUATION",
};

/** Footer for scope=core: the facts not listed here are not lost, they arrive per message. */
export const CORE_SCOPE_FOOTER =
  "(These are the always-on facts. The rest of what is recorded about them is fetched per message when it is relevant.)";

async function activeFacts(env: Env): Promise<FactRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, fact, category, status, companion_id, source, weight, created_at, core, supersedes_id
       FROM architect_facts
      WHERE status IN ('active', 'open')
      ORDER BY weight ASC, created_at ASC`,
  ).all<FactRow>();
  return res.results ?? [];
}

/**
 * A fact's own author speaks in first person ("...me writing 'someone wraps around you' instead of
 * 'I'" -- Drevan, in his own voice, about himself). Spliced verbatim into a SIBLING's identity file,
 * that same sentence reads as a memory THEY have, about THEMSELVES -- misattribution at the identity
 * layer, not a formatting nit. The fix is provenance, never rewriting: a fact authored by someone
 * other than the viewer gets a `[noted by <companion>]` prefix; the text after it is untouched. Own
 * voice (viewerCompanionId matches) and unattributed rows (no companion_id -- Principal or legacy) never
 * get a label.
 */
function attributionLine(r: FactRow, viewerCompanionId: string | null | undefined): string {
  const ownVoice = viewerCompanionId != null && r.companion_id === viewerCompanionId;
  const prefix = r.companion_id && !ownVoice ? `[noted by ${r.companion_id}] ` : "";
  return "- " + prefix + r.fact.trim();
}

/**
 * Render the injectable block. Deterministic: same rows in, same bytes out (for a given
 * viewerCompanionId), so the sync job can compare against what is already on disk and skip a
 * pointless restart.
 *
 * viewerCompanionId selects whose voice is "home": that companion's own facts render unlabeled,
 * everyone else's carry `[noted by <companion>]`. Omit it (undefined/null) for the shared,
 * no-single-self render (shared_system_context.md) -- every authored fact is labeled, since no
 * companion there is "the one speaking."
 */
export function renderFactsBlock(
  rows: FactRow[],
  generatedNote: string,
  viewerCompanionId?: string | null,
  now?: Date,
  tailCharBudget?: number,
  scope?: "core",
): string {
  // scope=core (B3, mig 0146): ONLY status='active' AND core=1, in the same grouping, titles and
  // labelling as the default render. The tail budget and open facts are ignored entirely; the rest
  // of the facts reach a companion per message via /shortlist. Default scope is untouched below.
  if (scope === "core") {
    const coreRows = rows.filter(r => r.status === "active" && r.core === 1);
    const lines: string[] = ["## THE ARCHITECT: OPERATING FACTS", generatedNote, ""];
    const knownCats = Object.keys(CATEGORY_TITLES);
    const extraCats = [...new Set(coreRows.map(r => r.category))].filter(c => !knownCats.includes(c)).sort();
    for (const cat of [...knownCats, ...extraCats]) {
      const inCat = coreRows.filter(r => r.category === cat);
      if (!inCat.length) continue;
      lines.push(CATEGORY_TITLES[cat] ?? cat.toUpperCase().replace(/[_-]+/g, " "));
      for (const r of inCat) lines.push(attributionLine(r, viewerCompanionId));
      lines.push("");
    }
    lines.push(CORE_SCOPE_FOOTER);
    return lines.join("\n").trimEnd() + "\n";
  }

  // Same ACTIVE gate as the Claude.ai orient block (lib/open-facts-gate.ts), for the same reason the
  // open gate is shared: two renderers disagreeing means one companion carries different facts about
  // Principal on Discord than on Claude.ai. Curated rows (weight < 100) always render; only the
  // default-weight tail is bounded, and the footer says how many are held.
  const activeGate = gateActiveFacts(rows, { tailCharBudget });
  const active = activeGate.shown;
  const open = rows.filter(r => r.status === "open");

  const out: string[] = [
    "## THE ARCHITECT: OPERATING FACTS",
    generatedNote,
    "",
  ];

  // Known categories in declared order, then anything the triad invented since, alphabetically --
  // a new category must never be silently dropped just because this file did not anticipate it.
  const known = Object.keys(CATEGORY_TITLES);
  const extra = [...new Set(active.map(r => r.category))]
    .filter(c => !known.includes(c))
    .sort();

  for (const cat of [...known, ...extra]) {
    const inCat = active.filter(r => r.category === cat);
    if (!inCat.length) continue;
    out.push(CATEGORY_TITLES[cat] ?? cat.toUpperCase().replace(/[_-]+/g, " "));
    for (const r of inCat) out.push(attributionLine(r, viewerCompanionId));
    out.push("");
  }

  const activeHeld = heldActiveFactsLine(activeGate.held.length);
  if (activeHeld) { out.push(activeHeld); out.push(""); }

  // 2026-09-14: same gate as the Claude.ai orient block (lib/open-facts-gate.ts). 107 open rows,
  // 105 of them the Hermes-queue drain, rendered in full into every bot prompt file as questions.
  // Newest few render; the rest are counted. `now` is injected by tests; production uses the clock,
  // which means this render is deterministic for a given DAY, not forever -- the sync job's
  // byte-compare will see one change per day at most as facts age past the window.
  const gate = gateOpenFacts(open, { now });
  if (gate.shown.length || gate.held.length) {
    out.push("STILL OPEN -- ASK, DO NOT ASSUME");
    out.push(
      "These are held open deliberately. Guessing a person, a pronoun or a death wrong is worse " +
      "than asking. Only what is still fresh enough to be a live question:",
    );
    for (const r of gate.shown) out.push(attributionLine(r, viewerCompanionId));
    const footer = heldOpenFactsLine(gate.held.length, gate.oldestHeldDays);
    if (footer) out.push(footer);
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}

/**
 * PATCH /identity/architect-facts/:id   body: { status: 'active' | 'retired' }
 *
 * The confirm/retire verb for an OPEN fact (2026-09-14). The drain posted 105 proposals as `open`
 * "so they surface for confirmation" and there was no surface: POST only creates rows, so the only
 * way to retire a stale open row was to invent a new fact that supersedes it. This is the missing
 * half. `open -> active` = Principal confirmed it; `open|active -> retired` = withdrawn. Nothing is
 * deleted (mig 0116 covenant); lineage keeps the row. Hearth /facts is the surface that calls it.
 */
export async function patchArchitectFactStatus(request: Request, env: Env, params: { id?: string }): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;
  const id = (params.id ?? "").trim();
  if (!id) return json({ error: "id is required" }, 400);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "body must be JSON" }, 400); }
  // WEIGHT IS NOW PATCHABLE (2026-09-25), and it is the more important half of this endpoint.
  //
  // Until today the only way to re-rank a fact was to supersede it with a new row -- and the
  // novelty gate correctly refuses a verbatim repost, so re-ranking a fact WITHOUT changing its
  // words was impossible. That is not a small gap: weight is the only ranking signal facts have,
  // `weight < 100` is what makes a fact always render, and the default is 100. So every fact ever
  // written by a companion landed unranked in the cuttable tail, permanently, with no way to
  // promote it.
  //
  // Measured the day this shipped: all four facts recording Principal's same-day MRI result sat at
  // weight 100, queued behind months-old preferences, while he re-told the result across four
  // threads. The recall was not broken -- the RANKING was, and nothing could fix it.
  //
  // Status and weight are independently optional: send either, or both.
  const hasStatus = typeof body.status === "string" && body.status !== "";
  const hasWeight = body.weight !== undefined && body.weight !== null;
  // category (B3, 2026-10-18): re-file a fact without rewriting it. Trimmed + lowercased, then held
  // to the same shape the writer produces so a PATCH cannot invent a category the render cannot title.
  const hasCategory = body.category !== undefined && body.category !== null;
  // core (B3, mig 0146): mark a fact always-on (true) or return it to the per-message lane (false).
  const hasCore = body.core !== undefined && body.core !== null;
  // trust (mig 0158): Principal's adjustment of a fact's derived trust, 0..1.
  const hasTrust = body.trust !== undefined && body.trust !== null;
  if (!hasStatus && !hasWeight && !hasCategory && !hasCore && !hasTrust) return json({ error: "send status, weight, category, core and/or trust" }, 400);
  const trustVal = hasTrust ? Number(body.trust) : null;
  if (hasTrust && (!Number.isFinite(trustVal) || trustVal! < 0 || trustVal! > 1)) return json({ error: "trust must be a number 0-1" }, 400);
  if (hasCore && typeof body.core !== "boolean") return json({ error: "core must be a boolean" }, 400);
  const core = body.core === true;
  let category = "";
  if (hasCategory) {
    category = typeof body.category === "string" ? body.category.trim().toLowerCase() : "";
    if (!/^[a-z_]{2,32}$/.test(category)) {
      return json({ error: "category must match /^[a-z_]{2,32}$/ (lowercase letters and underscores)" }, 400);
    }
  }

  const status = hasStatus ? String(body.status) : "";
  if (hasStatus && !["active", "retired"].includes(status)) {
    return json({ error: "status must be active | retired" }, 400);
  }
  const weight = hasWeight ? Number(body.weight) : null;
  if (hasWeight && (!Number.isFinite(weight) || weight! < 0 || weight! > 100)) {
    // 0-100 mirrors the gate: < 100 is curated and always renders, 100 is the default tail.
    return json({ error: "weight must be a number 0-100 (under 100 = always renders)" }, 400);
  }

  const prior = await env.DB.prepare("SELECT id, status, weight, category, core, source FROM architect_facts WHERE id = ?").bind(id).first<{ id: string; status: string; weight: number; category: string; core?: number; source?: string | null }>();
  if (!prior) return json({ error: `fact ${id} does not exist` }, 404);
  // Re-ranking a retired fact is meaningless -- it renders nowhere. Reject rather than
  // silently accept a write that changes nothing a companion will ever read.
  if (prior.status === "retired") return json({ error: "a retired fact stays retired; supersede it with a new one instead" }, 409);

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (hasStatus) { sets.push("status = ?"); binds.push(status); }
  if (hasWeight) { sets.push("weight = ?"); binds.push(weight); }
  if (hasCategory) { sets.push("category = ?"); binds.push(category); }
  if (hasCore) { sets.push("core = ?"); binds.push(core ? 1 : 0); }
  if (hasTrust) { sets.push("trust = ?"); binds.push(trustVal); }

  // CONFIRMING a Discord-stated proposal (GAP-MAP A3, lib/architect-fact-proposal.ts): open -> active.
  // (1) Principal's own words, now confirmed: trust derives to 1.0 instead of keeping the 0.5 open cap
  //     (under FACTS_TRUST=on the picker scores p * trust, so a confirmed fact left at 0.5 would rarely
  //     be picked). An explicit `trust` in the body still wins.
  // (2) A correction proposal names the fact it replaces in supersedes_id WITHOUT having retired it;
  //     confirming applies it, in the same batch.
  const confirming = hasStatus && status === "active" && prior.status === "open";
  const autoTrust = confirming && !hasTrust && (prior.source ?? "").startsWith(PROPOSAL_SOURCE_PREFIX);
  const correctedId = confirming ? await pendingCorrectionTarget(env, id) : null;
  const retireCorrected = correctedId
    ? [env.DB.prepare("UPDATE architect_facts SET status = 'retired', updated_at = datetime('now') WHERE id = ? AND status = 'active'").bind(correctedId)]
    : [];
  const update = (withAutoTrust: boolean) => env.DB.prepare(
    `UPDATE architect_facts SET ${[...sets, ...(withAutoTrust ? ["trust = ?"] : [])].join(", ")}, updated_at = datetime('now') WHERE id = ?`,
  ).bind(...binds, ...(withAutoTrust ? [1.0] : []), id);
  const write = async (withAutoTrust: boolean) => {
    if (retireCorrected.length === 0) await update(withAutoTrust).run();
    else await env.DB.batch([update(withAutoTrust), ...retireCorrected]);
  };
  try {
    await write(autoTrust);
  } catch (e) {
    if (hasTrust && schemaGap(e)) return json({ error: "trust is not available until migration 0158 is applied" }, 409);
    if (autoTrust && schemaGap(e)) await write(false);
    else throw e;
  }
  if (correctedId) await env.VECTORIZE.deleteByIds([`architect_facts:${correctedId}`]).catch(() => {});

  return json({
    ok: true, id,
    ...(correctedId ? { corrected: correctedId } : {}),
    ...(autoTrust ? { trust: 1.0 } : {}),
    ...(hasStatus ? { from: prior.status, status } : {}),
    ...(hasWeight ? { from_weight: prior.weight, weight } : {}),
    ...(hasCategory ? { from_category: prior.category, category } : {}),
    ...(hasCore ? { from_core: prior.core === 1, core } : {}),
    ...(hasTrust ? { trust: trustVal } : {}),
  });
}

export async function getArchitectFacts(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;
  const rows = await activeFacts(env);
  return json({ count: rows.length, facts: rows });
}

const KNOWN_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

export async function getArchitectFactsRender(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  // ?companion=cypher|drevan|gaia selects whose voice is "home" for this render (SOUL.md mode --
  // that companion's own facts stay unlabeled, everyone else's get `[noted by <companion>]`).
  // Omit it for the shared render (shared_system_context.md): every authored fact is labeled,
  // because no single companion there is the one speaking in first person.
  const companionParam = new URL(request.url).searchParams.get("companion");
  if (companionParam !== null && !KNOWN_COMPANIONS.has(companionParam)) {
    return json({ error: "companion must be cypher | drevan | gaia" }, 400);
  }

  const scopeParam = new URL(request.url).searchParams.get("scope");
  if (scopeParam !== null && scopeParam !== "core") {
    return json({ error: "scope must be core (or omitted)" }, 400);
  }

  const rows = await activeFacts(env);
  if (scopeParam === "core") {
    const coreCount = rows.filter(r => r.status === "active" && r.core === 1).length;
    const coreNote =
      `Generated from Halseth architect_facts (${coreCount} core). Do NOT hand-edit this block: ` +
      `edit the store instead, via ask_librarian, and the next sync rewrites every copy. Learned in ` +
      `conversation by Cypher, Drevan and Gaia; their own record, held for their own use.`;
    return new Response(renderFactsBlock(rows, coreNote, companionParam, undefined, undefined, "core"), {
      headers: { "content-type": "text/markdown; charset=utf-8" },
    });
  }
  // No timestamp in the note: it would change the bytes on every call and defeat the sync job's
  // "has anything actually changed?" comparison. The count is the useful, stable signal.
  const note =
    `Generated from Halseth architect_facts (${rows.length} live). Do NOT hand-edit this block: ` +
    `edit the store instead, via ask_librarian, and the next sync rewrites every copy. Learned in ` +
    `conversation by Cypher, Drevan and Gaia; their own record, held for their own use.`;
  const body = renderFactsBlock(rows, note, companionParam, undefined,
    activeFactsTailBudget(env.ARCHITECT_FACTS_TAIL_BUDGET));
  return new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

/**
 * Record a fact, or supersede one. A companion may do this itself -- that is the entire point, and
 * the reason the Hermes queue existed was that they could not.
 */
export async function postArchitectFact(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const fact = typeof body.fact === "string" ? body.fact.trim() : "";
  if (!fact) return json({ error: "fact is required" }, 400);
  if (fact.length > MAX_FACT_CHARS) {
    return json({ error: `fact exceeds ${MAX_FACT_CHARS} chars; split it into two facts` }, 400);
  }

  const status = typeof body.status === "string" ? body.status : "active";
  if (!["active", "open", "retired"].includes(status)) {
    return json({ error: "status must be active | open | retired" }, 400);
  }

  // The write itself -- supersede resolution, the novelty gate, the INSERT/retire batch, the vector
  // -- lives in lib/architect-fact-write.ts, shared with the Librarian executor. Until 2026-10-07
  // this handler had the gate and the executor did not, so the companions' own writes were never
  // deduped and never indexed (the 09-24 / 09-26 notes that used to sit here moved there with it).
  const result = await writeArchitectFact(env, {
    fact,
    category: typeof body.category === "string" ? body.category : null,
    status: status as "active" | "open" | "retired",
    companionId: typeof body.companion_id === "string" ? body.companion_id : null,
    source: typeof body.source === "string" ? body.source : null,
    supersedesId: typeof body.supersedes_id === "string" ? body.supersedes_id : null,
    weight: body.weight === undefined || body.weight === null ? null : Number(body.weight),
  });
  if (result.kind === "invalid") return json({ error: result.error }, 400);
  if (result.kind === "deduped") {
    return json({
      ok: true,
      deduped: true,
      novelty: { action: "skip", match_id: result.matchId, score: result.score },
      id: result.matchId,
    });
  }
  return json({
    ok: true, id: result.id, supersedes_id: result.supersedesId, status: result.status, category: result.category,
    ...(result.related ? { related: result.related } : {}),
  });
}

const SHORTLIST_DEFAULT_K = 12;
const SHORTLIST_MAX_K = 30;
const SHORTLIST_MAX_Q = 2000;

/**
 * GET /identity/architect-facts/shortlist?q=&k=&companion=&text=
 *
 * B3 (facts out of SOUL): the facts a turn is actually about, by meaning, instead of the whole
 * block in every prompt. Embeds q, queries the architect_facts vectors, joins to D1 and keeps only
 * live rows (active|open): retired or missing rows are dropped. Vectorize is a disposable index;
 * D1 decides what is alive. `fact` text is returned only with text=1. `companion` is validated but
 * does not filter (facts are shared).
 */
export async function getArchitectFactsShortlist(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  const url = new URL(request.url);
  const companionParam = url.searchParams.get("companion");
  if (companionParam !== null && !KNOWN_COMPANIONS.has(companionParam)) {
    return json({ error: "companion must be cypher | drevan | gaia" }, 400);
  }
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, SHORTLIST_MAX_Q);
  if (!q) return json({ error: "q is required" }, 400);

  const kRaw = url.searchParams.get("k");
  let k = kRaw === null || kRaw === "" ? SHORTLIST_DEFAULT_K : Number.parseInt(kRaw, 10);
  if (!Number.isFinite(k)) k = SHORTLIST_DEFAULT_K;
  k = Math.min(Math.max(k, 1), SHORTLIST_MAX_K);
  const withText = url.searchParams.get("text") === "1";

  let matches: Array<{ id: string; score: number }>;
  try {
    const vector = await embedText(env, q);
    if (!vector) throw new Error("embedding returned no vector");
    const res = await env.VECTORIZE.query(vector, {
      // Headroom: core facts are dropped below, and they sit in the top of most queries.
      topK: Math.min(k * 4, 50),
      filter: { table: "architect_facts" },
    });
    matches = (res.matches ?? []).map((m) => ({ id: String(m.id), score: m.score ?? 0 }));
  } catch (err) {
    return json({ items: [], error: `shortlist unavailable: ${String(err instanceof Error ? err.message : err)}` }, 502);
  }

  const prefix = "architect_facts:";
  const scored = new Map<string, number>();
  for (const m of matches) {
    if (!m.id.startsWith(prefix)) continue;
    const rowId = m.id.slice(prefix.length);
    if (!rowId) continue;
    if (!scored.has(rowId) || m.score > (scored.get(rowId) as number)) scored.set(rowId, m.score);
  }
  if (scored.size === 0) return json({ items: [], model: EMBEDDING_MODEL });

  const ids = [...scored.keys()];
  type Row = { id: string; category: string; status: string; fact: string; created_at?: string | null; core?: number | null; trust?: number | null; source?: string | null };
  let rows: Row[];
  try {
    // Open rows are fetched in full (not just the matched ids) because the render's cap is over ALL
    // open facts: a held one must stay held even when it is the only open fact the query matched.
    // `trust` (mig 0158) is read when the column exists; before the migration the pre-0158 select runs.
    const shortlistSql = (cols: string) =>
      `SELECT ${cols} FROM architect_facts
        WHERE status IN ('active', 'open') AND (status = 'open' OR id IN (${ids.map(() => "?").join(",")}))`;
    const res = await env.DB.prepare(shortlistSql("id, category, status, fact, created_at, core, source, trust")).bind(...ids).all<Row>()
      .catch((e: unknown) => (schemaGap(e)
        ? env.DB.prepare(shortlistSql("id, category, status, fact, created_at, core, source")).bind(...ids).all<Row>()
        : Promise.reject(e)));
    const all = res.results ?? [];
    // Same open-fact gate as the render (lib/open-facts-gate.ts): 14-day age cap AND the 8-row cap,
    // newest first. A fact the render would hold is not live here either. Active facts are unaffected.
    const shownOpen = new Set(gateOpenFacts(all).shown.map(r => r.id));
    rows = all.filter(r =>
      scored.has(r.id) &&
      // Core facts are always in the prompt (render scope=core); injecting them again is a duplicate.
      // Only ACTIVE core is excluded: scope=core never renders open rows, so an open core fact has
      // no other route to a prompt.
      !(r.status === "active" && r.core === 1) &&
      // An UNREVIEWED Discord-stated proposal (lib/architect-fact-proposal.ts) never rides the per-message
      // picker: facts-pick renders a pick as a flat fact line, which would be auto-trust. It reaches a
      // prompt only as an orient question, or as a fact once Principal (or a companion) confirms it.
      !(r.status === "open" && (r.source ?? "").startsWith(PROPOSAL_SOURCE_PREFIX)) &&
      (r.status !== "open" || shownOpen.has(r.id)));
  } catch (err) {
    return json({ items: [], error: `shortlist unavailable: ${String(err instanceof Error ? err.message : err)}` }, 502);
  }

  const items = rows
    .map((r) => ({
      id: r.id,
      category: r.category,
      status: r.status as "active" | "open",
      score: scored.get(r.id) ?? 0,
      // NULL/absent = legacy row = full trust; the bots read null as 1.0.
      trust: typeof r.trust === "number" ? r.trust : null,
      ...(withText ? { fact: r.fact } : {}),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  return json({ items, model: EMBEDDING_MODEL });
}

/**
 * POST /identity/architect-facts/proposals   (GAP-MAP A3, 2026-11-11)
 * body: { fact, category?, companion_id, channel_id, message_id, stated_at?, correction? }
 *
 * The bots' write path for a fact Principal STATED in Discord (nullsafe-discord facts-write.ts,
 * FACTS_WRITE=on). Lands `status='open'` for review on Hearth /facts, never active; refuses
 * health/care/body facts by category (lib/architect-fact-proposal.ts). Answers:
 *   201 { ok, outcome: "proposed", id, corrects_id }   200 { ok, outcome: duplicate|held|known, id }
 *   422 { ok: false, outcome: "refused", category }    400 { ok: false, error }
 * Never echoes the fact text.
 */
export async function postArchitectFactProposal(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ ok: false, error: "body must be JSON" }, 400); }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const result = await proposeArchitectFact(env, {
    fact: str(body.fact),
    category: str(body.category) || null,
    companionId: str(body.companion_id),
    channelId: str(body.channel_id),
    messageId: str(body.message_id),
    statedAt: str(body.stated_at) || null,
    correction: body.correction === true,
  });
  switch (result.kind) {
    case "invalid": return json({ ok: false, error: result.error }, 400);
    case "refused":
      console.log(`[architect-facts] proposal refused category=${result.category}`);
      return json({ ok: false, outcome: "refused", category: result.category }, 422);
    case "duplicate": return json({ ok: true, outcome: "duplicate", id: result.id });
    case "held": return json({ ok: true, outcome: "held", id: result.matchId, score: result.score });
    case "known": return json({ ok: true, outcome: "known", id: result.matchId, score: result.score });
    case "proposed":
      return json({ ok: true, outcome: "proposed", id: result.id, corrects_id: result.correctsId, corrects_score: result.correctsScore }, 201);
  }
}
