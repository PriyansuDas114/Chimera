import type Database from "better-sqlite3";
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointTuple,
} from "@langchain/langgraph";
import type { PendingWrite } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

// Type for checkpoint list options
interface CheckpointListOptions {
  limit?: number;
}

// ─── Row Types ────────────────────────────────────────────────────────────────

interface CheckpointRow {
  thread_id:     string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_id:     string | null;
  type:          string | null;
  checkpoint:    string;
  metadata:      string;
}

interface WriteRow {
  task_id:  string;
  idx:      number;
  channel:  string;
  type:     string | null;
  value:    string;
}

// ─── SQLite Checkpointer ──────────────────────────────────────────────────────

/**
 * A LangGraph BaseCheckpointSaver backed by an existing better-sqlite3
 * Database instance.
 *
 * Shares the DB connection opened by SessionStore so there is only one
 * SQLite file and one WAL journal per session directory.
 *
 * LangGraph calls:
 *   getTuple  — on graph start, to load the latest (or specific) checkpoint
 *   put       — after each node completes, to persist the new checkpoint
 *   putWrites — to persist pending channel writes mid-step
 *   list      — to enumerate checkpoints (used by resume / history commands)
 */
export class SqliteCheckpointer extends BaseCheckpointSaver {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    super();
    this.db = db;
  }

  // ── getTuple ────────────────────────────────────────────────────────────────

  /**
   * Retrieves the most recent checkpoint for a thread, or a specific one
   * if `config.configurable.checkpoint_id` is set (resume path).
   */
  async getTuple(
    config: RunnableConfig
  ): Promise<CheckpointTuple | undefined> {
    if (!this.db.open) return undefined;
    const threadId = config.configurable?.["thread_id"] as string | undefined;
    const checkpointNs =
      (config.configurable?.["checkpoint_ns"] as string | undefined) ?? "";
    const checkpointId = config.configurable?.["checkpoint_id"] as
      | string
      | undefined;

    if (!threadId) return undefined;

    let row: CheckpointRow | undefined;

    if (checkpointId) {
      row = this.db
        .prepare(
          `SELECT * FROM checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?`
        )
        .get(threadId, checkpointNs, checkpointId) as
        | CheckpointRow
        | undefined;
    } else {
      // Get the most recent checkpoint for this thread
      row = this.db
        .prepare(
          `SELECT * FROM checkpoints
           WHERE thread_id = ? AND checkpoint_ns = ?
           ORDER BY checkpoint_id DESC
           LIMIT 1`
        )
        .get(threadId, checkpointNs) as CheckpointRow | undefined;
    }

    if (!row) return undefined;

    // Load any pending writes associated with this checkpoint
    const writeRows = this.db
      .prepare(
        `SELECT * FROM writes
         WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
         ORDER BY task_id, idx`
      )
      .all(threadId, checkpointNs, row.checkpoint_id) as WriteRow[];

    const writePromises = writeRows.map(async (w) => [
      w.task_id,
      w.channel,
      await this.serde.loadsTyped(
        w.type ?? "json",
        w.value
      ),
    ]);
    const pendingWrites = (await Promise.all(writePromises)) as Array<[string, string, unknown]>;

    const checkpoint = (await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint
    )) as Checkpoint;

    const metadata = JSON.parse(row.metadata) as CheckpointMetadata;

    const result: CheckpointTuple = {
      config: {
        configurable: {
          thread_id:     row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata,
    } as CheckpointTuple;

    if (row.parent_id) {
      result.parentConfig = {
        configurable: {
          thread_id:     row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_id,
        },
      } as RunnableConfig;
    }

    return result;
  }

  // ── list ────────────────────────────────────────────────────────────────────

  /**
   * Enumerates checkpoints for a thread, newest first.
   * Used by `chimera sessions inspect <id>` to show step history.
   */
  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions
  ): AsyncGenerator<CheckpointTuple> {
    if (!this.db.open) return;
    const threadId = config.configurable?.["thread_id"] as string | undefined;
    if (!threadId) return;

    const checkpointNs =
      (config.configurable?.["checkpoint_ns"] as string | undefined) ?? "";
    const limit = options?.limit ?? 100;

    const rows = this.db
      .prepare(
        `SELECT * FROM checkpoints
         WHERE thread_id = ? AND checkpoint_ns = ?
         ORDER BY checkpoint_id DESC
         LIMIT ?`
      )
      .all(threadId, checkpointNs, limit) as CheckpointRow[];

    for (const row of rows) {
      const checkpoint = (await this.serde.loadsTyped(
        row.type ?? "json",
        row.checkpoint
      )) as Checkpoint;

      const metadata = JSON.parse(row.metadata) as CheckpointMetadata;

      const result: CheckpointTuple = {
        config: {
          configurable: {
            thread_id:     row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata,
      } as CheckpointTuple;

      if (row.parent_id) {
        result.parentConfig = {
          configurable: {
            thread_id:     row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.parent_id,
          },
        } as RunnableConfig;
      }

      yield result;
    }
  }

  // ── put ─────────────────────────────────────────────────────────────────────

  /**
   * Persists a new checkpoint after a node completes.
   * Called by LangGraph automatically — never call this manually.
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata
  ): Promise<RunnableConfig> {
    if (!this.db.open) return config;
    const threadId = config.configurable?.["thread_id"] as string;
    const checkpointNs =
      (config.configurable?.["checkpoint_ns"] as string | undefined) ?? "";
    const checkpointId = checkpoint.id;
    const parentId = config.configurable?.["checkpoint_id"] as
      | string
      | undefined;

    const [type, serialised] = this.serde.dumpsTyped(checkpoint);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO checkpoints
           (thread_id, checkpoint_ns, checkpoint_id, parent_id,
            type, checkpoint, metadata, created_at)
         VALUES
           (@threadId, @checkpointNs, @checkpointId, @parentId,
            @type, @checkpoint, @metadata, @createdAt)`
      )
      .run({
        threadId,
        checkpointNs,
        checkpointId,
        parentId:    parentId ?? null,
        type,
        checkpoint:  serialised,
        metadata:    JSON.stringify(metadata),
        createdAt:   new Date().toISOString(),
      });

    return {
      configurable: {
        thread_id:     threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpointId,
      },
    };
  }

  // ── putWrites ───────────────────────────────────────────────────────────────

  /**
   * Persists pending channel writes during an in-progress step.
   * Allows the graph to resume from the middle of a node if interrupted.
   */
  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string
  ): Promise<void> {
    if (!this.db.open) return;
    const threadId     = config.configurable?.["thread_id"] as string;
    const checkpointNs =
      (config.configurable?.["checkpoint_ns"] as string | undefined) ?? "";
    const checkpointId = config.configurable?.["checkpoint_id"] as string;

    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO writes
         (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
       VALUES
         (@threadId, @checkpointNs, @checkpointId, @taskId, @idx, @channel, @type, @value)`
    );

    // Wrap in a transaction — all writes for a step are atomic
    const insertAll = this.db.transaction(
      (entries: Array<{ channel: string; value: unknown }>, idx_offset: number) => {
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry) continue;
          const [type, serialised] = this.serde.dumpsTyped(entry.value);
          insert.run({
            threadId,
            checkpointNs,
            checkpointId,
            taskId,
            idx: idx_offset + i,
            channel: entry.channel,
            type,
            value: serialised,
          });
        }
      }
    );

    const entries = writes.map(([channel, value]) => ({ channel, value }));
    insertAll(entries, 0);
  }
}