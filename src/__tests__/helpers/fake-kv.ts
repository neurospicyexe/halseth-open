/** Minimal in-memory KVNamespace for tests (get/put/delete; TTL recorded, not enforced). */
export function makeFakeKV() {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv = {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => { store.set(k, v); ttls.set(k, opts?.expirationTtl); },
    delete: async (k: string) => { store.delete(k); ttls.delete(k); },
    store, ttls,
  };
  return kv as any;
}
