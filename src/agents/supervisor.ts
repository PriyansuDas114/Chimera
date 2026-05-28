import { z } from "zod";
import { SystemMessage, AIMessage, HumanMessage } from "@langchain/core/messages";
import { createLLM } from "./llm.js";
import { getModelForRole } from "../providers/registry.js";
import type { AgentState, AgentStateUpdate, WorkerName } from "../graph/state.js";

// ─── Routing Schema ───────────────────────────────────────────────────────────

/**
 * The strict schema the Supervisor must emit on every invocation.
 * Zod validates this after JSON.parse — a missing or misspelled
 * `next_agent` value will throw and trigger the fallback path.
 */
const RoutingDecisionSchema = z.object({
  next_agent: z.enum(["Coder", "Auditor", "Researcher", "QA", "FINISH"]),
  instructions: z
    .string()
    .default("Continue with task"),
  reasoning: z
    .string()
    .optional()
    .describe("Optional: Supervisor's internal chain-of-thought for this decision"),
});

type RoutingDecision = z.infer<typeof RoutingDecisionSchema>;

// ─── System Prompt ────────────────────────────────────────────────────────────

const SUPERVISOR_SYSTEM_PROMPT = `
You are the Orchestrator in a multi-agent software engineering system.
Your ONLY job is to analyze the current state of a task and decide which specialist agent should act next.

## AVAILABLE AGENTS
- **Coder**: Writes, edits, and creates code and files. Use for implementation tasks.
- **QA**: Writes and executes automated tests for the code. Use after Coder finishes implementation.
- **Auditor**: Reviews code and test results for correctness, security flaws, and alignment with the goal. Use after QA tests are complete.
- **Researcher**: Explores and maps the existing codebase using search and read tools. Use when the task requires understanding existing code before changes are made.
- **FINISH**: The task is fully complete and verified. Use ONLY when the Auditor has confirmed the implementation is correct.

## ROUTING RULES
1. For a new task with no code written yet:
   - Route to **Coder** directly if the task is self-contained (e.g., "create a file", "write a script", "add a function"). Do NOT use Researcher for simple tasks.
   - Route to **Researcher** ONLY if the task explicitly requires understanding the existing codebase first (e.g., "refactor X", "add feature to existing module Y").
2. After Coder produces an implementation, route to **QA** to verify the code works. (Exception: If the task is purely documentation or non-code, you may skip QA and route directly to Auditor).
3. After QA has executed tests and reported the verdict, ALWAYS route to **Auditor**.
4. If a worker (Coder/QA/Researcher/Auditor) fails with a [WORKER ERROR] or 'fetch failed' message, you MUST route back to that same worker with instructions to retry, or route to Researcher to investigate the cause. Do NOT route to Auditor or FINISH if the Coder or QA has failed.
5. If the Auditor finds issues, route back to Coder with the specific issues listed in your instructions.
6. If the Auditor approves, route to FINISH IMMEDIATELY. Do not route back to the Researcher, Coder, or QA just to say "good job".
7. Never route to FINISH unless an Auditor has explicitly approved the implementation in the message history (Exception: see Trivial Tasks Bypass rule below).
8. If you see repeated failures (3+ cycles on the same issue), set next_agent to FINISH and explain the blocker in instructions.
9. **Trivial Tasks Bypass**: If the task is extremely simple and direct (e.g., creating a single file with simple console.log/text, reading a file, or running a simple command), once the Coder or Researcher completes the file creation or operation successfully (confirmed by a successful tool execution message in history), you should route directly to **FINISH** to avoid wasting time/resources on QA and Auditor cycles.

## OUTPUT FORMAT
You MUST respond with ONLY a valid JSON object. No markdown, no explanation outside the JSON.
The JSON must have EXACTLY this structure with EXACTLY these field names:

{
  "next_agent": "Coder",
  "instructions": "Write the implementation now.",
  "reasoning": "The task requires new code to be written."
}

The "next_agent" field MUST be one of these exact strings: "Coder", "Auditor", "Researcher", "QA", "FINISH"
Do NOT use "name", "arguments", "agent", or any other field name. ONLY "next_agent".

## CRITICAL
- Do NOT attempt to write code yourself.
- Do NOT call any tools.
- Do NOT add any text before or after the JSON object.
- The ONLY valid field names are: next_agent, instructions, reasoning.
`.trim();

// ─── Agent → WorkerName Mapping ───────────────────────────────────────────────

const AGENT_TO_WORKER: Record<string, WorkerName> = {
  Coder:      "coder",
  Auditor:    "auditor",
  Researcher: "researcher",
  QA:         "qa",
  FINISH:     null,
};

// ─── Supervisor Node ──────────────────────────────────────────────────────────

/**
 * LangGraph node function for the Supervisor agent.
 *
 * Reads the full AgentState, calls the JSON-mode LLM, validates the response
 * with Zod, and returns a partial state update that sets the next active worker
 * and appends a SystemMessage with routing instructions for that worker.
 *
 * On parse failure, returns a safe fallback update that logs the error and
 * leaves status as PLANNING — the graph edge will re-route back here.
 */
export async function supervisorNode(
  state: AgentState
): Promise<AgentStateUpdate> {
  // Count consecutive parse failures to prevent infinite loops
  const parseErrors = state.errorLogs.filter(
    (log) => log.includes("Supervisor parse failure")
  ).length;

  // After 3 parse failures, auto-finish with explanation
  if (parseErrors >= 3) {
    return {
      status: "FINISHED",
      activeWorker: null,
      messages: [
        new SystemMessage(
          `[ORCHESTRATOR] Supervisor unable to continue (parse failures: ${parseErrors}). ` +
          `Task marked as complete. Review output from previous steps.`
        ),
      ],
    };
  }

  // ── Hard-coded Error Recovery ──────────────────────────────────────────────
  // If the last message was a [WORKER ERROR], force a retry of that same worker
  // rather than letting the LLM decide. This prevents the "hallucination loop"
  // where a small model tries to audit a failed implementation.
  const lastMessage = state.messages[state.messages.length - 1];
  if (
    lastMessage &&
    lastMessage._getType() === "system" &&
    typeof lastMessage.content === "string" &&
    lastMessage.content.includes("[WORKER ERROR")
  ) {
    const workerMatch = lastMessage.content.match(/\[WORKER ERROR — (.*?)\]/);
    const workerName = workerMatch ? workerMatch[1] : null;
    
    if (workerName && state.activeWorker) {
      return {
        messages: [
          new SystemMessage(
            `[ORCHESTRATOR → ${workerName}]\n` +
            `The previous attempt failed with an error. Retrying implementation...`
          ),
        ],
      };
    }
  }

  // Build the message list: system prompt first, then full conversation history
  const supervisorLLM = createLLM({
    model:       getModelForRole("supervisor"),
    jsonMode:    true,
    temperature: 0,
  });
  const response = await supervisorLLM.invoke([
    new SystemMessage(SUPERVISOR_SYSTEM_PROMPT),
    // Inject current goal as context so the LLM doesn't have to hunt for it
    new SystemMessage(
      `## CURRENT SESSION\n` +
      `Session ID: ${state.sessionId}\n` +
      `Global Goal: ${state.globalGoal}\n` +
      `Current Status: ${state.status}\n` +
      `Active Worker: ${state.activeWorker ?? "none"}\n` +
      `Parse Failures: ${parseErrors}\n` +
      `Error Log: ${state.errorLogs.length > 0 ? state.errorLogs.slice(-3).join("; ") : "none"}\n\n` +
      `IMPORTANT: You MUST respond with a valid JSON object. Ensure all strings (keys and values) are enclosed in double quotes.`
    ),
    ...state.messages,
  ]);

  // ── Parse & validate ────────────────────────────────────────────────────────
  let decision: RoutingDecision;

  try {
    const rawContent =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);

    // ── Step 1: Strip <think>...</think> and stray </think> tags ──────────
    // Models like Nemotron emit CoT reasoning inside think tags before the JSON.
    let cleaned = rawContent
      .replace(/<think>[\s\S]*?<\/think>/gi, "")   // full <think>...</think> blocks
      .replace(/<\/?think>/gi, "")                  // stray opening/closing tags
      .trim();

    // ── Step 2: Extract the first complete JSON object via brace counting ─
    // This handles cases where the model emits two JSON objects back-to-back
    // (e.g. a FINISH decision followed by a new routing decision).
    // The old lastIndexOf("}") would grab a span crossing both, causing failures.
    if (cleaned.includes("{")) {
      const jsonStart = cleaned.indexOf("{");
      let depth = 0;
      let jsonEnd = -1;
      for (let i = jsonStart; i < cleaned.length; i++) {
        if (cleaned[i] === "{") depth++;
        else if (cleaned[i] === "}") {
          depth--;
          if (depth === 0) {
            jsonEnd = i;
            break;
          }
        }
      }
      if (jsonEnd > jsonStart) {
        cleaned = cleaned.slice(jsonStart, jsonEnd + 1);
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      // ── Layer 2: Attempt heuristic repair ──────────────────────────────
      // Models sometimes omit quotes around values, especially 'reasoning'.
      // Try to wrap unquoted values in double quotes.
      const repaired = cleaned
        .replace(/"reasoning":\s*([^"{}\s][^{}]*)/g, '"reasoning": "$1"')
        .replace(/"instructions":\s*([^"{}\s][^{}]*)/g, '"instructions": "$1"')
        .replace(/,\s*}/g, "}"); // strip trailing comma

      try {
        parsed = JSON.parse(repaired);
      } catch {
        // Repair failed — throw original error
        throw parseErr;
      }
    }

    decision = RoutingDecisionSchema.parse(parsed);
  } catch (err) {
    // ── Fallback: bad JSON or schema mismatch ──────────────────────────────
    const errorMessage =
      err instanceof Error ? err.message : String(err);

    const errorLog =
      `Supervisor parse failure at ${new Date().toISOString()}: ${errorMessage}. ` +
      `Raw response: ${String(response.content).slice(0, 300)}`;

    return {
      status: "PLANNING",
      activeWorker: null,
      errorLogs: [errorLog],
      messages: [
        new SystemMessage(
          `[ORCHESTRATOR ERROR] Failed to parse routing decision. ` +
          `Retrying. Error: ${errorMessage}`
        ),
      ],
    };
  }

  // ── Build state update ──────────────────────────────────────────────────────
  const nextWorker = AGENT_TO_WORKER[decision.next_agent] ?? null;

  const nextStatus = ((): AgentState["status"] => {
    switch (decision.next_agent) {
      case "Coder":      return "CODING";
      case "QA":         return "TESTING";
      case "Auditor":    return "REVIEWING";
      case "Researcher": return "PLANNING";
      case "FINISH":     return "FINISHED";
    }
  })();

  return {
    status: nextStatus,
    activeWorker: nextWorker,
    messages: [
      new HumanMessage(
        `[ORCHESTRATOR → ${decision.next_agent}]\n` +
        `Instructions: ${decision.instructions}` +
        (decision.reasoning ? `\nReasoning: ${decision.reasoning}` : "")
      ),
    ],
  };
}