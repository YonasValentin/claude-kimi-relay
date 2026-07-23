import assert from "node:assert/strict";
import test from "node:test";

import { RelayError } from "../src/errors.js";
import { runCommand } from "../src/process.js";

void test("runCommand surfaces OUTPUT_LIMIT instead of collapsing it to COMMAND_ERROR", async () => {
  await assert.rejects(
    () =>
      runCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(1000))"], {
        maxOutputBytes: 10,
      }),
    (error: unknown) => error instanceof RelayError && error.code === "OUTPUT_LIMIT",
  );
});

void test("runCommand surfaces COMMAND_FAILED for a non-zero exit", async () => {
  await assert.rejects(
    () => runCommand(process.execPath, ["-e", "process.exit(3)"]),
    (error: unknown) => error instanceof RelayError && error.code === "COMMAND_FAILED",
  );
});
