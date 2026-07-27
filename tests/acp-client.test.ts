import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import { KimiAcpClient } from "../src/acp-client.js";
import { RelayError } from "../src/errors.js";
import type { AgentRunResult, RelayConfig, TaskKind } from "../src/types.js";

const FAKE_AGENT = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-acp-agent.mjs");

function config(dataDir: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    dataDir,
    // Spawning node with the fixture as its argument keeps this cross-platform:
    // no shebang, no executable bit, and the Windows CI leg runs it too.
    kimiCliPath: process.execPath,
    kimiCliArgs: [FAKE_AGENT],
    defaultTimeoutMs: 30_000,
    maxFileBytes: 65_536,
    maxWorkspaceBytes: 1_048_576,
    maxResultBytes: 1_048_576,
    ...overrides,
  };
}

async function workspace(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "relay-acp-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function run(
  scenario: string,
  workspaceDir: string,
  options: {
    readonly kind?: TaskKind;
    readonly timeoutMs?: number;
    readonly relay?: Partial<RelayConfig>;
    readonly progress?: string[];
  } = {},
): Promise<AgentRunResult> {
  // KIMI_TEST_SCENARIO must keep its prefix: the relay filters the agent's
  // environment through a prefix allowlist, so an unprefixed name would never
  // arrive. Every test here therefore also asserts that KIMI_* still passes.
  process.env.KIMI_TEST_SCENARIO = scenario;
  try {
    const client = new KimiAcpClient(config(workspaceDir, options.relay ?? {}));
    return await client.run(
      {
        taskId: "task-1",
        kind: options.kind ?? "review",
        prompt: "review the changes",
        workspaceDir,
        timeoutMs: options.timeoutMs ?? 30_000,
      },
      (message) => {
        options.progress?.push(message);
      },
    );
  } finally {
    delete process.env.KIMI_TEST_SCENARIO;
  }
}

async function runFailure(
  scenario: string,
  workspaceDir: string,
  options = {},
): Promise<RelayError> {
  try {
    await run(scenario, workspaceDir, options);
  } catch (error) {
    assert.ok(error instanceof RelayError, `expected a RelayError, got ${String(error)}`);
    return error;
  }
  throw new Error(`scenario ${scenario} unexpectedly succeeded`);
}

void test("a completed prompt turn returns the streamed text, stop reason, and session id", async (t) => {
  const dir = await workspace(t);
  const progress: string[] = [];

  const result = await run("ok", dir, { progress });

  assert.equal(result.text, "fake review: nothing to report");
  assert.equal(result.stopReason, "end_turn");
  assert.equal(result.sessionId, "session_fake");
  assert.match(progress.join("\n"), /session_fake/u);
});

void test("an agent negotiating a different protocol version is refused, not talked to", async (t) => {
  const dir = await workspace(t);

  assert.equal((await runFailure("version-mismatch", dir)).code, "ACP_VERSION_MISMATCH");
});

void test("an unauthenticated agent produces the sign-in error, not a raw protocol failure", async (t) => {
  const dir = await workspace(t);

  const error = await runFailure("auth-required", dir);

  assert.equal(error.code, "KIMI_AUTH_REQUIRED");
  assert.match(error.message, /sign in/u);
});

void test("an agent that dies mid-protocol reports what it said on the way out", async (t) => {
  const dir = await workspace(t);

  const error = await runFailure("exit-after-session", dir);

  // A dying child closes the protocol stream and fires its exit event at
  // effectively the same moment, so either KIMI_EXITED or the generic protocol
  // failure can win that race. What must not vary is that the agent's own
  // stderr -- the only place it explains itself -- reaches the user.
  assert.match(error.message, /fake agent could not start its model/u);
  assert.ok(["KIMI_EXITED", "KIMI_ACP_FAILED"].includes(error.code));
});

void test("a result larger than the configured limit is cut off rather than buffered", async (t) => {
  const dir = await workspace(t);

  const error = await runFailure("huge-result", dir, { relay: { maxResultBytes: 4096 } });

  assert.equal(error.code, "RESULT_TOO_LARGE");
});

void test("a run that outlives its timeout is terminated and reported as a timeout", async (t) => {
  const dir = await workspace(t);

  // The fake never answers the prompt, so only the relay's own clock ends this.
  assert.equal((await runFailure("silent", dir, { timeoutMs: 400 })).code, "TIMEOUT");
});

void test("a denied tool request is rejected through the permission policy, one shot only", async (t) => {
  const dir = await workspace(t);

  const result = await run("permission", dir);

  // `npm publish` is on the always-deny list, and the policy must pick the
  // one-shot reject rather than any session-wide decision.
  assert.match(result.text, /"outcome":"selected"/u);
  assert.match(result.text, /"optionId":"reject"/u);
});

void test("a review task cannot write, even to a path inside its own workspace", async (t) => {
  const dir = await workspace(t);

  const result = await run("fs-write", dir, { kind: "review" });

  assert.match(result.text, /write:denied/u);
  await assert.rejects(readFile(join(dir, "written.txt"), "utf8"));
});

void test("a delegate task may write inside the workspace", async (t) => {
  const dir = await workspace(t);

  const result = await run("fs-write", dir, { kind: "delegate" });

  assert.equal(result.text, "write:ok");
  assert.equal(await readFile(join(dir, "written.txt"), "utf8"), "from the agent\n");
});

void test("a delegate write that climbs out of the workspace is refused", async (t) => {
  const dir = await workspace(t);

  const result = await run("fs-write-escape", dir, { kind: "delegate" });

  assert.match(result.text, /write:denied/u);
  await assert.rejects(readFile(join(dir, "..", "escaped.txt"), "utf8"));
});

void test("a file read inside the workspace is served to the agent", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, "readable.txt"), "hello from the workspace\n", "utf8");

  const result = await run("fs-read", dir);

  assert.equal(result.text, "read:hello from the workspace");
});
