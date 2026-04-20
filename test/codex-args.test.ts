import test from "node:test";
import assert from "node:assert/strict";
import { buildCodexArgs } from "../src/adapters/codex";
import type { CompletionParams } from "../src/adapters/types";

function makeParams(overrides: Partial<CompletionParams> = {}): CompletionParams {
  return {
    messages: [],
    cwd: "/tmp",
    persistSession: true,
    ...overrides
  };
}

test("buildCodexArgs places search before exec for new runs", () => {
  const args = buildCodexArgs(
    makeParams({
      codexSearch: true
    }),
    "danger-full-access"
  );

  assert.equal(args[0], "--search");
  assert.equal(args[1], "exec");
  assert.equal(args.includes("resume"), false);
  assert.equal(args.indexOf("--search") < args.indexOf("exec"), true);
});

test("buildCodexArgs places search before exec for resume runs", () => {
  const args = buildCodexArgs(
    makeParams({
      codexSearch: true,
      sessionId: "session-123"
    }),
    "danger-full-access"
  );

  assert.deepEqual(args.slice(0, 3), ["--search", "exec", "resume"]);
  assert.equal(args.at(-2), "session-123");
  assert.equal(args.at(-1), "-");
});
