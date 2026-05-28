/**
 * SQLite schema definitions for session persistence.
 *
 * Three tables:
 *   sessions     — one row per user session (metadata + final state snapshot)
 *   checkpoints  — one row per graph step (LangGraph checkpoint tuples)
 *   writes       — pending in-progress writes between checkpoint steps
 */

export const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    session_id    TEXT PRIMARY KEY,
    goal          TEXT NOT NULL,
    cwd           TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'PLANNING',
    step_count    INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    final_state   TEXT
  );
` as const;

export const CREATE_CHECKPOINTS_TABLE = `
  CREATE TABLE IF NOT EXISTS checkpoints (
    thread_id     TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    parent_id     TEXT,
    type          TEXT,
    checkpoint    TEXT NOT NULL,
    metadata      TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
  );
` as const;

export const CREATE_WRITES_TABLE = `
  CREATE TABLE IF NOT EXISTS writes (
    thread_id     TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL DEFAULT '',
    checkpoint_id TEXT NOT NULL,
    task_id       TEXT NOT NULL,
    idx           INTEGER NOT NULL,
    channel       TEXT NOT NULL,
    type          TEXT,
    value         TEXT NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  );
` as const;

export const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_checkpoints_thread
     ON checkpoints (thread_id, checkpoint_ns, created_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_writes_thread
     ON writes (thread_id, checkpoint_ns, checkpoint_id);`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_updated
     ON sessions (updated_at DESC);`,
] as const;