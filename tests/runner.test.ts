import { test } from "node:test";
import * as assert from "node:assert";
import { resolveDbPath } from "../src/graph/runner.js";
import { CONFIG } from "../src/config/index.js";
import * as path from "path";

test("Runner: resolves DB path correctly using CONFIG", () => {
  const sessionId = "test-session-123";
  const dbPath = resolveDbPath(sessionId);
  
  const expectedBase = path.resolve(CONFIG.PATHS.SESSIONS_DIR);
  assert.ok(dbPath.startsWith(expectedBase));
  assert.ok(dbPath.endsWith(`${sessionId}.db`));
});

test("Runner: can import graph without side effects", async () => {
  // Dynamic import to verify the graph definition doesn't crash on load
  const { runGraph } = await import("../src/graph/runner.js");
  assert.ok(runGraph);
});
