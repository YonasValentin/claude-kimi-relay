import assert from "node:assert/strict";
import test from "node:test";

import {
  EFFORT_TARGET,
  MODEL_TARGET,
  applyConfigRequests,
  summarizeConfigOptions,
  type ConfigRequest,
} from "../src/session-config.js";

// Kimi's actual rule, read off the shipped adapter: a model that declares
// supported efforts exposes them as the thinking scale; one that declares none
// falls back to the legacy off/on pair. Switching model therefore rewrites the
// effort option under you -- proven live against Kimi Code 0.29.0, where setting
// kimi-for-coding flipped thinking from "high" to "on".
const EFFORTS = new Map<string, readonly string[]>([
  ["kimi-code/k3", ["low", "high", "max"]],
  ["kimi-code/kimi-for-coding", []],
]);

function fakeAgent(initialModel = "kimi-code/k3", initialThinking = "high") {
  const calls: { configId: string; value: string }[] = [];
  let model = initialModel;
  let thinking = initialThinking;
  let inFlight = false;

  const snapshot = (): unknown => {
    const efforts = EFFORTS.get(model) ?? [];
    const values = efforts.length > 0 ? efforts : ["off", "on"];
    if (!values.includes(thinking)) thinking = values[values.length - 1] ?? "on";
    return [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: model,
        options: [...EFFORTS.keys()].map((value) => ({ value, name: value })),
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue: thinking,
        options: values.map((value) => ({ value, name: value })),
      },
    ];
  };

  return {
    calls,
    initial: snapshot(),
    setOption: async (configId: string, value: string): Promise<unknown> => {
      assert.equal(inFlight, false, "two set calls were in flight at once");
      inFlight = true;
      await Promise.resolve();
      calls.push({ configId, value });
      if (configId === "model") model = value;
      if (configId === "thinking") thinking = value;
      inFlight = false;
      return { configOptions: snapshot() };
    },
  };
}

const modelRequest = (requested: string): ConfigRequest => ({
  target: MODEL_TARGET,
  label: "model",
  requested,
});
const effortRequest = (requested: string): ConfigRequest => ({
  target: EFFORT_TARGET,
  label: "thinking effort",
  requested,
});

void test("the effort is resolved against the state the model change produced, not the old one", async () => {
  // The live-proven case. Requesting a model without an effort scale plus an
  // effort of "max" must not send "max" from a stale catalog -- Kimi answers an
  // unoffered effort with a hard -32602.
  const agent = fakeAgent();

  const result = await applyConfigRequests(
    agent.initial,
    [modelRequest("kimi-code/kimi-for-coding"), effortRequest("max")],
    agent.setOption,
  );

  assert.deepEqual(agent.calls, [{ configId: "model", value: "kimi-code/kimi-for-coding" }]);
  assert.equal(
    summarizeConfigOptions(result.state),
    "Model=kimi-code/kimi-for-coding, Thinking=on",
  );
  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.configId, outcome.applied, outcome.effectiveValue]),
    [
      ["model", true, "kimi-code/kimi-for-coding"],
      ["thinking", false, "on"],
    ],
  );
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /does not offer thinking effort "max".*off, on/u);
});

void test("requests are applied one at a time, model before effort", async () => {
  const agent = fakeAgent();

  await applyConfigRequests(
    agent.initial,
    [modelRequest("kimi-code/k3"), effortRequest("max")],
    agent.setOption,
  );

  // k3 is already current, so only the effort needs a call.
  assert.deepEqual(agent.calls, [{ configId: "thinking", value: "max" }]);
});

void test("state is rebuilt from the response, not patched locally", async () => {
  // The agent may change an option the relay never touched. Trusting a locally
  // patched copy would report a session that does not exist.
  const setOption = async (): Promise<unknown> => {
    await Promise.resolve();
    return {
      configOptions: [
        {
          type: "select",
          id: "thinking",
          name: "Thinking",
          currentValue: "max",
          options: [{ value: "max" }],
        },
        {
          type: "select",
          id: "mode",
          name: "Mode",
          currentValue: "plan",
          options: [{ value: "plan" }],
        },
      ],
    };
  };

  const result = await applyConfigRequests(
    [
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        currentValue: "low",
        options: [{ value: "low" }, { value: "max" }],
      },
      {
        type: "select",
        id: "mode",
        name: "Mode",
        currentValue: "default",
        options: [{ value: "default" }],
      },
    ],
    [effortRequest("max")],
    setOption,
  );

  assert.equal(summarizeConfigOptions(result.state), "Thinking=max, Mode=plan");
  assert.deepEqual(result.warnings, []);
});

void test("a value the agent already reports fires no set call at all", async () => {
  // Kimi deliberately re-runs both SDK calls even when the value is unchanged,
  // so re-asserting costs a round-trip and a spurious notification.
  const agent = fakeAgent();

  const result = await applyConfigRequests(agent.initial, [effortRequest("high")], agent.setOption);
  const [outcome] = result.outcomes;

  assert.deepEqual(agent.calls, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(outcome);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.effectiveValue, "high");
});

void test("a refused set becomes a warning and does not stop the next request", async () => {
  const calls: string[] = [];
  const setOption = async (configId: string): Promise<unknown> => {
    await Promise.resolve();
    calls.push(configId);
    if (configId === "model") throw Object.assign(new Error("Unknown model"), { code: -32602 });
    return {
      configOptions: [
        {
          type: "select",
          id: "model",
          name: "Model",
          currentValue: "a",
          options: [{ value: "a" }, { value: "b" }],
        },
        {
          type: "select",
          id: "thinking",
          name: "Thinking",
          currentValue: "max",
          options: [{ value: "low" }, { value: "max" }],
        },
      ],
    };
  };

  const result = await applyConfigRequests(
    [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "a",
        options: [{ value: "a" }, { value: "b" }],
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        currentValue: "low",
        options: [{ value: "low" }, { value: "max" }],
      },
    ],
    [modelRequest("b"), effortRequest("max")],
    setOption,
  );

  assert.deepEqual(calls, ["model", "thinking"]);
  assert.match(result.warnings[0] ?? "", /refused to set model to "b".*JSON-RPC -32602/u);
  assert.equal(result.outcomes[0]?.applied, false);
  assert.equal(result.outcomes[1]?.applied, true);
});

void test("a build without session/set_config_option is told once, not once per request", async () => {
  const calls: string[] = [];
  const setOption = async (configId: string): Promise<unknown> => {
    await Promise.resolve();
    calls.push(configId);
    throw Object.assign(new Error("Method not found"), { code: -32601 });
  };

  const result = await applyConfigRequests(
    [
      {
        type: "select",
        id: "model",
        name: "Model",
        currentValue: "a",
        options: [{ value: "a" }, { value: "b" }],
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        currentValue: "low",
        options: [{ value: "low" }, { value: "max" }],
      },
    ],
    [modelRequest("b"), effortRequest("max")],
    setOption,
  );

  assert.deepEqual(calls, ["model"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /does not support session\/set_config_option/u);
  assert.equal(
    result.outcomes.every((outcome) => !outcome.applied),
    true,
  );
});

void test("an agent that advertises nothing warns once per request and never calls out", async () => {
  const setOption = async (): Promise<unknown> => {
    await Promise.resolve();
    throw new Error("must not be called");
  };

  const result = await applyConfigRequests(
    undefined,
    [modelRequest("x"), effortRequest("max")],
    setOption,
  );

  assert.deepEqual(result.state, []);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0] ?? "", /advertised no model option/u);
});

void test("a silent downgrade is reported, even though the set itself succeeded", async () => {
  // Kimi's documentation says an effort outside a model's supported list falls
  // back to the model default and reports that effective value. The set returns
  // success, so only comparing against the final state catches it.
  const setOption = async (): Promise<unknown> => {
    await Promise.resolve();
    return {
      configOptions: [
        {
          type: "select",
          id: "thinking",
          name: "Thinking",
          currentValue: "high",
          options: [{ value: "high" }, { value: "max" }],
        },
      ],
    };
  };

  const result = await applyConfigRequests(
    [
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        currentValue: "low",
        options: [{ value: "high" }, { value: "max" }],
      },
    ],
    [effortRequest("max")],
    setOption,
  );

  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /reports Thinking="high".*not the requested "max"/u);
  assert.equal(result.outcomes[0]?.effectiveValue, "high");
});

void test("an empty response keeps the known state instead of erasing it", async () => {
  const setOption = async (): Promise<unknown> => {
    await Promise.resolve();
    return { configOptions: [] };
  };

  const result = await applyConfigRequests(
    [
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        currentValue: "low",
        options: [{ value: "low" }, { value: "max" }],
      },
    ],
    [effortRequest("max")],
    setOption,
  );

  assert.equal(summarizeConfigOptions(result.state), "Thinking=low");
  assert.match(result.warnings[0] ?? "", /not the requested "max"/u);
});
