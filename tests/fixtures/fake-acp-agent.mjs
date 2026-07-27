// A fake ACP agent for testing KimiAcpClient end to end over a real pipe.
//
// Deliberately hand-rolled NDJSON rather than the ACP SDK: using the SDK here
// would validate the SDK against itself, and would pin this fixture to whatever
// shapes the current SDK version happens to accept. The client under test is the
// thing being exercised, so this side speaks the wire directly.
//
// The scenario arrives in KIMI_TEST_SCENARIO. That name is not decorative: the
// relay sanitizes the agent environment through a prefix allowlist, so only a
// KIMI_-prefixed variable reaches this process at all -- which makes every test
// here a live assertion that the allowlist still forwards KIMI_*.
//
// stdout carries the protocol and nothing else. Diagnostics go to stderr, where
// the relay buffers them for its failure message.

const scenario = process.env.KIMI_TEST_SCENARIO ?? "ok";
const sessionId = "session_fake";
let nextId = 1000;

// The relay terminates the agent with SIGTERM and only escalates to SIGKILL
// after a 2s grace. Exiting promptly keeps the suite fast; the escalation path
// has its own test.
process.on("SIGTERM", () => process.exit(0));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function update(sessionUpdate) {
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: sessionUpdate } });
}

function textChunk(text) {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
}

/** Sends a request to the client and resolves with its result, or rejects with its error. */
const pending = new Map();
function ask(method, params) {
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const CONFIG_OPTIONS = [
  {
    type: "select",
    id: "model",
    name: "Model",
    category: "model",
    currentValue: "fake/large",
    options: [
      { value: "fake/large", name: "Large" },
      { value: "fake/small", name: "Small" },
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

async function runPrompt(id) {
  switch (scenario) {
    case "huge-result":
      // Comfortably past any sane maxResultBytes the test sets.
      for (let index = 0; index < 64; index += 1) textChunk("x".repeat(4096));
      break;
    case "permission":
      await ask("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "call_1", title: "npm publish", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      }).then(
        (outcome) => textChunk(`permission:${JSON.stringify(outcome)}`),
        (error) => textChunk(`permission-error:${error.message}`),
      );
      break;
    case "fs-write":
    case "fs-write-escape":
      await ask("fs/write_text_file", {
        sessionId,
        path:
          scenario === "fs-write-escape"
            ? `${process.cwd()}/../escaped.txt`
            : `${process.cwd()}/written.txt`,
        content: "from the agent\n",
      }).then(
        () => textChunk("write:ok"),
        (error) => textChunk(`write:denied:${error.message}`),
      );
      break;
    case "fs-read":
      await ask("fs/read_text_file", { sessionId, path: `${process.cwd()}/readable.txt` }).then(
        (result) => textChunk(`read:${result.content.trim()}`),
        (error) => textChunk(`read:denied:${error.message}`),
      );
      break;
    case "config-change":
      textChunk("switching gears");
      // An agent may change model or reasoning level mid-turn, for instance
      // when it falls back after a rate limit.
      update({
        sessionUpdate: "config_option_update",
        configOptions: [CONFIG_OPTIONS[0], { ...CONFIG_OPTIONS[1], currentValue: "low" }],
      });
      break;
    case "silent":
      // Never responds. The relay's own timeout has to end the run.
      return;
    default:
      textChunk("fake review: nothing to report");
      break;
  }
  respond(id, { stopReason: "end_turn" });
}

function handle(message) {
  if (message.id !== undefined && message.method === undefined) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (waiter === undefined) return;
    if (message.error) {
      const error = new Error(message.error.message ?? "client error");
      error.code = message.error.code;
      waiter.reject(error);
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  switch (message.method) {
    case "initialize":
      if (scenario === "auth-required") {
        fail(message.id, -32000, "Authentication required");
        return;
      }
      respond(message.id, {
        // A mismatch must make the relay refuse to talk to this agent at all.
        protocolVersion: scenario === "version-mismatch" ? 99 : 1,
        agentCapabilities: {},
        agentInfo: { name: "Fake ACP Agent", version: "1.2.3" },
      });
      return;
    case "session/new":
      respond(message.id, {
        sessionId,
        ...(scenario === "no-config" ? {} : { configOptions: CONFIG_OPTIONS }),
      });
      if (scenario === "exit-after-session") {
        process.stderr.write("fake agent could not start its model\n");
        process.exit(3);
      }
      return;
    case "session/prompt":
      void runPrompt(message.id);
      return;
    case "session/cancel":
      return;
    default:
      if (message.id !== undefined) fail(message.id, -32601, `Method not found: ${message.method}`);
      return;
  }
}

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line !== "") {
      try {
        handle(JSON.parse(line));
      } catch (error) {
        process.stderr.write(`fake agent could not handle a message: ${String(error)}\n`);
      }
    }
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
