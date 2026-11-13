// Turn key phase 2: X-Turn-Id from the bots becomes one id-only `turn_request` log line.
import { describe, it, expect } from "vitest";
import { turnIdFrom, turnRequestLine, logTurnRequest, TURN_HEADER } from "../lib/turn-header.js";

const req = (h?: string, url = "https://h.example/mind/note?q=secret%20words") =>
  new Request(url, { method: "POST", headers: h === undefined ? {} : { [TURN_HEADER]: h } });

describe("turnIdFrom", () => {
  it("accepts the bot's minted shape", () => {
    expect(turnIdFrom(req("drevan-20261112T033006-7hkw"))).toBe("drevan-20261112T033006-7hkw");
    expect(turnIdFrom(req("  cypher-20261112T033006-0000 "))).toBe("cypher-20261112T033006-0000");
  });
  it("ignores a missing or malformed header (never rejects the request)", () => {
    expect(turnIdFrom(req())).toBeNull();
    for (const bad of ["", "drevan", "drevan-2026-11-12-abcd", "Drevan-20261112T033006-7hkw",
      "drevan-20261112T033006-7hkw {\"event\":\"x\"}", "drevan-20261112T033006-7HKW", "x".repeat(300)]) {
      expect(turnIdFrom(req(bad))).toBeNull();
    }
  });
});

describe("turn_request line", () => {
  it("carries ids only: path without the query string, method, status, ms", () => {
    const line = turnRequestLine("gaia-20261112T000000-abcd", req("gaia-20261112T000000-abcd"), 201, 12.6);
    expect(line).toEqual({ event: "turn_request", turn: "gaia-20261112T000000-abcd", method: "POST", path: "/mind/note", status: 201, ms: 13 });
    expect(JSON.stringify(line)).not.toContain("secret");
  });
  it("never throws, even when the sink does", () => {
    expect(() => logTurnRequest("gaia-20261112T000000-abcd", req(), 200, 1, () => { throw new Error("x"); })).not.toThrow();
    const out: string[] = [];
    logTurnRequest("gaia-20261112T000000-abcd", req(), 200, 1, (s) => out.push(s));
    expect(JSON.parse(out[0]!).event).toBe("turn_request");
  });
});
