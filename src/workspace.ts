import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { RelayConfig, TaskKind } from "./types.js";
import { RelayError } from "./errors.js";
import { isContained, isSensitivePath } from "./fs-security.js";
import { runCommand } from "./process.js";

const COPY_EXCLUDES = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".expo",
  ".gradle",
  "Pods",
]);

export interface PreparedWorkspace {
  readonly path: string;
  readonly warnings: readonly string[];
  // True when the isolated base and current snapshots resolve to the same tree,
  // so `git diff HEAD^ HEAD` is empty. Only meaningful for git-backed reviews.
  readonly diffIsEmpty: boolean;
}

interface CopyResult {
  readonly warnings: readonly string[];
}

function assertSafeProjectPath(path: string): string {
  const absolute = resolve(path);
  if (absolute === resolve(absolute, "..")) {
    throw new RelayError(
      "Refusing to use a filesystem root as project directory.",
      "UNSAFE_PROJECT_DIR",
    );
  }
  return absolute;
}

function assertSafeRelativePath(path: string): void {
  if (path === "" || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    throw new RelayError(`Git returned an unsafe path: ${path}`, "UNSAFE_GIT_PATH");
  }
}

export class WorkspaceManager {
  public constructor(private readonly config: RelayConfig) {}

  public async prepare(
    taskId: string,
    projectDirInput: string,
    kind: TaskKind,
    baseRef: string,
  ): Promise<PreparedWorkspace> {
    const projectDir = assertSafeProjectPath(projectDirInput);
    const projectInfo = await stat(projectDir).catch(() => undefined);
    if (!projectInfo?.isDirectory()) {
      throw new RelayError("Project directory does not exist.", "PROJECT_NOT_FOUND");
    }

    const workspacesRoot = join(this.config.dataDir, "workspaces");
    const destination = join(workspacesRoot, taskId);
    await mkdir(workspacesRoot, { recursive: true, mode: 0o700 });
    await rm(destination, { recursive: true, force: true });

    const gitProbe = await runCommand("git", ["rev-parse", "--show-toplevel"], {
      cwd: projectDir,
      allowFailure: true,
      timeoutMs: 15_000,
    });

    if (gitProbe.exitCode === 0) {
      return this.prepareGitWorkspace(projectDir, destination, kind, baseRef);
    }

    const snapshot = await this.copyDirectorySnapshot(projectDir, destination);
    return {
      path: destination,
      warnings: [
        "Project is not a Git repository; patch generation is unavailable.",
        ...snapshot.warnings,
      ],
      diffIsEmpty: false,
    };
  }

  private async prepareGitWorkspace(
    projectDir: string,
    destination: string,
    kind: TaskKind,
    baseRef: string,
  ): Promise<PreparedWorkspace> {
    const repositoryRoot = (
      await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd: projectDir })
    ).stdout.trim();
    const stagingRoot = await mkdtemp(join(this.config.dataDir, "relay-base-"));
    const warnings: string[] = [];
    const resolvedBaseRef = await this.resolveBaseRef(repositoryRoot, kind, baseRef, warnings);

    try {
      await runCommand(
        "git",
        ["clone", "--local", "--no-hardlinks", "--no-tags", repositoryRoot, stagingRoot],
        { timeoutMs: 5 * 60_000 },
      );
      await runCommand("git", ["checkout", "--detach", resolvedBaseRef], {
        cwd: stagingRoot,
        timeoutMs: 60_000,
      });

      await mkdir(destination, { recursive: true, mode: 0o700 });
      await runCommand("git", ["init"], { cwd: destination });
      await this.configureIdentity(destination);

      const baseCopy = await this.copyGitWorkingSet(stagingRoot, destination, false);
      warnings.push(...baseCopy.warnings.map((warning) => `Base snapshot: ${warning}`));
      await this.commitSnapshot(destination, "relay: filtered base snapshot");

      await this.clearWorkingTree(destination);
      const currentCopy = await this.copyGitWorkingSet(repositoryRoot, destination, true);
      warnings.push(...currentCopy.warnings.map((warning) => `Current snapshot: ${warning}`));
      await this.commitSnapshot(destination, "relay: isolated task baseline");
    } finally {
      await rm(stagingRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    }

    // Both snapshots are always committed (--allow-empty), so HEAD^ exists.
    // Exit 0 means the trees match: baseRef resolved to the current state and
    // there is nothing to compare.
    const diffProbe = await runCommand("git", ["diff", "--quiet", "HEAD^", "HEAD"], {
      cwd: destination,
      allowFailure: true,
      timeoutMs: 60_000,
    });
    const diffIsEmpty = diffProbe.exitCode === 0;

    if (kind === "delegate") {
      warnings.push(
        "Delegate runs in a new isolated repository containing only filtered base and current snapshots. Only later Kimi changes are returned as a patch.",
      );
    } else if (diffIsEmpty) {
      warnings.push(
        "baseRef resolved to the same tree as the current snapshot — there are NO changes to review. Pass an explicit baseRef (a merge-base or the PR target branch) to review actual changes; this run inspects the full current tree only.",
      );
    } else {
      warnings.push(
        "Review runs in a new isolated repository containing only filtered base and current snapshots. Inspect the comparison with git diff HEAD^ HEAD.",
      );
    }

    return { path: destination, warnings, diffIsEmpty };
  }

  // An empty baseRef is the "auto" sentinel. For review/challenge, resolve it to
  // the merge-base with the branch's upstream so "review my work" compares real
  // changes instead of an empty HEAD..HEAD; fall back to HEAD (the empty-diff
  // warning then fires) when no upstream is configured. Delegate always diffs
  // against the current tree, and an explicit ref (including "HEAD") is verbatim.
  private async resolveBaseRef(
    repositoryRoot: string,
    kind: TaskKind,
    requested: string,
    warnings: string[],
  ): Promise<string> {
    if (requested !== "") return requested;
    if (kind === "delegate") return "HEAD";

    const mergeBase = await runCommand("git", ["merge-base", "HEAD", "@{upstream}"], {
      cwd: repositoryRoot,
      allowFailure: true,
      timeoutMs: 15_000,
    });
    const base = mergeBase.exitCode === 0 ? mergeBase.stdout.trim() : "";
    if (base === "") return "HEAD";

    const upstream = await runCommand(
      "git",
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { cwd: repositoryRoot, allowFailure: true, timeoutMs: 15_000 },
    );
    const label =
      upstream.exitCode === 0 && upstream.stdout.trim()
        ? upstream.stdout.trim()
        : "the upstream branch";
    warnings.push(
      `No baseRef was given; auto-selected the merge-base with ${label} (${base.slice(0, 12)}) as the review base. Pass an explicit baseRef to override.`,
    );
    return base;
  }

  private async configureIdentity(destination: string): Promise<void> {
    await runCommand("git", ["config", "user.name", "Claude Kimi Relay"], { cwd: destination });
    await runCommand("git", ["config", "user.email", "relay@localhost.invalid"], {
      cwd: destination,
    });
  }

  private async commitSnapshot(destination: string, message: string): Promise<void> {
    await runCommand("git", ["add", "-A", "--", "."], { cwd: destination });
    await runCommand("git", ["commit", "--allow-empty", "-m", message], {
      cwd: destination,
      timeoutMs: 60_000,
    });
  }

  private async clearWorkingTree(destination: string): Promise<void> {
    for (const entry of await readdir(destination, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      await rm(join(destination, entry.name), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }

  private async copyGitWorkingSet(
    sourceRoot: string,
    destinationRoot: string,
    includeUntracked: boolean,
  ): Promise<CopyResult> {
    const args = includeUntracked
      ? ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]
      : ["ls-files", "--cached", "-z"];
    const result = await runCommand("git", args, {
      cwd: sourceRoot,
      timeoutMs: 60_000,
      maxOutputBytes: 50 * 1024 * 1024,
    });
    const paths = [...new Set(result.stdout.split("\0").filter(Boolean))].sort();
    const warnings: string[] = [];
    let total = 0;

    for (const rel of paths) {
      assertSafeRelativePath(rel);
      if (isSensitivePath(rel)) {
        warnings.push(`excluded sensitive path ${rel}`);
        continue;
      }
      if (rel.split(/[\\/]/u).some((part) => COPY_EXCLUDES.has(part))) continue;

      const source = join(sourceRoot, rel);
      const target = join(destinationRoot, rel);
      const info = await lstat(source).catch(() => undefined);
      if (info === undefined) continue;

      if (info.isSymbolicLink()) {
        const copied = await this.copySafeSymlink(sourceRoot, source, target);
        if (!copied) warnings.push(`excluded unsafe or unsupported symbolic link ${rel}`);
        continue;
      }
      if (info.isDirectory()) {
        warnings.push(`excluded Git submodule or directory entry ${rel}`);
        continue;
      }
      if (!info.isFile()) {
        warnings.push(`excluded non-regular file ${rel}`);
        continue;
      }
      if (info.size > this.config.maxFileBytes) {
        warnings.push(`excluded oversized file ${rel}`);
        continue;
      }

      total += info.size;
      if (total > this.config.maxWorkspaceBytes) {
        throw new RelayError("Workspace exceeds its configured copy limit.", "WORKSPACE_TOO_LARGE");
      }
      await mkdir(dirname(target), { recursive: true });
      await cp(source, target, { preserveTimestamps: true });
    }

    return { warnings };
  }

  private async copySafeSymlink(
    sourceRoot: string,
    source: string,
    target: string,
  ): Promise<boolean> {
    try {
      const canonicalRoot = await realpath(sourceRoot);
      const canonicalTarget = await realpath(source);
      if (!isContained(canonicalRoot, canonicalTarget)) return false;
      if (isSensitivePath(relative(canonicalRoot, canonicalTarget))) return false;
      // Recreate the link as a workspace-relative path to the canonical target
      // instead of copying its raw value. A raw absolute link (or one whose
      // relative value resolves differently at the new depth) would point back
      // into the original project tree; a relative link stays inside the copy.
      // Computed in root-relative space so the link and target keep the same
      // layout in the destination (and so a symlinked temp root like /var on
      // macOS does not turn into a spurious escaping path).
      const relSource = relative(sourceRoot, source);
      const relTarget = relative(canonicalRoot, canonicalTarget);
      const linkTarget = relative(dirname(relSource), relTarget) || ".";
      await mkdir(dirname(target), { recursive: true });
      await symlink(linkTarget, target);
      return true;
    } catch {
      return false;
    }
  }

  private async copyDirectorySnapshot(
    sourceRoot: string,
    destinationRoot: string,
  ): Promise<CopyResult> {
    let total = 0;
    const warnings: string[] = [];
    const walk = async (sourceDir: string): Promise<void> => {
      const entries = await readdir(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (COPY_EXCLUDES.has(entry.name)) continue;
        const source = join(sourceDir, entry.name);
        const rel = relative(sourceRoot, source);
        if (rel.startsWith(`..${sep}`) || isSensitivePath(rel)) {
          if (isSensitivePath(rel)) warnings.push(`excluded sensitive path ${rel}`);
          continue;
        }
        const target = join(destinationRoot, rel);
        if (entry.isSymbolicLink()) {
          const copied = await this.copySafeSymlink(sourceRoot, source, target);
          if (!copied) warnings.push(`excluded unsafe or unsupported symbolic link ${rel}`);
          continue;
        }
        if (entry.isDirectory()) {
          await mkdir(target, { recursive: true });
          await walk(source);
          continue;
        }
        if (!entry.isFile()) continue;
        const info = await stat(source);
        if (info.size > this.config.maxFileBytes) {
          warnings.push(`excluded oversized file ${rel}`);
          continue;
        }
        total += info.size;
        if (total > this.config.maxWorkspaceBytes) {
          throw new RelayError(
            "Workspace exceeds its configured copy limit.",
            "WORKSPACE_TOO_LARGE",
          );
        }
        await mkdir(dirname(target), { recursive: true });
        await cp(source, target, { preserveTimestamps: true });
      }
    };

    await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    await walk(sourceRoot);
    return { warnings };
  }

  public async createPatch(taskId: string, workspaceDir: string): Promise<string | undefined> {
    const probe = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workspaceDir,
      allowFailure: true,
    });
    if (probe.exitCode !== 0) return undefined;

    await runCommand("git", ["add", "-N", "--", "."], {
      cwd: workspaceDir,
      allowFailure: true,
    });
    const diff = await runCommand("git", ["diff", "--binary", "HEAD", "--", "."], {
      cwd: workspaceDir,
      timeoutMs: 60_000,
      maxOutputBytes: 100 * 1024 * 1024,
    });
    if (diff.stdout.trim() === "") return undefined;

    const artifactDir = join(this.config.dataDir, "artifacts", taskId);
    await mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const patchPath = join(artifactDir, "changes.patch");
    await writeFile(patchPath, diff.stdout, { encoding: "utf8", mode: 0o600 });
    return patchPath;
  }

  public async cleanup(workspaceDir: string): Promise<void> {
    const root = resolve(join(this.config.dataDir, "workspaces"));
    const target = resolve(workspaceDir);
    if (!target.startsWith(`${root}${sep}`)) {
      throw new RelayError(
        "Refusing to remove a directory outside the workspace root.",
        "UNSAFE_CLEANUP",
      );
    }
    await rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
}
