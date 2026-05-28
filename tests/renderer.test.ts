import { test } from "node:test";
import * as assert from "node:assert";
import { renderMarkdown } from "../src/cli/renderer.js";

test("Renderer: handles headers", () => {
  const result = renderMarkdown("### Test Header");
  assert.match(result, /TEST HEADER/);
});

test("Renderer: handles bullet lists", () => {
  const result = renderMarkdown("* Bullet Item");
  assert.match(result, /- Bullet Item/);
});

test("Renderer: handles numbered lists", () => {
  const result = renderMarkdown("1. Numbered Item");
  assert.match(result, /• Numbered Item/);
});

test("Renderer: handles inline code", () => {
  const result = renderMarkdown("Run `npm test` now");
  // The styled text will have ANSI colors, so we check for presence of npm test
  assert.match(result, /npm test/);
});

test("Renderer: handles blockquotes", () => {
  const result = renderMarkdown("> Important quote");
  assert.match(result, /│/);
  assert.match(result, /Important quote/);
});

test("Renderer: handles code blocks with highlighting", () => {
  const codeBlock = "```typescript\nconst count: number = 42;\nconsole.log(count);\n```";
  const result = renderMarkdown(codeBlock);
  
  // Verify borders are rendered
  assert.match(result, /┌── \[typescript\]/);
  assert.match(result, /└/);
  assert.match(result, /│/);
  
  // Verify content is present
  assert.match(result, /count/);
  assert.match(result, /console/);
});
