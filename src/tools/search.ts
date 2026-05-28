import { tool } from "@langchain/core/tools";
import { z } from "zod";
import * as path from "path";
import { vectorStore } from "../memory/vector.js";
import { CONFIG } from "../config/index.js";
import type { SearchResult } from "../memory/vector.js";

// ─── Result Formatter ─────────────────────────────────────────────────────────

/**
 * Formats hybrid search results into a structured string the LLM
 * can parse to understand file locations and relevant code.
 */
function formatResults(results: SearchResult[], query: string): string {
  if (results.length === 0) {
    return (
      `No results found for query: "${query}".\n` +
      `Try broader terms, or use list_dir + read_file to explore manually.`
    );
  }

  const lines: string[] = [
    `Hybrid search results for: "${query}"`,
    `Found ${results.length} relevant chunks (vector + BM25 fused via RRF):`,
    "",
  ];

  for (let i = 0; i < results.length; i++) {
    const { chunk, rrfScore, vectorRank, bm25Rank } = results[i]!;

    lines.push(
      `── Result ${i + 1} ` +
      `[RRF: ${rrfScore.toFixed(4)}` +
      (vectorRank ? ` | vec:#${vectorRank}` : "") +
      (bm25Rank   ? ` | bm25:#${bm25Rank}` : "") +
      `]`
    );
    lines.push(`   File: ${chunk.relativePath}`);
    lines.push(`   Lines: ${chunk.startLine}–${chunk.endLine} of ${chunk.fileLineCount}`);
    lines.push(`   Language: ${chunk.language}`);
    lines.push("");

    // Include the chunk content, indented for readability
    const contentLines = chunk.content.split("\n").slice(0, 20); // max 20 lines preview
    for (const line of contentLines) {
      lines.push(`   ${line}`);
    }
    if (chunk.content.split("\n").length > 20) {
      lines.push(`   … (${chunk.content.split("\n").length - 20} more lines)`);
    }
    lines.push("");
  }

  lines.push(
    `To read a full file, use the read_file tool with the path shown above.`
  );

  return lines.join("\n");
}

// ─── Search Codebase Tool ─────────────────────────────────────────────────────

export const searchCodebaseTool = tool(
  async ({ query, cwd, topK }, config): Promise<string> => {
    // ── Check initialisation ────────────────────────────────────────────────
    const isReady = await vectorStore.isInitialised().catch(() => false);

    if (!isReady) {
      const dbPath = path.resolve(
        CONFIG.PATHS.VECTOR_DIR,
        "codebase.lance"
      );

      // Auto-open if the DB file exists but wasn't opened yet
      try {
        await vectorStore.open(dbPath);
        const nowReady = await vectorStore.isInitialised();
        if (!nowReady) throw new Error("Index empty");
      } catch {
        // ── FALLBACK: Simple Keyword Search ──────────────────────────────────
        // If vector DB is missing, don't just fail — do a basic grep search.
        const searchCwd = config?.configurable?.cwd ?? cwd ?? process.cwd();
        try {
          const { execSync } = await import("child_process");
          // Use git grep if available (fast), else fall back to a message
          const results = execSync(`git grep -n "${query}"`, { 
            cwd: searchCwd, 
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"] 
          });
          
          return (
            `Vector index not found. Falling back to 'git grep' results:\n\n` +
            results.split("\n").slice(0, 15).join("\n") +
            (results.split("\n").length > 15 ? "\n... (truncated)" : "")
          );
        } catch {
          return (
            `Vector search index is not available. ` +
            `Please index the codebase with 'chimera index'.\n\n` +
            `In the meantime, I searched for "${query}" using basic grep but found nothing. ` +
            `Use list_dir and read_file to explore manually.`
          );
        }
      }
    }

    // ── Execute hybrid search ───────────────────────────────────────────────
    try {
      const results = await vectorStore.search(query, topK ?? 8);
      return formatResults(results, query);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return `Search failed: ${message}. Falling back to manual exploration with list_dir.`;
    }
  },
  {
    name: "search_codebase",
    description:
      "Performs hybrid semantic + keyword search over the indexed codebase. " +
      "Returns the most relevant code chunks with file paths and line numbers. " +
      "Use this BEFORE read_file when you don't know which file to look at. " +
      "Combines vector similarity (semantic meaning) with BM25 (exact identifiers) " +
      "for best results on both natural language and code-specific queries.",
    schema: z.object({
      query: z
        .string()
        .min(1)
        .describe(
          "Natural language or code search query. Examples: " +
          "'authentication middleware', 'JWT token validation', " +
          "'function that handles file uploads', 'UserSchema definition'"
        ),
      cwd: z
        .string()
        .min(1)
        .optional()
        .describe("The absolute current working directory."),
      topK: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of results to return (default: 8, max: 20)."),
    }),
  }
);