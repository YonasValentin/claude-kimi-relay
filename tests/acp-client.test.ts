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
    readonly model?: string;
    readonly thinkingEffort?: string;
    readonly reports?: { agentConfig: unknown; warnings: readonly string[] }[];
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
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.thinkingEffort === undefined ? {} : { thinkingEffort: options.thinkingEffort }),
      },
      (message) => {
        options.progress?.push(message);
      },
      undefined,
      (report) => {
        options.reports?.push(report);
      },
    );
  } finally {
    delete process.env.KIMI_TEST_SCENARIO;
  }
}

async function runFailure(
  scenario: string,
  workspaceDir: string,
  options: Parameters<typeof run>[2] = {},
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

void test("a result says which agent, model and reasoning level produced it", async (t) => {
  const dir = await workspace(t);
  const progress: string[] = [];

  const { agentConfig } = await run("ok", dir, { progress });

  assert.ok(agentConfig);
  assert.deepEqual(agentConfig.agent, { name: "Fake ACP Agent", version: "1.2.3" });
  assert.equal(agentConfig.summary, "Model=fake/large, Thinking=high");
  assert.deepEqual(
    agentConfig.options.map((option) => [option.id, option.currentValue, option.category]),
    [
      ["model", "fake/large", "model"],
      ["thinking", "high", "thought_level"],
    ],
  );
  // Reported before the prompt is sent, so a task that later hangs still says
  // what it was running as.
  assert.match(progress[0] ?? "", /Fake ACP Agent 1\.2\.3 \| Model=fake\/large/u);
  assert.equal(agentConfig.changedDuringRun, undefined);
});

void test("an agent that advertises no configuration is still identified, with no invented options", async (t) => {
  const dir = await workspace(t);

  const { agentConfig } = await run("no-config", dir);

  assert.ok(agentConfig);
  assert.deepEqual(agentConfig.options, []);
  assert.equal(agentConfig.summary, "");
  assert.deepEqual(agentConfig.agent, { name: "Fake ACP Agent", version: "1.2.3" });
});

void test("a model or effort change during the run is reported, not overwritten by the start state", async (t) => {
  const dir = await workspace(t);
  const progress: string[] = [];

  const { agentConfig } = await run("config-change", dir, { progress });

  assert.ok(agentConfig);
  assert.equal(agentConfig.summary, "Model=fake/large, Thinking=low");
  assert.equal(agentConfig.changedDuringRun, true);
  assert.match(progress.join("\n"), /Thinking high -> low/u);
});

void test("a requested model and effort are applied and reported as applied", async (t) => {
  const dir = await workspace(t);
  const progress: string[] = [];

  const { agentConfig, warnings } = await run("ok", dir, {
    progress,
    model: "fake/large",
    thinkingEffort: "max",
  });

  assert.ok(agentConfig);
  assert.equal(agentConfig.summary, "Model=fake/large, Thinking=max");
  assert.deepEqual(warnings, []);
  assert.deepEqual(
    agentConfig.requests?.map((outcome) => [
      outcome.configId,
      outcome.applied,
      outcome.effectiveValue,
    ]),
    [
      // The model is already current, so it is reported applied without a call.
      ["model", true, "fake/large"],
      ["thinking", true, "max"],
    ],
  );
  // The agent echoes each set as a notification as well as answering it. Those
  // echoes must not be narrated as changes the agent made on its own.
  assert.equal(progress.filter((line) => line.includes("changed its session config")).length, 0);
});

void test("an effort the model cannot offer after a model switch is refused, not sent", async (t) => {
  const dir = await workspace(t);

  // fake/small has no reasoning levels, so switching to it collapses the
  // thinking scale to off/on -- the live-proven Kimi behaviour. Requesting max
  // alongside it must resolve against the new scale, not the old one.
  const { agentConfig, warnings } = await run("ok", dir, {
    model: "fake/small",
    thinkingEffort: "max",
  });

  assert.ok(agentConfig);
  assert.equal(agentConfig.summary, "Model=fake/small, Thinking=on");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? "", /does not offer thinking effort "max".*off, on/u);
  assert.equal(agentConfig.requests?.[1]?.applied, false);
});

void test("a task still runs when the agent refuses the requested configuration", async (t) => {
  const dir = await workspace(t);

  // The request is an optimisation; the review is the deliverable. Losing a
  // completed review because a knob would not turn is the worse outcome.
  const result = await run("reject-config", dir, { thinkingEffort: "max" });

  assert.equal(result.text, "fake review: nothing to report");
  assert.match(result.warnings[0] ?? "", /refused to set thinking effort/u);
});

void test("an agent without set_config_option is reported once and still does the work", async (t) => {
  const dir = await workspace(t);

  const result = await run("no-set-support", dir, {
    model: "fake/small",
    thinkingEffort: "max",
  });

  assert.equal(result.text, "fake review: nothing to report");
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /does not support session\/set_config_option/u);
});

void test("an environment override is reported by name, never by value", async (t) => {
  const dir = await workspace(t);
  process.env.KIMI_MODEL_NAME = "some-private-model";
  process.env.KIMI_MODEL_API_KEY = "super-secret";
  t.after(() => {
    delete process.env.KIMI_MODEL_NAME;
    delete process.env.KIMI_MODEL_API_KEY;
  });

  const result = await run("ok", dir);

  assert.deepEqual(result.agentConfig?.envOverrides, ["KIMI_MODEL_API_KEY", "KIMI_MODEL_NAME"]);
  // The value of KIMI_MODEL_API_KEY is a credential; the name alone is not.
  assert.doesNotMatch(JSON.stringify(result), /super-secret|some-private-model/u);
});

void test("a file read inside the workspace is served to the agent", async (t) => {
  const dir = await workspace(t);
  await writeFile(join(dir, "readable.txt"), "hello from the workspace\n", "utf8");

  const result = await run("fs-read", dir);

  assert.equal(result.text, "read:hello from the workspace");
});

void test("a run that fails after the session started still reports what it was running as", async (t) => {
  // `run` returns on success and throws on every failure, so without this sink
  // a timed-out or cancelled task tells you nothing about which model produced
  // the silence -- which is exactly when you want to know.
  const dir = await workspace(t);
  const reports: { agentConfig: unknown; warnings: readonly string[] }[] = [];

  const error = await runFailure("silent", dir, { timeoutMs: 400, reports, thinkingEffort: "max" });

  assert.equal(error.code, "TIMEOUT");
  // The first report is the one that matters: it must arrive before the prompt,
  // not with the result. A second follows from the failure path carrying the
  // final warnings.
  assert.ok(reports.length >= 1, "no report arrived before the run failed");
  assert.deepEqual(reports[0]?.agentConfig, {
    summary: "Model=fake/large, Thinking=max",
    options: [
      { id: "model", name: "Model", currentValue: "fake/large", category: "model" },
      { id: "thinking", name: "Thinking", currentValue: "max", category: "thought_level" },
    ],
    agent: { name: "Fake ACP Agent", version: "1.2.3" },
    requests: [{ configId: "thinking", requested: "max", applied: true, effectiveValue: "max" }],
  });
});

void test("a configuration warning survives a run that then fails", async (t) => {
  const dir = await workspace(t);
  const reports: { agentConfig: unknown; warnings: readonly string[] }[] = [];

  await runFailure("silent", dir, { timeoutMs: 400, reports, thinkingEffort: "nonsense" });

  assert.match(reports[0]?.warnings[0] ?? "", /does not offer thinking effort "nonsense"/u);
});

void test("tool calls the relay was never asked to approve are reported as ungated", async (t) => {
  // Kimi's auto and yolo session modes stop sending session/request_permission
  // entirely -- its own documentation calls that those modes' explicit contract
  // -- and the mode can be preset in the user's kimi config. The relay cannot
  // prevent that, so it has to notice and say so, or a review silently runs
  // with the deny-first command policy never consulted.
  const dir = await workspace(t);

  const result = await run("ungated-tools", dir);

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /ran 2 tool calls without asking this relay/u);
  assert.match(result.warnings[0] ?? "", /session mode as "yolo"/u);
});

void test("a run whose tool call went through the policy raises no ungated warning", async (t) => {
  // The tool call is announced before its permission request, so a check made
  // at the first tool call would fire on every correctly gated run.
  const dir = await workspace(t);

  const result = await run("permission", dir);

  assert.deepEqual(result.warnings, []);
});

void test("a run with no tool calls at all raises no ungated warning", async (t) => {
  const dir = await workspace(t);

  const result = await run("ok", dir);

  assert.deepEqual(result.warnings, []);
});
