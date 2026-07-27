import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { meetsNodeFloor, runDoctor } from "../src/doctor.js";
import type { RelayConfig } from "../src/types.js";

const config = (dataDir: string, kimiCliPath: string): RelayConfig => ({
  dataDir,
  kimiCliPath,
  defaultTimeoutMs: 60_000,
  maxFileBytes: 1024,
  maxWorkspaceBytes: 1_048_576,
  maxResultBytes: 4096,
});

void test("meetsNodeFloor enforces the full 22.14 floor, not just the major version", () => {
  assert.equal(meetsNodeFloor("v22.16.0"), true);
  assert.equal(meetsNodeFloor("22.14.0"), true);
  assert.equal(meetsNodeFloor("v23.0.0"), true);
  assert.equal(meetsNodeFloor("v22.13.9"), false);
  assert.equal(meetsNodeFloor("v22.0.0"), false);
  assert.equal(meetsNodeFloor("v21.99.99"), false);
});

void test("the Kimi check says which environment it used, so a red tick explains itself", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "relay-doctor-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const checks = await runDoctor(config(dir, process.execPath));
  const kimi = checks.find((check) => check.name === "Kimi Code");

  assert.ok(kimi);
  assert.equal(kimi.ok, true);
  assert.match(kimi.detail, /restricted environment/u);
});

void test(
  "the Kimi check runs under the sanitized agent environment, not the relay's own",
  { skip: process.platform === "win32" },
  async (t) => {
    // Before this, doctor spawned `kimi --version` with no env at all, so the
    // child inherited the relay's whole environment while the real ACP spawn
    // got the allowlist. A green doctor could therefore reflect a variable the
    // task never sees.
    const dir = await mkdtemp(join(tmpdir(), "relay-doctor-env-"));
    const probe = join(dir, "kimi-probe.mjs");
    await writeFile(
      probe,
      [
        "#!/usr/bin/env node",
        'const seen = Object.keys(process.env).filter((key) => key.endsWith("_DOCTOR_PROBE"));',
        'process.stdout.write(seen.sort().join(",") || "none");',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await chmod(probe, 0o755);

    process.env.KIMI_DOCTOR_PROBE = "allowlisted";
    process.env.SECRET_DOCTOR_PROBE = "not-allowlisted";
    t.after(() => {
      delete process.env.KIMI_DOCTOR_PROBE;
      delete process.env.SECRET_DOCTOR_PROBE;
      return rm(dir, { recursive: true, force: true });
    });

    const checks = await runDoctor(config(dir, probe));
    const kimi = checks.find((check) => check.name === "Kimi Code");

    assert.ok(kimi);
    assert.match(kimi.detail, /KIMI_DOCTOR_PROBE/u);
    assert.doesNotMatch(kimi.detail, /SECRET_DOCTOR_PROBE/u);
  },
);
