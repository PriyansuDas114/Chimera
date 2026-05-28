import * as path from "path";
import { CodeChunker, type ChunkerConfig } from "./chunker.js";
import { vectorStore } from "./vector.js";

// ─── Ingester ─────────────────────────────────────────────────────────────────

export interface IngestOptions {
  /** Root directory to index. */
  rootDir: string;
  /** Path to the LanceDB database directory. */
  dbPath: string;
  /** Whether to wipe and rebuild the index from scratch. */
  clearExisting?: boolean;
  /** Custom chunker config. */
  chunkerConfig?: ChunkerConfig;
  /** Progress callback: called after each embedding batch. */
  onProgress?: (done: number, total: number) => void;
  /** Called when a file is being chunked (before embedding). */
  onFile?: (relativePath: string) => void;
}

export interface IngestResult {
  filesProcessed: number;
  chunksIndexed:  number;
  chunksSkipped:  number;
  durationMs:     number;
}

/**
 * Orchestrates the full ingestion pipeline:
 *   1. Walk the directory with CodeChunker
 *   2. Collect all chunks (with optional per-file callback)
 *   3. Batch-embed via Ollama nomic-embed-text
 *   4. Write to LanceDB
 *   5. BM25 index is rebuilt automatically by VectorStore.ingest()
 */
export async function ingestCodebase(
  options: IngestOptions
): Promise<IngestResult> {
  const {
    rootDir,
    dbPath,
    clearExisting = false,
    chunkerConfig,
    onProgress,
    onFile,
  } = options;

  const start   = Date.now();
  const chunker = new CodeChunker(chunkerConfig);

  // ── Collect all chunks ────────────────────────────────────────────────────
  const allChunks   = [];
  const seenFiles   = new Set<string>();

  for (const chunk of chunker.chunkDirectory(rootDir)) {
    if (!seenFiles.has(chunk.relativePath)) {
      seenFiles.add(chunk.relativePath);
      onFile?.(chunk.relativePath);
    }
    allChunks.push(chunk);
  }

  if (allChunks.length === 0) {
    return {
      filesProcessed: 0,
      chunksIndexed:  0,
      chunksSkipped:  0,
      durationMs:     Date.now() - start,
    };
  }

  // ── Open vector store and ingest ─────────────────────────────────────────
  await vectorStore.open(dbPath);

  const { indexed, skipped } = await vectorStore.ingest(allChunks, {
    clearExisting,
    ...(onProgress ? { onProgress } : {}),
  });

  return {
    filesProcessed: seenFiles.size,
    chunksIndexed:  indexed,
    chunksSkipped:  skipped,
    durationMs:     Date.now() - start,
  };
}
