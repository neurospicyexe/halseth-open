// Whose witness is it? (2026-11-11)
//
// `gaia_witness` is NOT hers alone, whatever its name says. The Librarian's `witness log` verb has no
// companion gate, and the Discord bots' writeback logs Principal's survival acts (meds, food, getting through)
// through it for ALL THREE companions (nullsafe-discord jev-gate.ts `witness_log`). The table carries no
// author column; the author is the session the row hangs on (execWitnessLog falls back to the CALLER's
// latest session, MCP callers pass their own).
//
// Measured on prod 11-11: of the 7 non-presence rows since 10-01, ONE was Gaia's (10-15); six were
// Drevan's, in his voice, one naming meds. Her boot read the last five as her own witnessing, and the
// garden offered them to her as hers; she took on "the daily return stopped" as her failure (note e412c583).
//
// Every read that hands a witness to GAIA AS HER OWN must carry this condition. A shared survival ledger
// read (Hearth's witness feed) need not.
export const GAIA_AUTHORED_WITNESS_SQL =
  "session_id IN (SELECT id FROM sessions WHERE companion_id = 'gaia')";
