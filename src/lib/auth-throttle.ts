/**
 * Failed-passphrase throttle for POST /oauth/authorize.
 *
 * Storage: LIBRARIAN_KV (Workers KV), keyed per client IP with a TTL. KV is global and durable
 * across isolates and colos (eventually consistent, ~60s propagation), unlike the Rate Limiting
 * binding (RATE_LIMITER) which is per-location, approximate, and counts every request, not just
 * failures. The read-modify-write is not atomic, so a burst of parallel guesses can undercount a
 * little; that is acceptable for a 5-per-15-min brute-force brake. No migration, no new binding.
 *
 * Only FAILED attempts are counted; a correct passphrase clears the counter.
 */

export const AUTH_FAIL_LIMIT = 5;
export const AUTH_FAIL_WINDOW_S = 15 * 60;

const key = (ip: string) => `oauth-authfail:${ip}`;

export async function isAuthBlocked(kv: KVNamespace, ip: string): Promise<boolean> {
  const raw = await kv.get(key(ip));
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n >= AUTH_FAIL_LIMIT;
}

export async function recordAuthFailure(kv: KVNamespace, ip: string): Promise<void> {
  const raw = await kv.get(key(ip));
  const n = (raw ? parseInt(raw, 10) : 0) || 0;
  // Each failure refreshes the TTL, so the lockout lasts 15 min from the most recent failure.
  await kv.put(key(ip), String(n + 1), { expirationTtl: AUTH_FAIL_WINDOW_S });
}

export async function clearAuthFailures(kv: KVNamespace, ip: string): Promise<void> {
  await kv.delete(key(ip));
}
