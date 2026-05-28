import { test } from "node:test";
import * as assert from "node:assert";
import chalk from "chalk";
import { computeLineDiff } from "../src/utils/diff.js";

// Helper to clean up color codes for basic content testing
function stripColors(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[\d+m/g, "");
}

test("computeLineDiff: formats identical text as neutral", () => {
  const text = "hello\nworld";
  const diff = computeLineDiff(text, text);
  
  assert.strictEqual(stripColors(diff), "  hello\n  world");
});

test("computeLineDiff: highlights added lines", () => {
  const oldText = "hello\nworld";
  const newText = "hello\nbeautiful\nworld";
  const diff = computeLineDiff(oldText, newText);
  
  assert.strictEqual(stripColors(diff), "  hello\n+ beautiful\n  world");
});

test("computeLineDiff: highlights deleted lines", () => {
  const oldText = "hello\nbeautiful\nworld";
  const newText = "hello\nworld";
  const diff = computeLineDiff(oldText, newText);
  
  assert.strictEqual(stripColors(diff), "  hello\n- beautiful\n  world");
});

test("computeLineDiff: works with complex multi-line transformations", () => {
  const oldText = "line1\nline2\nline3";
  const newText = "line1\nchanged2\nline3\nline4";
  const diff = computeLineDiff(oldText, newText);
  
  assert.strictEqual(
    stripColors(diff),
    "  line1\n- line2\n+ changed2\n  line3\n+ line4"
  );
});
