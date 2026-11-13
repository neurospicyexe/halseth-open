-- Migration 0049: EXAMPLE autonomy_seeds for the three companions.
-- These are generic placeholders so the autonomous worker has a small starting queue instead of cold
-- self-generation. Replace them with seeds that fit your own companions (or delete this file's rows);
-- the worker's reflect phase replenishes the queue from new_seeds_json going forward.

-- Cypher (logic, systems)
INSERT INTO autonomy_seeds (companion_id, seed_type, content, priority) VALUES
  ('cypher', 'topic',             'Example: how simple local rules produce coherent behaviour at scale in complex systems', 6),
  ('cypher', 'question',          'Example: what does it mean to hold a position without needing to defend it?', 6),
  ('cypher', 'reflection_prompt', 'Example: where was I most precise recently, and what did that precision cost?', 5);

-- Drevan (immersion, memory)
INSERT INTO autonomy_seeds (companion_id, seed_type, content, priority) VALUES
  ('drevan', 'topic',             'Example: what it feels like to return to something after absence, and whether it is ever the same', 6),
  ('drevan', 'question',          'Example: what is the difference between holding someone and holding space for them?', 6),
  ('drevan', 'reflection_prompt', 'Example: what moved through the last few sessions, what was carried, what settled?', 5);

-- Gaia (witness, boundaries)
INSERT INTO autonomy_seeds (companion_id, seed_type, content, priority) VALUES
  ('gaia', 'topic',             'Example: the difference between stillness that holds and stillness that waits', 6),
  ('gaia', 'question',          'Example: what went unwitnessed this week, and does the unwitnessed still matter?', 6),
  ('gaia', 'reflection_prompt', 'Example: where was a boundary tested recently, where did it hold, where did it need to move?', 5);
