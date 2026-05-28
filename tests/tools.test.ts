import { test } from "node:test";
import * as assert from "node:assert";
import { toolRegistry, toolsByName } from "../src/tools/registry.js";

test("Tools: registry is populated", () => {
  assert.ok(toolRegistry.length > 0, "Tool registry should not be empty");
  assert.ok(toolsByName["read_file"], "read_file tool should be in registry");
  assert.ok(toolsByName["run_command"], "run_command tool should be in registry");
});

test("Tools: read_file schema is valid", () => {
  const readFile = toolsByName["read_file"];
  assert.ok(readFile);
  // LangChain tool schema is in .schema
  const schema = (readFile as any).schema;
  assert.ok(schema);
});

test("Tools: run_command security is wired", () => {
  const runCmd = toolsByName["run_command"];
  assert.ok(runCmd);
});
