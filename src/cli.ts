#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { loadConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { RelayError } from "./errors.js";
import { TaskService } from "./task-service.js";
import type { TaskKind } from "./types.js";

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

function usage(): never {
  console.error(`claude-kimi-relay

Commands:
  doctor
  start --kind review|challenge|delegate --prompt "..." [--project .] [--background]
  status <task-id>
  result <task-id>
  list [--limit 20]
  cancel <task-id>
  apply <task-id> [--project .]
`);
  process.exit(2);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const service = new TaskService(config);
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "doctor": {
      const checks = await runDoctor(config);
      for (const check of checks)
        console.log(`${check.ok ? "✓" : "✗"} ${check.name}: ${check.detail}`);
      process.exitCode = checks.every((check) => check.ok) ? 0 : 1;
      return;
    }
    case "start": {
      const kind = flag(args, "--kind") as TaskKind | undefined;
      const prompt = flag(args, "--prompt");
      if (kind === undefined || prompt === undefined) usage();
      const timeoutFlag = flag(args, "--timeout-ms");
      const record = await service.start({
        kind,
        prompt,
        projectDir: flag(args, "--project") ?? process.cwd(),
        background: has(args, "--background"),
        baseRef: flag(args, "--base") ?? "HEAD",
        ...(timeoutFlag === undefined ? {} : { timeoutMs: Number.parseInt(timeoutFlag, 10) }),
        keepWorkspace: has(args, "--keep-workspace"),
      });
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    case "status": {
      const id = args[0];
      if (id === undefined) usage();
      console.log(JSON.stringify(await service.get(id), null, 2));
      return;
    }
    case "result": {
      const id = args[0];
      if (id === undefined) usage();
      const record = await service.get(id);
      console.log(record.result?.summary ?? record.error ?? `Task status: ${record.status}`);
      if (record.result?.patchPath) console.log(`\nPatch: ${record.result.patchPath}`);
      return;
    }
    case "list": {
      const limit = Number.parseInt(flag(args, "--limit") ?? "20", 10);
      console.log(JSON.stringify(await service.list(limit), null, 2));
      return;
    }
    case "cancel": {
      const id = args[0];
      if (id === undefined) usage();
      console.log(JSON.stringify(await service.cancel(id), null, 2));
      return;
    }
    case "apply": {
      const id = args[0];
      if (id === undefined) usage();
      const record = await service.get(id);
      const patchPath = record.result?.patchPath;
      if (patchPath === undefined) throw new RelayError("Task has no generated patch.", "NO_PATCH");
      const patch = await readFile(patchPath, "utf8");
      const { runCommand } = await import("./process.js");
      await runCommand("git", ["apply", "--check", "--binary", "-"], {
        cwd: flag(args, "--project") ?? process.cwd(),
        input: patch,
      });
      await runCommand("git", ["apply", "--binary", "-"], {
        cwd: flag(args, "--project") ?? process.cwd(),
        input: patch,
      });
      console.log(`Applied patch from task ${id}.`);
      return;
    }
    default:
      usage();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
