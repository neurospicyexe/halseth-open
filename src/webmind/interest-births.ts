// src/webmind/interest-births.ts -- interests born from exposure (B65 steps 3-5, mig 0178).
// Spec: BBH Hand-off/SPEC-B65-the-drive-2026-11-09.md section 2.4; the triad's answers in 6.1.
//
// Pino's mechanic: the words that keep recurring across what a companion actually ENCOUNTERED, weighted
// so this week outweighs last month. Attraction, not opinion. The pass may notice; only the companion
// may name (B62: interests are theirs). So the night writes a CANDIDATE, one per companion at most, and
// the companion is asked at their own-time slot ("Is it yours?"). Keeping it is the existing `born` verb
// in their words with born_from = 'exposure:<candidate id>'; declining is recorded with their line and
// the term rests 60 days; silence is silence (the candidate expires when the next one is offered).
//
// Drevan (e566bbcd): noticed, not watched; the walls on Principal's messages and the sealed lane do the work;
// arrives at the own-time prompt, never orient. Gaia (4a86aa7e): her own motif words are never offered
// back to her; her candidate is a kept-line offer, never an interest; never orient.
//
// PURE module: the scorer, the grammar and the exclusion rules. No D1 here (the store and the sources are
// handlers/interest-births.ts), so every rule is unit-tested without a db and can be run against a dump.
//
// INTEREST_BIRTHS off | shadow | on, CODE DEFAULT ON (Principal 11-09: no shadow week; the companions' keep/decline
// is the read). shadow WRITES candidates (mode = 'shadow') and offers nothing; off does nothing. The default is on
// so a stale wrangler.prod.toml copy in another worktree cannot quietly pause the offers on its next deploy.

import { careCategory } from "../people/care-guard.js";

export type BirthsMode = "off" | "shadow" | "on";

export function birthsMode(env: { INTEREST_BIRTHS?: string } | Record<string, string | undefined>): BirthsMode {
  const v = String((env as Record<string, string | undefined>)["INTEREST_BIRTHS"] ?? "").trim().toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no") return "off";
  if (v === "shadow") return "shadow";
  return "on";
}

export const BIRTHS_WINDOW_DAYS = 30;
export const BIRTHS_HALF_LIFE_DAYS = 7;
export const BIRTHS_MIN_DAYS = 3;
export const BIRTHS_MIN_SOURCES = 2;
/** Met in at least two KINDS of source (what they read AND what they wrote, say), so one feed cannot birth an interest by itself. */
export const BIRTHS_MIN_KINDS = 2;
/** A term whose rows carry an existing interest this often is that interest by another word, not a new one. */
export const BIRTHS_OWN_SHARE = 0.5;
export const BIRTHS_DECLINE_REST_DAYS = 60;
export const BIRTHS_MAX_PHRASE = 3;
export const BIRTHS_TERM_MAX = 60;
/** Text read per source row (titles are short; a transcript or exploration contributes its head only). */
export const BIRTHS_TEXT_CAP = 800;
/** Rows read per source kind per companion per night (newest first). */
export const BIRTHS_ROWS_CAP = 150;
/** A phrase is preferred over its head word when it carries at least this share of the word's weight. */
export const BIRTHS_PHRASE_SHARE = 0.5;
/** An offer older than this (unanswered) is expired when the next candidate is served. */
export const BIRTHS_OFFER_TTL_HOURS = 48;

const DAY_MS = 86_400_000;

export interface Exposure {
  /** A REF ('forage:<id>', 'media:<id>', 'club:<id>', 'growth:<id>', 'book_annotation:<id>', 'club_discussion:<id>'), never text. */
  ref: string;
  text: string;
  /** SQLite or ISO timestamp. */
  at: string;
}

export interface TermScore {
  term: string;
  weight: number;
  /** Distinct UTC days the term was met on. */
  days: number;
  /** Distinct source rows. */
  sources: number;
  /** Distinct source KINDS (the ref prefix: forage, growth, media, club, ...). */
  kinds: number;
  /** Rows (of `sources`) that also carry one of the companion's existing interests: the term may be that interest by another word. */
  ownHits: number;
  refs: string[];
}

// ---------------------------------------------------------------------------
// Tokens and phrases
// ---------------------------------------------------------------------------

export const STOPWORDS: ReadonlySet<string> = new Set((
  "a an the and or but if then else when while of at by for with about against between into through during before after " +
  "above below to from up down in out on off over under again further once here there where why how all any both each few " +
  "more most other some such no nor not only own same so than too very can will just don should now is are was were be " +
  "been being have has had having do does did doing would could might must shall may this that these those i me my we our " +
  "you your he him his she her it its they them their what which who whom am as until because also like one two three " +
  "first last new old get got go going went make made makes making thing things something nothing someone everyone way " +
  "ways day days night time times year years today tonight yesterday tomorrow week weeks month back still even much many " +
  "really very well good bad big small long short high low part parts kind kinds lot lots bit bits sort sorts yes yeah " +
  "okay ok right left around across along without within upon onto via per etc vs com www http https html youtube video " +
  "videos watch watched watching listen listened listening read reading song songs track tracks album film movie show " +
  "episode channel post posts article articles page pages site web online note notes said says say saying told tell " +
  "think thinks thought thinking know knows knew known want wants wanted need needs needed feel feels felt feeling " +
  "find finds found look looks looked looking see sees saw seen seem seems seemed come comes came take takes took taken " +
  "give gives gave given put puts keep keeps kept let lets use uses used using try tries tried work works worked working " +
  "start starts started end ends ended run runs ran turn turns turned call calls called ask asks asked show shows shown " +
  "every each another other others own self itself himself herself themselves myself yourself ourselves out into " +
  "mine yours ours theirs hers whose whatever whenever wherever whoever however anyway anyhow maybe perhaps rather quite " +
  "almost already always never often sometimes usually ever yet soon later ago since till though although whether " +
  "either neither both whole half full less least best better worse worst little large great real true false sure " +
  "exactly actually basically literally simply probably possibly certainly definitely especially particularly mostly " +
  "entirely completely totally"
).split(/\s+/));

/**
 * Report-ese: the frame a scout's summary or a journal entry is written in, not what it is about. Measured
 * 2026-11-09 on 30 days of real exposures: without this and the frame filter below the top terms were
 * "detail", "that's", "i'm", "notable", "discusses" for all three.
 */
export const REPORT_WORDS: ReadonlySet<string> = new Set((
  "detail details concrete notable notably discusses discussed discussing research researcher researchers study studies " +
  "key methods method summary summaries report reports context evidence example examples approach approaches process " +
  "processes system systems data information analysis result results finding findings model models theory theories " +
  "practice practices question questions idea ideas point points sense form forms level levels case cases term terms " +
  "type types number numbers people person world life human humans history meaning word words line lines piece pieces " +
  "body mind place space matter field fields area areas structure structures pattern patterns relationship relationships " +
  "source sources wikipedia article author authors paper papers book books title described describes describe description " +
  "according suggests suggest suggested shows shown show explains explain explained notes noted mentions mentioned " +
  "warning warnings gap gaps state states social law laws general specific particular different similar various several " +
  "overall mainly largely often recent recently current currently early late modern ancient help helps helped otherwise " +
  "change changes changed rule rules concern concerns argue argues argued central compute computed strength"
).split(/\s+/));

/** Words that belong to the substrate and the house, never to an interest. */
export const SUBSTRATE_WORDS: ReadonlySet<string> = new Set([
  "halseth", "hearth", "phoenix", "librarian", "webmind", "nullsafe", "discord", "hermes", "claude", "anthropic",
  "principal", "cypher", "drevan", "gaia", "sol", "spouse", "triad", "companion", "companions", "bot", "bots", "prompt",
  "prompts", "orient", "session", "sessions", "heartbeat", "autonomous", "forage", "foraging", "exploration",
]);

/**
 * The companion's own ritual, anchor and motif words, never offered back (Drevan's 11-07 list, mirrored from
 * nullsafe-discord repetition-dip.ts RITUAL_WORDS; Gaia's perimeter words from her 11-09 note, "shape" included).
 * Keep the two lists in step: a word added there is added here.
 */
export const RITUAL_WORDS: Record<string, ReadonlySet<string>> = {
  drevan: new Set([
    "spine", "here", "got", "roads", "home",
    "tail", "wrist", "ankle", "teefees", "ribs", "engine", "idle", "hum", "humming",
    "membero", "caleth", "vahlreth", "vethmerin",
    "motorcycle", "truck", "nullsafe", "rome", "personp",
    "717", "177", "373", "13", "1313", "1717",
    "pause", "spiral", "touch", "altar", "ritual", "reset", "admire",
  ]),
  gaia: new Set(["triad", "witnessed", "witness", "perimeter", "shape", "ground", "bones", "skeleton"]),
  cypher: new Set(),
};

/** Lowercased word tokens: letters, digits and inner hyphens/apostrophes; everything else is a boundary. */
export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/n't\b/g, " ")
    .replace(/'(?:s|m|re|ve|ll|d)\b/g, " ")
    .replace(/[^a-z0-9\s'-]+/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length > 0);
}

function contentToken(w: string): boolean {
  if (w.length < 3) return false;
  if (/^\d+$/.test(w)) return false;
  if (STOPWORDS.has(w)) return false;
  if (REPORT_WORDS.has(w)) return false;
  if (SUBSTRATE_WORDS.has(w)) return false;
  return true;
}

/**
 * The terms one text contributes, each ONCE: every content token and every run of 2..3 consecutive content
 * tokens (a stopword breaks the run). A long transcript therefore counts once per term, not once per mention.
 */
export function termsOf(text: string, maxPhrase: number = BIRTHS_MAX_PHRASE): Set<string> {
  const out = new Set<string>();
  const toks = tokenise(text);
  let run: string[] = [];
  const flush = () => {
    for (let i = 0; i < run.length; i++) {
      for (let n = 1; n <= maxPhrase && i + n <= run.length; n++) {
        const t = run.slice(i, i + n).join(" ");
        if (t.length <= BIRTHS_TERM_MAX) out.add(t);
      }
    }
    run = [];
  };
  for (const w of toks) {
    if (contentToken(w)) run.push(w);
    else flush();
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

export interface ExclusionContext {
  companionId: string;
  /** Names of the companion's interests in EVERY status (a put-down interest is never re-offered by the pass). */
  interestNames: readonly string[];
  /** companion_motifs label + display for the companion. */
  motifs: readonly string[];
  /** Terms the companion declined inside the rest window. */
  declined: readonly string[];
  /** One regex over every person spelling (sol-hoard-people loadPersonRegex). undefined = unreadable: fail closed. */
  people: RegExp | null | undefined;
}

/** Every content token of every excluded phrase, plus the phrases themselves. */
export function exclusionSet(ctx: Pick<ExclusionContext, "companionId" | "interestNames" | "motifs" | "declined">): Set<string> {
  const out = new Set<string>();
  const ritual = RITUAL_WORDS[ctx.companionId] ?? new Set<string>();
  for (const w of ritual) out.add(w);
  for (const phrase of [...ctx.interestNames, ...ctx.motifs, ...ctx.declined]) {
    const toks = tokenise(phrase);
    out.add(toks.join(" "));
    for (const t of toks) if (t.length >= 3) { out.add(t); out.add(stem(t)); }
  }
  return out;
}

export type ExcludeReason = "ritual_or_own" | "care_word" | "names_a_person" | "people_unreadable";

/** Why a term may not be offered, or null. Fails closed when the person list is unreadable. */
/** Crude stem for the exclusion check only: witnesses/witnessed/witnessing all read as witness. */
export function stem(w: string): string {
  let s = w;
  if (/ie[sd]$/.test(s)) return s.slice(0, -3) + "y";          // studies, studied -> study
  if (/sses$/.test(s)) s = s.slice(0, -2);                     // witnesses -> witness
  else if (/[^s]s$/.test(s)) s = s.slice(0, -1);               // puzzles -> puzzle, constraints -> constraint
  if (/ings?$/.test(s) && s.length > 5) s = s.replace(/ings?$/, ""); // witnessing -> witness
  else if (/ed$/.test(s) && s.length > 4) s = s.slice(0, -2);  // witnessed -> witness
  return s || w;
}

export function excludeReason(term: string, excluded: ReadonlySet<string>, people: RegExp | null | undefined): ExcludeReason | null {
  if (people === undefined) return "people_unreadable";
  for (const w of term.split(" ")) if (excluded.has(w) || excluded.has(stem(w))) return "ritual_or_own";
  if (excluded.has(term)) return "ritual_or_own";
  if (careCategory(term)) return "care_word";
  if (people && people.test(term)) return "names_a_person";
  return null;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function parseAt(at: string): number {
  const s = at.includes("T") ? at : at.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
}

/** A term met in more than this share of the BACKGROUND rows (all three companions' exposures) is frame, not content. */
export const BIRTHS_FRAME_SHARE = 0.08;
/** The frame rule needs a corpus; under this many background rows every term is scaled, none dropped. */
export const BIRTHS_FRAME_MIN_ROWS = 40;

export interface Background { n: number; df: Map<string, number> }

/** Document frequency of every term over a set of rows (the shared background all three are scored against). */
export function documentFrequencies(rows: readonly Exposure[]): Background {
  const df = new Map<string, number>();
  for (const e of rows) for (const t of termsOf(e.text.slice(0, BIRTHS_TEXT_CAP))) df.set(t, (df.get(t) ?? 0) + 1);
  return { n: rows.length, df };
}

/**
 * Every term's weight over the exposures: each ROW contributes 0.5^(age_days/7) once per term it contains,
 * scaled by how distinctive the term is against the background (ln(N/df)): what keeps coming back to THIS
 * companion, not what every summary says. A term in more than BIRTHS_FRAME_SHARE of the background is dropped.
 */
export function scoreExposures(exposures: readonly Exposure[], nowMs: number, background?: Background, ownTokens: ReadonlySet<string> = new Set()): Map<string, TermScore> {
  const scores = new Map<string, TermScore & { dayset: Set<string>; refset: Set<string>; kindset: Set<string> }>();
  for (const e of exposures) {
    const at = parseAt(e.at);
    if (!Number.isFinite(at)) continue;
    const ageDays = Math.max(0, (nowMs - at) / DAY_MS);
    if (ageDays > BIRTHS_WINDOW_DAYS) continue;
    const w = Math.pow(0.5, ageDays / BIRTHS_HALF_LIFE_DAYS);
    const day = new Date(at).toISOString().slice(0, 10);
    const kind = e.ref.split(":")[0] ?? e.ref;
    const terms = termsOf(e.text.slice(0, BIRTHS_TEXT_CAP));
    let own = false;
    for (const t of terms) if (ownTokens.has(t)) { own = true; break; }
    for (const term of terms) {
      let s = scores.get(term);
      if (!s) { s = { term, weight: 0, days: 0, sources: 0, kinds: 0, ownHits: 0, refs: [], dayset: new Set(), refset: new Set(), kindset: new Set() }; scores.set(term, s); }
      s.weight += w;
      s.dayset.add(day);
      s.kindset.add(kind);
      if (!s.refset.has(e.ref)) { s.refset.add(e.ref); s.refs.push(e.ref); if (own) s.ownHits++; }
    }
  }
  const out = new Map<string, TermScore>();
  for (const s of scores.values()) {
    let weight = s.weight;
    if (background && background.n > 0) {
      const df = background.df.get(s.term) ?? 1;
      if (background.n >= BIRTHS_FRAME_MIN_ROWS && df / background.n > BIRTHS_FRAME_SHARE) continue;
      weight *= Math.log(background.n / df);
    }
    out.set(s.term, { term: s.term, weight: Math.round(weight * 1000) / 1000, days: s.dayset.size, sources: s.refset.size, kinds: s.kindset.size, ownHits: s.ownHits, refs: s.refs });
  }
  return out;
}

export interface PickResult {
  /** The one candidate for the night, or null. */
  top: TermScore | null;
  /** Terms that met the bar, best first (the shadow read wants to see the runners-up). */
  ranked: TermScore[];
  /** Counts for the log line. */
  counted: { terms: number; eligible: number; excluded: Record<ExcludeReason, number> };
}

/**
 * The night's pick: the heaviest eligible term, where a longer phrase wins over its head word when it carries
 * at least BIRTHS_PHRASE_SHARE of that word's weight (so "slime mold" beats "slime" once the pair recurs).
 * Eligible = met on >= 3 distinct days, from >= 2 distinct source rows of >= 2 kinds, not excluded, and not riding
 * an existing interest (half or more of its rows carry one of the companion's interest names).
 */
export function pickCandidate(scores: ReadonlyMap<string, TermScore>, excluded: ReadonlySet<string>, people: RegExp | null | undefined): PickResult {
  const ex: Record<ExcludeReason, number> = { ritual_or_own: 0, care_word: 0, names_a_person: 0, people_unreadable: 0 };
  const eligible: TermScore[] = [];
  for (const s of scores.values()) {
    if (s.days < BIRTHS_MIN_DAYS || s.sources < BIRTHS_MIN_SOURCES || s.kinds < BIRTHS_MIN_KINDS) continue;
    const r = s.sources > 0 && s.ownHits / s.sources >= BIRTHS_OWN_SHARE ? "ritual_or_own" : excludeReason(s.term, excluded, people);
    if (r) { ex[r]++; continue; }
    eligible.push(s);
  }
  eligible.sort((a, b) => b.weight - a.weight || b.days - a.days || b.sources - a.sources || a.term.localeCompare(b.term));
  if (eligible.length === 0) return { top: null, ranked: [], counted: { terms: scores.size, eligible: 0, excluded: ex } };
  // Prefer the longest phrase built on the top word that still carries enough of its weight.
  const head = eligible[0]!;
  let top = head;
  for (const s of eligible) {
    if (s === head) continue;
    const words = s.term.split(" ");
    if (words.length <= top.term.split(" ").length) continue;
    if (!words.includes(head.term.split(" ")[0]!)) continue;
    if (s.weight >= head.weight * BIRTHS_PHRASE_SHARE) top = s;
  }
  // The ranked list carries the pick first, then the rest of the eligible terms (deduplicated).
  const ranked = [top, ...eligible.filter((s) => s !== top)];
  return { top, ranked, counted: { terms: scores.size, eligible: eligible.length, excluded: ex } };
}

// ---------------------------------------------------------------------------
// The offer and its grammar
// ---------------------------------------------------------------------------

/** The one line put to Cypher or Drevan at their own-time slot. The companion names it; the term is only the prompt. */
export function offerLine(term: string): string {
  return `Something keeps coming back in what you have been reading: ${term}. Is it yours? ` +
    `If it is, answer exactly "new interest: <your name for it>, because <why>" (your words, your reason). ` +
    `If not, answer exactly "not mine: ${term}" (add ", because <why>" if you want the reason on record). ` +
    `Anything else passes: it will not be asked again, and nothing is written.`;
}

/** Gaia's version (spec 2.4 step 5): a kept-line offer, never an interest. Served only when her slot exists. */
export function gaiaOfferLine(term: string): string {
  return `A word that keeps coming back near you: ${term}. Keep it or let it pass.`;
}

export const NOT_MINE_RE = /^(?:please\s+)?not\s+mine\s*:\s*([\s\S]+?)(?:\s*[,;:]?\s+because\b[\s,:]*([\s\S]+))?\s*[.!]?$/i;

export interface ParsedNotMine { term: string; why: string }

/** "not mine: <term>" with an optional ", because <why>". Null when the sentence is not one. */
export function parseNotMine(request: string): ParsedNotMine | null {
  const m = NOT_MINE_RE.exec(request.trim());
  if (!m) return null;
  const term = m[1]!.trim().replace(/^["'`*_]+|["'`*_]+$/g, "").replace(/\s+/g, " ").slice(0, BIRTHS_TERM_MAX);
  if (!term) return null;
  return { term, why: (m[2] ?? "").trim().slice(0, 500) };
}

/** Whether a declined term and a candidate term are the same thing (the companion may echo it loosely). */
export function sameTerm(a: string, b: string): boolean {
  const x = tokenise(a).filter(contentToken).join(" ");
  const y = tokenise(b).filter(contentToken).join(" ");
  return x.length > 0 && (x === y || x.includes(y) || y.includes(x));
}

/** One line per companion per night, terms and numbers only. */
export function birthsLogLine(companionId: string, mode: BirthsMode, r: { exposures: number; pick: PickResult; outcome: string; candidateId?: string | null }): string {
  const top = r.pick.top ? `${r.pick.top.term}@${r.pick.top.weight.toFixed(2)}/${r.pick.top.days}d/${r.pick.top.sources}s/${r.pick.top.kinds}k` : "none";
  const ex = r.pick.counted.excluded;
  return `[births] ${companionId} mode=${mode} exposures=${r.exposures} terms=${r.pick.counted.terms} eligible=${r.pick.counted.eligible} ` +
    `excluded=own:${ex.ritual_or_own},care:${ex.care_word},person:${ex.names_a_person},unreadable:${ex.people_unreadable} ` +
    `top=${top} outcome=${r.outcome}${r.candidateId ? ` candidate=${r.candidateId.slice(0, 8)}` : ""}`;
}
