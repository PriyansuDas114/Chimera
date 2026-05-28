import { HumanMessage } from "@langchain/core/messages";
import { randomUUID } from "crypto";
import * as path from "path";
import { buildGraph } from "./builder.js";
import { SqliteCheckpointer } from "./checkpointer.js";
import { SessionStore } from "../memory/session.js";
import type { AgentState, AgentStateUpdate } from "./state.js";
import { LazyLoopDetector } from "./loop_detector.js";

import { CONFIG } from "../config/index.js";

// ─── DB Path Resolution ───────────────────────────────────────────────────────

export function resolveDbPath(sessionId: string): string {
  return path.resolve(CONFIG.PATHS.SESSIONS_DIR, `${sessionId}.db`);
}

// ─── Run Options ──────────────────────────────────────────────────────────────

export interface RunOptions {
  goal: string;
  cwd: string;
  sessionId?: string;
  /** When continuing an existing session, provide the new task here. */
  followUpGoal?: string;
  onStep?: (step: GraphStep) => void;
  /** Optional existing store to reuse. If provided, caller is responsible for closing. */
  store?: SessionStore;
  safetyMode?: "STRICT" | "COMMAND_ONLY" | "AUTO_APPROVE" | "READ_ONLY";
  overrides?: {
    maxSteps?: number | undefined;
    temperature?: number | undefined;
    model?: string | undefined;
    recursionLimit?: number | undefined;
  };
}

export interface GraphStep {
  nodeName: string;
  update: AgentStateUpdate;
  timestamp: string;
}

export interface RunResult {
  sessionId: string;
  finalState: AgentState;
  stepCount: number;
  success: boolean;
  errorLogs: string[];
}

// ─── Graph Runner ─────────────────────────────────────────────────────────────

export async function runGraph(options: RunOptions): Promise<RunResult> {
  const { goal, cwd, onStep } = options;
  const sessionId = options.sessionId ?? randomUUID();
  const dbPath    = resolveDbPath(sessionId);

  // ── Initialise persistence layer ────────────────────────────────────────────
  const store       = options.store ?? new SessionStore(dbPath);
  const checkpointer = new SqliteCheckpointer(store.rawDb);

  // ── Build graph with checkpointer wired in ──────────────────────────────────
  const graph = buildGraph(checkpointer);

  // ── Determine if this is a new session or a resume ──────────────────────────
  const existingSession = store.getById(sessionId);
  const isResume = existingSession !== null;

  if (!isResume) {
    store.createSession({ sessionId, goal, cwd });
  }

  // ── Thread config: LangGraph uses thread_id to scope checkpoints ────────────
  const threadConfig = {
    configurable: { 
      thread_id: sessionId,
      overrides: options.overrides,
      safetyMode: options.safetyMode ?? "STRICT",
    },
  };

  // ── Build initial state ─────────────────────────────────────────────────────
  // On a fresh session: seed the full initial state.
  // On a resume with a follow-up goal: append a new HumanMessage and reset
  //   status to PLANNING so the Supervisor picks up the new instruction.
  // On a bare resume (no new goal): pass empty — LangGraph restores from checkpoint.
  const initialState: AgentStateUpdate = !isResume
    ? {
        sessionId,
        cwd,
        globalGoal: goal,
        status:       "PLANNING",
        activeWorker: null,
        messages: [
          new HumanMessage(
            `Session ID: ${sessionId}\n` +
            `Working Directory: ${cwd}\n\n` +
            `Task: ${goal}`
          ),
        ],
        errorLogs: [],
      }
    : options.followUpGoal
    ? {
        // Continuation: inject the new goal into the live thread
        globalGoal:   options.followUpGoal,
        status:       "PLANNING",
        activeWorker: null,
        errorLogs:    [],
        messages: [
          new HumanMessage(
            `Follow-up Task: ${options.followUpGoal}\n` +
            `(Continue building on your previous work in this session.)`
          ),
        ],
      }
    : {}; // bare resume — LangGraph restores from checkpoint

  // ── Stream execution ────────────────────────────────────────────────────────
  let stepCount  = existingSession?.stepCount ?? 0;
  let lastState: AgentState | null = null;
  let runError: string | null = null;
  const maxSteps = options.overrides?.maxSteps ?? CONFIG.LIMITS.MAX_GRAPH_STEPS;

  const detector = new LazyLoopDetector();

  try {
    const stream = await graph.stream(initialState, {
      ...threadConfig,
      streamMode: "updates",
      // Sync LangGraph's internal recursion limit with our step cap.
      // Without this, LangGraph throws at its default of 25 before our
      // graceful handler ever gets a chance to run.
      recursionLimit: options.overrides?.recursionLimit ?? CONFIG.LIMITS.RECURSION_LIMIT,
    });

    for await (const chunk of stream) {
      for (const [nodeName, update] of Object.entries(chunk)) {
        stepCount++;

        // ── Step limit gate ────────────────────────────────────────────────
        if (stepCount > maxSteps) {
          runError = `Exceeded maximum step limit (${maxSteps}). Halting execution.`;
          break;
        }

        const typedUpdate = update as AgentStateUpdate;

        // Persist step metadata to sessions table
        store.updateStep({
          sessionId,
          status:    typedUpdate.status ?? "PLANNING",
          stepCount,
        });

        const step: GraphStep = {
          nodeName,
          update: typedUpdate,
          timestamp: new Date().toISOString(),
        };

        onStep?.(step);

        // Check for lazy loops
        const loopResult = detector.recordAndCheck(step);
        if (loopResult.detected) {
          runError = loopResult.reason || "Lazy loop detected. Halting execution.";
          break;
        }
      }

      // ── Break outer loop if step limit reached or loop detected ────────
      if (stepCount > maxSteps || runError) {
        break;
      }
    }

    // ── Get final merged state via checkpoint ──────────────────────────────
    const finalStateObj = await graph.getState(threadConfig);
    if (finalStateObj) {
      lastState = finalStateObj.values as AgentState;
    }

  } catch (err) {
    runError = err instanceof Error ? err.message : String(err);
  }

  // ── Finalise session record ─────────────────────────────────────────────────
  const finalStatus = lastState?.status ?? "PLANNING";

  if (lastState) {
    store.finalise({
      sessionId,
      status:     finalStatus,
      stepCount,
      finalState: lastState,
    });
  }
 
  // Only close the store if we created it locally
  if (!options.store) {
    // Wait a brief tick for any pending background checkpointer writes to flush
    await new Promise((resolve) => setTimeout(resolve, 200));
    store.close();
  }

  const success  = finalStatus === "FINISHED" && runError === null;
  const errorLogs = [
    ...(lastState?.errorLogs ?? []),
    ...(runError ? [`Runner error: ${runError}`] : []),
  ];

  return {
    sessionId,
    finalState: lastState ?? ({} as AgentState),
    success,
    errorLogs,
    stepCount,
  };
}