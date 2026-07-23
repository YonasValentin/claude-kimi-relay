import assert from "node:assert/strict";
import test from "node:test";

import { PermissionPolicy } from "../src/policy.js";

const options = [
  { optionId: "allow", kind: "allow_once", name: "Allow once" },
  { optionId: "deny", kind: "reject_once", name: "Reject" },
] as const;

const policy = new PermissionPolicy();

void test("review permits a read-oriented operation", () => {
  const result = policy.decide(
    { toolCall: { title: "Read file src/index.ts" }, options },
    { mode: "review", workspaceDir: "/tmp/workspace" },
  );
  assert.deepEqual(result, { outcome: "selected", optionId: "allow" });
});

void test("review rejects writes", () => {
  const result = policy.decide(
    { toolCall: { title: "Edit src/index.ts" }, options },
    { mode: "review", workspaceDir: "/tmp/workspace" },
  );
  assert.deepEqual(result, { outcome: "selected", optionId: "deny" });
});

void test("delegate rejects publishing", () => {
  const result = policy.decide(
    { toolCall: { title: "Run npm publish" }, options },
    { mode: "delegate", workspaceDir: "/tmp/workspace" },
  );
  assert.deepEqual(result, { outcome: "selected", optionId: "deny" });
});

void test("delegate rejects network tools and dependency installation", () => {
  for (const title of [
    "Run curl https://example.com",
    "Run npm install lodash",
    "Run git commit -am done",
  ]) {
    const result = policy.decide(
      { toolCall: { title }, options },
      { mode: "delegate", workspaceDir: "/tmp/workspace" },
    );
    assert.deepEqual(result, { outcome: "selected", optionId: "deny" });
  }
});
