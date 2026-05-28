import type { CodeChunk } from "./chunker.js";

// ─── BM25 Implementation ──────────────────────────────────────────────────────

/**
 * Okapi BM25 — a probabilistic term-frequency ranking function.
 *
 * Better than TF-IDF for code retrieval because:
 *   - Term saturation: adding the 10th occurrence of "AuthMiddleware"
 *     contributes far less than the 1st (controlled by k1).
 *   - Length normalisation: short chunks aren't unfairly penalised vs
 *     long ones (controlled by b).
 *
 * Standard parameters: k1=1.5, b=0.75
 */

interface BM25Document {
  id: string;
  terms: string[];
}

interface BM25Result {
  id: string;
  score: number;
}

export class BM25Index {
  private readonly k1 = 1.5;
  private readonly b  = 0.75;

  private documents:    BM25Document[] = [];
  private df:           Map<string, number> = new Map(); // doc frequency
  private avgDocLength = 0;
  private N            = 0; // total documents

  /**
   * Tokenises text into lowercase terms.
   * Splits on non-alphanumeric boundaries — preserves camelCase parts
   * by also splitting on case transitions.
   */
  tokenise(text: string): string[] {
    return text
      // Split camelCase: "authMiddleware" → ["auth", "Middleware"]
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      // Split on underscores and hyphens
      .replace(/[_\-]/g, " ")
      // Remove non-alphanumeric (except spaces)
      .replace(/[^a-zA-Z0-9\s]/g, " ")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1); // drop single chars
  }

  /**
   * Builds the BM25 index from an array of code chunks.
   * Must be called before any `search()` calls.
   */
  build(chunks: CodeChunk[]): void {
    this.documents = [];
    this.df        = new Map();
    this.N         = chunks.length;

    let totalTerms = 0;

    for (const chunk of chunks) {
      const terms = this.tokenise(chunk.content + " " + chunk.relativePath);
      this.documents.push({ id: chunk.id, terms });
      totalTerms += terms.length;

      // Document frequency: count how many docs contain each term
      const seen = new Set<string>();
      for (const term of terms) {
        if (!seen.has(term)) {
          this.df.set(term, (this.df.get(term) ?? 0) + 1);
          seen.add(term);
        }
      }
    }

    this.avgDocLength = totalTerms / Math.max(this.N, 1);
  }

  /**
   * Returns the top-k chunks by BM25 score for the given query.
   */
  search(query: string, topK = 10): BM25Result[] {
    if (this.N === 0) return [];

    const queryTerms = this.tokenise(query);
    const scores     = new Map<string, number>();

    for (const term of queryTerms) {
      const df_t = this.df.get(term) ?? 0;
      if (df_t === 0) continue;

      // IDF — inverse document frequency (smoothed)
      const idf = Math.log(
        (this.N - df_t + 0.5) / (df_t + 0.5) + 1
      );

      for (const doc of this.documents) {
        const tf = doc.terms.filter((t) => t === term).length;
        if (tf === 0) continue;

        const docLen = doc.terms.length;

        // BM25 term score
        const numerator   = tf * (this.k1 + 1);
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (docLen / this.avgDocLength));

        const termScore = idf * (numerator / denominator);
        scores.set(doc.id, (scores.get(doc.id) ?? 0) + termScore);
      }
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ id, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}
