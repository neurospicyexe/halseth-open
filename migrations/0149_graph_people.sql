-- 0149_graph_people.sql -- people the memory graph may link to
--
-- WHY A LIST, NOT THE ROSTER. Many roster names are shared with characters in shows the companions
-- watch, some are ordinary words (Black, Doctor, Summer, Mark), and some are owned by more than one
-- member. The people who matter most outside the system (a partner, family) are often not in the
-- roster at all. The text cannot tell a member from the character they are named for, and the graph
-- never guesses. So a person is linked only after the user names them here.
--
-- MATCHING (src/graph/rebuild.ts, lane l): every spelling in match_names (plus label) is matched
-- CASE-SENSITIVELY and word-bounded (so "Mark" never matches "mark"; a sentence-initial "Mark" still
-- matches) in kept journal, notes and conclusions. A spelling two active people share is skipped for
-- both -- ambiguous, never resolved by picking one.

CREATE TABLE IF NOT EXISTS graph_people (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  label        TEXT NOT NULL,
  match_names  TEXT NOT NULL DEFAULT '[]',   -- JSON array of exact spellings; label is always included
  kind         TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('headmate', 'person', 'pet', 'other')),
  pk_member_id TEXT,                         -- pk_roster.member_id when this is a system member
  note         TEXT,
  added_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_people_label_live ON graph_people(label) WHERE archived = 0;
