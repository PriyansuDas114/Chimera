import * as fs from "fs";
import * as path from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CodeChunk {
  /** Unique identifier: `<relativePath>:<startLine>-<endLine>` */
  id: string;
  /** Absolute path to the source file. */
  filePath: string;
  /** Path relative to the indexed root (stored in the vector DB). */
  relativePath: string;
  /** The actual text content of this chunk. */
  content: string;
  /** 1-indexed line number where this chunk starts. */
  startLine: number;
  /** 1-indexed line number where this chunk ends (inclusive). */
  endLine: number;
  /** File extension without the dot (e.g. "ts", "py", "md"). */
  language: string;
  /** Total number of lines in the source file. */
  fileLineCount: number;
}

// ─── Configuration ────────────────────────────────────────────────────────────

export interface ChunkerConfig {
  /**
   * Approximate number of lines per chunk.
   * 40 lines ≈ 256 tokens for typical TypeScript — adjust per language.
   */
  chunkLines?: number;
  /**
   * Number of lines to overlap between consecutive chunks.
   * Prevents concepts from being split across chunk boundaries.
   */
  overlapLines?: number;
  /** File extensions to include (without dot). Empty = include all. */
  includeExtensions?: string[];
  /** Directory names to always skip. */
  excludeDirs?: string[];
  /** File name patterns to skip (glob-style prefix match). */
  excludePatterns?: string[];
}

const DEFAULT_CONFIG: Required<ChunkerConfig> = {
  chunkLines:        40,
  overlapLines:      8,
  includeExtensions: [
    "ts", "tsx", "js", "jsx", "mjs", "cjs",
    "py", "rs", "go", "java", "cpp", "c", "h",
    "md", "mdx", "json", "yaml", "yml", "toml",
    "sql", "sh", "bash", "env",
  ],
  excludeDirs: [
    "node_modules", ".git", "dist", "build", ".next",
    "__pycache__", ".venv", "venv", "target", ".cache",
    "coverage", ".nyc_output", "data",
  ],
  excludePatterns: [
    ".env", ".DS_Store", "package-lock.json",
    "yarn.lock", "pnpm-lock.yaml", "*.min.js",
  ],
};

// ─── File Walker ──────────────────────────────────────────────────────────────

/**
 * Recursively walks a directory and yields absolute paths of files
 * that match the configured extensions and exclusion rules.
 */
function* walkDirectory(
  dir: string,
  config: Required<ChunkerConfig>
): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (config.excludeDirs.includes(entry.name)) continue;
      yield* walkDirectory(fullPath, config);
      continue;
    }

    if (!entry.isFile()) continue;

    // Check exclusion patterns
    const isExcluded = config.excludePatterns.some((pattern) => {
      if (pattern.startsWith("*.")) {
        return entry.name.endsWith(pattern.slice(1));
      }
      return entry.name === pattern;
    });
    if (isExcluded) continue;

    // Check extension allowlist
    const ext = path.extname(entry.name).slice(1).toLowerCase();
    if (
      config.includeExtensions.length > 0 &&
      !config.includeExtensions.includes(ext)
    ) {
      continue;
    }

    yield fullPath;
  }
}

// ─── Chunker ──────────────────────────────────────────────────────────────────

export class CodeChunker {
  private readonly config: Required<ChunkerConfig>;

  constructor(config: ChunkerConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Chunks a single file into overlapping line windows.
   * Returns an empty array if the file is unreadable or empty.
   */
  chunkFile(filePath: string, rootDir: string): CodeChunk[] {
    let content: string;

    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      return [];
    }

    // Skip binary files — heuristic: null bytes in first 512 chars
    if (content.slice(0, 512).includes("\0")) return [];

    // Skip very large files (> 500KB) — too costly to embed
    if (content.length > 500_000) return [];

    const lines = content.split("\n");
    const ext   = path.extname(filePath).slice(1).toLowerCase();
    const rel   = path.relative(rootDir, filePath);

    const { chunkLines, overlapLines } = this.config;
    const stride = chunkLines - overlapLines;
    const chunks: CodeChunk[] = [];

    for (let start = 0; start < lines.length; start += stride) {
      const end         = Math.min(start + chunkLines, lines.length);
      const chunkLines_ = lines.slice(start, end);

      // Skip chunks that are purely whitespace or comments
      const meaningful = chunkLines_.filter(
        (l) => l.trim().length > 0 && !l.trim().startsWith("//") && !l.trim().startsWith("#")
      );
      if (meaningful.length < 2) continue;

      const chunkContent = chunkLines_.join("\n");
      const startLine    = start + 1;       // 1-indexed
      const endLine      = end;             // 1-indexed, inclusive

      chunks.push({
        id:            `${rel}:${startLine}-${endLine}`,
        filePath,
        relativePath:  rel,
        content:       chunkContent,
        startLine,
        endLine,
        language:      ext,
        fileLineCount: lines.length,
      });

      // If we've reached the end of the file, stop
      if (end >= lines.length) break;
    }

    return chunks;
  }

  /**
   * Walks an entire directory and chunks all matching files.
   * Yields chunks lazily to avoid loading all files into memory.
   */
  *chunkDirectory(rootDir: string): Generator<CodeChunk> {
    for (const filePath of walkDirectory(rootDir, this.config)) {
      const chunks = this.chunkFile(filePath, rootDir);
      for (const chunk of chunks) {
        yield chunk;
      }
    }
  }
}
