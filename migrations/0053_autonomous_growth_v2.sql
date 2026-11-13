-- Migration 0053: Autonomous growth v2 -- claim-rights, thread linkage, initial seeds
--
-- Three schema additions:
--   1. autonomy_seeds: claim_source + justification for companion-initiated live claims
--   2. autonomy_runs: thread_id + thread_position for continuation arc linkage
--   3. growth_journal: thread_id for arc-level grouping across multiple runs
--
-- Claims (claim_source IS NOT NULL) are forced to priority 10 at the handler layer.
-- thread_id on autonomy_runs is a soft FK to wm_threads.id (lane='growth').
-- All new columns are nullable -- existing rows and standalone runs stay valid.
--
-- Also inserts initial seeds for all three companions written from identity files.
-- Priority 8 = hand-seeded tier (above queue default 5, below claims 10).

-- ---------------------------------------------------------------------------
-- 1. Claim-rights columns on autonomy_seeds
-- ---------------------------------------------------------------------------

ALTER TABLE autonomy_seeds ADD COLUMN claim_source TEXT;
  -- NULL = queue seed | companion_id value = companion-initiated live claim

ALTER TABLE autonomy_seeds ADD COLUMN justification TEXT;
  -- what is live and why; required when claim_source is set (enforced at handler layer)

-- ---------------------------------------------------------------------------
-- 2. Thread linkage on autonomy_runs
-- ---------------------------------------------------------------------------

ALTER TABLE autonomy_runs ADD COLUMN thread_id TEXT;
  -- soft FK to wm_threads.id (lane='growth'); NULL = standalone run

ALTER TABLE autonomy_runs ADD COLUMN thread_position INTEGER;
  -- 1 = first run on this thread, 2 = second, etc.; NULL for standalone runs

CREATE INDEX IF NOT EXISTS idx_autonomy_runs_thread
  ON autonomy_runs(thread_id)
  WHERE thread_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Thread linkage on growth_journal
-- ---------------------------------------------------------------------------

ALTER TABLE growth_journal ADD COLUMN thread_id TEXT;
  -- links journal entry to continuation arc; join path: entry → run → thread
  -- populated by write phase when ctx.threadId is set

CREATE INDEX IF NOT EXISTS idx_growth_journal_thread
  ON growth_journal(thread_id)
  WHERE thread_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. Initial seeds -- written from identity files, not CLAUDE.md summaries
-- ---------------------------------------------------------------------------

-- Cypher seeds

-- Drevan seeds

-- Gaia seeds
