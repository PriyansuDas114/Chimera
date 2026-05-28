import chalk from "chalk";

/**
 * Computes a standard unified diff between two text strings using the
 * Longest Common Subsequence (LCS) dynamic programming algorithm.
 * Returns a styled terminal string highlighting additions (green),
 * deletions (red), and neutral unchanged lines (dim).
 */
export function computeLineDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split(/\r?\n/);
  const newLines = newStr.split(/\r?\n/);
  const n = oldLines.length;
  const m = newLines.length;

  const dp: number[][] = Array(n + 1)
    .fill(null)
    .map(() => Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const row = dp[i] as number[];
    const prevRow = dp[i - 1] as number[];
    for (let j = 1; j <= m; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        row[j] = (prevRow[j - 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(prevRow[j] ?? 0, row[j - 1] ?? 0);
      }
    }
  }

  const diffResult: { type: "add" | "delete" | "neutral"; line: string }[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    const oldLine = oldLines[i - 1] ?? "";
    const newLine = newLines[j - 1] ?? "";
    const row = dp[i] ?? [];
    const prevRow = dp[i - 1] ?? [];

    if (i > 0 && j > 0 && oldLine === newLine) {
      diffResult.unshift({ type: "neutral", line: oldLine });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (row[j - 1] ?? 0) >= (prevRow[j] ?? 0))) {
      diffResult.unshift({ type: "add", line: newLine });
      j--;
    } else {
      diffResult.unshift({ type: "delete", line: oldLine });
      i--;
    }
  }

  const formattedLines = diffResult.map((item) => {
    if (item.type === "add") {
      return chalk.hex("#10B981")(`+ ${item.line}`); // Sleek emerald green
    } else if (item.type === "delete") {
      return chalk.hex("#EF4444")(`- ${item.line}`); // Sleek coral red
    } else {
      return chalk.dim(`  ${item.line}`);
    }
  });

  return formattedLines.join("\n");
}
