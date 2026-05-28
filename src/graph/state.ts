import { BaseMessage } from "@langchain/core/messages";
import {
  Annotation,
  messagesStateReducer,
} from "@langchain/langgraph";

// ─── Status Union ────────────────────────────────────────────────────────────

/**
 * Represents the lifecycle stage of a single agent execution cycle.
 *
 * PLANNING         → Supervisor is analyzing the goal and routing.
 * CODING           → Coder worker is actively generating or editing code.
 * REVIEWING        → Auditor worker is inspecting code for issues.
 * AWAITING_APPROVAL→ HITL gateway is blocking, waiting for user [Y/n].
 * FINISHED         → Terminal state; graph execution halts.
 */
export type AgentStatus =
  | "PLANNING"
  | "CODING"
  | "REVIEWING"
  | "TESTING"
  | "AWAITING_APPROVAL"
  | "FINISHED";

// ─── Worker Names ─────────────────────────────────────────────────────────────

/**
 * Strongly-typed worker identifiers.
 * Null means no worker is currently active (e.g., during supervisor routing).
 */
export type WorkerName = "coder" | "auditor" | "researcher" | "qa" | null;

// ─── Custom Reducers ──────────────────────────────────────────────────────────

/**
 * Append-only reducer for string arrays (used for errorLogs).
 *
 * Nodes return a *partial* list of new errors. This reducer merges them
 * into the existing log without any node needing to know prior state.
 *
 * @param current - The accumulated error log already in state.
 * @param incoming - New error strings emitted by the current node.
 * @returns A new array with incoming entries appended after current.
 */
function appendStrings(current: string[], incoming: string[]): string[] {
  return [...current, ...incoming];
}

// ─── AgentState Annotation ────────────────────────────────────────────────────

/**
 * The single source of truth passed between every node in the graph.
 *
 * Defined using LangGraph's `Annotation.Root` API, which lets each channel
 * declare its own reducer independently. LangGraph merges partial node
 * outputs into the full state using these reducers at each step.
 */
export const AgentStateAnnotation = Annotation.Root({
  /**
   * Unique identifier for this execution session.
   * Set once at graph invocation, never mutated.
   * Reducer: LastValue (overwrite) — scalar identity field.
   */
  sessionId: Annotation<string>({
    reducer: (_current, incoming) => incoming,
    default: () => "",
  }),

  /**
   * Absolute path of the working directory where the CLI was launched.
   * Used by filesystem and shell tools to scope all I/O.
   * Reducer: LastValue (overwrite) — a single ground-truth path.
   */
  cwd: Annotation<string>({
    reducer: (_current, incoming) => incoming,
    default: () => process.cwd(),
  }),

  /**
   * The top-level task description provided by the user.
   * Injected at start; the Supervisor references this to decompose work.
   * Reducer: LastValue (overwrite) — goal is stable once set.
   */
  globalGoal: Annotation<string>({
    reducer: (_current, incoming) => incoming,
    default: () => "",
  }),

  /**
   * Full conversation history as LangChain BaseMessage objects.
   *
   * Reducer: messagesStateReducer
   * - Appends new messages by default.
   * - Supports in-place updates via matching message `id`.
   * - Supports deletions via RemoveMessage sentinel.
   *
   * This is the canonical reducer for any LangGraph message history channel.
   * Nodes should return only *new* messages; the reducer handles merging.
   */
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /**
   * Current lifecycle stage of the agent execution cycle.
   * Drives conditional edge routing in the graph builder.
   * Reducer: LastValue (overwrite) — only one status can be active.
   */
  status: Annotation<AgentStatus>({
    reducer: (_current, incoming) => incoming,
    default: () => "PLANNING",
  }),

  /**
   * The worker node currently handling execution, or null when the
   * Supervisor is in control between worker handoffs.
   * Reducer: LastValue (overwrite) — only one active worker at a time.
   */
  activeWorker: Annotation<WorkerName>({
    reducer: (_current, incoming) => incoming,
    default: () => null,
  }),

  /**
   * Append-only log of error strings accumulated across all nodes.
   *
   * Reducer: appendStrings (custom)
   * - Nodes emit only *new* errors as a plain string array.
   * - The reducer appends them without nodes needing to read prior logs.
   * - Never overwrites — full error history is always preserved.
   *
   * Useful for the HITL gateway to surface accumulated issues to the user
   * and for the Auditor to reference prior failures without re-querying state.
   */
  errorLogs: Annotation<string[]>({
    reducer: appendStrings,
    default: () => [],
  }),
});

// ─── Derived Type ─────────────────────────────────────────────────────────────

/**
 * The concrete TypeScript type inferred from the annotation.
 * Import this type everywhere you need to type a state object or
 * a partial node return value.
 *
 * Example node signature:
 *   async function coderNode(state: AgentState): Promise<Partial<AgentState>>
 */
export type AgentState = typeof AgentStateAnnotation.State;

/**
 * Type for partial state updates returned by graph nodes.
 * Nodes should always return this rather than the full AgentState
 * to make reducer behaviour explicit and avoid accidental overwrites.
 *
 * Example:
 *   return {
 *     status: "CODING",
 *     activeWorker: "coder",
 *     messages: [new AIMessage("Starting code generation...")],
 *   } satisfies AgentStateUpdate;
 */
export type AgentStateUpdate = Partial<AgentState>;