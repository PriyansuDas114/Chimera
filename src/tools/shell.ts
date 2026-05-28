import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import { confirm, log, isCancel } from "@clack/prompts";
import chalk from "chalk";

const execAsync = promisify(exec);

import { CONFIG } from "../config/index.js";

function isBlockedCommand(command: string): boolean {
  return CONFIG.SECURITY.BLOCKED_COMMANDS.some((pattern) => pattern.test(command));
}

// ─── Run Command (with HITL Gateway) ─────────────────────────────────────────

export const runCommandTool = tool(
  async ({ command, cwd }, config): Promise<string> => {
    // ── Layer 1: Static blocklist check ────────────────────────────────────
    if (isBlockedCommand(command)) {
      return (
        `Action blocked: The command "${command}" matches a permanently blocked ` +
        `pattern and cannot be executed under any circumstances.`
      );
    }

    const safetyMode = config.configurable?.safetyMode ?? "STRICT";

    if (safetyMode === "READ_ONLY") {
      return (
        `Action blocked: The agent is running in READ_ONLY safety mode. ` +
        `Execution of "${command}" is blocked.`
      );
    }

    // ── Layer 2: HITL approval gate ────────────────────────────────────────
    let shouldPrompt = true;

    if (safetyMode === "AUTO_APPROVE") {
      shouldPrompt = false;
    } else {
      // Check if command is in safe commands whitelist
      const isSafe = CONFIG.SECURITY.SAFE_COMMANDS.some((pattern) => pattern.test(command));
      if (isSafe) {
        log.info(chalk.hex("#10B981")(`  ✔ Whitelist auto-approved safe command: ${command}`));
        shouldPrompt = false;
      }
    }

    if (shouldPrompt) {
      (global as any).isPromptActive = true;
      try {
        const { select, text } = await import("@clack/prompts");
        console.log();
        console.log(chalk.hex("#7C3AED")("┌── [unsafe shell execution] ──────────────────────────────────────────────"));
        console.log(chalk.hex("#7C3AED")("│"));
        console.log(chalk.hex("#7C3AED")("│  ") + chalk.yellow("Agent requested to run:"));
        console.log(chalk.hex("#7C3AED")("│  ") + chalk.white.bold(command));
        console.log(chalk.hex("#7C3AED")("│"));
        console.log(chalk.hex("#7C3AED")("│  ") + chalk.dim(`Working directory: ${cwd ?? process.cwd()}`));
        console.log(chalk.hex("#7C3AED")("└──────────────────────────────────────────────────────────────────────────"));
        console.log();

        const action = await select({
          message: chalk.hex("#7C3AED").bold("◈ Choose authorization action:"),
          options: [
            { value: "APPROVE", label: "  Approve execution and run" },
            { value: "EDIT", label: "  Edit command inline before running" },
            { value: "DENY", label: chalk.hex("#EF4444")("  Deny execution") },
          ],
        });

        if (isCancel(action) || action === "DENY") {
          return (
            `Action aborted: The human user denied permission to run this command. ` +
            `Command was: "${command}". Do not retry this command without asking ` +
            `the user to clarify or proposing an alternative approach.`
          );
        }

        if (action === "EDIT") {
          const edited = await text({
            message: chalk.hex("#7C3AED").bold("Edit command:"),
            initialValue: command,
          });

          if (isCancel(edited) || !edited) {
            return `Action aborted: The command edit was cancelled. Command was: "${command}".`;
          }
          command = String(edited);
          log.info(chalk.dim(`Executing edited command: ${command}`));
        }
      } finally {
        (global as any).isPromptActive = false;
      }
    }

    // ── Layer 3: Execution with timeout and output capture ─────────────────
    try {
      log.info(chalk.dim(`Running: ${command}`));

      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd ?? process.cwd(),
        timeout: CONFIG.LIMITS.SHELL_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,    // 1MB output cap
      });

      const parts: string[] = [];

      if (stdout.trim()) {
        parts.push(`STDOUT:\n${stdout.trim()}`);
      }
      if (stderr.trim()) {
        // stderr isn't always fatal (e.g., npm uses it for progress)
        parts.push(`STDERR:\n${stderr.trim()}`);
      }
      if (parts.length === 0) {
        parts.push("Command completed with no output.");
      }

      return parts.join("\n\n");
    } catch (err) {
      // child_process throws on non-zero exit codes
      if (
        err instanceof Error &&
        "code" in err &&
        "stdout" in err &&
        "stderr" in err
      ) {
        const execErr = err as NodeJS.ErrnoException & {
          code: number;
          stdout: string;
          stderr: string;
        };
        return (
          `Command failed with exit code ${execErr.code}.\n` +
          (execErr.stdout ? `STDOUT:\n${execErr.stdout.trim()}\n` : "") +
          (execErr.stderr ? `STDERR:\n${execErr.stderr.trim()}` : "")
        ).trim();
      }

      const message = err instanceof Error ? err.message : String(err);
      return `Error executing command "${command}": ${message}`;
    }
  },
  {
    name: "run_command",
    description:
      "Executes a shell command in the current working directory. " +
      "IMPORTANT: This tool will ALWAYS pause and ask the human user for approval before running. " +
      "The human may deny the request. Only use this for necessary operations like installing packages, " +
      "running tests, or compiling code. Avoid destructive commands.",
    schema: z.object({
      command: z
        .string()
        .min(1)
        .describe("The exact shell command to execute."),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("The absolute working directory in which to run the command."),
    }),
  }
);