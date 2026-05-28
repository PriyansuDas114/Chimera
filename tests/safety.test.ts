import { test } from "node:test";
import * as assert from "node:assert";
import { runCommandTool } from "../src/tools/shell.js";
import { writeFileTool } from "../src/tools/filesystem.js";
import * as path from "path";
import * as fs from "fs";

test("Safety Mode: READ_ONLY blocks runCommandTool execution", async () => {
  const result = await runCommandTool.invoke(
    { command: "node -v" },
    { configurable: { safetyMode: "READ_ONLY" } }
  );

  assert.match(result, /Action blocked: The agent is running in READ_ONLY safety mode/);
});

test("Safety Mode: READ_ONLY blocks writeFileTool execution", async () => {
  const tempPath = "tests/temp_test_write.txt";
  const result = await writeFileTool.invoke(
    { filePath: tempPath, content: "should not write" },
    { configurable: { safetyMode: "READ_ONLY" } }
  );

  assert.match(result, /Error: Write blocked. Agent is running in READ_ONLY safety mode/);
  assert.strictEqual(fs.existsSync(tempPath), false);
});

test("Safety Mode: Whitelisted safe commands auto-approve in STRICT mode", async () => {
  // git status is a whitelisted safe command. It should bypass prompt and execute.
  const result = await runCommandTool.invoke(
    { command: "git status" },
    { configurable: { safetyMode: "STRICT" } }
  );

  // Assert it ran successfully and contains git info, not a prompt block
  assert.ok(result.includes("On branch") || result.includes("Not a git repository") || result.includes("STDOUT") || result.includes("STDERR"));
});

test("Safety Mode: AUTO_APPROVE allows writeFileTool without prompt", async () => {
  const tempPath = "tests/temp_auto_approve.txt";
  if (fs.existsSync(tempPath)) {
    fs.unlinkSync(tempPath);
  }

  const result = await writeFileTool.invoke(
    { filePath: tempPath, content: "auto approve content" },
    { configurable: { safetyMode: "AUTO_APPROVE" } }
  );

  assert.strictEqual(fs.existsSync(tempPath), true);
  assert.strictEqual(fs.readFileSync(tempPath, "utf-8"), "auto approve content");

  // Clean up
  fs.unlinkSync(tempPath);
});
