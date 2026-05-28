import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";

// ─── Read File ────────────────────────────────────────────────────────────────

export const readFileTool = tool(
  async ({ filePath, cwd }, config): Promise<string> => {
    try {
      const safeCwd = path.resolve(config?.configurable?.cwd ?? cwd ?? process.cwd());
      const resolved = path.resolve(safeCwd, filePath);

      // Prevent path traversal outside the working directory
      if (!resolved.startsWith(safeCwd)) {
        return `Error: Path traversal detected. Access denied for path: "${filePath}" (CWD: ${safeCwd})`;
      }

      if (!fs.existsSync(resolved)) {
        return `Error: File not found at resolved path: "${resolved}"`;
      }

      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        return `Error: "${resolved}" is a directory, not a file. Use listDirTool to inspect directories.`;
      }

      const content = fs.readFileSync(resolved, "utf-8");

      // Guard against feeding enormous files into the LLM context
      const MAX_CHARS = 32_000;
      if (content.length > MAX_CHARS) {
        return (
          `Warning: File truncated to ${MAX_CHARS} characters (actual: ${content.length}).\n\n` +
          content.slice(0, MAX_CHARS)
        );
      }

      return content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error reading file "${filePath}": ${message}`;
    }
  },
  {
    name: "read_file",
    description:
      "Reads the contents of a file at the given path, relative to the current working directory (cwd). " +
      "Returns the raw file content as a string, or an error message if the file cannot be read.",
    schema: z.object({
      filePath: z
        .string()
        .min(1)
        .describe("Relative path to the file from the current working directory."),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("The absolute current working directory. Used to resolve relative paths safely."),
    }),
  }
);

// ─── Write File ───────────────────────────────────────────────────────────────

export const writeFileTool = tool(
  async ({ filePath, content, cwd }, config): Promise<string> => {
    try {
      const safeCwd = path.resolve(config?.configurable?.cwd ?? cwd ?? process.cwd());
      const resolved = path.resolve(safeCwd, filePath);

      // Prevent path traversal outside the working directory
      if (!resolved.startsWith(safeCwd)) {
        return `Error: Path traversal detected. Write access denied for path: "${filePath}" (CWD: ${safeCwd})`;
      }

      const safetyMode = config.configurable?.safetyMode ?? "STRICT";

      if (safetyMode === "READ_ONLY") {
        return `Error: Write blocked. Agent is running in READ_ONLY safety mode. Cannot write to "${filePath}".`;
      }

      if (safetyMode === "STRICT") {
        const exists = fs.existsSync(resolved);
        const oldContent = exists ? fs.readFileSync(resolved, "utf-8") : "";

        (global as any).isPromptActive = true;
        try {
          while (true) {
            const { select, isCancel } = await import("@clack/prompts");
            console.log();
            console.log(chalk.hex("#7C3AED")("┌── [unsafe file modification] ────────────────────────────────────────────"));
            console.log(chalk.hex("#7C3AED")("│"));
            console.log(chalk.hex("#7C3AED")("│  ") + chalk.yellow(`Agent requested to write file:`));
            console.log(chalk.hex("#7C3AED")("│  ") + chalk.white.bold(filePath) + chalk.dim(exists ? " (File exists, will overwrite)" : " (New file)"));
            console.log(chalk.hex("#7C3AED")("│  ") + chalk.dim(`Size: ${content.length} characters`));
            console.log(chalk.hex("#7C3AED")("│"));
            console.log(chalk.hex("#7C3AED")("└──────────────────────────────────────────────────────────────────────────"));
            console.log();

            const options = [
              { value: "APPROVE", label: "  Approve write and proceed" },
              { value: "VIEW", label: exists ? "  🔍 View unified diff" : "  🔍 View file content" },
              { value: "DENY", label: chalk.hex("#EF4444")("  Deny write") },
            ];

            const action = await select({
              message: chalk.hex("#7C3AED").bold(`◈ Authorize write to ${filePath}?`),
              options,
            });

            if (isCancel(action) || action === "DENY") {
              return (
                `Error: The human user denied write access to file "${filePath}". ` +
                `Do not retry this write operation without user clarification.`
              );
            }

            if (action === "VIEW") {
              if (exists) {
                const { computeLineDiff } = await import("../utils/diff.js");
                const diffStr = computeLineDiff(oldContent, content);
                console.log();
                console.log(chalk.hex("#7C3AED")("┌── [unified diff] ────────────────────────────────────────────────────────"));
                console.log(diffStr.split("\n").map(line => `│  ${line}`).join("\n"));
                console.log(chalk.hex("#7C3AED")("└──────────────────────────────────────────────────────────────────────────"));
                console.log();
              } else {
                console.log();
                console.log(chalk.hex("#7C3AED")("┌── [new file content] ───────────────────────────────────────────────────"));
                console.log(content.split("\n").map(line => `│  ${line}`).join("\n"));
                console.log(chalk.hex("#7C3AED")("└──────────────────────────────────────────────────────────────────────────"));
                console.log();
              }
              continue;
            }

            if (action === "APPROVE") {
              break;
            }
          }
        } finally {
          (global as any).isPromptActive = false;
        }
      }

      const dir = path.dirname(resolved);

      // Create intermediate directories if they don't exist
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(resolved, content, "utf-8");

      return `Success: File written to "${resolved}" (${content.length} characters).`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error writing file "${filePath}": ${message}`;
    }
  },
  {
    name: "write_file",
    description:
      "Writes content to a file at the given path, relative to the current working directory (cwd). " +
      "Automatically creates any missing parent directories. Overwrites existing files.",
    schema: z.object({
      filePath: z
        .string()
        .min(1)
        .describe("Relative path to the file from the current working directory."),
      content: z
        .string()
        .describe("The full content to write into the file."),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("The absolute current working directory. Used to resolve relative paths safely."),
    }),
  }
);

// ─── List Directory ───────────────────────────────────────────────────────────

export const listDirTool = tool(
  async ({ dirPath, cwd }, config): Promise<string> => {
    try {
      const safeCwd = path.resolve(config?.configurable?.cwd ?? cwd ?? process.cwd());
      const resolved = path.resolve(safeCwd, dirPath);

      if (!resolved.startsWith(safeCwd)) {
        return `Error: Path traversal detected. Access denied for path: "${dirPath}" (CWD: ${safeCwd})`;
      }

      if (!fs.existsSync(resolved)) {
        return `Error: Directory not found: "${resolved}"`;
      }

      const stat = fs.statSync(resolved);
      if (!stat.isFile && !stat.isDirectory()) {
        return `Error: "${resolved}" is neither a file nor directory.`;
      }

      if (stat.isFile()) {
        return `Error: "${resolved}" is a file. Use read_file to read its contents.`;
      }

      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const formatted = entries.map((e) => {
        const prefix = e.isDirectory() ? "DIR  " : "FILE ";
        return `${prefix} ${e.name}`;
      });

      return `Contents of "${resolved}":\n${formatted.join("\n")}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Error listing directory "${dirPath}": ${message}`;
    }
  },
  {
    name: "list_dir",
    description:
      "Lists the files and subdirectories in a given directory, relative to the current working directory (cwd). " +
      "Use this to explore the project structure before reading specific files.",
    schema: z.object({
      dirPath: z
        .string()
        .min(1)
        .describe(
          "Relative path to the directory from the current working directory. Use '.' for the root."
        ),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("The absolute current working directory."),
    }),
  }
);