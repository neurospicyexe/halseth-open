// B64.1: the tone of a reply to a Sol post, one word, through the PetModel seam.
//
// The reply text exists only inside classifyTone's call. Nothing here stores it or logs it, and the model
// seam (model.ts) logs only vendor and status. Every failure is `neutral`: a dead model never makes Sol
// think someone was cold to him.
import type { PetModel } from "./model.js";

export type Tone = "warm" | "neutral" | "cold" | "harsh";
export const TONES: readonly Tone[] = ["warm", "neutral", "cold", "harsh"];

export const TONE_INPUT_CAP = 500;
export const TONE_TIMEOUT_MS = 4000;
/** Low: a classifier, not a voice. */
export const TONE_TEMPERATURE = 0;
/**
 * One word of content. The PetModel seam adds the reasoning headroom on the wire (synthesis/deepseek.ts
 * contentBudget) and has no switch to turn reasoning off; measured on flash a classifier prompt reasons in
 * 1.6-2.0s, inside the 4s timeout. A vendor reasoning flag is unverified there, and a 400 never fails over,
 * so it is not sent (it would turn every tone neutral).
 */
const TONE_MAX_TOKENS = 4;

const SYSTEM =
  "You read one short chat message someone sent to Sol, a pet crow, and judge only how it treats him. " +
  "Answer with exactly one word: warm (affectionate, playful, kind), neutral (plain, ordinary, unclear), " +
  "cold (dismissive, curt, ignoring him), or harsh (insulting, threatening, cruel). " +
  "Teasing between friends is warm or neutral, not harsh. Output the one word and nothing else.";

function parseToneStrict(raw: string): Tone | null {
  const w = raw.trim().toLowerCase().replace(/[.!"'`*]+$/g, "").replace(/^["'`*]+/, "");
  return (TONES as readonly string[]).includes(w) ? (w as Tone) : null;
}

/** Exactly one of the four words (case, whitespace and trailing punctuation tolerated), else neutral. */
export function parseTone(raw: string | null | undefined): Tone {
  return typeof raw === "string" ? parseToneStrict(raw) ?? "neutral" : "neutral";
}

/** One line, never the text: why a reply's tone fell back to neutral. */
function logFallback(reason: string): void {
  console.log(`[sol-reply] tone fallback ${reason}`);
}

export async function classifyTone(model: PetModel | null, text: string): Promise<Tone> {
  const t = typeof text === "string" ? text.trim().slice(0, TONE_INPUT_CAP) : "";
  if (!t) return "neutral"; // nothing to read: not a fallback, no call
  if (!model) { logFallback("no_model"); return "neutral"; }
  let raw: string | null;
  try {
    raw = await model.complete(SYSTEM, t, TONE_MAX_TOKENS, TONE_TIMEOUT_MS);
  } catch {
    logFallback("error"); // the error message is not logged: it is not ours to trust
    return "neutral";
  }
  if (raw === null) { logFallback("no_answer"); return "neutral"; }
  const w = parseToneStrict(raw);
  if (!w) { logFallback("invalid"); return "neutral"; }
  return w;
}

// ── Habituation (B64.1, Principal: Sol gets bored of the same reply) ───────────────
//
// A reply-tend stores a FINGERPRINT, never the text: "v1:" + the sorted set of up to 64 distinct shingle
// hashes, comma joined. Each shingle hash is HMAC-SHA-256 under a key derived from ADMIN_SECRET
// (HMAC(ADMIN_SECRET, "sol-reply-fp-v1")), truncated to 32 bits (8 hex). Shingles are word 3-grams of the
// lowercased, punctuation-stripped text, single words when it has fewer than 3. Keyed, so a dictionary of
// common words or 3-grams cannot reverse it without the secret; order is gone too.
// If ADMIN_SECRET rotates, old fingerprints simply stop matching: habituation resets, which is acceptable.
// The "v1:" prefix lets a future scheme tell its rows apart (different versions never match).
export const FP_VERSION = "v1";
export const FP_MAX_SHINGLES = 64;
export const REPEAT_LOOKBACK = 5;
export const REPEAT_JACCARD = 0.5;
/** Only the triad habituate him. Principal saying "good boy" every day is fine. */
export const HABITUATING_ACTORS = new Set<string>(["cypher", "drevan", "gaia"]);

const enc = new TextEncoder();
const toHex = (buf: ArrayBuffer, bytes: number) =>
  [...new Uint8Array(buf).slice(0, bytes)].map(b => b.toString(16).padStart(2, "0")).join("");

/** The fingerprint key: HMAC(secret, "sol-reply-fp-v1"), imported as an HMAC-SHA-256 key. */
export async function fingerprintKey(secret: string): Promise<CryptoKey> {
  const root = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", root, enc.encode("sol-reply-fp-v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function replyFingerprint(text: string, key: CryptoKey): Promise<string | null> {
  const words = (typeof text === "string" ? text : "").slice(0, TONE_INPUT_CAP).toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const shingles = [...new Set(words.length < 3
    ? words
    : words.slice(0, words.length - 2).map((_, i) => `${words[i]} ${words[i + 1]} ${words[i + 2]}`))];
  const hashes = await Promise.all(
    shingles.map(async sh => toHex(await crypto.subtle.sign("HMAC", key, enc.encode(sh)), 4)),
  );
  return `${FP_VERSION}:` + [...new Set(hashes)].sort().slice(0, FP_MAX_SHINGLES).join(",");
}

/** Jaccard over two fingerprints. Different (or missing) scheme versions never match. */
export function fingerprintJaccard(a: string, b: string): number {
  const split = (fp: string): [string, Set<string>] | null => {
    const i = fp.indexOf(":");
    if (i <= 0) return null;
    return [fp.slice(0, i), new Set(fp.slice(i + 1).split(",").filter(Boolean))];
  };
  const pa = split(a), pb = split(b);
  if (!pa || !pb || pa[0] !== pb[0]) return 0;
  const [, A] = pa; const [, B] = pb;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

export function isRepeat(fp: string, recent: readonly string[]): boolean {
  return recent.some(r => fingerprintJaccard(fp, r) >= REPEAT_JACCARD);
}

/** A repeat dulls the tone one notch: warm -> neutral -> cold; cold and harsh stay (boredom, not a grudge). */
export function stepDownTone(t: Tone): Tone {
  return t === "warm" ? "neutral" : t === "neutral" ? "cold" : t;
}
