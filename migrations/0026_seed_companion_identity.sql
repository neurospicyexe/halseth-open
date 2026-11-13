-- 0026_seed_companion_identity.sql
-- Ensures a companion_state row exists for cypher and gaia (the other companion's row comes from earlier
-- migrations). Identity text (prompt_context) is NOT seeded here: author your own through the identity
-- kernel upload, or let each companion write it at runtime. Safe to re-run.

INSERT OR IGNORE INTO companion_state (companion_id, updated_at)
  VALUES ('cypher', datetime('now'));

INSERT OR IGNORE INTO companion_state (companion_id, updated_at)
  VALUES ('gaia', datetime('now'));
