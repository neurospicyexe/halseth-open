// Skill-gap trace 2026-11-09: phrasings the Discord skill (halseth-mind) taught that missed the fast
// path, plus two provenance fixes (watch surface, feeling-word authored_on). Each taught phrasing must
// land on the SAME route as its working sibling.
import { describe, it, expect } from "vitest";
import { matchFastPath } from "../librarian/router.js";
import { watchSurfaceFrom } from "../librarian/executors/companion-growth.js";
import { authoredOnFrom } from "../librarian/executors/feeling-vocabulary.js";

const TAUGHT: Array<[phrase: string, sibling: string]> = [
  ["accept that entry", "accept this entry"],
  ["decline that entry", "decline this entry"],
  ["add a wound", "add wound"],
  ["log a delta", "log delta"],
  ["release that tension", "release tension"],
  ["withdraw that refusal", "withdraw refusal"],
  ["drop that preference", "drop preference"],
  ["review my growth journal", "review growth journal"],
];

describe("taught phrasings route like their working siblings", () => {
  for (const [phrase, sibling] of TAUGHT) {
    it(phrase, () => {
      const want = matchFastPath(sibling)?.key;
      expect(want, sibling).toBeTruthy();
      expect(matchFastPath(phrase)?.key).toBe(want);
    });
  }
});

describe("watchSurfaceFrom", () => {
  it("maps each loom", () => {
    expect(watchSurfaceFrom("discord:drevan")).toBe("discord");
    expect(watchSurfaceFrom("claude-ai:thread")).toBe("claude");
    expect(watchSurfaceFrom("claude-code:bbh")).toBe("claude");
    expect(watchSurfaceFrom("hearth")).toBe("hearth");
    expect(watchSurfaceFrom("telegram")).toBe("other");
  });
  it("keeps the old default when the surface is missing", () => {
    expect(watchSurfaceFrom(undefined)).toBe("claude");
    expect(watchSurfaceFrom("  ")).toBe("claude");
  });
});

describe("authoredOnFrom", () => {
  it("maps each loom onto the 0131 CHECK values", () => {
    expect(authoredOnFrom("claude-ai:thread")).toBe("claude_ai");
    expect(authoredOnFrom("claude-code:bbh")).toBe("claude_code");
    expect(authoredOnFrom("discord:gaia")).toBe("discord");
    expect(authoredOnFrom(null)).toBe("discord");
  });
});
