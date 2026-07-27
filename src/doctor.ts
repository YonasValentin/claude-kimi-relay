import { constants } from "node:fs";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { DoctorCheck, RelayConfig } from "./types.js";
import { runCommand, sanitizedAgentEnvironment } from "./process.js";

// Appended to the Kimi check so a red tick explains itself: the check now runs
// under the agent's restricted environment, so a variable Kimi needs but the
// allowlist drops shows up here instead of failing the first real task.
const RESTRICTED_ENV_NOTE =
  "(checked with the same restricted environment the relay gives the agent)";

// The package declares engines.node ">=22.14"; doctor must enforce the same
// floor, not just the major version, so a green tick never contradicts the
// stated minimum.
export function meetsNodeFloor(version: string): boolean {
  const parts = version.replace(/^v/u, "").split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isInteger(major)) return false;
  return major > 22 || (major === 22 && (Number.isInteger(minor) ? minor : 0) >= 14);
}

async function commandCheck(
  name: string,
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  try {
    const result = await runCommand(command, args, {
      allowFailure: true,
      timeoutMs: 20_000,
      ...(env === undefined ? {} : { env }),
    });
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
    ok: meetsNodeFloor(process.versions.node),
    detail: `${process.version} (requires Node.js 22.14 or newer)`,
  });
  // Git is a host diagnostic: it keeps the full environment on purpose, because
  // stripping GIT_* or a certificate path would report a broken Git on a machine
  // where Git works.
  checks.push(await commandCheck("Git", "git", ["--version"]));
  // Kimi is not a host diagnostic -- it is the agent. The only place the
  // environment is sanitized is the ACP spawn (see acp-client.ts), so checking
  // Kimi with the inherited environment could pass under variables the real
  // task never sees. Do not "simplify" this back to the unsanitized call.
  const kimi = await commandCheck(
    "Kimi Code",
    config.kimiCliPath,
    ["--version"],
    sanitizedAgentEnvironment(),
  );
  checks.push({ ...kimi, detail: `${kimi.detail} ${RESTRICTED_ENV_NOTE}` });
  checks.push(await stateDirectoryCheck(config));
  return checks;
}
