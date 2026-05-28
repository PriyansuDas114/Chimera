import { CONFIG } from "../config/index.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmbedResult {
  embedding: number[];
  tokenCount: number;
}

// ─── Ollama Embed Response ────────────────────────────────────────────────────

interface OllamaEmbedResponse {
  embedding: number[];
}

// ─── Embedder ─────────────────────────────────────────────────────────────────

/**
 * Thin wrapper around Ollama's /api/embeddings endpoint.
 *
 * Uses nomic-embed-text (768 dimensions) — the best open-source
 * embedding model available via Ollama for code + natural language.
 *
 * Why not LangChain's OllamaEmbeddings? Direct fetch gives us better
 * error messages, explicit retry logic, and no hidden batching surprises.
 */
export class OllamaEmbedder {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;

  constructor(options: {
    model?: string;
    baseUrl?: string;
    maxRetries?: number;
  } = {}) {
    this.model      = options.model    ?? process.env["OLLAMA_EMBED_MODEL"] ?? "nomic-embed-text";
    this.baseUrl    = options.baseUrl  ?? CONFIG.OLLAMA.BASE_URL;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Embeds a single text string.
   * Retries on transient network failures with exponential backoff.
   */
  async embed(text: string): Promise<EmbedResult> {
    // nomic-embed-text performs better with this prefix for retrieval tasks
    const prefixed = `search_document: ${text}`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: this.model, prompt: prefixed }),
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          throw new Error(
            `Ollama embed API returned ${response.status}: ${await response.text()}`
          );
        }

        const data = (await response.json()) as OllamaEmbedResponse;

        if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
          throw new Error("Ollama returned an empty embedding vector.");
        }

        return {
          embedding:  data.embedding,
          tokenCount: Math.ceil(prefixed.length / 4), // rough estimate
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.maxRetries - 1) {
          // Exponential backoff: 500ms, 1000ms, 2000ms
          await new Promise((res) => setTimeout(res, 500 * Math.pow(2, attempt)));
        }
      }
    }

    throw lastError ?? new Error("Embedding failed after retries.");
  }

  /**
   * Embeds a query string (uses query prefix for nomic-embed-text).
   * Retrieve documents with `embed()`, query with `embedQuery()`.
   */
  async embedQuery(query: string): Promise<number[]> {
    const prefixed = `search_query: ${query}`;

    const response = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: prefixed }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`Embed query failed: ${response.status}`);
    }

    const data = (await response.json()) as OllamaEmbedResponse;
    return data.embedding;
  }

  /**
   * Batch-embeds multiple texts with a concurrency limit.
   * Prevents overwhelming Ollama with parallel requests.
   */
  async embedBatch(
    texts: string[],
    options: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
  ): Promise<EmbedResult[]> {
    const { concurrency = 3, onProgress } = options;
    const results: EmbedResult[] = new Array(texts.length);
    let completed = 0;

    // Process in windows of `concurrency`
    for (let i = 0; i < texts.length; i += concurrency) {
      const batch  = texts.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((text) => this.embed(text))
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result) {
          results[i + j] = result;
        }
        completed++;
      }

      onProgress?.(completed, texts.length);
    }

    return results;
  }
}
