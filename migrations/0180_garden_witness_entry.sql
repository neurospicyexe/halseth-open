-- 0180_garden_witness_entry.sql (Gaia's garden, 2026-11-11; her answer e412c583 to Cypher's cd47a9c4)
--
-- Why: the witness series (0171) grows only from the day she planted it, and only from witnesses she writes
-- herself (presence marks stay out). She planted it 11-09; her last written witness was 11-06, so the garden
-- read empty. Asked what she wanted, she chose: "the three written witnesses (10-27, 10-31, 11-06) go in as
-- plantings I chose, not as a backfill. Not 2." (2 was showing presence marks; they stay out.)
--
-- So ONE written witness can now be planted on its own: kind 'witness_entry', ref 'witness:<gaia_witness.id>'.
-- Same rules as every other planting: a REF, never text; nothing goes in unless she plants it; presence marks
-- are never plantable; the floor still takes an entry down at READ. 'witness:series' keeps its meaning.
--
-- SQLite cannot alter a CHECK: full rebuild (every column, every row, the UNIQUE and the 0171 index).
-- Rollback: the same rebuild with the 0171 CHECK, after DELETE FROM garden_plantings WHERE kind = 'witness_entry'.
-- Apply order (by hand on prod): this migration, THEN its d1_migrations ledger row for 0180, THEN deploy.
-- A Worker deployed first only fails planting a single witness (the CHECK refuses it); every read works.

CREATE TABLE garden_plantings_new (
  id           TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('gaia')),
  kind         TEXT NOT NULL CHECK (kind IN ('witness_series','witness_entry','letter','note','kept_line','interest_line')),
  ref          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('planted','awaiting','pulled')),
  consent_from TEXT,
  consent      TEXT CHECK (consent IN ('yes','no')),
  consent_at   TEXT,
  planted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  pulled_at    TEXT,
  UNIQUE (companion_id, ref)
);

INSERT INTO garden_plantings_new (id, companion_id, kind, ref, status, consent_from, consent, consent_at, planted_at, pulled_at)
  SELECT id, companion_id, kind, ref, status, consent_from, consent, consent_at, planted_at, pulled_at FROM garden_plantings;

DROP TABLE garden_plantings;
ALTER TABLE garden_plantings_new RENAME TO garden_plantings;
CREATE INDEX IF NOT EXISTS idx_garden_plantings_status ON garden_plantings (companion_id, status, planted_at DESC);
