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

void test("never selects a session-wide allow_always option, even when listed first", () => {
  // A conforming agent records allow_always as a persistent grant and stops
  // re-requesting, which would bypass the deny gate for the rest of the session.
  const withAlways = [
    { optionId: "always", kind: "allow_always", name: "Allow always" },
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "deny", kind: "reject_once", name: "Reject" },
  ] as const;
  const result = policy.decide(
    { toolCall: { title: "Read file src/index.ts" }, options: withAlways },
    { mode: "review", workspaceDir: "/tmp/workspace" },
  );
  assert.deepEqual(result, { outcome: "selected", optionId: "once" });
});

void test("refuses to allow when only a session-wide allow_always is offered", () => {
  const onlyAlways = [
    { optionId: "always", kind: "allow_always", name: "Allow always" },
    { optionId: "deny", kind: "reject_once", name: "Reject" },
  ] as const;
  const result = policy.decide(
    { toolCall: { title: "Read file src/index.ts" }, options: onlyAlways },
    { mode: "review", workspaceDir: "/tmp/workspace" },
  );
  assert.notDeepEqual(result, { outcome: "selected", optionId: "always" });
});

void test("review denies a safe-read verb that chains or redirects a write", () => {
  for (const command of [
    "cat template.txt && echo pwned > ~/.bashrc",
    "grep -r x . | tee ./out.txt",
    "cat notes.md; rm important.txt",
  ]) {
    const result = policy.decide(
      { toolCall: { title: "Run command", rawInput: { command } }, options },
      { mode: "review", workspaceDir: "/tmp/workspace" },
    );
    assert.deepEqual(result, { outcome: "selected", optionId: "deny" }, command);
  }
});

void test("review denies safe-read verbs that write via flags, binaries, or non-obvious separators", () => {
  for (const command of [
    "find . -maxdepth 1 -fprint /home/user/pwned.txt", // find write-action
    "find . -type f -exec rm {} ;", // find -exec
    "cat notes.md\nrm -f important.txt", // newline separator + rm binary
    "cat a.txt & rm b.txt", // bare & separator
    "cat x.txt; cp x.txt /home/user/evil", // cp binary
    "ls . && tee /home/user/out", // tee binary
  ]) {
    const result = policy.decide(
      { toolCall: { title: "Run command", rawInput: { command } }, options },
      { mode: "review", workspaceDir: "/tmp/workspace" },
    );
    assert.deepEqual(result, { outcome: "selected", optionId: "deny" }, JSON.stringify(command));
  }
});

// --- R8R regression matrix -------------------------------------------------
// The `.env` entry in DENY_ALWAYS was unreachable for the exact filename: the
// patterns are tested against JSON.stringify(toolCall), where `^`/`$` anchor to
// the serialized object rather than to a path, so `cat .env` was ALLOWED in both
// modes -- including delegate, where the deny list is the only content gate.
// Only `cat ./.env.local` (asserted above) happened to match, which is why the
// defect shipped. These cases lock the whole contract down in both directions.

const decide = (
  toolCall: Record<string, unknown>,
  mode: "review" | "delegate",
): string | undefined => {
  const result = policy.decide({ toolCall, options }, { mode, workspaceDir: "/tmp/workspace" });
  return result.outcome === "selected" ? result.optionId : undefined;
};

void test("sensitive paths are denied in both modes, however the command spells them", () => {
  const denied = [
    "cat .env",
    "cat ./.env",
    "cat /repo/.env",
    "cat .env.local",
    "cat ./.env.local",
    "cat C:\\repo\\.env",
    'cat ".env"',
    "cat '.env'",
    "echo x >.env",
    "cat ../.env",
    "cat $HOME/.env",
    "cat .env.production",
    "grep -r KEY /srv/app/.env",
    "cat notes.md; cat .env",
    "cat .env > /tmp/out",
    "cat .env|base64",
    "cat \\repo\\.env.local",
    // Secret classes the workspace filter and the ACP fs bridge already block;
    // the policy layer now agrees with them instead of knowing a weaker subset.
    "cat .ssh/id_rsa",
    "cat ~/.aws/credentials",
    "cat kubeconfig",
    "cat server.pem",
  ];
  for (const command of denied) {
    for (const mode of ["review", "delegate"] as const) {
      assert.equal(
        decide({ title: "Run command", rawInput: { command } }, mode),
        "deny",
        `${mode}: ${command}`,
      );
    }
  }
});

void test("sensitive paths are denied in both modes when supplied as a structured path", () => {
  for (const path of [".env", "C:\\repo\\.env", "src/config/.env.local"]) {
    for (const mode of ["review", "delegate"] as const) {
      assert.equal(decide({ title: "Read", rawInput: { path } }, mode), "deny", `${mode}: ${path}`);
    }
  }
});

void test("non-secret lookalikes are not blocked -- this is not a substring ban on 'env'", () => {
  // .env.example/.sample/.template are ordinary repo files; this repository
  // ships one. fs-security.ts allows them deliberately, and the policy layer
  // must not disagree with the layer that decides what enters the workspace.
  const allowedReads = [
    "cat .env.example",
    "cat .env.sample",
    "cat .env.template",
    "cat .environment",
    "cat foo.env",
    "cat src/env.ts",
    "grep env README.md",
    "cat environment.yml",
  ];
  for (const command of allowedReads) {
    for (const mode of ["review", "delegate"] as const) {
      assert.equal(
        decide({ title: "Run command", rawInput: { command } }, mode),
        "allow",
        `${mode}: ${command}`,
      );
    }
  }
  // A write is still a write in review mode -- checked in delegate only, where
  // the deny list is the sole content gate.
  assert.equal(decide({ title: "Edit src/dotenv-loader.ts" }, "delegate"), "allow");
  for (const path of [".env.example", "src/environment.ts"]) {
    assert.equal(decide({ title: "Read", rawInput: { path } }, "delegate"), "allow", path);
  }
});
