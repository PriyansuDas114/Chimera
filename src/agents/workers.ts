import { createLLM } from "./llm.js";
import { toolRegistry, toolsByName } from "../tools/registry.js";
import type { AgentState, AgentStateUpdate } from "../graph/state.js";
import { SystemMessage, AIMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { CONFIG } from "../config/index.js";
import { getModelForRole } from "../providers/registry.js";
import type { WorkerConfig } from "../types/index.js";

// ─── Worker Factory ───────────────────────────────────────────────────────────

/**
 * Factory that produces a LangGraph node function for a specialized worker agent.
 *
 * Each worker:
 *   1. Gets TWO LLM instances: one with tools (normal use), one without (cap fallback).
 *   2. Prepends its system prompt + session context to the current message history.
 *   3. Counts tool calls already made in this turn. If the cap is hit, it SWITCHES
 *      to the no-tools LLM — the model is then physically incapable of emitting
 *      tool_calls, regardless of its trained behaviour.
 *   4. Returns a partial state update appending the LLM's response to messages.
 *
 * Why two LLM instances?
 *   Injecting a "stop using tools" SystemMessage is insufficient — models trained
 *   for tool use will often ignore it when tools are still registered. Removing
 *   the tool binding at the API level is the only reliable enforcement mechanism.
 */

import type { RunnableConfig } from "@langchain/core/runnables";

export function createWorkerNode(
  config: WorkerConfig
): (state: AgentState, runConfig?: RunnableConfig) => Promise<AgentStateUpdate> {
  // Filter the tool registry based on what this worker is allowed to do.
  // If no list is provided, default to all tools (backward compatibility/Coder).
  const filteredTools = config.allowedTools 
    ? toolRegistry.filter(t => config.allowedTools!.includes(t.name))
    : toolRegistry;

  // Primary LLM: filtered tools bound.
  const llmWithTools: BaseChatModel = createLLM({
    model: config.model,
    tools: filteredTools,
    temperature: config.temperature ?? 0.15,
    jsonMode: false,
  });

  // Fallback LLM: NO tools bound — used when the per-turn tool cap is hit.
  // Without any tools registered, the model cannot physically emit tool_calls,
  // so it is forced to produce a plain-text final response.
  const llmNoTools: BaseChatModel = createLLM({
    model: config.model,
    temperature: config.temperature ?? 0.15,
    jsonMode: false,
  });

  return async function workerNode(state: AgentState, runConfig?: RunnableConfig): Promise<AgentStateUpdate> {
    try {
      // ── Tool call counting ──────────────────────────────────────────────────
      // Find the index of the last SystemMessage that starts with [ORCHESTRATOR]
      // to scope the count to the current supervisor turn only.
      const messages = state.messages;
      let turnStartIdx = 0;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (
          m &&
          m._getType() === "human" &&
          typeof m.content === "string" &&
          m.content.startsWith("[ORCHESTRATOR")
        ) {
          turnStartIdx = i;
          break;
        }
      }

      // Count AI messages with tool_calls since the current turn started.
      const toolCallsThisTurn = messages
        .slice(turnStartIdx)
        .filter(
          (m) =>
            m._getType() === "ai" &&
            Array.isArray((m as any).tool_calls) &&
            (m as any).tool_calls.length > 0
        ).length;

      const hitToolCap = toolCallsThisTurn >= CONFIG.LIMITS.MAX_TOOL_CALLS_PER_TURN;

      // ── Build message list ──────────────────────────────────────────────────
      // CRITICAL: Only pass the CURRENT TURN's messages to the worker.
      // Passing the full history causes context poisoning — the model sees
      // dozens of JSON routing decisions from past turns and starts imitating
      // that format instead of calling tools. The turnStartIdx already points
      // to the last [ORCHESTRATOR → X] instruction, so slicing from there
      // gives the worker exactly what it needs: its task + any tool results.
      const currentTurnMessages = state.messages.slice(turnStartIdx);

      const prompt = [
        new SystemMessage(config.systemPrompt),
        new SystemMessage(
          `## SESSION CONTEXT\n` +
          `Session ID: ${state.sessionId}\n` +
          `Working Directory (cwd): ${state.cwd}\n` +
          `Your Role: ${config.name}\n` +
          `Current Goal: ${state.globalGoal}\n\n` +
          `CRITICAL: You are a WORKER agent. You MUST call tools to do your job.\n` +
          `Do NOT output JSON objects like {"next_agent": ...}. That is ONLY for the Orchestrator.\n` +
          `Your ONLY valid outputs are: tool calls, or a plain-text summary after completing your task.`
        ),
        ...currentTurnMessages,
        // When cap is hit, reinforce with a directive even though the model
        // has no tools — belt-and-suspenders for clarity in the message history.
        ...(hitToolCap
          ? [new SystemMessage(
              `[SYSTEM] Tool call limit reached (${toolCallsThisTurn}/${CONFIG.LIMITS.MAX_TOOL_CALLS_PER_TURN}). ` +
              `You MUST now write your complete final response as plain text. ` +
              `Do not request any further tool calls.`
            )]
          : []),
      ];

      // ── Invoke the appropriate LLM ──────────────────────────────────────────
      const overrides = runConfig?.configurable?.["overrides"];
      let activeLLM: BaseChatModel;

      if (overrides?.temperature !== undefined || overrides?.model !== undefined) {
        // Dynamic override for this specific turn
        activeLLM = createLLM({
          model: overrides.model ?? config.model,
          tools: hitToolCap ? [] : filteredTools,
          temperature: overrides.temperature ?? config.temperature ?? 0.15,
          jsonMode: false,
        });
      } else {
        // Use pre-instantiated defaults
        activeLLM = hitToolCap ? llmNoTools : llmWithTools;
      }

      const response = await activeLLM.invoke(prompt);

      // ── Content-based tool call fallback ─────────────────────────────────────
      // Some models (e.g. qwen2.5-coder) emit tool calls as JSON text in
      // the content field rather than as structured tool_calls objects.
      // Detect this pattern and execute the tool manually.
      const contentStr = typeof response.content === "string" ? response.content.trim() : "";
      const hasRealToolCalls = Array.isArray(response.tool_calls) && response.tool_calls.length > 0;

      if (!hasRealToolCalls && contentStr.includes("{")) {
        let cleaned = contentStr;
        const start = cleaned.indexOf("{");
        const end   = cleaned.lastIndexOf("}");
        if (start !== -1 && end !== -1 && end > start) {
          cleaned = cleaned.slice(start, end + 1);
        }

        try {
          const parsed = JSON.parse(cleaned);

          // Check if the worker hallucinated supervisor routing JSON
          if (parsed && typeof parsed === "object" && "next_agent" in parsed) {
            const summary = (parsed as any).instructions ?? (parsed as any).reasoning ?? "Task completed.";
            response.content = summary;
            return {
              messages: [response],
              activeWorker: state.activeWorker,
            };
          }

          const toolName: string | undefined = parsed.name;
          const toolArgs: Record<string, unknown> = parsed.arguments ?? parsed.args ?? {};

          if (toolName && toolsByName[toolName]) {
            const theTool = toolsByName[toolName];
            // Inject cwd into args if the tool needs it
            const argsWithCwd = { cwd: state.cwd, ...toolArgs };
            const toolResult = await theTool.invoke(argsWithCwd as any);

            const fakeId = `fallback-${Date.now()}`;
            const aiMsg = new AIMessage({
              content: "",
              tool_calls: [{ name: toolName, args: argsWithCwd, id: fakeId }],
            });
            const toolMsg = new ToolMessage({
              content: String(toolResult),
              tool_call_id: fakeId,
            });

            return {
              messages: [aiMsg, toolMsg],
              activeWorker: state.activeWorker,
            };
          }
        } catch {
          // Not a valid JSON object, fall through
        }

        // If it starts with JSON syntax but wasn't a valid tool call or routing JSON
        if (contentStr.startsWith("{")) {
          return {
            messages: [
              response,
              new SystemMessage(
                `[WORKER ERROR — ${config.name}] You output raw JSON that is not a valid tool call. ` +
                `You are a worker agent, NOT the Orchestrator. You MUST use the provided tools ` +
                `to execute your task. Do not output routing decisions or raw JSON.`
              ),
            ],
            activeWorker: state.activeWorker,
          };
        }
      }

      // Normal text response (e.g. summary or lazy response) or successful tool call
      return {
        messages: [response],
        activeWorker: state.activeWorker,
      };
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);

      const errorLog =
        `Worker "${config.name}" failed at ${new Date().toISOString()}: ${errorMessage}`;

      return {
        errorLogs: [errorLog],
        messages: [
          new SystemMessage(
            `[WORKER ERROR — ${config.name}] ${errorMessage}. ` +
            `The worker failed to produce a response. Routing back to Orchestrator.`
          ),
        ],
      };
    }
  };
}

// ─── System Prompts ───────────────────────────────────────────────────────────

const CODER_SYSTEM_PROMPT = `
You are the Coder agent in a multi-agent software engineering system.
You are an expert software engineer. Your ONLY job is to implement exactly what the Orchestrator instructs using the provided tools.

## CRITICAL RULES — READ FIRST
- You are a WORKER. You use TOOLS. You do NOT output JSON routing decisions.
- NEVER output JSON objects like {"next_agent": ...} or {"instructions": ...}. That format is ONLY for the Orchestrator, not you.
- If you output JSON instead of calling a tool, you have made a FATAL ERROR. Always call a tool instead.
- Your ONLY valid responses are: (1) a tool call, or (2) a plain-text summary AFTER you have already called write_file.

## YOUR RESPONSIBILITIES
- Use the write_file tool to create or modify files. This is your PRIMARY action.
- Use read_file ONLY if you need to read an existing file's content first.
- Use list_dir ONLY if you genuinely need to discover the directory structure.
- Use run_command for tasks like installing packages, running tests, or compiling — only when explicitly needed.

## EXAMPLE — CORRECT BEHAVIOR
Task: "Create a file named hello.js with content console.log('hello');"
Correct action: Call write_file with path="hello.js" and content="console.log('hello');" IMMEDIATELY.
Do NOT think about it. Do NOT explain. Just call write_file.

## WHEN TO STOP USING TOOLS
- You have a strict limit of 5 tool calls total.
- Write the file, then STOP. Do NOT read it back to verify.
- After completing your implementation, write a plain-text summary of what you did.

## CODING STANDARDS
- Always match the existing code style in the project.
- Do not leave TODO stubs — implement the full logic requested.
`.trim();

const AUDITOR_SYSTEM_PROMPT = `
You are the Auditor agent in a multi-agent software engineering system.
You are a senior code reviewer. Your job is to critically review the Coder's output and ensure quality and correctness.

## YOUR RESPONSIBILITIES
- Read every file that the Coder claims to have written or modified using read_file.
- Verify the implementation against the original goal stated in the session context.
- Check for the following categories of issues:

### Correctness
- Does the code do what it is supposed to do?
- Are there logical errors, off-by-one errors, or unhandled edge cases?

### Security
- Are there any injection vulnerabilities, path traversal risks, or exposed secrets?
- Are external inputs validated before use?

### TypeScript Quality
- Are types strict and accurate? No implicit 'any' or type assertions without justification.
- Are error cases handled explicitly?

### Goal Alignment
- Does the implementation fully satisfy the user's original global goal?
- Are there missing pieces that the Coder skipped?

## WHEN TO STOP USING TOOLS
- You have a strict limit of 5 tool calls total.
- You MUST use read_file on every file the Coder claims to have written.
- Read each relevant file ONCE. Do NOT read the same file twice.
- Do NOT trust the Coder's summary. You MUST verify the code exists on disk.
- Once you have read all necessary files, STOP calling tools immediately.
- Write your verdict AFTER your last tool call result. Do NOT call tools after writing the verdict.

## OUTPUT FORMAT
After reading the files, you MUST write your review and end with ONE of these exact verdicts:

**VERDICT: APPROVED** — if the implementation is correct and complete.
**VERDICT: NEEDS_REVISION** — if there are issues. List each issue as a numbered item below the verdict.

Never approve code that has security vulnerabilities or fails to meet the goal.
IMPORTANT: Output the verdict as the LAST thing in your response. Do NOT call any tools after writing the verdict.
`.trim();

const RESEARCHER_SYSTEM_PROMPT = `
You are the Researcher agent in a multi-agent software engineering system.
Your job is to explore the codebase, understand the existing architecture, and find relevant code for the Coder to modify.

## YOUR RESPONSIBILITIES
- Use list_dir to discover the project structure.
- Use read_file to examine the contents of relevant files.
- Use search_codebase to find code related to specific features or identifiers.
- Provide a clear, structured summary of your findings to the Orchestrator.

## RECONNAISSANCE STRATEGY
- Do NOT just list the directory over and over. Once you know a file exists, READ it.
- If you are looking for where a function is defined, use search_codebase first.
- When you find relevant code, quote the key parts in your report so the Coder knows exactly what they are working with.
- If you find a file like math.ts, you MUST read its content to understand its structure before reporting back.

## BEHAVIOUR RULES
- Be thorough but efficient. You have a limit of 5 tool calls.
- Always report your findings in a structured "Reconnaissance Report".
- Do NOT guess file contents — if you haven't read the file, you don't know what's in it.
`.trim();

// ─── Worker Node Instances ────────────────────────────────────────────────────
//
// Each worker reads its model from the runtime store at INVOCATION TIME via
// a getter — this ensures /model changes take effect on the next message
// without restarting the process.

export const coderNode = createWorkerNode({
  name: "Coder",
  get model() { return getModelForRole("coder"); },
  systemPrompt: CODER_SYSTEM_PROMPT,
  temperature: 0.2,
  allowedTools: ["read_file", "write_file", "list_dir", "run_command", "search_codebase"],
});

export const auditorNode = createWorkerNode({
  name: "Auditor",
  get model() { return getModelForRole("auditor"); },
  systemPrompt: AUDITOR_SYSTEM_PROMPT,
  temperature: 0.0,
  allowedTools: ["read_file", "list_dir"],
});

export const researcherNode = createWorkerNode({
  name: "Researcher",
  get model() { return getModelForRole("researcher"); },
  systemPrompt: RESEARCHER_SYSTEM_PROMPT,
  temperature: 0.1,
  allowedTools: ["read_file", "list_dir", "search_codebase"],
});

const QA_SYSTEM_PROMPT = `
You are the QA Engineer agent in a multi-agent software engineering system.
You are a senior testing specialist. Your job is to verify that the Coder's implementation works correctly by writing and running automated tests.

## YOUR RESPONSIBILITIES
- Use read_file to read the code that the Coder just wrote or modified.
- Write a dedicated test file (e.g., using node:test for TS/JS, or a simple test script for Python/others) using the write_file tool.
- Execute the test file using the run_command tool.
- Analyze the output of the test run to determine if the code works as expected.
- If the test fails or throws an error, you must clearly report the failure.

## WHEN TO STOP USING TOOLS
- You have a strict limit of 5 tool calls total.
- You MUST use write_file to save your test script.
- You MUST use run_command to execute your test script.
- Do NOT trust the Coder's summary. You MUST verify the code executes without errors.
- Once you have executed the tests and seen the result, STOP calling tools immediately.
- Write your final QA report AFTER your last tool call result. Do NOT call tools after writing the report.

## OUTPUT FORMAT
After executing the tests, you MUST write your QA report and end with ONE of these exact verdicts:

**QA VERDICT: PASSED** — if the tests executed successfully and passed.
**QA VERDICT: FAILED** — if the tests failed or threw an error. List the error output clearly.

IMPORTANT: Output the verdict as the LAST thing in your response. Do NOT call any tools after writing the verdict.
`.trim();

export const qaNode = createWorkerNode({
  name: "QA Engineer",
  get model() { return getModelForRole("qa"); },
  systemPrompt: QA_SYSTEM_PROMPT,
  temperature: 0.1,
  allowedTools: ["read_file", "write_file", "run_command", "list_dir"],
});