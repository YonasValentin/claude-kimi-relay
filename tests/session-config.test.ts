import assert from "node:assert/strict";
import test from "node:test";

import {
  ConfigTracker,
  EFFORT_TARGET,
  MODEL_TARGET,
  describeConfigChange,
  extractConfigOptions,
  parseConfigOptions,
  resolveConfigRequest,
  setRequestBody,
  summarizeConfigOptions,
} from "../src/session-config.js";

// The shape Kimi Code 0.29.0 actually sends on session/new.
const kimiOptions = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "kimi-code/k3",
    options: [
      { value: "kimi-code/kimi-for-coding", name: "K2.7 Coding" },
      { value: "kimi-code/k3", name: "K3" },
    ],
  },
  {
    type: "select",
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    currentValue: "high",
    options: [
      { value: "low", name: "Low" },
      { value: "high", name: "High" },
      { value: "max", name: "Max" },
    ],
  },
];

void test("a select option with no type still parses, because stable v1 omits it", () => {
  // The SDK's own typings mark `type` required on a select. The stable v1 wire
  // form omits it, so narrowing on type === "select" would make a compliant
  // agent invisible.
  const parsed = parseConfigOptions([
    { id: "model", name: "Model", currentValue: "a", options: [{ value: "a" }, { value: "b" }] },
  ]);

  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0]?.values, ["a", "b"]);
});

void test("an option with an unrecognized type is ignored rather than guessed at", () => {
  const parsed = parseConfigOptions([
    { type: "_slider", id: "temperature", currentValue: "0.3" },
    ...kimiOptions,
  ]);

  assert.deepEqual(
    parsed.map((option) => option.id),
    ["model", "thinking"],
  );
});

void test("grouped select values are flattened, so a provider-grouped model list still resolves", () => {
  // The same field carries either values or groups of values. Missing the group
  // shape would report every offered model as unavailable.
  const parsed = parseConfigOptions([
    {
      type: "select",
      id: "model",
      name: "Model",
      category: "model",
      currentValue: "vendor/a",
      options: [
        {
          group: "vendor",
          name: "Vendor",
          options: [{ value: "vendor/a" }, { value: "vendor/b" }],
        },
        { group: "other", name: "Other", options: [{ value: "other/c" }] },
      ],
    },
  ]);

  assert.deepEqual(parsed[0]?.values, ["vendor/a", "vendor/b", "other/c"]);
  assert.deepEqual(resolveConfigRequest(parsed, MODEL_TARGET, "vendor/b"), {
    kind: "apply",
    configId: "model",
    value: "vendor/b",
  });
});

void test("a boolean option is reported but offers no values, so it is never set", () => {
  const parsed = parseConfigOptions([
    { type: "boolean", id: "brave_mode", name: "Brave mode", currentValue: true },
  ]);
  const [option] = parsed;

  assert.ok(option);
  assert.equal(option.currentValue, "true");
  assert.deepEqual(option.values, []);
  assert.equal(
    resolveConfigRequest(parsed, { ids: ["brave_mode"], categories: [] }, "true").kind,
    "not_offered",
  );
});

void test("the agent's array order is preserved, because order is display priority", () => {
  const parsed = parseConfigOptions([...kimiOptions].reverse());

  assert.deepEqual(
    parsed.map((option) => option.id),
    ["thinking", "model"],
  );
});

void test("a missing, null, or unfamiliar category still resolves by id", () => {
  for (const category of [undefined, null, "_vendor_specific"]) {
    const parsed = parseConfigOptions([
      {
        type: "select",
        id: "model",
        currentValue: "a",
        options: [{ value: "a" }, { value: "b" }],
        category,
      },
    ]);

    assert.equal(parsed.length, 1, `category ${String(category)} was dropped`);
    assert.equal(resolveConfigRequest(parsed, MODEL_TARGET, "b").kind, "apply");
  }
});

void test("an option with no name falls back to its id as the label", () => {
  const parsed = parseConfigOptions([{ type: "select", id: "thinking", currentValue: "on" }]);

  assert.equal(parsed[0]?.label, "thinking");
  assert.equal(summarizeConfigOptions(parsed), "thinking=on");
});

void test("the v2 configId key is read as well as v1's id", () => {
  const parsed = parseConfigOptions([{ type: "select", configId: "model", currentValue: "a" }]);

  assert.equal(parsed[0]?.id, "model");
});

void test("a hostile option list is bounded instead of copied into the task record", () => {
  const parsed = parseConfigOptions([
    { type: "select", id: "x".repeat(5000), currentValue: "a" },
    {
      type: "select",
      id: "model",
      currentValue: "a",
      options: Array.from({ length: 10_000 }, (_, index) => ({ value: `v${index}` })),
    },
    ...Array.from({ length: 500 }, (_, index) => ({
      type: "select",
      id: `filler-${index}`,
      currentValue: "a",
    })),
  ]);

  assert.ok(parsed.length <= 32);
  assert.equal(
    parsed.some((option) => option.id.length > 200),
    false,
  );
  assert.ok((parsed.find((option) => option.id === "model")?.values.length ?? 0) <= 128);
});

void test("garbage input parses to nothing instead of throwing", () => {
  for (const input of [undefined, null, "nope", 7, {}, [null, 3, "x", {}]]) {
    assert.deepEqual(parseConfigOptions(input), []);
  }
});

void test("an exact id match beats a category match", () => {
  // An agent may well ship a `model`-category option whose id is something else
  // alongside an option literally called `model`.
  const parsed = parseConfigOptions([
    {
      type: "select",
      id: "engine",
      category: "model",
      currentValue: "a",
      options: [{ value: "b" }],
    },
    {
      type: "select",
      id: "model",
      category: "_custom",
      currentValue: "c",
      options: [{ value: "d" }],
    },
  ]);

  assert.deepEqual(resolveConfigRequest(parsed, MODEL_TARGET, "d"), {
    kind: "apply",
    configId: "model",
    value: "d",
  });
});

void test("the effort option is found by thought_level when its id is unfamiliar", () => {
  const parsed = parseConfigOptions([
    {
      type: "select",
      id: "reasoning_level",
      name: "Reasoning",
      category: "thought_level",
      currentValue: "low",
      options: [{ value: "low" }, { value: "high" }],
    },
  ]);

  assert.deepEqual(resolveConfigRequest(parsed, EFFORT_TARGET, "high"), {
    kind: "apply",
    configId: "reasoning_level",
    value: "high",
  });
});

void test("two options in the same category are refused, never picked between", () => {
  const parsed = parseConfigOptions([
    {
      type: "select",
      id: "primary",
      category: "model",
      currentValue: "a",
      options: [{ value: "x" }],
    },
    {
      type: "select",
      id: "fallback",
      category: "model",
      currentValue: "b",
      options: [{ value: "x" }],
    },
  ]);

  assert.deepEqual(resolveConfigRequest(parsed, MODEL_TARGET, "x"), {
    kind: "ambiguous",
    configIds: ["primary", "fallback"],
  });
});

void test("a unique case-insensitive value is accepted but an ambiguous one is not", () => {
  const parsed = parseConfigOptions(kimiOptions);
  assert.deepEqual(resolveConfigRequest(parsed, EFFORT_TARGET, " Max "), {
    kind: "apply",
    configId: "thinking",
    value: "max",
  });

  const shouty = parseConfigOptions([
    {
      type: "select",
      id: "thinking",
      currentValue: "low",
      options: [{ value: "max" }, { value: "MAX" }],
    },
  ]);
  assert.equal(resolveConfigRequest(shouty, EFFORT_TARGET, "Max").kind, "not_offered");
});

void test("a value the agent does not offer is refused here, with the offered list", () => {
  // Kimi answers an unoffered effort with a hard -32602, and the spec defines no
  // error contract for it at all. Resolving client-side keeps the relay's
  // outbound config a strict subset of what the agent advertised.
  const resolution = resolveConfigRequest(parseConfigOptions(kimiOptions), EFFORT_TARGET, "xhigh");

  assert.deepEqual(resolution, {
    kind: "not_offered",
    configId: "thinking",
    currentValue: "high",
    offered: ["low", "high", "max"],
  });
});

void test("a request for the value already selected fires no set call", () => {
  // Kimi deliberately has no idempotency check, so re-asserting a value costs a
  // round-trip and an extra notification for nothing.
  assert.deepEqual(resolveConfigRequest(parseConfigOptions(kimiOptions), EFFORT_TARGET, "high"), {
    kind: "already",
    configId: "thinking",
    value: "high",
  });
});

void test("resolving against an agent that advertises nothing reports no option", () => {
  assert.deepEqual(resolveConfigRequest([], MODEL_TARGET, "kimi-code/k3"), { kind: "no_option" });
});

void test("the summary uses the agent's own labels and invents no model field", () => {
  assert.equal(
    summarizeConfigOptions(parseConfigOptions(kimiOptions)),
    "Model=kimi-code/k3, Thinking=high",
  );
  assert.equal(summarizeConfigOptions([]), "");
});

void test("a removed option is described as a change, not silently dropped", () => {
  // Selecting a model that cannot think removes the effort option outright.
  const before = parseConfigOptions(kimiOptions);
  const after = parseConfigOptions([kimiOptions[0]]);

  assert.match(describeConfigChange(before, after) ?? "", /Thinking is no longer offered/u);
  assert.equal(describeConfigChange(before, before), undefined);
});

void test("the set request body carries no type discriminator, as stable v1 requires", () => {
  assert.deepEqual(setRequestBody("thinking", "max"), { configId: "thinking", value: "max" });
});

void test("extractConfigOptions ignores every session update except a config change", () => {
  assert.equal(extractConfigOptions({ sessionUpdate: "agent_message_chunk" }), undefined);
  assert.equal(extractConfigOptions(null), undefined);
  assert.deepEqual(
    extractConfigOptions({
      sessionUpdate: "config_option_update",
      configOptions: kimiOptions,
    })?.map((option) => option.id),
    ["model", "thinking"],
  );
});

void test("an empty config update is ignored instead of wiping the known state", () => {
  // The SDK decodes notifications with a skip-on-error list decoder, so an
  // undecodable payload arrives as []. Applying that would report a session with
  // no model at all.
  const tracker = new ConfigTracker(parseConfigOptions(kimiOptions));

  assert.equal(
    tracker.observe({ sessionUpdate: "config_option_update", configOptions: [] }),
    undefined,
  );
  assert.equal(summarizeConfigOptions(tracker.state), "Model=kimi-code/k3, Thinking=high");
  assert.equal(tracker.changedDuringRun, false);
});

void test("the tracker stays silent when a notification only echoes the state it already has", () => {
  // Kimi emits a config_option_update for every set it performs *and* returns a
  // fresh snapshot in the response. Baselining from the response means the echo
  // must not produce a second event.
  const tracker = new ConfigTracker(parseConfigOptions(kimiOptions));

  assert.equal(
    tracker.observe({ sessionUpdate: "config_option_update", configOptions: kimiOptions }),
    undefined,
  );
  assert.equal(tracker.changedDuringRun, false);
});

void test("a mid-run change is narrated once and remembered in the reported state", () => {
  const tracker = new ConfigTracker(parseConfigOptions(kimiOptions));
  const changed = [kimiOptions[0], { ...kimiOptions[1], currentValue: "low" }];

  const line = tracker.observe({ sessionUpdate: "config_option_update", configOptions: changed });

  assert.match(line ?? "", /Thinking high -> low/u);
  assert.equal(tracker.changedDuringRun, true);
  assert.equal(summarizeConfigOptions(tracker.state), "Model=kimi-code/k3, Thinking=low");
});

void test("the tracker stops narrating after the event cap but keeps tracking state", () => {
  // Every narrated line becomes a TaskEvent against a 200-event budget, so a
  // chatty agent must not be able to push real progress out of the log.
  const tracker = new ConfigTracker(parseConfigOptions(kimiOptions));
  let narrated = 0;
  for (let index = 0; index < 40; index += 1) {
    const update = {
      sessionUpdate: "config_option_update",
      configOptions: [
        kimiOptions[0],
        { ...kimiOptions[1], currentValue: index % 2 === 0 ? "low" : "max" },
      ],
    };
    if (tracker.observe(update) !== undefined) narrated += 1;
  }

  assert.equal(narrated, 10);
  assert.equal(tracker.changedDuringRun, true);
  assert.equal(summarizeConfigOptions(tracker.state), "Model=kimi-code/k3, Thinking=max");
});
