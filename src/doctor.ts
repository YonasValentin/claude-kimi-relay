import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DoctorCheck, RelayConfig } from "./types.js";
import { runCommand } from "./process.js";

async function commandCheck(
  name: string,
  command: string,
  args: readonly string[],
): Promise<DoctorCheck> {
  try {
    const result = await runCommand(command, args, { allowFailure: true, timeoutMs: 20_000 });
    return {
      name,
      ok: result.exitCode === 0,
      detail: (result.stdout || result.stderr).trim() || `exit ${result.exitCode}`,
    };
  } catch (error) {
    return { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function stateDirectoryCheck(config: RelayConfig): Promise<DoctorCheck> {
  const probe = join(config.dataDir, `.write-probe-${process.pid}`);
  try {
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await access(config.dataDir, constants.F_OK | constants.W_OK);
    await writeFile(probe, "ok\n", { flag: "wx", mode: 0o600 });
    await rm(probe, { force: true });
    return { name: "State directory", ok: true, detail: config.dataDir };
  } catch (error) {
    await rm(probe, { force: true }).catch(() => undefined);
    return {
      name: "State directory",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runDoctor(config: RelayConfig): Promise<readonly DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "Node.js",
    ok: Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10) >= 22,
    detail: `${process.version} (requires Node.js 22.14 or newer)`,
  });
  checks.push(await commandCheck("Git", "git", ["--version"]));
  checks.push(await commandCheck("Kimi Code", config.kimiCliPath, ["--version"]));
  checks.push(await stateDirectoryCheck(config));
  return checks;
}
