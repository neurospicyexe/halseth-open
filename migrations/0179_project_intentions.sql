-- 0179 Intentions (STATUS R22; BBH Hand-off/GAP-MAP-flow-and-agency-2026-11-11.md C1, Principal's yes):
-- a companion says "I'll come back to this Thursday" and the worker comes back to it Thursday.
--
-- Rides companion_projects (mig 0122) instead of a new table: a dated intention IS a held project with a
-- date on it. The worker already works projects (seed level 2.3, explore piece plan, project_log write);
-- what was missing is WHEN. Three nullable columns, nothing else:
--
--   due_at          UTC ISO of 00:00 America/Chicago on the day the companion named. The nightly run for
--                   that day (Cy 3am, Dre 5am, Gaia 7am Chicago) finds it due. Set ONLY by the companion's own
--                   verb ("intend: ..." / "I'll come back to ... on ..."). Cleared by the pursuit (in the same
--                   batch as the worker's project_log row), by "intention done", or by "drop intention".
--   next_step       the companion's own words for what to come back FOR. Fed to the worker's piece plan.
--   last_pursued_at stamped when the worker pursued a DUE intention (distinct from last_worked_at, which any
--                   work stamps, live sessions included).
--
-- No ceiling column, no count limit (R7). Nothing here lowers a level. Additive only: pre-0179 code reads
-- `SELECT *` and never names these columns, so it is unaffected. D1 rule: no foreign-key clauses.
-- Apply by `--file` + a d1_migrations ledger row (the prod ledger stops at 0135).

ALTER TABLE companion_projects ADD COLUMN due_at TEXT;
ALTER TABLE companion_projects ADD COLUMN next_step TEXT;
ALTER TABLE companion_projects ADD COLUMN last_pursued_at TEXT;

-- The worker's nightly "what is due for me" read: one companion, dated rows only.
CREATE INDEX IF NOT EXISTS idx_companion_projects_due
  ON companion_projects (companion_id, due_at) WHERE due_at IS NOT NULL;
