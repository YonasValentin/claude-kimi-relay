import { spawn } from "node:child_process";

import { RelayError, toErrorMessage } from "./errors.js";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface RunCommandOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string | Buffer;
  readonly timeoutMs?: number;
  readonly allowFailure?: boolean;
  readonly maxOutputBytes?: number;
}

export async function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const controller = new AbortController();
  const timeout = options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : undefined;

  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        signal: controller.signal,
        windowsHide: true,
      });

      const chunksOut: Buffer[] = [];
      const chunksErr: Buffer[] = [];
      let bytes = 0;
      const maxOutputBytes = options.maxOutputBytes ?? 20 * 1024 * 1024;

      const append = (target: Buffer[], chunk: Buffer): void => {
        bytes += chunk.byteLength;
        if (bytes > maxOutputBytes) {
          child.kill("SIGTERM");
          reject(new RelayError("Command output exceeded its safety limit.", "OUTPUT_LIMIT"));
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => append(chunksOut, chunk));
      child.stderr.on("data", (chunk: Buffer) => append(chunksErr, chunk));
      child.once("error", (error) => reject(error));
      child.once("close", (code) => {
        const result: CommandResult = {
          stdout: Buffer.concat(chunksOut).toString("utf8"),
          stderr: Buffer.concat(chunksErr).toString("utf8"),
          exitCode: code ?? 1,
        };
        if (result.exitCode !== 0 && options.allowFailure !== true) {
          reject(
            new RelayError(
              `${command} exited with code ${result.exitCode}: ${result.stderr.trim()}`,
              "COMMAND_FAILED",
            ),
          );
          return;
        }
        resolve(result);
      });

      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new RelayError(`${command} timed out.`, "COMMAND_TIMEOUT", { cause: error });
    }
    throw new RelayError(toErrorMessage(error), "COMMAND_ERROR", { cause: error });
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function sanitizedAgentEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowedPrefixes = ["KIMI_", "MOONSHOT_", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const allowedNames = new Set([
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SHELL",
    "COMSPEC",
    "SYSTEMROOT",
    "LANG",
    "LC_ALL",
    "TERM",
  ]);

  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => {
      if (value === undefined) return false;
      return allowedNames.has(key) || allowedPrefixes.some((prefix) => key.startsWith(prefix));
    }),
  );
}
