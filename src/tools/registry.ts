import type { StructuredToolInterface } from "@langchain/core/tools";
import { readFileTool, writeFileTool, listDirTool } from "./filesystem.js";
import { runCommandTool } from "./shell.js";
import { searchCodebaseTool } from "./search.js";

// ─── Tool Registry ────────────────────────────────────────────────────────────

/**
 * The canonical list of all tools available to worker agents.
 *
 * The graph builder binds this array to each worker's LLM instance via
 * `llm.bindTools(toolRegistry)`. The order here influences the JSON Schema
 * block order injected into the model's context — put high-priority tools first.
 */
export const toolRegistry: StructuredToolInterface[] = [
  readFileTool,
  writeFileTool,
  listDirTool,
  runCommandTool,
  searchCodebaseTool,
];

/**
 * Tool lookup map for the ToolNode executor.
 * LangGraph's ToolNode uses this to dispatch tool-call results back to
 * the correct function by name.
 */
export const toolsByName: Record<string, StructuredToolInterface> = Object.fromEntries(
  toolRegistry.map((t) => [t.name, t])
);

// Re-export individual tools so callers can import selectively
export {
  readFileTool,
  writeFileTool,
  listDirTool,
  runCommandTool,
  searchCodebaseTool,
};