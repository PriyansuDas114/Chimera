import { test } from "node:test";
import * as assert from "node:assert";
import * as path from "node:path";
import * as fs from "node:fs";
import { SessionStore } from "../src/memory/session.js";

test("SessionStore: CRUD lifecycle operations", () => {
  const tmpDir = path.resolve("./data/test-sessions");
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  const dbPath = path.resolve(tmpDir, "test-session-crud.db");
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const store = new SessionStore(dbPath);

  // 1. Create session
  const record = store.createSession({
    sessionId: "test-uuid-1234",
    goal: "Verify session crud works perfectly",
    cwd: process.cwd(),
  });

  assert.strictEqual(record.sessionId, "test-uuid-1234");
  assert.strictEqual(record.goal, "Verify session crud works perfectly");
  assert.strictEqual(record.status, "PLANNING");
  assert.strictEqual(record.stepCount, 0);

  // 2. Fetch by ID
  const fetched = store.getById("test-uuid-1234");
  assert.ok(fetched);
  assert.strictEqual(fetched.goal, "Verify session crud works perfectly");

  // 3. Update step count and status
  store.updateStep({
    sessionId: "test-uuid-1234",
    status: "EXECUTING",
    stepCount: 5,
  });

  const updated = store.getById("test-uuid-1234");
  assert.ok(updated);
  assert.strictEqual(updated.status, "EXECUTING");
  assert.strictEqual(updated.stepCount, 5);

  // 4. List recent
  const list = store.listRecent();
  assert.ok(list.length > 0);
  assert.strictEqual(list[0].sessionId, "test-uuid-1234");

  // 5. Delete
  const deleted = store.deleteById("test-uuid-1234");
  assert.ok(deleted);
  store.close();
  // Clean up
  try {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    const wal = dbPath + "-wal";
    const shm = dbPath + "-shm";
    if (fs.existsSync(wal)) fs.unlinkSync(wal);
    if (fs.existsSync(shm)) fs.unlinkSync(shm);
  } catch {
    // ignore lock issues
  }
});
