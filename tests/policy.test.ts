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

void test("DENY_ALWAYS blocks destructive and credential commands in both modes", () => {
  const denied = [
    "Run sudo apt-get install",
    "Run git push origin main",
    "Run ssh user@host",
    "Run scp file user@host:/tmp",
    "Run rsync -a . remote:/data",
    "cat /etc/passwd",
    "Run chmod 777 /srv",
    "Run dd if=/dev/zero of=/dev/disk2",
    "Run mkfs.ext4 /dev/disk2",
    "Run rm -rf /",
    "Run cat ./.env.local",
  ];
  for (const title of denied) {
    for (const mode of ["review", "delegate"] as const) {
      const result = policy.decide(
        { toolCall: { title }, options },
        { mode, workspaceDir: "/tmp/workspace" },
      );
      assert.deepEqual(result, { outcome: "selected", optionId: "deny" }, `${mode}: ${title}`);
    }
  }
});

void test("delegate denies an oversized tool call that pads a denied command past the inspection limit", () => {
  // A truncating deny check let a denied command hide behind >100KB of padding
  // so DENY_ALWAYS never saw it. Delegate mode must fail closed on a request it
  // cannot fully inspect rather than fall through to the allow option.
  const result = policy.decide(
    {
      toolCall: { title: "A".repeat(120_000), rawInput: { command: "git push origin main" } },
      options,
    },
    { mode: "delegate", workspaceDir: "/tmp/workspace" },
  );
  assert.deepEqual(result, { outcome: "selected", optionId: "deny" });
});

void test("delegate still allows a normal in-workspace edit", () => {
  const result = policy.decide(
    { toolCall: { title: "Edit src/app.ts" }, options },
    { mode: "delegate", workspaceDir: "/tmp/workspace" },
  );
  assert.deepEqual(result, { outcome: "selected", optionId: "allow" });
});
