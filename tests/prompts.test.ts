import assert from "node:assert/strict";
import test from "node:test";

import { buildPrompt } from "../src/prompts.js";

void test("review prompt keeps the diff hint when a base↔current diff exists", () => {
  const prompt = buildPrompt("review", "focus here", false);
  assert.match(prompt, /git diff HEAD\^ HEAD/u);
  assert.match(prompt, /when applicable/u);
});

void test("review prompt tells Kimi the snapshots are identical when the diff is empty", () => {
  const prompt = buildPrompt("review", "focus here", true);
  assert.doesNotMatch(prompt, /when applicable/u);
  assert.match(prompt, /identical/iu);
  // Must forbid new-vs-pre-existing attribution: that inference caused the
  // real-world mis-attribution this fix exists to prevent.
  assert.match(prompt, /pre-existing/iu);
});

void test("challenge prompt also drops the diff hint on an empty diff", () => {
  const prompt = buildPrompt("challenge", "focus here", true);
  assert.doesNotMatch(prompt, /when applicable/u);
  assert.match(prompt, /identical/iu);
});

void test("delegate prompt is unaffected by the empty-diff flag", () => {
  const empty = buildPrompt("delegate", "do it", true);
  const nonEmpty = buildPrompt("delegate", "do it", false);
  assert.equal(empty, nonEmpty);
  assert.match(empty, /smallest safe, production-quality patch/u);
});
