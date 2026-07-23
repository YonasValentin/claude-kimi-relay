import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { RelayConfig } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_WORKSPACE_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 10 * 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  // Require a pure integer: parseInt would read "5MB" as 5 and "30min" as 30,
  // silently turning a generous limit into a near-zero one.
  if (!/^\d+$/u.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const dataDir = resolve(
    env.CLAUDE_KIMI_RELAY_DATA_DIR ??
      env.CLAUDE_PLUGIN_DATA ??
      join(homedir(), ".claude-kimi-relay"),
  );
  const kimiCliPath = env.KIMI_CLI_PATH?.trim();

  return {
    dataDir,
    ...(env.CLAUDE_PROJECT_DIR?.trim() ? { projectDir: resolve(env.CLAUDE_PROJECT_DIR) } : {}),
    kimiCliPath: kimiCliPath === undefined || kimiCliPath === "" ? "kimi" : kimiCliPath,
    defaultTimeoutMs: positiveInteger(env.CLAUDE_KIMI_RELAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    maxFileBytes: positiveInteger(env.CLAUDE_KIMI_RELAY_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES),
    maxWorkspaceBytes: positiveInteger(
      env.CLAUDE_KIMI_RELAY_MAX_WORKSPACE_BYTES,
      DEFAULT_MAX_WORKSPACE_BYTES,
    ),
    maxResultBytes: positiveInteger(
      env.CLAUDE_KIMI_RELAY_MAX_RESULT_BYTES,
      DEFAULT_MAX_RESULT_BYTES,
    ),
  };
}
