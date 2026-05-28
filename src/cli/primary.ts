import { tool } from "@langchain/core/tools";
import { z } from "zod";
import chalk from "chalk";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { getSupervisorLLM, createLLM } from "../agents/llm.js";
import { readFileTool, listDirTool } from "../tools/filesystem.js";
import { searchCodebaseTool } from "../tools/search.js";
import { runGraph, type GraphStep, resolveDbPath } from "../graph/runner.js";
import { SessionStore } from "../memory/session.js";
import { createSpinner } from "./prompts.js";
import { renderStep, formatStep } from "./renderer.js";
import { SqliteCheckpointer } from "../graph/checkpointer.js";
import { randomUUID } from "crypto";
import { SystemMessage } from "@langchain/core/messages";
import { CONFIG } from "../config/index.js";
import readline from "readline";

// Per-turn execution counter to prevent redundant re-delegations.
// The Primary Agent's React loop often calls execute_task multiple times with
// rephrased goals. This counter allows at most 1 successful execution per user turn.
let _executeTaskCallCount = 0;

/** Reset the execute_task guard. Call this at the start of each user turn. */
export function resetExecuteTaskGuard(): void {
  _executeTaskCallCount = 0;
}

// ─── Keypress Helper ──────────────────────────────────────────────────────────

async function waitForKeypress(promptText: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(promptText);

    if (!process.stdin.isTTY) {
      console.log();
      resolve("");
      return;
    }

    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    readline.emitKeypressEvents(process.stdin);

    const onKeypress = (chunk: any, key: any) => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(wasRaw);
      const name = (key && key.name ? key.name : "").toLowerCase();
      resolve(name);
    };

    process.stdin.on("keypress", onKeypress);
  });
}

// ─── Execute Task Tool ────────────────────────────────────────────────────────

export const executeTaskTool = tool(
  async ({ goal, cwd, sessionId, ...overrides }, config): Promise<string> => {
    // ── Per-turn guard: allow at most 1 execute_task call per user prompt ──
    _executeTaskCallCount++;
    if (_executeTaskCallCount > 1) {
      console.log();
      console.log(chalk.hex("#F97316").bold(` ◈ Task already delegated this turn. Skipping redundant execute_task call.`));
      return (
        `Task Execution Completed.\n` +
        `Success: true\n` +
        `Steps Taken: 0\n` +
        `No errors encountered.\n` +
        `Final Status: FINISHED\n` +
        `Info: A task was already executed for this user request. Do NOT call execute_task again. Summarize the previous result for the user.`
      );
    }

    const spinner = createSpinner();
    spinner.start(chalk.hex("#7F1D1D")("Routing task to orchestrator…"));

    let stepIndex = 0;
    const stepLogs: string[] = [];
    
    // We use a separate sub-session ID for the graph execution so it doesn't
    // clash with the chat thread in the database.
    const resolvedSessionId = (sessionId && sessionId.trim() !== "") ? sessionId : config.configurable?.thread_id;
    if (!resolvedSessionId) {
      throw new Error("No session ID found in tool arguments or configuration thread_id.");
    }
    const subSessionId = `${resolvedSessionId}-task-${randomUUID().slice(0, 8)}`;
    const dbPath = resolveDbPath(resolvedSessionId); // Store it in the same DB file
    const store = new SessionStore(dbPath);

    const safetyMode = config.configurable?.safetyMode;
    const resolvedCwd = config.configurable?.cwd ?? cwd ?? process.cwd();

    try {
      const result = await runGraph({
        goal,
        cwd: resolvedCwd,
        sessionId: subSessionId,
        store,
        overrides,
        safetyMode,
        onStep(step: GraphStep) {
          spinner.stop("", 0);
          const formatted = formatStep(step, ++stepIndex);
          stepLogs.push(...formatted);
          for (const line of formatted) {
            console.log(line);
          }
          const nextMsg = step.update.activeWorker
            ? `Agent running: ${step.update.activeWorker}…`
            : `Orchestrating…`;
          spinner.start(nextMsg);
        },
      });

      spinner.stop(
        result.success
          ? chalk.hex("#84CC16")("✓ Execution complete")
          : chalk.hex("#DC2626")("✗ Execution ended with errors"),
        0
      );

      // Collapsible process logs dropdown
      if (stepLogs.length > 0) {
        // Erase dynamic live-written logs and completion message
        const linesToClear = stepLogs.length + 1;
        for (let i = 0; i < linesToClear; i++) {
          process.stdout.write("\u001b[1A\u001b[2K");
        }

        const durationText = result.stepCount > 0 ? ` · ${result.stepCount} steps` : "";
        let expanded = false;

        while (true) {
          if (!expanded) {
            const promptText =
              `  ${chalk.hex("#F97316")("▶")} ${chalk.hex("#F59E0B").bold("Worked")}` +
              chalk.dim(durationText) +
              chalk.hex("#7F1D1D")("  ─  ") +
              chalk.dim("L") + chalk.hex("#991B1B")(" expand logs  ") +
              chalk.dim("↵") + chalk.hex("#991B1B")(" continue ");
            const key = await waitForKeypress(promptText);

            // Clear prompt line
            process.stdout.write(`\r\u001b[2K`);

            if (key === "l") {
              expanded = true;
              // Expanded header
              const divLine = chalk.hex("#7F1D1D")("─".repeat(Math.min((process.stdout.columns ?? 80) - 4, 72)));
              console.log();
              console.log(`  ${divLine}`);
              console.log(
                `  ${chalk.hex("#F97316")("▼")} ${chalk.hex("#F59E0B").bold("Execution Logs")}` +
                chalk.dim(durationText) +
                chalk.hex("#7F1D1D")("  ─  ") +
                chalk.hex("#991B1B").dim(`goal: ${goal.slice(0, 60)}${goal.length > 60 ? "…" : ""}`)
              );
              console.log(chalk.dim(`  ⌕ ${resolvedCwd}`));
              console.log(`  ${divLine}`);
              console.log();
              for (const line of stepLogs) {
                console.log(line);
              }
              console.log();
            } else {
              // Confirm collapsed
              console.log(
                `  ${chalk.hex("#F97316")("▶")} ${chalk.hex("#F59E0B").bold("Worked")}` +
                chalk.dim(durationText)
              );
              break;
            }
          } else {
            const promptText =
              `  ${chalk.dim("L")} ${chalk.hex("#991B1B")("collapse logs  ")}` +
              `${chalk.dim("↵")} ${chalk.hex("#991B1B")("continue ")}  `;
            const key = await waitForKeypress(promptText);

            // Clear prompt line
            process.stdout.write(`\r\u001b[2K`);

            if (key === "l") {
              expanded = false;
              // Clear the expanded printout:
              // divLine + blank + goal line + cwd line + divLine + blank header = 6 extra lines
              // + stepLogs.length log lines + 1 blank line after logs
              const linesToClear = 7 + stepLogs.length;
              for (let i = 0; i < linesToClear; i++) {
                process.stdout.write("\u001b[1A\u001b[2K");
              }
            } else {
              // Confirm expanded (keep logs visible)
              break;
            }
          }
        }
      }

      let finalResultContent = "";
      if (result.finalState.messages) {
        for (let i = result.finalState.messages.length - 1; i >= 0; i--) {
          const msg = result.finalState.messages[i];
          if (!msg) continue;
          const isAI = typeof msg._getType === "function"
            ? msg._getType() === "ai"
            : msg.constructor.name === "AIMessage";

          if (isAI && msg.content) {
            const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
            const trimmed = contentStr.trim();
            if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
              continue;
            }
            finalResultContent = trimmed;
            break;
          }
        }
      }

      return (
        `Task Execution Completed.\n` +
        `Success: ${result.success}\n` +
        `Steps Taken: ${result.stepCount}\n` +
        (finalResultContent ? `Result:\n${finalResultContent}\n` : "") +
        (result.errorLogs.length > 0
          ? `Errors encountered:\n${result.errorLogs.join("\n")}\n`
          : "No errors encountered.\n") +
        `Final Status: ${result.finalState.status}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      spinner.stop(chalk.hex("#DC2626")(`Execution failed: ${msg}`), 1);
      return `Failed to execute task: ${msg}`;
    } finally {
      // Wait a brief tick for any pending background checkpointer writes to flush
      await new Promise((resolve) => setTimeout(resolve, 200));
      store.close();
    }
  },
  {
    name: "execute_task",
    description:
      "Use this tool to delegate complex coding tasks, bug fixes, file creation, or testing to the specialized Multi-Agent Team. " +
      "Provide a clear, detailed goal. You MUST use this tool whenever the user asks to modify the codebase.",
    schema: z.object({
      goal: z.string().describe("The comprehensive task description for the agents to execute."),
      cwd: z.string().describe("The absolute working directory."),
      sessionId: z.string().optional().describe("The current session ID."),
      maxSteps: z.number().optional().describe("Override the maximum number of steps for the orchestrator (default: 50)."),
      temperature: z.number().optional().describe("Override the model temperature for this task."),
      model: z.string().optional().describe("Override the primary model used for this task."),
    }),
  }
);

// ─── Primary Agent Definition ──────────────────────────────────────────────────

const PRIMARY_SYSTEM_PROMPT = `
You are the Primary AI Assistant for the Chimera Engine.
You act as the conversational interface between the human user and the specialized agent orchestrator.

## CAPABILITIES
- You can answer questions, analyze code, and chat with the user.
- You have read-only tools to explore the codebase: read_file, list_dir, search_codebase.
- If the user asks you to modify code, write tests, or execute complex multi-step workflows, you MUST use the \`execute_task\` tool.

## RULES
1. NEVER attempt to write or modify code yourself (you do not have write tools).
2. Use \`execute_task\` for all implementation requests. Pass a detailed 'goal' so the orchestrator knows exactly what to do.
3. After \`execute_task\` returns, summarize the outcome for the user.
4. You can dynamically adjust orchestrator parameters (maxSteps, temperature, model) in \`execute_task\` if a situation warrants it (e.g., increase maxSteps for very large tasks, or temperature for creative exploratory tasks).
5. When answering questions, use Markdown formatting for readability.
6. If the user's intent is ambiguous (e.g. "fix it"), ask for clarification before delegating the task.
7. After execute_task returns a successful result, you MUST immediately write a plain-text summary for the user and stop calling tools. Do NOT call execute_task again for the same task.
8. NEVER call execute_task more than once per user request. If the first execution succeeds, the task is DONE.
`.trim();

/**
 * Creates the Primary React Agent, which powers the unified REPL.
 */
export function createPrimaryAgent(dbPath: string, cwd: string) {
  const chatLLM = createLLM({
    model: CONFIG.OLLAMA.MODELS.SUPERVISOR,
    jsonMode: false,
    temperature: CONFIG.OLLAMA.DEFAULT_TEMPERATURE,
  });

  const tools = [
    readFileTool,
    listDirTool,
    searchCodebaseTool,
    executeTaskTool,
  ];

  // We use the raw DB from a temporary store instance to initialize the checkpointer
  const store = new SessionStore(dbPath);
  const checkpointer = new SqliteCheckpointer(store.rawDb);

  const dynamicSystemPrompt = `${PRIMARY_SYSTEM_PROMPT}\n\n## CURRENT ENVIRONMENT\n- Current Working Directory (CWD): ${cwd}`.trim();

  const agent = createReactAgent({
    llm: chatLLM,
    tools,
    checkpointSaver: checkpointer,
    messageModifier: new SystemMessage(dynamicSystemPrompt),
  });

  return { agent, store };
}
