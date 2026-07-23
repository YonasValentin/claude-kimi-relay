import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import test from "node:test";

import { runCommand } from "../src/process.js";
import { WorkspaceManager } from "../src/workspace.js";
import type { RelayConfig } from "../src/types.js";

const config = (dataDir: string): RelayConfig => ({
  dataDir,
  kimiCliPath: "kimi",
  defaultTimeoutMs: 60_000,
  maxFileBytes: 1024 * 1024,
  maxWorkspaceBytes: 10 * 1024 * 1024,
  maxResultBytes: 1024 * 1024,
});

void test("delegate patch contains only changes made after the isolated baseline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-repo-"));
  const dataDir = await mkdtemp(join(tmpdir(), "relay-data-"));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]),
  );

  await runCommand("git", ["init"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: root });
  await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(join(root, "app.txt"), "committed\n");
  await runCommand("git", ["add", "app.txt"], { cwd: root });
  await runCommand("git", ["commit", "-m", "initial"], { cwd: root });

  await writeFile(join(root, "app.txt"), "user change\n");
  await writeFile(join(root, "untracked.txt"), "user untracked\n");

  const manager = new WorkspaceManager(config(dataDir));
  const prepared = await manager.prepare("task-1", root, "delegate", "HEAD");
  assert.equal(await readFile(join(prepared.path, "app.txt"), "utf8"), "user change\n");
  assert.equal(await readFile(join(prepared.path, "untracked.txt"), "utf8"), "user untracked\n");

  await writeFile(join(prepared.path, "app.txt"), "kimi change\n");
  await writeFile(join(prepared.path, "created-by-kimi.txt"), "new\n");
  const patchPath = await manager.createPatch("task-1", prepared.path);
  assert.ok(patchPath);
  const patch = await readFile(patchPath, "utf8");
  assert.match(patch, /kimi change/u);
  assert.match(patch, /created-by-kimi\.txt/u);
  assert.doesNotMatch(patch, /user untracked/u);
  assert.doesNotMatch(patch, /^\+user change$/mu);
});

void test("isolated workspace excludes sensitive files and original Git history", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-history-repo-"));
  const dataDir = await mkdtemp(join(tmpdir(), "relay-history-data-"));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]),
  );

  await runCommand("git", ["init"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: root });
  await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await writeFile(join(root, "old-secret.txt"), "historical secret\n");
  await writeFile(join(root, "app.txt"), "v1\n");
  await runCommand("git", ["add", "-A"], { cwd: root });
  await runCommand("git", ["commit", "-m", "contains historical secret"], { cwd: root });

  await rm(join(root, "old-secret.txt"));
  await writeFile(join(root, ".env"), "API_KEY=do-not-copy\n");
  await writeFile(join(root, "app.txt"), "v2\n");
  await runCommand("git", ["add", "-A"], { cwd: root });
  await runCommand("git", ["commit", "-m", "current"], { cwd: root });

  const manager = new WorkspaceManager(config(dataDir));
  const prepared = await manager.prepare("task-history", root, "review", "HEAD");

  await assert.rejects(() => readFile(join(prepared.path, ".env"), "utf8"));
  await assert.rejects(() => readFile(join(prepared.path, "old-secret.txt"), "utf8"));

  const log = await runCommand("git", ["log", "--format=%s"], { cwd: prepared.path });
  assert.deepEqual(log.stdout.trim().split("\n"), [
    "relay: isolated task baseline",
    "relay: filtered base snapshot",
  ]);

  const objects = await runCommand("git", ["rev-list", "--objects", "--all"], {
    cwd: prepared.path,
  });
  assert.doesNotMatch(objects.stdout, /old-secret\.txt|(?:^|\s)\.env(?:\s|$)/mu);
  assert.ok(prepared.warnings.some((warning) => warning.includes("excluded sensitive path .env")));
});

void test("an absolute in-repo symlink is rewritten to stay inside the workspace", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-link-repo-")));
  const dataDir = await mkdtemp(join(tmpdir(), "relay-link-data-"));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]),
  );

  await runCommand("git", ["init"], { cwd: root });
  await runCommand("git", ["config", "user.name", "Test"], { cwd: root });
  await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await mkdir(join(root, "data"));
  await writeFile(join(root, "data", "real.txt"), "hello\n");
  // Absolute symlink pointing back into the original checkout.
  await symlink(join(root, "data", "real.txt"), join(root, "link.txt"));
  await runCommand("git", ["add", "-A"], { cwd: root });
  await runCommand("git", ["commit", "-m", "with symlink"], { cwd: root });

  const manager = new WorkspaceManager(config(dataDir));
  const prepared = await manager.prepare("task-link", root, "review", "HEAD");

  const copied = join(prepared.path, "link.txt");
  const linkValue = await readlink(copied);
  assert.ok(!isAbsolute(linkValue), `link should be relative, got ${linkValue}`);
  assert.ok(!linkValue.includes(root), "link must not reference the original project path");

  // It must resolve to the copied file inside the workspace, not the original.
  const resolved = await realpath(copied);
  assert.ok(resolved.startsWith(`${await realpath(prepared.path)}${sep}`));
  assert.equal(await readFile(copied, "utf8"), "hello\n");
});
