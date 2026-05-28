import type { AgentState, AgentStatus, WorkerName } from "../graph/state.js";

/**
 * Represents a single turn in a multi-turn agent session.
 */
export interface SessionTurn {
  turnNumber: number;
  goal: string;
  timestamp: string;
  success: boolean;
  stepCount: number;
}

/**
 * Metadata for a persisted session.
 */
export interface SessionMetadata {
  sessionId: string;
  globalGoal: string;
  cwd: string;
  status: AgentStatus;
  stepCount: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Result returned by a full graph execution.
 */
export interface RunResult {
  sessionId: string;
  finalState: AgentState;
  success: boolean;
  errorLogs: string[];
  stepCount: number;
}

/**
 * Configuration for a worker agent instance.
 */
export interface WorkerConfig {
  name: string;
  model: string;
  systemPrompt: string;
  temperature?: number;
  // Per-worker tool scoping
  allowedTools?: string[];
}
