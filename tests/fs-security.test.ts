import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveInsideRoot } from "../src/fs-security.js";

void test("resolveInsideRoot rejects lexical traversal", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relay-root-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => resolveInsideRoot(root, "../secret"), /escapes/iu);
});

void test("resolveInsideRoot rejects a symlink escape", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-root-")));
  const outside = await mkdtemp(join(tmpdir(), "relay-outside-"));
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]),
  );
  await writeFile(join(outside, "secret.txt"), "secret");
  await mkdir(join(root, "inside"));
  await symlink(outside, join(root, "inside", "link"));
  await assert.rejects(
    () => resolveInsideRoot(root, join(root, "inside", "link", "secret.txt")),
    /Symlink/iu,
  );
});

void test("resolveInsideRoot supports a new nested file inside the workspace", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-root-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(
    await resolveInsideRoot(root, "new/deep/file.ts"),
    join(root, "new", "deep", "file.ts"),
  );
});

void test("resolveInsideRoot blocks secret paths but permits templates", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-root-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(() => resolveInsideRoot(root, ".env.local"), /credential|secret/iu);
  assert.equal(await resolveInsideRoot(root, ".env.example"), join(root, ".env.example"));
});

void test("resolveInsideRoot blocks token and state files that are not dotenv files", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-root-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    ".npmrc",
    ".netrc",
    ".envrc",
    ".git-credentials",
    ".docker/config.json",
    "deploy/secrets.yaml",
    "infra/terraform.tfstate",
  ]) {
    await assert.rejects(() => resolveInsideRoot(root, path), /credential|secret/iu, path);
  }
  assert.equal(
    await resolveInsideRoot(root, "src/secretsmith.ts"),
    join(root, "src/secretsmith.ts"),
  );
});

void test("resolveInsideRoot accepts absolute paths when the root sits behind a symlink", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relay-root-")));
  const linkRoot = join(tmpdir(), `relay-link-${process.pid}-${Date.now()}`);
  t.after(() =>
    Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(linkRoot, { recursive: true, force: true }),
    ]),
  );
  await symlink(root, linkRoot);
  await writeFile(join(root, "file.txt"), "content");
  assert.equal(
    await resolveInsideRoot(linkRoot, join(linkRoot, "file.txt")),
    join(root, "file.txt"),
  );
});
