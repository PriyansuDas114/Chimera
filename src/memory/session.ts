import Database from "better-sqlite3";
import * as path from "path";
import * as fs from "fs";
import {
  CREATE_SESSIONS_TABLE,
  CREATE_CHECKPOINTS_TABLE,
  CREATE_WRITES_TABLE,
  CREATE_INDEXES,
} from "./schema.js";
import type { AgentState } from "../graph/state.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SessionRecord {
  sessionId: string;
  goal: string;
  cwd: string;
  status: string;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
  finalState: AgentState | null;
}

interface SessionRow {
  session_id: string;
  goal: string;
  cwd: string;
  status: string;
  step_count: number;
  created_at: string;
  updated_at: string;
  final_state: string | null;
}

// ─── Session Store ────────────────────────────────────────────────────────────

/**
 * Manages the `sessions` table — the human-readable metadata layer
 * sitting above the raw LangGraph checkpoint tuples.
 *
 * This is separate from the checkpointer (which owns `checkpoints` and
 * `writes`) so session CRUD is independently usable from the CLI
 * (e.g., `chimera sessions list`) without touching the LangGraph internals.
 */
export class SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Enable WAL mode — better concurrent read performance
    // (CLI reads while graph writes at the same time)
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.migrate();
  }

  // ── Schema migration ────────────────────────────────────────────────────────

  private migrate(): void {
    this.db.exec(CREATE_SESSIONS_TABLE);
    this.db.exec(CREATE_CHECKPOINTS_TABLE);
    this.db.exec(CREATE_WRITES_TABLE);
    for (const idx of CREATE_INDEXES) {
      this.db.exec(idx);
    }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  createSession(params: {
    sessionId: string;
    goal: string;
    cwd: string;
  }): SessionRecord {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions
           (session_id, goal, cwd, status, step_count, created_at, updated_at)
         VALUES
           (@sessionId, @goal, @cwd, 'PLANNING', 0, @now, @now)`
      )
      .run({ sessionId: params.sessionId, goal: params.goal, cwd: params.cwd, now });

    return {
      sessionId: params.sessionId,
      goal: params.goal,
      cwd: params.cwd,
      status: "PLANNING",
      stepCount: 0,
      createdAt: now,
      updatedAt: now,
      finalState: null,
    };
  }

  updateStep(params: {
    sessionId: string;
    status: string;
    stepCount: number;
  }): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET status = @status, step_count = @stepCount, updated_at = @now
         WHERE session_id = @sessionId`
      )
      .run({
        sessionId: params.sessionId,
        status: params.status,
        stepCount: params.stepCount,
        now: new Date().toISOString(),
      });
  }

  finalise(params: {
    sessionId: string;
    status: string;
    stepCount: number;
    finalState: AgentState;
  }): void {
    this.db
      .prepare(
        `UPDATE sessions
         SET status = @status,
             step_count = @stepCount,
             final_state = @finalState,
             updated_at = @now
         WHERE session_id = @sessionId`
      )
      .run({
        sessionId: params.sessionId,
        status: params.status,
        stepCount: params.stepCount,
        finalState: JSON.stringify(params.finalState),
        now: new Date().toISOString(),
      });
  }

  getById(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE session_id = ?`)
      .get(sessionId) as SessionRow | undefined;

    return row ? this.rowToRecord(row) : null;
  }

  listRecent(limit = 20): SessionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`
      )
      .all(limit) as SessionRow[];

    return rows.map((r) => this.rowToRecord(r));
  }

  deleteById(sessionId: string): boolean {
    // Cascade: also delete checkpoints and writes for this session
    this.db
      .prepare(`DELETE FROM checkpoints WHERE thread_id = ?`)
      .run(sessionId);
    this.db
      .prepare(`DELETE FROM writes WHERE thread_id = ?`)
      .run(sessionId);

    const result = this.db
      .prepare(`DELETE FROM sessions WHERE session_id = ?`)
      .run(sessionId);

    return result.changes > 0;
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private rowToRecord(row: SessionRow): SessionRecord {
    return {
      sessionId:  row.session_id,
      goal:       row.goal,
      cwd:        row.cwd,
      status:     row.status,
      stepCount:  row.step_count,
      createdAt:  row.created_at,
      updatedAt:  row.updated_at,
      finalState: row.final_state
        ? (JSON.parse(row.final_state) as AgentState)
        : null,
    };
  }

  close(): void {
    this.db.close();
  }

  /** Exposed for the checkpointer which shares the same DB connection. */
  get rawDb(): Database.Database {
    return this.db;
  }
}