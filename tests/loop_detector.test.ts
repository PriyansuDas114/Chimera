import { test } from "node:test";
import * as assert from "node:assert";
import { LazyLoopDetector } from "../src/graph/loop_detector.js";
import type { GraphStep } from "../src/graph/runner.js";
import { AIMessage, ToolMessage } from "@langchain/core/messages";

test("LazyLoopDetector: passes non-repetitive tool calls", () => {
  const detector = new LazyLoopDetector();

  const step1: GraphStep = {
    nodeName: "coder",
    timestamp: "2026-05-18T18:00:00Z",
    update: {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "read_file", args: { path: "src/index.ts" }, id: "1" }],
        }),
      ],
    },
  };

  const step2: GraphStep = {
    nodeName: "coder",
    timestamp: "2026-05-18T18:00:05Z",
    update: {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "write_file", args: { path: "src/index.ts", content: "console.log('hi');" }, id: "2" }],
        }),
      ],
    },
  };

  const step3: GraphStep = {
    nodeName: "coder",
    timestamp: "2026-05-18T18:00:10Z",
    update: {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "read_file", args: { path: "src/index.ts" }, id: "3" }],
        }),
      ],
    },
  };

  assert.deepStrictEqual(detector.recordAndCheck(step1), { detected: false });
  assert.deepStrictEqual(detector.recordAndCheck(step2), { detected: false });
  assert.deepStrictEqual(detector.recordAndCheck(step3), { detected: false });
});

test("LazyLoopDetector: detects identical tool call loops (3 times without writes)", () => {
  const detector = new LazyLoopDetector();

  const step1: GraphStep = {
    nodeName: "coder",
    timestamp: "2026-05-18T18:00:00Z",
    update: {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "read_file", args: { path: "src/index.ts" }, id: "1" }],
        }),
      ],
    },
  };

  const step2: GraphStep = {
    nodeName: "coder",
    timestamp: "2026-05-18T18:00:05Z",
    update: {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "read_file", args: { path: "src/index.ts" }, id: "2" }],
        }),
      ],
    },
  };

  const step3: GraphStep = {
    nodeName: "coder",
    timestamp: "2026-05-18T18:00:10Z",
    update: {
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ name: "read_file", args: { path: "src/index.ts" }, id: "3" }],
        }),
      ],
    },
  };

  assert.deepStrictEqual(detector.recordAndCheck(step1), { detected: false });
  assert.deepStrictEqual(detector.recordAndCheck(step2), { detected: false });
  
  const result = detector.recordAndCheck(step3);
  assert.strictEqual(result.detected, true);
  assert.match(result.reason || "", /Identical tool execution loop detected/);
});

test("LazyLoopDetector: detects node chat ping-pong loop", () => {
  const detector = new LazyLoopDetector();

  const makeStep = (content: string): GraphStep => ({
    nodeName: "researcher",
    timestamp: "2026-05-18T18:00:00Z",
    update: {
      messages: [new AIMessage({ content })],
    },
  });

  assert.deepStrictEqual(detector.recordAndCheck(makeStep("Searching codebase for errors...")), { detected: false });
  assert.deepStrictEqual(detector.recordAndCheck(makeStep("Searching codebase for errors...")), { detected: false });
  
  const result = detector.recordAndCheck(makeStep("Searching codebase for errors..."));
  assert.strictEqual(result.detected, true);
  assert.match(result.reason || "", /Repetitive conversational cycle detected/);
});

test("LazyLoopDetector: detects periodic pattern loops (A -> B -> A -> B -> A -> B)", () => {
  const detector = new LazyLoopDetector();

  const makeNodeStep = (nodeName: string, content: string): GraphStep => ({
    nodeName,
    timestamp: "2026-05-18T18:00:00Z",
    update: {
      messages: [new AIMessage({ content })],
    },
  });

  // Pattern: researcher -> supervisor -> researcher -> supervisor -> researcher -> supervisor
  assert.deepStrictEqual(detector.recordAndCheck(makeNodeStep("researcher", "Looked at files")), { detected: false });
  assert.deepStrictEqual(detector.recordAndCheck(makeNodeStep("supervisor", "What is next?")), { detected: false });
  
  assert.deepStrictEqual(detector.recordAndCheck(makeNodeStep("researcher", "Looked at files")), { detected: false });
  assert.deepStrictEqual(detector.recordAndCheck(makeNodeStep("supervisor", "What is next?")), { detected: false });

  // At step 5, 'researcher' has run 3 times with identical outputs, so Heuristic 2 triggers early!
  const result = detector.recordAndCheck(makeNodeStep("researcher", "Looked at files"));
  assert.strictEqual(result.detected, true);
  assert.match(result.reason || "", /Repetitive conversational cycle detected/);
});
