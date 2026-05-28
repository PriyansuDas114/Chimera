import { coderNode, auditorNode, researcherNode, qaNode } from "./workers.js";
import { supervisorNode } from "./supervisor.js";
import type { WorkerName } from "../graph/state.js";
import type { AgentState, AgentStateUpdate } from "../graph/state.js";

// ─── Node Type ────────────────────────────────────────────────────────────────

export type GraphNodeFn = (state: AgentState) => Promise<AgentStateUpdate>;

// ─── Worker Registry Map ──────────────────────────────────────────────────────

/**
 * Maps WorkerName values to their node functions.
 * The graph builder iterates this to register nodes dynamically,
 * meaning adding a new worker = adding one entry here.
 */
export const workerRegistry: Record<NonNullable<WorkerName>, GraphNodeFn> = {
  coder:      coderNode,
  auditor:    auditorNode,
  researcher: researcherNode,
  qa:         qaNode,
};

// Re-export everything the graph builder will need in one import
export { supervisorNode, coderNode, auditorNode, researcherNode, qaNode };