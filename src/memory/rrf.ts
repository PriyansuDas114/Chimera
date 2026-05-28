// ─── Reciprocal Rank Fusion ───────────────────────────────────────────────────

/**
 * Merges multiple ranked result lists into a single unified ranking
 * without requiring score normalisation across different retrieval systems.
 *
 * Formula: RRF(d) = Σ 1 / (k + rank(d, list))
 *   where k=60 is the standard smoothing constant that reduces the impact
 *   of very high-ranked documents dominating the final list.
 *
 * Reference: Cormack, Clarke & Buettcher (2009) "Reciprocal Rank Fusion
 * outperforms Condorcet and individual Rank Learning Methods"
 */

export interface RankedResult {
  id: string;
  score: number;
}

export interface FusedResult {
  id: string;
  rrfScore: number;
  /** Rank in vector search list (1-indexed), or null if absent. */
  vectorRank: number | null;
  /** Rank in BM25 list (1-indexed), or null if absent. */
  bm25Rank: number | null;
}

const RRF_K = 60;

/**
 * Fuses two ranked lists (vector results + BM25 results) via RRF.
 *
 * @param vectorResults  Ranked list from semantic vector search.
 * @param bm25Results    Ranked list from BM25 keyword search.
 * @param topK           Number of results to return after fusion.
 */
export function reciprocalRankFusion(
  vectorResults: RankedResult[],
  bm25Results:   RankedResult[],
  topK = 10
): FusedResult[] {
  const fusedScores = new Map<string, FusedResult>();

  // Process vector results
  for (let rank = 0; rank < vectorResults.length; rank++) {
    const result = vectorResults[rank];
    if (!result) continue;

    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = fusedScores.get(result.id);

    fusedScores.set(result.id, {
      id:          result.id,
      rrfScore:    (existing?.rrfScore ?? 0) + rrfScore,
      vectorRank:  rank + 1,
      bm25Rank:    existing?.bm25Rank ?? null,
    });
  }

  // Process BM25 results
  for (let rank = 0; rank < bm25Results.length; rank++) {
    const result = bm25Results[rank];
    if (!result) continue;

    const rrfScore = 1 / (RRF_K + rank + 1);
    const existing = fusedScores.get(result.id);

    fusedScores.set(result.id, {
      id:          result.id,
      rrfScore:    (existing?.rrfScore ?? 0) + rrfScore,
      vectorRank:  existing?.vectorRank ?? null,
      bm25Rank:    rank + 1,
    });
  }

  return Array.from(fusedScores.values())
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, topK);
}
