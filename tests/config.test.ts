import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig } from "../src/config.js";

void test("malformed numeric env values fall back to defaults instead of a truncated parse", () => {
  const config = loadConfig({
    CLAUDE_KIMI_RELAY_TIMEOUT_MS: "30min",
    CLAUDE_KIMI_RELAY_MAX_FILE_BYTES: "5MB",
  });
  assert.equal(config.defaultTimeoutMs, 30 * 60 * 1000);
  assert.equal(config.maxFileBytes, 5 * 1024 * 1024);
});

void test("pure-integer env values are honored", () => {
  const config = loadConfig({ CLAUDE_KIMI_RELAY_TIMEOUT_MS: "60000" });
  assert.equal(config.defaultTimeoutMs, 60000);
});
