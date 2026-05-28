import {
  StateGraph,
  END,
  START,
} from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { AIMessage } from "@langchain/core/messages";
import {
  AgentStateAnnotation,
  type AgentState,
} from "./state.js";
import {
  supervisorNode,
  coderNode,
  auditorNode,
  researcherNode,
  qaNode,
} from "../agents/registry.js";
import { toolRegistry } from "../tools/registry.js";
import type { BaseCheckpointSaver } from "@langchain/langgraph";

// ─── Node Name Constants ──────────────────────────────────────────────────────

/**
 * String literals for every node in the graph.
 * Using a const object instead of raw strings prevents typos in edge
 * definitions from silently creating disconnected nodes.
 */
export const NODE = {
  SUPERVISOR:        "supervisor",
  CODER:             "coder",
  AUDITOR:           "auditor",
  RESEARCHER:        "researcher",
  QA:                "qa",
  TOOLS_CODER:       "tools_coder",
  TOOLS_AUDITOR:     "tools_auditor",
  TOOLS_RESEARCHER:  "tools_researcher",
  TOOLS_QA:          "tools_qa",
} as const;

type NodeName = typeof NODE[keyof typeof NODE];

// ─── Edge Condition: Supervisor Routing ──────────────────────────────────────

/**
 * Reads the status set by the Supervisor node and routes to the
 * appropriate worker, or to END if the task is finished.
 *
 * This is the central dispatch function of the entire graph.
 * It must be a pure function of state — no side effects.
 */
function routeFromSupervisor(
  state: AgentState
): NodeName | typeof END {
  switch (state.activeWorker) {
    case "coder":      return NODE.CODER;
    case "auditor":    return NODE.AUDITOR;
    case "researcher": return NODE.RESEARCHER;
    case "qa":         return NODE.QA;
    case null:
      // activeWorker is null when Supervisor chose FINISH,
      // or on a parse-error recovery loop (status stays PLANNING).
      if (state.status === "FINISHED") return END;
      // Recovery: bad JSON on previous tick — re-enter supervisor
      return NODE.SUPERVISOR;
    default:
      // TypeScript exhaustiveness guard — should never reach here
      return END;
  }
}

// ─── Edge Condition: Worker Tool-Call Detection ───────────────────────────────

/**
 * After a worker node runs, check whether its last message contains
 * tool calls. If yes, route to the worker's dedicated ToolNode.
 * If no, the worker is done for this turn — route back to Supervisor.
 *
 * @param toolsNode - The NODE key for this worker's ToolNode.
 */
function makeWorkerEdge(toolsNode: NodeName) {
  return function shouldRunTools(
    state: AgentState
  ): NodeName | typeof END {
    const lastMessage = state.messages.at(-1);

    // Guard: if state is somehow empty, fall back safely
    if (!lastMessage) return NODE.SUPERVISOR;

    // AIMessage with tool_calls means the model wants to invoke a tool
    const isAI = typeof lastMessage._getType === "function" 
      ? lastMessage._getType() === "ai" 
      : (lastMessage as any).type === "ai" || lastMessage.constructor.name === "AIMessage";
    
    if (
      isAI &&
      Array.isArray((lastMessage as any).tool_calls) &&
      (lastMessage as any).tool_calls.length > 0
    ) {
      return toolsNode;
    }

    // No tool calls — worker has produced its final response for this turn
    return NODE.SUPERVISOR;
  };
}

// ─── Graph Assembly ───────────────────────────────────────────────────────────

/**
 * Builds and compiles the full multi-agent StateGraph.
 *
 * Graph structure:
 *
 *   START → supervisor
 *     supervisor → [coder | auditor | researcher | END]  (conditional)
 *     coder      → [tools_coder | supervisor]            (conditional)
 *     tools_coder → coder                                (always)
 *     auditor    → [tools_auditor | supervisor]          (conditional)
 *     tools_auditor → auditor                            (always)
 *     researcher → [tools_researcher | supervisor]       (conditional)
 *     tools_researcher → researcher                      (always)
 *     qa         → [tools_qa | supervisor]               (conditional)
 *     tools_qa   → qa                                    (always)
 *
 * Each worker has its own ToolNode so tool permissions can be scoped
 * per-worker in a future phase without restructuring the graph.
 */
export function buildGraph(checkpointer?: BaseCheckpointSaver) {
  const graph = new StateGraph(AgentStateAnnotation);

  graph
    .addNode(NODE.SUPERVISOR,        supervisorNode)
    .addNode(NODE.CODER,             coderNode)
    .addNode(NODE.AUDITOR,           auditorNode)
    .addNode(NODE.RESEARCHER,        researcherNode)
    .addNode(NODE.QA,                qaNode)
    .addNode(NODE.TOOLS_CODER,       new ToolNode(toolRegistry))
    .addNode(NODE.TOOLS_AUDITOR,     new ToolNode(toolRegistry))
    .addNode(NODE.TOOLS_RESEARCHER,  new ToolNode(toolRegistry))
    .addNode(NODE.TOOLS_QA,          new ToolNode(toolRegistry));

  graph.addEdge(START as never, NODE.SUPERVISOR as never);

  graph.addConditionalEdges(NODE.SUPERVISOR as never, routeFromSupervisor, {
    [NODE.CODER]:      NODE.CODER,
    [NODE.AUDITOR]:    NODE.AUDITOR,
    [NODE.RESEARCHER]: NODE.RESEARCHER,
    [NODE.QA]:         NODE.QA,
    [NODE.SUPERVISOR]: NODE.SUPERVISOR,
    [END]:             END,
  } as any);

  graph.addConditionalEdges(NODE.CODER as never, makeWorkerEdge(NODE.TOOLS_CODER), {
    [NODE.TOOLS_CODER]: NODE.TOOLS_CODER,
    [NODE.SUPERVISOR]:  NODE.SUPERVISOR,
  } as any);
  graph.addEdge(NODE.TOOLS_CODER as never, NODE.CODER as never);

  graph.addConditionalEdges(NODE.AUDITOR as never, makeWorkerEdge(NODE.TOOLS_AUDITOR), {
    [NODE.TOOLS_AUDITOR]: NODE.TOOLS_AUDITOR,
    [NODE.SUPERVISOR]:    NODE.SUPERVISOR,
  } as any);
  graph.addEdge(NODE.TOOLS_AUDITOR as never, NODE.AUDITOR as never);

  graph.addConditionalEdges(
    NODE.RESEARCHER as never,
    makeWorkerEdge(NODE.TOOLS_RESEARCHER),
    {
      [NODE.TOOLS_RESEARCHER]: NODE.TOOLS_RESEARCHER,
      [NODE.SUPERVISOR]:       NODE.SUPERVISOR,
    } as any
  );
  graph.addEdge(NODE.TOOLS_RESEARCHER as never, NODE.RESEARCHER as never);

  graph.addConditionalEdges(NODE.QA as never, makeWorkerEdge(NODE.TOOLS_QA), {
    [NODE.TOOLS_QA]: NODE.TOOLS_QA,
    [NODE.SUPERVISOR]: NODE.SUPERVISOR,
  } as any);
  graph.addEdge(NODE.TOOLS_QA as never, NODE.QA as never);

  // Pass checkpointer into compile — this is the only change from Phase 5
  return graph.compile({
    checkpointer: checkpointer ?? false,
  });
}

// ─── Compiled Graph Singleton ─────────────────────────────────────────────────

/**
 * The compiled, runnable graph instance.
 * Import this in the CLI entry point to invoke the engine.
 *
 * Usage:
 *   const result = await compiledGraph.invoke(initialState);
 *   // or streaming:
 *   const stream = await compiledGraph.stream(initialState);
 */
export const compiledGraph = buildGraph();

export type CompiledGraph = typeof compiledGraph;