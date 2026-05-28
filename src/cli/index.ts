import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

import { Command } from "commander";
import chalk from "chalk";
import * as clack from "@clack/prompts";
import {
  renderBanner,
  renderStep,
  renderSummary,
  renderFatalError,
  renderMarkdown,
  renderTurnHeader,
  LiveMarkdownStream,
} from "./renderer.js";
import {
  createSpinner,
  showOutro,
  promptOllamaRetry,
} from "./prompts.js";
import type { GraphStep } from "../graph/runner.js";
import { CONFIG } from "../config/index.js";
import {
  checkProviderHealth,
  getActiveProviderDisplay,
  listProviders,
  getAllRoleModels,
  setAllModels,
  setRoleModel,
  getActiveProvider,
} from "../providers/registry.js";
import type { AgentRole } from "../providers/registry.js";

async function checkProviderAvailability(): Promise<boolean> {
  return checkProviderHealth(CONFIG.ACTIVE_PROVIDER);
}

import { promptInitialization } from "./prompts.js";
import { createPrimaryAgent, resetExecuteTaskGuard } from "./primary.js";
import { HumanMessage } from "@langchain/core/messages";
import { randomUUID } from "crypto";

interface UnifiedReplOptions {
  cwd?: string;
  session?: string;
  new?: boolean;
  safety?: string;
}

async function handleUnifiedRepl(options: UnifiedReplOptions): Promise<void> {
  // Suppress harmless, late-firing LangChain stream event callback spam
  const originalConsoleError = console.error;
  console.error = (...args: any[]) => {
    const message = args.map(arg => String(arg)).join(" ");
    if (
      message.includes("EventStreamCallbackHandler") &&
      (message.includes("WritableStream is closed") || message.includes("ERR_INVALID_STATE"))
    ) {
      return;
    }
    originalConsoleError(...args);
  };

  const originalConsoleWarn = console.warn;
  console.warn = (...args: any[]) => {
    const message = args.map(arg => String(arg)).join(" ");
    if (
      message.includes("EventStreamCallbackHandler") &&
      (message.includes("WritableStream is closed") || message.includes("ERR_INVALID_STATE"))
    ) {
      return;
    }
    originalConsoleWarn(...args);
  };

  const originalStderrWrite = process.stderr.write;
  process.stderr.write = function (chunk: any, encoding?: any, callback?: any): boolean {
    const message = typeof chunk === "string" ? chunk : chunk.toString();
    if (
      message.includes("EventStreamCallbackHandler") &&
      (message.includes("WritableStream is closed") || message.includes("ERR_INVALID_STATE"))
    ) {
      if (callback) callback();
      return true;
    }
    return originalStderrWrite.apply(process.stderr, arguments as any);
  } as any;

  try {
    renderBanner();

    // ── Provider health gate ────────────────────────────────────────────────────
    const providerOk = await checkProviderAvailability();
    if (!providerOk) {
      if (CONFIG.ACTIVE_PROVIDER === "ollama") {
        const proceed = await promptOllamaRetry();
        if (!proceed) {
          renderFatalError(
            "Ollama is not reachable.",
            `Make sure Ollama is running: ollama serve\n  Expected at: ${CONFIG.OLLAMA.BASE_URL}`
          );
          process.exit(1);
        }
      } else {
        // Cloud providers — warn but continue (may just be a transient network issue)
        console.log(
          chalk.hex("#F59E0B")(`  ⚠ Provider health check failed for "${CONFIG.ACTIVE_PROVIDER}". Continuing anyway.`)
        );
      }
    }

    // ── Initialization ──────────────────────────────────────────────────────────
    let cwd: string;

    if (options.cwd) {
      cwd = options.cwd;
      console.log();
      console.log(chalk.hex("#F97316").bold(" ◈ CHIMERA ") + chalk.dim("non-interactive init"));
      console.log(chalk.dim(`CWD:  ${cwd}`));
      console.log();
    } else {
      const input = await promptInitialization(process.cwd());
      if (!input) process.exit(0);
      cwd = input.cwd;
    }

    const { resolveDbPath } = await import("../graph/runner.js");
    const dbDir = process.env["SESSION_DB_PATH"] ?? "./data/sessions";
    const { readdirSync, existsSync } = await import("fs");
    const { resolve: pathResolve } = await import("path");
    const { SessionStore } = await import("../memory/session.js");

    let currentSessionId = options.session;

    if (!currentSessionId && !options.new) {
      // Scan for existing sessions to resume
      if (existsSync(dbDir)) {
        const dbFiles = readdirSync(dbDir).filter((f) => f.endsWith(".db"));
        if (dbFiles.length > 0) {
          const sessions: { id: string; goal: string; status: string; steps: number; updatedAt: string }[] = [];
          for (const file of dbFiles) {
            const id = file.replace(".db", "");
            try {
              const store = new SessionStore(pathResolve(dbDir, file));
              const rec = store.getById(id);
              store.close();
              if (rec) {
                sessions.push({
                  id: rec.sessionId,
                  goal: rec.goal,
                  status: rec.status,
                  steps: rec.stepCount,
                  updatedAt: rec.updatedAt,
                });
              }
            } catch {
              // ignore corrupt
            }
          }

          // Sort by updatedAt DESC
          sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

          if (sessions.length > 0) {
            const selectOptions = [
              { value: "NEW", label: chalk.hex("#F97316").bold("  [+] Start a new session") },
              { value: "MANAGE", label: chalk.hex("#F59E0B").bold("  [⚙] Manage persisted sessions...") },
            ];

            for (const s of sessions.slice(0, 5)) {
              const dateStr = new Date(s.updatedAt).toLocaleDateString();
              const shortGoal = s.goal.length > 40 ? s.goal.slice(0, 37) + "..." : s.goal;
              const shortId = s.id.slice(0, 8);
              selectOptions.push({
                value: s.id,
                label: `  ${chalk.hex("#F97316").bold(`[${shortId}]`)} ${shortGoal.padEnd(40)} ${chalk.dim(`(${s.status} · ${s.steps} steps · ${dateStr})`)}`,
              });
            }

            const chosen = await clack.select({
              message: chalk.hex("#F97316").bold("◈ Session History Detected. Choose an action:"),
              options: selectOptions,
            });

            if (clack.isCancel(chosen)) {
              process.exit(0);
            }

            if (chosen === "NEW") {
              currentSessionId = randomUUID();
            } else if (chosen === "MANAGE") {
              await runInteractiveSessionManager();
              return;
            } else {
              currentSessionId = String(chosen);
            }
          }
        }
      }
    }

    if (!currentSessionId) {
      currentSessionId = randomUUID();
    }

    const dbPath = resolveDbPath(currentSessionId);
    
    // Initialize Primary Agent
    const { agent, store } = createPrimaryAgent(dbPath, cwd);

    // If resuming, restore conversation history
    let hasHistory = false;
    try {
      const state = await agent.getState({ configurable: { thread_id: currentSessionId } });
      const messages = state?.values?.messages ?? [];
      if (messages.length > 0) {
        hasHistory = true;
        // Slice first so we can display the count in the header
        const recentMessages = messages.slice(-6);
        console.log();
        const hBar = chalk.hex("#7F1D1D")("─".repeat(Math.min((process.stdout.columns ?? 80) - 4, 72)));
        console.log(`  ${hBar}`);
        console.log(
          `  ${chalk.hex("#F97316")("◈")} ` +
          chalk.hex("#F59E0B").bold("Resuming Session") +
          chalk.hex("#7F1D1D")("  ─  ") +
          chalk.dim(`last ${recentMessages.length} messages`)
        );
        console.log(`  ${hBar}`);

        for (const msg of recentMessages) {
          const isHuman = msg._getType() === "human" || msg.constructor.name === "HumanMessage";
          if (isHuman) {
            console.log();
            console.log(`  ${chalk.hex("#FCA5A5").bold("◈")} ${chalk.hex("#FCA5A5").bold("You")}`);
            console.log(`    ${chalk.hex("#D1D5DB")(String(msg.content))}`);
          } else if (msg.content) {
            console.log();
            console.log(`  ${chalk.hex("#F97316").bold("◈")} ${chalk.hex("#F59E0B").bold("AI")}`);
            // Render styled markdown history with tabbed spacing
            const rendered = renderMarkdown(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
            console.log(rendered.split("\n").map(l => `    ${l}`).join("\n"));
          }
        }
        console.log();
        console.log(`  ${hBar}`);
        console.log();
      }
    } catch {
      // ignore state fetching errors
    }

    if (!hasHistory) {
      clack.note(
        chalk.dim(`Session ID: ${currentSessionId}`) + "\n" +
        chalk.dim(`Working Directory: ${cwd}`) + "\n" +
        chalk.hex("#F97316")(`Provider: ${getActiveProviderDisplay()}`),
        "Environment Ready"
      );
    }

    // ── REPL Loop ───────────────────────────────────────────────────────────────
    try {
      while (true) {
        console.log();
        const userInput = await clack.text({
          message: chalk.hex("#FCA5A5").bold("◈ You:"),
          placeholder: "Ask a question or request a task (leave blank to exit)...",
        });

        if (clack.isCancel(userInput) || !userInput || String(userInput).trim() === "") {
          break;
        }

        const promptText = String(userInput).trim();
        
        // ── Slash Command Handlers ────────────────────────────────────────────
        if (promptText.startsWith("/")) {
          const [cmd, ...args] = promptText.slice(1).split(" ");

          // /help — show available commands
          if (cmd === "help") {
            console.log();
            console.log(chalk.hex("#F97316").bold("  CHIMERA Slash Commands"));
            console.log(chalk.hex("#7F1D1D")("  " + "─".repeat(40)));
            console.log(chalk.hex("#F59E0B")("  /model [provider:model]") + chalk.dim("  — Switch LLM provider/model"));
            console.log(chalk.hex("#F59E0B")("  /provider")               + chalk.dim("             — Show active provider info"));
            console.log(chalk.hex("#F59E0B")("  /help")                   + chalk.dim("                  — Show this help menu"));
            console.log(chalk.hex("#F59E0B")("  /exit")                   + chalk.dim("                  — Exit CHIMERA"));
            console.log();
            continue;
          }

          // /exit — exit the REPL
          if (cmd === "exit" || cmd === "quit") {
            break;
          }

          // /provider — show current provider info
          if (cmd === "provider") {
            const available = listProviders(true); // only configured providers
            const all = listProviders(false);
            console.log();
            console.log(chalk.hex("#F97316").bold("  Active Provider:"), chalk.white(getActiveProvider()));
            console.log(chalk.hex("#F97316").bold("  Configured:"), chalk.dim(available.join(", ")));
            if (available.length < all.length) {
              const missing = all.filter((p) => !available.includes(p));
              console.log(chalk.hex("#F59E0B")("  Unconfigured:"), chalk.dim(missing.join(", ") + " (missing API key)"));
            }
            console.log();
            continue;
          }

          // /model — show current per-role model assignments + switch
          if (cmd === "model") {
            const ROLE_LABELS: Record<AgentRole, string> = {
              supervisor: "Supervisor",
              coder:      "Coder    ",
              auditor:    "Auditor  ",
              researcher: "Researcher",
              qa:         "QA       ",
            };

            if (args.length === 0) {
              // Show current per-role breakdown
              const roleModels = getAllRoleModels();
              const activeProvider = getActiveProvider();
              const hasOpenRouterKey = Boolean(CONFIG.OPENROUTER.API_KEY);

              console.log();
              console.log(chalk.hex("#F97316").bold("  Active Provider: ") + chalk.white(activeProvider));
              console.log();
              console.log(chalk.hex("#F59E0B").bold("  Per-Role Models:"));
              console.log(chalk.hex("#7F1D1D")("  " + "─".repeat(52)));
              for (const [role, model] of Object.entries(roleModels)) {
                const label = ROLE_LABELS[role as AgentRole] ?? role;
                console.log(
                  chalk.dim("    " + label + "  ") +
                  chalk.white(model)
                );
              }
              console.log();
              console.log(chalk.dim("  Switch all agents:   /model <provider>:<model>"));
              console.log(chalk.dim("  Switch one agent:    /model <provider>:<model> <role>"));
              console.log(chalk.dim("  Roles: supervisor, coder, auditor, researcher, qa"));
              console.log();
              console.log(chalk.dim("  Ollama examples:"));
              console.log(chalk.dim("    /model ollama:llama3.1"));
              console.log(chalk.dim("    /model ollama:qwen2.5-coder:7b coder"));
              if (hasOpenRouterKey) {
                console.log(chalk.dim("  OpenRouter examples:"));
                console.log(chalk.dim("    /model openrouter:openai/gpt-4o"));
                console.log(chalk.dim("    /model openrouter:anthropic/claude-3-5-sonnet coder"));
                console.log(chalk.dim("    /model openrouter:google/gemini-2.0-flash-001 supervisor"));
              } else {
                console.log(chalk.hex("#F59E0B")("  OpenRouter: not configured (add OPENROUTER_API_KEY to .env)"));
              }
              console.log();

            } else {
              // /model <provider>:<model> [role]
              const spec     = args[0]!;
              const roleArg  = args[1] as AgentRole | undefined;
              const colonIdx = spec.indexOf(":");

              if (colonIdx === -1) {
                console.log(chalk.hex("#DC2626")(`  ✗ Invalid format. Use: /model provider:model-name`));
                console.log(chalk.dim("  Examples: /model ollama:llama3.1  or  /model openrouter:openai/gpt-4o"));
              } else {
                const newProvider = spec.slice(0, colonIdx);
                const newModel   = spec.slice(colonIdx + 1);

                let err: string | null;
                if (roleArg) {
                  // Switch a single role
                  err = setRoleModel(newProvider, roleArg, newModel);
                } else {
                  // Switch all roles
                  err = setAllModels(newProvider, newModel);
                }

                if (err) {
                  console.log();
                  for (const line of err.split("\n")) {
                    console.log(chalk.hex("#DC2626")(`  ✗ ${line}`));
                  }
                  console.log();
                } else {
                  const roleModels = getAllRoleModels();
                  console.log();
                  if (roleArg) {
                    console.log(chalk.hex("#84CC16")(`  ✓ ${ROLE_LABELS[roleArg]?.trim() ?? roleArg} → ${chalk.bold(newProvider)}:${chalk.bold(newModel)}`));
                  } else {
                    console.log(chalk.hex("#84CC16")(`  ✓ All agents → ${chalk.bold(newProvider)}`));
                  }
                  console.log(chalk.hex("#7F1D1D")("  " + "─".repeat(52)));
                  for (const [role, model] of Object.entries(roleModels)) {
                    const label = ROLE_LABELS[role as AgentRole] ?? role;
                    const changed = (!roleArg || roleArg === role);
                    console.log(
                      chalk.dim("    " + label + "  ") +
                      (changed ? chalk.hex("#84CC16").bold(model) : chalk.dim(model))
                    );
                  }
                  console.log();
                  console.log(chalk.dim("  Changes take effect on the next message."));
                  console.log();
                }
              }
            }
            continue;
          }


          // Unknown slash command
          console.log(chalk.hex("#F59E0B")(`  Unknown command: /${cmd}. Type /help for available commands.`));
          continue;
        }
        // ── End Slash Commands ────────────────────────────────────────────────

        // Reset the execute_task tool guard for this new user prompt
        resetExecuteTaskGuard();

        console.log();
        console.log(
          `  ${chalk.hex("#F97316").bold("◈")} ${chalk.hex("#F59E0B").bold("AI")}`
        );

        // Use streamEvents for real-time token streaming and tool tracking
        const stream = await agent.streamEvents(
          { messages: [new HumanMessage(promptText)] },
          { 
            version: "v2", 
            configurable: { 
              thread_id: currentSessionId,
              safetyMode: (options.safety ?? "STRICT").toUpperCase(),
              cwd: cwd,
            },
            recursionLimit: 100,
          }
        );

        let toolSpinnerInterval: NodeJS.Timeout | null = null;
        const markdownStream = new LiveMarkdownStream(false);
        const executedTools: string[] = [];
        let activeToolName: string | null = null;
        let finalizedToolsLine = false;
        let isExecutingTask = false;

        const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let frameIdx = 0;

        try {
          for await (const event of stream) {
            const kind = event.event;

            if (kind === "on_chat_model_stream") {
              if (isExecutingTask) {
                continue;
              }
              // Finalize tools line when assistant starts streaming text
               if (executedTools.length > 0 && !finalizedToolsLine) {
                if (toolSpinnerInterval) {
                  clearInterval(toolSpinnerInterval);
                  toolSpinnerInterval = null;
                }
                const prefix = chalk.hex("#84CC16")("  ✓ ");
                const count = executedTools.length;
                const list = chalk.hex("#7F1D1D")(`${count} tool${count > 1 ? "s" : ""} called [`) + chalk.dim(executedTools.join(", ")) + chalk.hex("#7F1D1D")("]");
                process.stdout.write(`\r\u001b[2K${prefix}${list}\n\n`);
                finalizedToolsLine = true;
              }

              // Stream text tokens through LiveMarkdownStream
              const chunk = event.data.chunk;
              if (chunk && chunk.content) {
                const text = typeof chunk.content === 'string' ? chunk.content : JSON.stringify(chunk.content);
                markdownStream.write(text);
              }
            } else if (kind === "on_tool_start") {
              if (event.name === "execute_task") {
                isExecutingTask = true;
              }
              if (isExecutingTask && event.name !== "execute_task") {
                // Skip tracking/spinning for tools called inside execute_task
                continue;
              }
              markdownStream.end(); // ensure current text line is printed before tool starts
              activeToolName = event.name;

              if (event.name !== "execute_task") {
                if (toolSpinnerInterval) clearInterval(toolSpinnerInterval);
                toolSpinnerInterval = setInterval(() => {
                  if ((global as any).isPromptActive) return;
                  const frame = spinnerFrames[frameIdx++ % spinnerFrames.length];
                  const prefix = chalk.hex("#F97316")(`  ${frame} `);
                  const list = executedTools.length > 0 
                    ? chalk.hex("#7F1D1D")(`[${executedTools.join(", ")}] → `) 
                    : "";
                  const active = chalk.hex("#FCA5A5")(`${activeToolName}`);
                  process.stdout.write(`\r\u001b[2K${prefix}${list}${active}...`);
                }, 80);
              }
            } else if (kind === "on_tool_end") {
              if (isExecutingTask && event.name !== "execute_task") {
                // Skip tracking/spinning for tools called inside execute_task
                continue;
              }
              if (event.name === "execute_task") {
                isExecutingTask = false;
                console.log();
              }
              if (event.name !== "execute_task") {
                executedTools.push(event.name);

                if (toolSpinnerInterval) {
                  clearInterval(toolSpinnerInterval);
                  toolSpinnerInterval = null;
                }

                const prefix = chalk.hex("#84CC16")("  ✓ ");
                const list = chalk.hex("#7F1D1D")(`${executedTools.join(" → ")}`);
                process.stdout.write(`\r\u001b[2K${prefix}${list}`);
              }
              activeToolName = null;
            } else if (kind === "on_chat_model_end") {
               if (isExecutingTask) {
                 continue;
               }
               // Flush remaining buffer
               markdownStream.end();
               console.log();
               
               if (toolSpinnerInterval) {
                 clearInterval(toolSpinnerInterval);
                 toolSpinnerInterval = null;
               }
               if (executedTools.length > 0 && !finalizedToolsLine) {
                 const prefix = chalk.hex("#84CC16")("  ✓ ");
                 const count = executedTools.length;
                 const list = chalk.hex("#7F1D1D")(`${count} tool${count > 1 ? "s" : ""} called [`) + chalk.dim(executedTools.join(", ")) + chalk.hex("#7F1D1D")("]");
                 process.stdout.write(`\r\u001b[2K${prefix}${list}\n\n`);
                 finalizedToolsLine = true;
               }
            }
          }
        } finally {
          if (toolSpinnerInterval) {
            clearInterval(toolSpinnerInterval);
          }
        }
      }
    } finally {
      store.close();
    }

    // ── Session farewell ────────────────────────────────────────────────────────
    clack.outro(
      chalk.hex("#F97316").bold("◈ Chimera Session complete") +
      (currentSessionId ? chalk.dim(` · ID: ${currentSessionId}`) : "")
    );

    process.exit(0);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    renderFatalError("Unhandled error in runner", `${message}`);
    process.exit(1);
  }
}

/**
 * Interactive dashboard manager for persisted sessions.
 */
async function runInteractiveSessionManager(): Promise<void> {
  const dbDir = process.env["SESSION_DB_PATH"] ?? "./data/sessions";
  const { readdirSync, existsSync, unlinkSync } = await import("fs");
  const { resolve: pathResolve } = await import("path");
  const { SessionStore } = await import("../memory/session.js");

  renderBanner();
  clack.intro(chalk.hex("#F97316").bold(" ◈ Persisted Sessions Manager "));

  while (true) {
    const action = await clack.select({
      message: chalk.hex("#F97316").bold("Select an action:"),
      options: [
        { value: "LIST", label: "  List recent sessions interactively" },
        { value: "DELETE_ALL", label: chalk.hex("#DC2626")("  Delete all persisted sessions") },
        { value: "EXIT", label: "  Exit manager" },
      ],
    });

    if (clack.isCancel(action) || action === "EXIT") {
      clack.outro(chalk.dim("Goodbye."));
      return;
    }

    if (action === "LIST") {
      if (!existsSync(dbDir)) {
        clack.log.info(chalk.dim("No sessions found."));
        continue;
      }

      const dbFiles = readdirSync(dbDir).filter((f) => f.endsWith(".db"));
      if (dbFiles.length === 0) {
        clack.log.info(chalk.dim("No sessions found."));
        continue;
      }

      const sessions: { id: string; goal: string; status: string; steps: number; updatedAt: string }[] = [];
      for (const file of dbFiles) {
        const id = file.replace(".db", "");
        try {
          const store = new SessionStore(pathResolve(dbDir, file));
          const rec = store.getById(id);
          store.close();
          if (rec) {
            sessions.push({
              id: rec.sessionId,
              goal: rec.goal,
              status: rec.status,
              steps: rec.stepCount,
              updatedAt: rec.updatedAt,
            });
          }
        } catch {
          // ignore
        }
      }

      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

      const listOptions = sessions.map((s) => {
        const dateStr = new Date(s.updatedAt).toLocaleDateString();
        const shortGoal = s.goal.length > 40 ? s.goal.slice(0, 37) + "..." : s.goal;
        const shortId = s.id.slice(0, 8);
        return {
          value: s.id,
          label: `  ${chalk.hex("#F97316").bold(`[${shortId}]`)} ${shortGoal.padEnd(40)} ${chalk.dim(`(${s.status} · ${s.steps} steps · ${dateStr})`)}`,
        };
      });

      listOptions.push({ value: "BACK", label: chalk.dim("  [← Back to main menu]") });

      const chosenSession = await clack.select({
        message: chalk.hex("#F97316").bold("Select a session to manage:"),
        options: listOptions,
      });

      if (clack.isCancel(chosenSession) || chosenSession === "BACK") {
        continue;
      }

      const sessionId = String(chosenSession);

      // Manage options for the specific session
      const subAction = await clack.select({
        message: chalk.hex("#F97316").bold(`Manage Session [${sessionId.slice(0, 8)}]:`),
        options: [
          { value: "RESUME", label: "  🚀 Resume session in interactive REPL" },
          { value: "INSPECT", label: "  🔍 Inspect full session metadata" },
          { value: "DELETE", label: chalk.hex("#DC2626")("  ❌ Delete session and checkpoints") },
          { value: "BACK", label: "  [← Back]" },
        ],
      });

      if (clack.isCancel(subAction) || subAction === "BACK") {
        continue;
      }

      if (subAction === "RESUME") {
        clack.outro(chalk.dim("Launching REPL..."));
        await handleUnifiedRepl({ session: sessionId });
        return;
      } else if (subAction === "INSPECT") {
        const dbPath = pathResolve(dbDir, `${sessionId}.db`);
        const store = new SessionStore(dbPath);
        const record = store.getById(sessionId);
        store.close();

        if (record) {
          console.log();
          console.log(chalk.hex("#F97316").bold("  🔍 Session Inspector Details"));
          console.log(chalk.dim("  " + "─".repeat(50)));
          console.log("  " + chalk.dim("ID:      ") + chalk.white(record.sessionId));
          console.log("  " + chalk.dim("Status:  ") + chalk.white(record.status));
          console.log("  " + chalk.dim("Steps:   ") + chalk.white(String(record.stepCount)));
          console.log("  " + chalk.dim("CWD:     ") + chalk.white(record.cwd));
          console.log("  " + chalk.dim("Created: ") + chalk.white(new Date(record.createdAt).toLocaleString()));
          console.log("  " + chalk.dim("Updated: ") + chalk.white(new Date(record.updatedAt).toLocaleString()));
          console.log();
          console.log("  " + chalk.dim("Goal:"));
          console.log("  " + chalk.white(record.goal));
          console.log(chalk.dim("  " + "─".repeat(50)));
          console.log();
        }
        await clack.text({
          message: "Press [Enter] to return to the sessions list...",
          placeholder: "",
        });
      } else if (subAction === "DELETE") {
        const dbPath = pathResolve(dbDir, `${sessionId}.db`);
        const confirmed = await clack.confirm({
          message: chalk.hex("#DC2626")(`Delete session ${sessionId.slice(0, 8)}? This cannot be undone.`),
          initialValue: false,
        });

        if (confirmed && !clack.isCancel(confirmed)) {
          if (existsSync(dbPath)) unlinkSync(dbPath);
          const walPath = dbPath + "-wal";
          const shmPath = dbPath + "-shm";
          if (existsSync(walPath)) unlinkSync(walPath);
          if (existsSync(shmPath)) unlinkSync(shmPath);
          clack.log.success(chalk.hex("#84CC16")(`✓ Session ${sessionId.slice(0, 8)} deleted.`));
        }
      }
    } else if (action === "DELETE_ALL") {
      const confirmed = await clack.confirm({
        message: chalk.hex("#DC2626")("Delete ALL persisted sessions? This is completely destructive and cannot be undone."),
        initialValue: false,
      });

      if (confirmed && !clack.isCancel(confirmed)) {
        if (existsSync(dbDir)) {
          const files = readdirSync(dbDir);
          for (const file of files) {
            try {
              unlinkSync(pathResolve(dbDir, file));
            } catch {
              // ignore locks
            }
          }
          clack.log.success(chalk.hex("#84CC16")("✓ All persisted sessions deleted."));
        }
      }
    }
  }
}

// ─── Commander Setup ──────────────────────────────────────────────────────────

const program = new Command();

program
  .name("chimera")
  .description("Multi-Agent Orchestration Engine — local-first, terminal-driven")
  .version("0.1.0");

program
  .command("run", { isDefault: true })
  .description("Start the unified conversational environment")
  .option(
    "-c, --cwd <path>",
    "Working directory for the session (default: current directory)"
  )
  .option(
    "-s, --session <id>",
    "Resume an existing session by ID"
  )
  .option(
    "-n, --new",
    "Start a new session directly, bypassing resume prompts"
  )
  .option(
    "-y, --safety <mode>",
    "Safety mode: strict, command-only, auto-approve, read-only",
    "strict"
  )
  .action(handleUnifiedRepl);

program
  .command("models")
  .description("List Ollama models available locally")
  .action(async () => {
    if (CONFIG.ACTIVE_PROVIDER !== "ollama") {
      console.log(chalk.hex("#F59E0B")("  ⚠ 'models' command only works with the Ollama provider."));
      console.log(chalk.dim(`  Current provider: ${CONFIG.ACTIVE_PROVIDER}. Use /model in the REPL to switch.`));
      process.exit(0);
    }
    const ok = await checkProviderAvailability();
    if (!ok) {
      renderFatalError(
        "Ollama is not reachable.",
        "Run: ollama serve"
      );
      process.exit(1);
    }

    try {
      const res = await fetch(`${CONFIG.OLLAMA.BASE_URL}/api/tags`);
      const data = await res.json() as { models?: Array<{ name: string; size: number }> };
      const models = data.models ?? [];

      console.log();
      console.log(chalk.hex("#F97316").bold("  Available Ollama models:"));
      console.log();

      if (models.length === 0) {
        console.log(chalk.dim("  No models found. Run: ollama pull llama3.1"));
      } else {
        for (const m of models) {
          const sizeGb = (m.size / 1e9).toFixed(1);
          console.log(
            chalk.dim("  · ") +
            chalk.white(m.name.padEnd(40)) +
            chalk.hex("#6B7280")(`${sizeGb} GB`)
          );
        }
      }
      console.log();
    } catch (err) {
      renderFatalError(`Failed to fetch models: ${String(err)}`);
      process.exit(1);
    }
  });

program
  .command("health")
  .description("Check that the active LLM provider is reachable")
  .action(async () => {
    const ok = await checkProviderAvailability();
    if (ok) {
      console.log(chalk.hex("#059669")(`  ✓ Provider "${CONFIG.ACTIVE_PROVIDER}" is reachable.`));
      process.exit(0);
    } else {
      console.log(chalk.hex("#DC2626")(`  ✗ Provider "${CONFIG.ACTIVE_PROVIDER}" is NOT reachable.`));
      process.exit(1);
    }
  });

// ─── Sessions Command Group ───────────────────────────────────────────────────

const sessions = program
  .command("sessions")
  .description("Manage persisted agent sessions")
  .action(async () => {
    await runInteractiveSessionManager();
  });

sessions
  .command("list")
  .description("List recent sessions")
  .option("-n, --limit <n>", "Number of sessions to show", "20")
  .action(async (opts: { limit: string }) => {
    const { SessionStore } = await import("../memory/session.js");
    const dbDir = process.env["SESSION_DB_PATH"] ?? "./data/sessions";

    // Each session has its own DB file — scan the directory
    const { readdirSync, existsSync } = await import("fs");
    if (!existsSync(dbDir)) {
      console.log(chalk.dim("  No sessions found."));
      return;
    }

    const dbFiles = readdirSync(dbDir).filter((f) => f.endsWith(".db"));
    if (dbFiles.length === 0) {
      console.log(chalk.dim("  No sessions found."));
      return;
    }

    const limit = Math.min(parseInt(opts.limit, 10) || 20, dbFiles.length);

    console.log();
    console.log(chalk.hex("#7C3AED").bold("  Recent sessions:"));
    console.log();

    // Header row
    console.log(
      chalk.dim("  " +
        "ID".padEnd(10) +
        "GOAL / TOPIC".padEnd(45) +
        "STATUS".padEnd(12) +
        "STEPS".padEnd(8) +
        "UPDATED"
      )
    );
    console.log(chalk.dim("  " + "─".repeat(95)));

    let shown = 0;
    const records = [];
    for (const file of dbFiles) {
      const sessionId = file.replace(".db", "");
      const { path: pathMod } = { path: await import("path") };
      const store = new SessionStore(pathMod.resolve(dbDir, file));
      const record = store.getById(sessionId);
      store.close();
      if (record) {
        records.push(record);
      }
    }

    // Sort by updatedAt DESC
    records.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    for (const record of records.slice(0, limit)) {
      const statusColour =
        record.status === "FINISHED"
          ? chalk.hex("#059669")
          : record.status === "PLANNING"
          ? chalk.hex("#7C3AED")
          : chalk.hex("#D97706");

      const shortId = record.sessionId.slice(0, 8);
      const shortGoal = record.goal.length > 42 ? record.goal.slice(0, 39) + "..." : record.goal;

      console.log(
        "  " +
        chalk.dim(shortId.padEnd(10)) +
        chalk.white(shortGoal.padEnd(45)) +
        statusColour(record.status.padEnd(12)) +
        chalk.white(String(record.stepCount).padEnd(8)) +
        chalk.dim(new Date(record.updatedAt).toLocaleDateString() + " " + new Date(record.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
      );
      shown++;
    }

    if (shown === 0) console.log(chalk.dim("  No valid session records found."));
    console.log();
  });

sessions
  .command("inspect <sessionId>")
  .description("Show full details for a session")
  .action(async (sessionId: string) => {
    const { SessionStore } = await import("../memory/session.js");
    const { path: pathMod } = { path: await import("path") };
    const dbDir  = process.env["SESSION_DB_PATH"] ?? "./data/sessions";
    const dbPath = pathMod.resolve(dbDir, `${sessionId}.db`);

    const { existsSync } = await import("fs");
    if (!existsSync(dbPath)) {
      renderFatalError(`Session not found: ${sessionId}`);
      process.exit(1);
    }

    const store  = new SessionStore(dbPath);
    const record = store.getById(sessionId);
    store.close();

    if (!record) {
      renderFatalError(`No record found for session: ${sessionId}`);
      process.exit(1);
    }

    console.log();
    console.log(chalk.hex("#7C3AED").bold("  Session Details"));
    console.log(chalk.dim("  " + "─".repeat(50)));
    console.log("  " + chalk.dim("ID:      ") + chalk.white(record.sessionId));
    console.log("  " + chalk.dim("Status:  ") + chalk.white(record.status));
    console.log("  " + chalk.dim("Steps:   ") + chalk.white(String(record.stepCount)));
    console.log("  " + chalk.dim("CWD:     ") + chalk.white(record.cwd));
    console.log("  " + chalk.dim("Created: ") + chalk.white(new Date(record.createdAt).toLocaleString()));
    console.log("  " + chalk.dim("Updated: ") + chalk.white(new Date(record.updatedAt).toLocaleString()));
    console.log();
    console.log("  " + chalk.dim("Goal:"));
    console.log("  " + chalk.white(record.goal));

    if (record.finalState?.errorLogs.length) {
      console.log();
      console.log("  " + chalk.hex("#DC2626")("Errors:"));
      for (const e of record.finalState.errorLogs) {
        console.log("  " + chalk.dim("· ") + chalk.hex("#DC2626")(e));
      }
    }
    console.log();
  });

sessions
  .command("delete <sessionId>")
  .description("Delete a session and its checkpoint data")
  .action(async (sessionId: string) => {
    const { SessionStore } = await import("../memory/session.js");
    const { path: pathMod } = { path: await import("path") };
    const { existsSync, unlinkSync } = await import("fs");
    const dbDir  = process.env["SESSION_DB_PATH"] ?? "./data/sessions";
    const dbPath = pathMod.resolve(dbDir, `${sessionId}.db`);

    if (!existsSync(dbPath)) {
      renderFatalError(`Session not found: ${sessionId}`);
      process.exit(1);
    }

    const confirmed = await clack.confirm({
      message: chalk.hex("#DC2626")(`Delete session ${sessionId}? This cannot be undone.`),
      initialValue: false,
    });

    if (!confirmed || clack.isCancel(confirmed)) {
      console.log(chalk.dim("  Cancelled."));
      return;
    }

    // Delete the entire DB file — contains sessions + checkpoints + writes
    unlinkSync(dbPath);
    const walPath = dbPath + "-wal";
    const shmPath = dbPath + "-shm";
    if (existsSync(walPath)) unlinkSync(walPath);
    if (existsSync(shmPath)) unlinkSync(shmPath);

    console.log(chalk.hex("#059669")(`  ✓ Session ${sessionId} deleted.`));
  });

// ─── Index Command ────────────────────────────────────────────────────────────

program
  .command("index")
  .description("Index a codebase into the vector store for RAG search")
  .option(
    "-c, --cwd <path>",
    "Directory to index (default: current directory)"
  )
  .option(
    "--clear",
    "Wipe and rebuild the index from scratch",
    false
  )
  .action(async (opts: { cwd?: string; clear: boolean }) => {
    const { ingestCodebase } = await import("../memory/ingester.js");
    const rootDir = resolve(opts.cwd ?? process.cwd());
    const dbPath  = resolve(
      process.env["VECTOR_DB_PATH"] ?? "./data/vectors",
      "codebase.lance"
    );

    renderBanner();
    clack.intro(
      chalk.hex("#059669").bold(" ◈ Codebase Indexer ") +
      chalk.dim("nomic-embed-text · LanceDB · BM25")
    );

    clack.log.info(chalk.dim(`Indexing: ${rootDir}`));
    clack.log.info(chalk.dim(`Database: ${dbPath}`));
    if (opts.clear) {
      clack.log.warn(chalk.hex("#F59E0B")("--clear flag set: existing index will be wiped."));
    }

    const spinner = createSpinner();
    spinner.start("Walking directory tree…");

    let filesFound = 0;
    let lastProgress = 0;

    try {
      const result = await ingestCodebase({
        rootDir,
        dbPath,
        clearExisting: opts.clear,

        onFile(relativePath) {
          filesFound++;
          spinner.message(`Chunking file ${filesFound}: ${relativePath}`);
        },

        onProgress(done, total) {
          const pct = Math.round((done / total) * 100);
          if (pct !== lastProgress && pct % 5 === 0) {
            lastProgress = pct;
            spinner.message(
              `Embedding chunks: ${done}/${total} (${pct}%)`
            );
          }
        },
      });

      spinner.stop(chalk.hex("#059669")("Indexing complete."), 0);
      console.log();
      console.log(
        "  " + chalk.hex("#059669")("✓") +
        chalk.white(` ${result.filesProcessed} files`) +
        chalk.dim(" · ") +
        chalk.white(`${result.chunksIndexed} chunks indexed`) +
        chalk.dim(" · ") +
        chalk.white(`${result.chunksSkipped} skipped`) +
        chalk.dim(` · ${(result.durationMs / 1000).toFixed(1)}s`)
      );
      console.log();

      clack.outro(
        chalk.hex("#059669").bold("✓ Index ready.") +
        chalk.dim(" Run `chimera run` to start an agent session.")
      );
    } catch (err) {
      spinner.stop(chalk.hex("#DC2626")("Indexing failed."), 0);
      renderFatalError(
        err instanceof Error ? err.message : String(err),
        "Check that Ollama is running and nomic-embed-text is pulled:\n  ollama pull nomic-embed-text"
      );
      process.exit(1);
    }
  });

// ─── Boot ─────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  renderFatalError(
    err instanceof Error ? err.message : String(err),
    "Run with --help for usage information."
  );
  process.exit(1);
});