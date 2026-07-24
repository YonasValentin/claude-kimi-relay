import assert from "node:assert/strict";
import test from "node:test";

import { capEvents, MAX_EVENTS } from "../src/runner.js";
import type { TaskEvent } from "../src/types.js";

void test("capEvents keeps the most recent events and a truncation marker when over the cap", () => {
  const many: TaskEvent[] = Array.from({ length: MAX_EVENTS + 50 }, (_, i) => ({
    at: `t${i}`,
    status: "running",
    message: `m${i}`,
  }));
  const capped = capEvents(many);
  assert.ok(capped.length <= MAX_EVENTS, `expected <= ${MAX_EVENTS}, got ${capped.length}`);
  assert.match(capped[0]?.message ?? "", /truncated/u);
  assert.equal(capped[capped.length - 1]?.message, `m${MAX_EVENTS + 49}`);
});

void test("capEvents leaves a short list untouched", () => {
  const few: TaskEvent[] = [{ at: "t0", status: "queued", message: "q" }];
  assert.deepEqual(capEvents(few), few);
});
