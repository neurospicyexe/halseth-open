-- 0178 B65 steps 3-5: interests born from exposure (BBH Hand-off/SPEC-B65-the-drive-2026-11-09.md section 2.4).
--
-- The nightly pass (webmind/interest-births.ts, run from the hourly ferment tick after 02:00 Chicago) scores the
-- words that keep recurring across what a companion ENCOUNTERED in the last 30 days and writes AT MOST ONE
-- candidate per companion per night. It installs nothing: the companion is asked at their own-time slot and
-- keeps it (the existing `born` verb, their name and their why, born_from = 'exposure:<id>') or declines it
-- ('not mine: <term>', rests 60 days) or stays silent (expires when the next one is offered).
--
-- `mode` records what the pass was in when it wrote the row ('shadow' rows are never offered; a week of them
-- is the read before the flip). `sources_json` holds REFS only (forage:<id>, growth:<id>, ...), never text.
-- `term` is the pass's word; `answer_name` is the companion's (the interest is named by them, not by the pass).
--
-- Spec section 3 step 3 also names companion_verdicts, creature_interests, expression_need rows and
-- metronome_actions.serves for this number; they belong to steps 6-8 and land with those builds. This
-- migration carries only what steps 4-5 use. D1 rule: no foreign-key clauses.

CREATE TABLE IF NOT EXISTS companion_interest_candidates (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  term         TEXT NOT NULL,
  weight       REAL NOT NULL,
  days         INTEGER NOT NULL,
  sources      INTEGER NOT NULL,
  kinds        INTEGER NOT NULL DEFAULT 0,
  sources_json TEXT NOT NULL DEFAULT '[]',          -- refs only, never text
  runners_json TEXT NOT NULL DEFAULT '[]',          -- the next few eligible terms with their numbers (the shadow read)
  mode         TEXT NOT NULL CHECK (mode IN ('shadow','on')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  offered_at   TEXT,                                -- stamped when the offer is served to the companion
  answered_at  TEXT,
  answer       TEXT CHECK (answer IN ('kept','declined','expired')),
  answer_name  TEXT,                                -- the companion's own name for it (kept)
  why          TEXT,                                -- the companion's line (kept or declined), their words
  interest_id  TEXT                                 -- companion_interests.id when kept
);

CREATE INDEX IF NOT EXISTS idx_interest_candidates_companion ON companion_interest_candidates (companion_id, created_at DESC);
