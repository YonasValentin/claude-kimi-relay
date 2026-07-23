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

void test(
  "terminate with group:true reaps a detached child's descendants",
  { skip: process.platform === "win32" },
  async () => {
    // A group leader that ignores SIGTERM and spawns a grandchild that also
    // ignores SIGTERM. A plain child.kill leaves the grandchild orphaned; a
    // group signal must escalate to SIGKILL and reap both.
    const parentSource = [
      'const { spawn } = require("node:child_process");',
      "process.on('SIGTERM', () => {});",
      "const g = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
      "process.stdout.write(String(g.pid));",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    const parent = spawn(process.execPath, ["-e", parentSource], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parentPid = parent.pid;
    assert.ok(parentPid !== undefined);

    const grandchildPid = await new Promise<number>((resolve) => {
      parent.stdout.once("data", (chunk: Buffer) => resolve(Number.parseInt(chunk.toString(), 10)));
    });
    assert.ok(Number.isInteger(grandchildPid));

    await terminate(parent, { group: true });

    assert.equal(isAlive(parentPid), false, "parent survived");
    await waitForDead(grandchildPid);
    assert.equal(isAlive(grandchildPid), false, "grandchild survived group terminate");
  },
);

async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (isAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
