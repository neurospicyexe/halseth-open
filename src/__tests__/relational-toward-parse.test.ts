// "verb toward [name]: [text]" (Librarian wm_relational_write). 2026-11-01: the name was one token,
// so a qualified name ("MemberF (Spouse)", "Lestat (ours)") failed the match and the write was lost.

import { describe, it, expect } from "vitest";
import { parseRelationalRequest } from "../librarian/executors/webmind.js";

describe("parseRelationalRequest", () => {
  it("keeps a one-word name as before (lowercased)", () => {
    expect(parseRelationalRequest("how i feel toward Principal: steady and close")).toEqual({ toward: "principal", stateText: "steady and close", stateType: undefined });
  });

  it("keeps a qualified name whole", () => {
    expect(parseRelationalRequest("witness toward MemberF (Spouse): he laughed at the monkey")?.toward).toBe("memberf (spouse)");
    expect(parseRelationalRequest("how i feel toward Lestat (ours): fond")?.toward).toBe("lestat (ours)");
    expect(parseRelationalRequest("held toward MemberF || 🍂: a good night")).toMatchObject({ toward: "memberf || 🍂", stateType: "held" });
  });

  it("splits at the FIRST colon, so the text may contain colons", () => {
    expect(parseRelationalRequest("i feel toward Spouse: grateful: he stayed")).toMatchObject({ toward: "spouse", stateText: "grateful: he stayed" });
  });

  it("collapses inner whitespace in the name and infers the state type", () => {
    expect(parseRelationalRequest("witness toward  MemberF   (Spouse) : quiet")).toEqual({ toward: "memberf (spouse)", stateText: "quiet", stateType: "witness" });
  });

  it("refuses shapes without a name, a colon, or text", () => {
    expect(parseRelationalRequest("how i feel toward : nothing")).toBeNull();
    expect(parseRelationalRequest("how i feel toward Principal")).toBeNull();
    expect(parseRelationalRequest("how i feel toward Principal:   ")).toBeNull();
    expect(parseRelationalRequest("tell me about Principal: x")).toBeNull();
  });

  it("does not let a name span lines", () => {
    expect(parseRelationalRequest("how i feel toward Principal\nand Spouse: both")).toBeNull();
  });
});
