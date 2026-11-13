-- 0181_watchalong_cursors.sql
--
-- B67: a Claude.ai companion follows the active watchalong through the Librarian. Claude.ai has no
-- Discord channel id, so the Librarian finds "the live film" (newest session not ended) and keeps a
-- per-companion, per-surface delivered-through cursor, exactly like each Discord bot keeps its own in
-- memory (nullsafe-discord packages/shared/src/watchalong.ts). The cursor is the last playhead second
-- already handed to that companion; the next "what's on screen" returns only cues past it.
--
--   surface = 'claude_ai' today. A Discord bot's cursor stays in the bot's memory; the column is here so
--   the key says which door the position belongs to and a second surface never shares a position.
--
-- Cues never carry health data; this table holds ids and a number only. Additive, IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS watchalong_cursors (
  session_id TEXT NOT NULL REFERENCES watchalong_sessions(id) ON DELETE CASCADE,
  companion_id TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  surface TEXT NOT NULL DEFAULT 'claude_ai',
  through_sec REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, companion_id, surface)
);

-- "newest live session" lookup (no channel id): status filter + newest first.
CREATE INDEX IF NOT EXISTS idx_watchalong_sessions_live
  ON watchalong_sessions(status, created_at DESC);
