import assert from "node:assert/strict";
import test from "node:test";

import { sanitizedAgentEnvironment } from "../src/process.js";

void test("proxy credentials are stripped before the environment reaches the agent", () => {
  const env = sanitizedAgentEnvironment({
    HTTPS_PROXY: "http://alice:s3cr3t@corp-proxy:8080",
    HTTP_PROXY: "http://proxy:3128",
    NO_PROXY: "localhost",
    KIMI_API_KEY: "keep-me",
    AWS_SECRET_ACCESS_KEY: "drop-me",
  });

  assert.equal(env.HTTPS_PROXY, "http://corp-proxy:8080/");
  assert.doesNotMatch(env.HTTPS_PROXY, /alice|s3cr3t/u);
  assert.equal(env.HTTP_PROXY, "http://proxy:3128"); // no credentials -> left untouched
  assert.equal(env.NO_PROXY, "localhost");
  assert.equal(env.KIMI_API_KEY, "keep-me");
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined); // not on the allowlist
});
