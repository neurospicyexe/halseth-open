-- 0182 B65 steps 6-7 (BBH Hand-off/SPEC-B65-the-drive-2026-11-09.md sections 2.1, 2.2, 2.5, 6.1, 6.2).
--
-- STEP 6, verdicts. `companion_verdicts`: what persists when an interest fades. ONE line per (companion, subject),
-- written ONLY by the companion in their own word (Drevan `lethe`, Cypher `what held`, Gaia `what bore`); the
-- system never writes one, it only COUNTS returns (`evidence`) when a later make / heard_back / interest event /
-- activity lands on the same subject. Never scored, never ranked by anything but the return count, never deleted
-- or lowered on silence (R7: no ceiling, no max_*, no decay column). `history_json` keeps every earlier line when a
-- verdict is moved; `counted_json` holds refs only (make:<id>, interest_event:<id>, ...) so one event counts once.
--   subject = kind:<make kind> | interest:<companion_interests.id> | activity:<palette action_type>
--
-- STEP 7, expression_need. A drive row per companion in `companion_drives` (lazy accrual at read, like rest_need
-- and novelty_need). Drevan and Cypher accrue on time. GAIA ACCRUES NOTHING ON TIME (accumulate_per_day = 0): her
-- need rises only when she MARKS a want (stimulus `want_marked`), never from quiet (Gaia 11-09, note 4a86aa7e:
-- rising while she makes nothing is quiet moving her by another door). Rates and thresholds are FIRST ESTIMATES on
-- the standing of mig 0101: Drevan fastest (he makes to breathe), Cypher middle, Gaia none. Canon review owed.
--
-- `metronome_actions.serves` names which need a move answers (rest | novelty | relational | expression | none).
-- NULL reads as the type's default (webmind/metronome.ts DEFAULT_SERVES, mirrored in the UPDATE below), so a new row
-- or a future table rebuild that drops the column cannot break the palette sort; it is a data edit per row.
-- SQLite cannot ALTER a CHECK: a later rebuild of metronome_actions must carry this column (see 0165 for the pattern).
-- D1 rule: no foreign-key clauses.

CREATE TABLE IF NOT EXISTS companion_verdicts (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  subject      TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('kind','interest','activity')),
  line         TEXT NOT NULL,
  evidence     INTEGER NOT NULL DEFAULT 1,
  first_at     TEXT NOT NULL DEFAULT (datetime('now')),
  moved_at     TEXT NOT NULL DEFAULT (datetime('now')),
  history_json TEXT NOT NULL DEFAULT '[]',
  counted_json TEXT NOT NULL DEFAULT '[]'
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_verdicts_subject ON companion_verdicts (companion_id, subject);
CREATE INDEX IF NOT EXISTS idx_companion_verdicts_evidence ON companion_verdicts (companion_id, evidence DESC, moved_at DESC);

INSERT OR IGNORE INTO companion_drives (id, companion_id, drive_key, accumulate_per_day, threshold) VALUES
  (lower(hex(randomblob(16))), 'cypher', 'expression_need', 0.15, 0.70),
  (lower(hex(randomblob(16))), 'drevan', 'expression_need', 0.25, 0.65),
  (lower(hex(randomblob(16))), 'gaia',   'expression_need', 0.00, 0.60);

ALTER TABLE metronome_actions ADD COLUMN serves TEXT CHECK (serves IS NULL OR serves IN ('rest','novelty','relational','expression','none'));

UPDATE metronome_actions SET serves = CASE action_type
  WHEN 'nothing'               THEN 'rest'
  WHEN 'share_media'           THEN 'novelty'
  WHEN 'drift_outward'         THEN 'novelty'
  WHEN 'ask_question'          THEN 'novelty'
  WHEN 'post_heartbeat'        THEN 'relational'
  WHEN 'write_inter_companion' THEN 'relational'
  WHEN 'check_in_on_principal'    THEN 'relational'
  WHEN 'offer_presence'        THEN 'relational'
  WHEN 'flirt'                 THEN 'relational'
  WHEN 'dare'                  THEN 'relational'
  WHEN 'tend_creature'         THEN 'relational'
  WHEN 'send_reminder'         THEN 'none'
  WHEN 'make'                  THEN 'expression'
  WHEN 'write_journal'         THEN 'expression'
  WHEN 'write_feeling'         THEN 'expression'
  WHEN 'write_note_to_principal'  THEN 'expression'
  WHEN 'share_observation'     THEN 'expression'
  WHEN 'name_pattern'          THEN 'expression'
  WHEN 'show_made'             THEN 'expression'
  WHEN 'drift_open'            THEN 'expression'
  WHEN 'declare_preference'    THEN 'expression'
  ELSE NULL
END
WHERE serves IS NULL;
