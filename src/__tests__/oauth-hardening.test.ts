import { describe, it, expect } from "vitest";
import { postOAuthAuthorize, postOAuthRegister, isValidRedirectUri } from "../handlers/oauth";
import { safeEqual } from "../lib/auth";
import { AUTH_FAIL_LIMIT } from "../lib/auth-throttle";
import { makeFakeKV } from "./helpers/fake-kv";

const ADMIN = "correct-horse";

function makeDB() {
  const inserted: unknown[][] = [];
  return {
    inserted,
    prepare(sql: string) {
      let args: unknown[] = [];
      const st = {
        bind(...a: unknown[]) { args = a; return st; },
        async first() {
          if (sql.includes("FROM oauth_clients")) return { redirect_uris: JSON.stringify(["https://cb.example/cb"]) };
          return null;
        },
        async run() { inserted.push([sql, ...args]); return {}; },
      };
      return st;
    },
  } as any;
}

function authReq(secret: string, ip = "9.9.9.9") {
  const f = new URLSearchParams({
    client_id: "c1", redirect_uri: "https://cb.example/cb", state: "s",
    code_challenge_method: "S256", secret,
  });
  return new Request("https://h.example/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "CF-Connecting-IP": ip },
    body: f.toString(),
  });
}

describe("POST /oauth/authorize failure throttle", () => {
  it("5 wrong passphrases re-render (401); the 6th is 429, even with the right one", async () => {
    const env = { ADMIN_SECRET: ADMIN, DB: makeDB(), LIBRARIAN_KV: makeFakeKV() } as any;
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) {
      expect((await postOAuthAuthorize(authReq("wrong"), env)).status).toBe(401);
    }
    expect((await postOAuthAuthorize(authReq("wrong"), env)).status).toBe(429);
    expect((await postOAuthAuthorize(authReq(ADMIN), env)).status).toBe(429);
  });

  it("a correct passphrase after a few typos still succeeds and clears the counter", async () => {
    const kv = makeFakeKV();
    const env = { ADMIN_SECRET: ADMIN, DB: makeDB(), LIBRARIAN_KV: kv } as any;
    for (let i = 0; i < AUTH_FAIL_LIMIT - 1; i++) await postOAuthAuthorize(authReq("wrong"), env);
    expect((await postOAuthAuthorize(authReq(ADMIN), env)).status).toBe(302);
    expect(kv.store.size).toBe(0);
    // counter was reset: another 4 typos are still allowed
    for (let i = 0; i < AUTH_FAIL_LIMIT - 1; i++) {
      expect((await postOAuthAuthorize(authReq("wrong"), env)).status).toBe(401);
    }
  });

  it("is keyed per IP and failures carry a TTL", async () => {
    const kv = makeFakeKV();
    const env = { ADMIN_SECRET: ADMIN, DB: makeDB(), LIBRARIAN_KV: kv } as any;
    for (let i = 0; i < AUTH_FAIL_LIMIT; i++) await postOAuthAuthorize(authReq("wrong", "1.1.1.1"), env);
    expect((await postOAuthAuthorize(authReq("wrong", "1.1.1.1"), env)).status).toBe(429);
    expect((await postOAuthAuthorize(authReq(ADMIN, "2.2.2.2"), env)).status).toBe(302);
    expect(kv.ttls.get("oauth-authfail:1.1.1.1")).toBe(900);
  });
});

describe("OAUTH_PASSPHRASE", () => {
  it("when set, it is the login passphrase and ADMIN_SECRET is refused", async () => {
    const env = { ADMIN_SECRET: ADMIN, OAUTH_PASSPHRASE: "login-only", DB: makeDB(), LIBRARIAN_KV: makeFakeKV() } as any;
    expect((await postOAuthAuthorize(authReq(ADMIN), env)).status).toBe(401);
    expect((await postOAuthAuthorize(authReq("login-only"), env)).status).toBe(302);
  });

  it("when unset, ADMIN_SECRET still works", async () => {
    const env = { ADMIN_SECRET: ADMIN, DB: makeDB(), LIBRARIAN_KV: makeFakeKV() } as any;
    expect((await postOAuthAuthorize(authReq(ADMIN), env)).status).toBe(302);
  });
});

describe("redirect_uri validation", () => {
  it("accepts https and loopback http", () => {
    for (const u of ["https://claude.ai/api/mcp/auth_callback", "https://x.example/cb?a=1", "http://localhost:3000/cb", "http://127.0.0.1/cb", "http://[::1]:8080/cb"]) {
      expect(isValidRedirectUri(u), u).toBe(true);
    }
  });
  it("rejects dangerous or malformed values", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,x", "http://evil.example/cb", "ftp://x.example/", "myapp://cb", "not a url", "", "https://u:you@example.com/cb", "https://x.example/cb#frag", 42, null, {}]) {
      expect(isValidRedirectUri(u), String(u)).toBe(false);
    }
  });
  it("register returns 400 invalid_redirect_uri and stores nothing on a bad uri", async () => {
    const db = makeDB();
    const req = (body: unknown) => new Request("https://h.example/oauth/register", { method: "POST", body: JSON.stringify(body) });
    for (const body of [{ redirect_uris: ["javascript:alert(1)"] }, { redirect_uris: ["https://ok.example/cb", "data:x"] }, {}, { redirect_uris: [] }]) {
      const res = await postOAuthRegister(req(body), { DB: db } as any);
      expect(res.status).toBe(400);
      expect((await res.json() as any).error).toBe("invalid_redirect_uri");
    }
    expect(db.inserted.length).toBe(0);
    const ok = await postOAuthRegister(req({ client_name: "c", redirect_uris: ["https://claude.ai/cb"] }), { DB: db } as any);
    expect(ok.status).toBe(201);
    expect(db.inserted.length).toBe(1);
  });
});

describe("safeEqual", () => {
  it("keeps semantics across equal, unequal, and length-mismatched inputs", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abcd", "abc")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});
