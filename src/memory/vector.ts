import * as lancedb from "vectordb";
import * as path from "path";
import * as fs from "fs";
import type { CodeChunk } from "./chunker.js";
import { OllamaEmbedder } from "./embedder.js";
import { BM25Index } from "./bm25.js";
import { reciprocalRankFusion, type RankedResult } from "./rrf.js";

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * The shape of a record stored in LanceDB.
 * LanceDB requires the vector field to be named "vector".
 */
interface VectorRecord {
  vector:       number[];
  id:           string;
  relativePath: string;
  filePath:     string;
  content:      string;
  startLine:    number;
  endLine:      number;
  language:     string;
  fileLineCount: number;
}

// ─── Search Result ────────────────────────────────────────────────────────────

export interface SearchResult {
  chunk: CodeChunk;
  rrfScore: number;
  vectorRank: number | null;
  bm25Rank: number | null;
}

// ─── Vector Store ─────────────────────────────────────────────────────────────

/**
 * Manages the LanceDB vector store and BM25 index for hybrid search.
 *
 * Lifecycle:
 *   1. `open(dbPath)` — opens or creates the LanceDB database
 *   2. `ingest(chunks)` — embeds and stores chunks (run once per codebase)
 *   3. `search(query)` — hybrid BM25 + vector search with RRF fusion
 */
export class VectorStore {
  private db:         lancedb.Connection | null = null;
  private table:      lancedb.Table | null = null;
  private bm25:       BM25Index = new BM25Index();
  private allChunks:  Map<string, CodeChunk> = new Map();
  private embedder:   OllamaEmbedder;
  private dbPath:     string = "";

  private static readonly TABLE_NAME = "codebase";

  constructor() {
    this.embedder = new OllamaEmbedder();
  }

  // ── Initialisation ──────────────────────────────────────────────────────────

  /**
   * Opens the LanceDB database at `dbPath`, creating it if needed.
   * Must be called before ingest() or search().
   */
  async open(dbPath: string): Promise<void> {
    this.dbPath = dbPath;

    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = await lancedb.connect(dbPath);

    // Load existing table and rebuild BM25 index if data already exists
    const tableNames = await this.db.tableNames();
    if (tableNames.includes(VectorStore.TABLE_NAME)) {
      this.table = await this.db.openTable(VectorStore.TABLE_NAME);
      await this.rebuildBM25FromTable();
    }
  }

  /**
   * Returns true if the vector store has been populated.
   * Used by the searchCodebaseTool to return a meaningful error
   * if the user hasn't run `chimera index` yet.
   */
  async isInitialised(): Promise<boolean> {
    if (!this.table) return false;
    try {
      const count = await this.table.countRows();
      return count > 0;
    } catch {
      return false;
    }
  }

  // ── Ingestion ───────────────────────────────────────────────────────────────

  /**
   * Embeds and stores code chunks in LanceDB.
   * Idempotent: existing records with the same `id` are overwritten
   * via delete-then-insert (LanceDB doesn't support upsert natively).
   *
   * @param chunks   Code chunks from CodeChunker.
   * @param onProgress  Called with (completed, total) after each batch.
   */
  async ingest(
    chunks: CodeChunk[],
    options: {
      onProgress?: (done: number, total: number) => void;
      clearExisting?: boolean;
    } = {}
  ): Promise<{ indexed: number; skipped: number }> {
    if (!this.db) throw new Error("VectorStore not opened. Call open() first.");

    const { onProgress, clearExisting = false } = options;

    if (chunks.length === 0) return { indexed: 0, skipped: 0 };

    // Embed all chunks
    const texts = chunks.map((c) => c.content + "\n// File: " + c.relativePath);
    const embedResults = await this.embedder.embedBatch(texts, {
      concurrency: 3,
      ...(onProgress ? { onProgress } : {}),
    });

    // Build LanceDB records
    const records: VectorRecord[] = [];
    let skipped = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk  = chunks[i];
      const result = embedResults[i];
      if (!chunk || !result) { skipped++; continue; }

      records.push({
        vector:        result.embedding,
        id:            chunk.id,
        relativePath:  chunk.relativePath,
        filePath:      chunk.filePath,
        content:       chunk.content,
        startLine:     chunk.startLine,
        endLine:       chunk.endLine,
        language:      chunk.language,
        fileLineCount: chunk.fileLineCount,
      });

      // Keep chunk in memory for BM25 and result reconstruction
      this.allChunks.set(chunk.id, chunk);
    }

    // Write to LanceDB
    const tableNames = await this.db.tableNames();

    if (clearExisting || !tableNames.includes(VectorStore.TABLE_NAME)) {
      // Create or replace table
      this.table = await this.db.createTable(
        VectorStore.TABLE_NAME,
        records as unknown as Record<string, unknown>[],
        { writeMode: clearExisting ? lancedb.WriteMode.Overwrite : lancedb.WriteMode.Create }
      );
    } else {
      // Append to existing table
      this.table = await this.db.openTable(VectorStore.TABLE_NAME);
      await this.table.add(records as unknown as Record<string, unknown>[]);
    }

    // Rebuild BM25 over all chunks now in memory
    this.bm25.build(Array.from(this.allChunks.values()));

    return { indexed: records.length, skipped };
  }

  // ── Search ──────────────────────────────────────────────────────────────────

  /**
   * Hybrid search: BM25 keyword + vector semantic, fused via RRF.
   *
   * @param query  Natural language or code snippet to search for.
   * @param topK   Number of results after fusion.
   */
  async search(query: string, topK = 8): Promise<SearchResult[]> {
    if (!this.table) {
      throw new Error("Vector store not initialised. Run `chimera index` first.");
    }

    // ── Vector search ────────────────────────────────────────────────────────
    const queryEmbedding = await this.embedder.embedQuery(query);

    const vectorRows = await this.table
      .search(queryEmbedding)
      .limit(topK * 2)        // Retrieve 2× for RRF headroom
      .execute() as VectorRecord[];

    const vectorResults: RankedResult[] = vectorRows.map((row, idx) => ({
      id:    row.id,
      score: 1 - (idx / vectorRows.length), // normalised rank score
    }));

    // ── BM25 search ──────────────────────────────────────────────────────────
    const bm25Results: RankedResult[] = this.bm25
      .search(query, topK * 2)
      .map((r) => ({ id: r.id, score: r.score }));

    // ── RRF fusion ───────────────────────────────────────────────────────────
    const fused = reciprocalRankFusion(vectorResults, bm25Results, topK);

    // ── Reconstruct SearchResult from chunk map ───────────────────────────────
    const results: SearchResult[] = [];

    for (const fusedItem of fused) {
      // Try in-memory map first (fast path)
      let chunk = this.allChunks.get(fusedItem.id);

      // Fall back to reconstructing from LanceDB row
      if (!chunk) {
        const matchRow = vectorRows.find((r) => r.id === fusedItem.id);
        if (matchRow) {
          chunk = {
            id:            matchRow.id,
            filePath:      matchRow.filePath,
            relativePath:  matchRow.relativePath,
            content:       matchRow.content,
            startLine:     matchRow.startLine,
            endLine:       matchRow.endLine,
            language:      matchRow.language,
            fileLineCount: matchRow.fileLineCount,
          };
        }
      }

      if (!chunk) continue;

      results.push({
        chunk,
        rrfScore:   fusedItem.rrfScore,
        vectorRank: fusedItem.vectorRank,
        bm25Rank:   fusedItem.bm25Rank,
      });
    }

    return results;
  }

  // ── BM25 Rebuild ────────────────────────────────────────────────────────────

  /**
   * Reconstructs the BM25 index from persisted LanceDB records.
   * Called on `open()` when an existing table is found.
   */
  private async rebuildBM25FromTable(): Promise<void> {
    if (!this.table) return;

    try {
      // Fetch all records without a vector filter
      const rows = await this.table
        .search(new Array(768).fill(0))
        .limit(100_000)
        .execute() as VectorRecord[];

      for (const row of rows) {
        const chunk: CodeChunk = {
          id:            row.id,
          filePath:      row.filePath,
          relativePath:  row.relativePath,
          content:       row.content,
          startLine:     row.startLine,
          endLine:       row.endLine,
          language:      row.language,
          fileLineCount: row.fileLineCount,
        };
        this.allChunks.set(chunk.id, chunk);
      }

      this.bm25.build(Array.from(this.allChunks.values()));
    } catch {
      // Non-fatal — BM25 will be empty but vector search still works
    }
  }

  close(): void {
    // LanceDB connections are stateless HTTP — nothing to close
    this.db    = null;
    this.table = null;
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

/**
 * Process-level singleton.
 * The CLI index command and the searchCodebaseTool both use this instance.
 */
export const vectorStore = new VectorStore();
