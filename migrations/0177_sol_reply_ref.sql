-- 0177 B64.1: a reply to a Sol post is a tend (spec docs/superpowers/specs/2026-11-08-sol-replies-and-no-repeat.md in BBH).
-- creature_interactions.ref: the Discord message id a row is about. On a reply-tend it is the Sol post being answered.
-- On a Sol appearance it is the message id the worker posted. NULL on every other row.
-- D1 rule: no foreign-key clauses. The reply text itself is never stored, so there is no column for it.

ALTER TABLE creature_interactions ADD COLUMN ref TEXT;

-- creature_interactions.fp: a reply-tend's similarity fingerprint (habituation, Sol gets bored of the same reply).
-- Sorted 16-bit hashes of word shingles, comma joined. Lossy by design, the text cannot be read back from it.
ALTER TABLE creature_interactions ADD COLUMN fp TEXT;

-- At most one reply-tend per (creature, actor, Sol post), enforced by the DB: all three bots may report the
-- same human message and only one row lands. NULL refs (every ordinary tend) never collide.
CREATE UNIQUE INDEX IF NOT EXISTS idx_creature_interactions_reply_once ON creature_interactions(creature_id, actor, ref) WHERE ref IS NOT NULL;
