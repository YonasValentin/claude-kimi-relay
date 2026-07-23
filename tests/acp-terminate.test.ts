import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";

import { terminate } from "../src/acp-client.js";

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

void test("terminate escalates to SIGKILL when the agent ignores SIGTERM", async () => {
  // `kimi acp` ignores SIGTERM. A surviving child keeps the relay's event loop
  // alive, so the worker never exits and leaks its agent process.
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: "ignore" },
  );
  const pid = child.pid;
  assert.ok(pid !== undefined);
  await new Promise((resolve) => child.once("spawn", resolve));

  await terminate(child);

  assert.equal(isAlive(pid), false, "child survived terminate()");
});

void test("terminate returns without error when the agent already exited", async () => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((resolve) => child.once("exit", resolve));

  await terminate(child);

  assert.notEqual(child.exitCode, null);
});
