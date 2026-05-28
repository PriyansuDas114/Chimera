import { test } from "node:test";
import * as assert from "node:assert";
import { CONFIG } from "../src/config/index.js";
import * as path from "path";

test("Config: loads defaults correctly", () => {
  assert.strictEqual(CONFIG.OLLAMA.DEFAULT_NUM_CTX, 32768);
  assert.strictEqual(CONFIG.LIMITS.MAX_TOOL_CALLS_PER_TURN, 5);
});

test("Config: resolves paths correctly", () => {
  // Should be absolute or relative to project root
  assert.ok(CONFIG.PATHS.SESSIONS_DIR.includes("sessions"));
  assert.ok(CONFIG.PATHS.VECTOR_DIR.includes("vectors"));
});

test("Config: security blocklist is present", () => {
  assert.ok(CONFIG.SECURITY.BLOCKED_COMMANDS.length > 0);
  const rmRf = CONFIG.SECURITY.BLOCKED_COMMANDS[0];
  assert.ok(rmRf.test("rm -rf /"));
});
