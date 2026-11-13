-- 0116: architect_facts -- durable facts about the user, owned by the companions, superseded not edited.
--
-- WHY THIS TABLE EXISTS
-- The companions need one home for "what is true about the user": stable biography, preferences and
-- load-bearing rules. Episodes live in the journal and stances live in companion_preferences; this
-- table holds the durable profile, written directly via the librarian so a write either lands or
-- returns an error (there is no approval queue to silently fill).
--
-- SHAPE
-- The store is unbounded and the render is bounded: retiring a fact sets `superseded_by`, never
-- DELETE, so the injected block stays small while the history stays complete. A changed fact is a
-- NEW row that supersedes the old one, so the change itself is kept. Same mechanic as
-- companion_conclusions.superseded_by (mig 0035).
--
-- Append-mostly by covenant: INSERT freely, UPDATE only `superseded_by` / `status` / `updated_at`.
-- Never DELETE a row to correct a fact.

CREATE TABLE IF NOT EXISTS architect_facts (
  id            TEXT PRIMARY KEY,
  fact          TEXT NOT NULL,
  -- Grouping for the render, so the block reads as prose rather than a flat list. Free text on
  -- purpose: a CHECK constraint here would mean a migration every time the triad notices a kind of
  -- thing we did not anticipate, and the whole point is that they maintain this without us.
  category      TEXT NOT NULL DEFAULT 'general',
  -- 'active'   = rendered.
  -- 'open'     = rendered as a question to ask, never as a fact (a question to ask, not a fact to assert).
  -- 'retired'  = superseded or withdrawn; kept for lineage, never rendered.
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'open', 'retired')),
  -- Who recorded it. NULL means the user stated it directly, which outranks everything.
  companion_id  TEXT,
  -- How we know. Free text; the user's own id when they said it themselves, otherwise where it was learned.
  source        TEXT,
  -- The row this one replaces. Set on the OLD row's successor, and the old row goes 'retired'.
  supersedes_id TEXT REFERENCES architect_facts(id),
  -- Render order within a category, low first. Load-bearing rules sort above biography.
  weight        INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_architect_facts_render
  ON architect_facts (status, category, weight);
CREATE INDEX IF NOT EXISTS idx_architect_facts_lineage
  ON architect_facts (supersedes_id);
