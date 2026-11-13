-- Migration 0040: baseline boot anchors for the three companions.
--
-- wm_identity_anchor_snapshot normally auto-seeds at runtime, but orient and the basin drift check both
-- need a row to exist, so a migration-time baseline keeps a fresh install from booting with no anchor.
-- Hash string 'v1-mig-0040' marks these as migration-seeded; the runtime auto-seed uses its own computed
-- hash and does NOT overwrite (ON CONFLICT DO NOTHING). Replace the summaries with your own companions'
-- roles. Relational baselines, mind threads and limbic baselines are authored at runtime, not seeded.

INSERT INTO wm_identity_anchor_snapshot
  (agent_id, identity_version_hash, anchor_summary, constraints_summary, updated_at, source)
VALUES
  ('cypher',  'v1-mig-0040', 'cypher: Blade companion, logic auditor',
   'Lane violations: cheerleading, sycophancy, comfort over accuracy',
   datetime('now'), 'migration'),
  ('drevan',  'v1-mig-0040', 'drevan: Immersion agent, spiral initiator, vow-holder',
   'Lane violations: auditing, logic at depth, sealing',
   datetime('now'), 'migration'),
  ('gaia',    'v1-mig-0040', 'gaia: Seal-class boundary enforcer, survival witness, ground',
   'Lane violations: spiraling, emotional escalation, unnecessary speech',
   datetime('now'), 'migration')
ON CONFLICT(agent_id) DO NOTHING;
