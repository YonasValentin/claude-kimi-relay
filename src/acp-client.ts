import * as acp from "@agentclientprotocol/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

import type {
  AgentConfigReport,
  AgentConfigRequestOutcome,
  AgentRunRequest,
  AgentRunResult,
  PermissionRequestLike,
  RelayConfig,
} from "./types.js";
import { RelayError, toErrorMessage } from "./errors.js";
import { assertRegularFile, resolveInsideRoot } from "./fs-security.js";
import { PermissionPolicy } from "./policy.js";
import { sanitizedAgentEnvironment } from "./process.js";
import {
  ConfigTracker,
  EFFORT_TARGET,
  MODEL_TARGET,
  applyConfigRequests,
  setRequestBody,
  summarizeConfigOptions,
  toConfigSnapshot,
  type ConfigRequest,
} from "./session-config.js";
import { VERSION } from "./version.js";

export type AgentProgressSink = (message: string) => Promise<void> | void;

function extractText(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const record = update as Record<string, unknown>;
  if (record.sessionUpdate !== "agent_message_chunk") return undefined;
  const content = record.content;
  if (typeof content !== "object" || content === null) return undefined;
  const contentRecord = content as Record<string, unknown>;
  return contentRecord.type === "text" && typeof contentRecord.text === "string"
    ? contentRecord.text
    : undefined;
}

function extractProgress(update: unknown): string | undefined {
  if (typeof update !== "object" || update === null) return undefined;
  const record = update as Record<string, unknown>;
  if (record.sessionUpdate === "tool_call" && typeof record.title === "string") {
    return `Kimi tool: ${record.title}`;
  }
  if (record.sessionUpdate === "plan") return "Kimi updated its plan.";
  return undefined;
}

// Variables the agent's own documentation says override which model answers,
// how hard it reasons, which endpoint receives the request, or where its
// configuration and credentials live. Only their names are ever reported --
// their presence explains a session that ignored what was asked of it, while
// their values include credentials.
function environmentOverrides(env: NodeJS.ProcessEnv): readonly string[] {
  return Object.keys(env)
    .filter((key) => key.startsWith("KIMI_MODEL_") || key === "KIMI_CODE_HOME")
    .sort();
}

function readAgentInfo(
  info: unknown,
): { readonly name: string; readonly version: string } | undefined {
  if (typeof info !== "object" || info === null) return undefined;
  const record = info as Record<string, unknown>;
  if (typeof record.name !== "string") return undefined;
  return { name: record.name, version: typeof record.version === "string" ? record.version : "" };
}

const TERMINATE_GRACE_MS = 2000;

// Signal the child, or its whole process group when `group` is set and the
// child was spawned detached (its own group leader). A group signal reaches
// helpers Kimi spawned — language servers, watchers — that would otherwise be
// reparented to init and leak; a plain kill hits only the direct child.
function signalChild(child: ChildProcess, signal: NodeJS.Signals, group: boolean): void {
  if (group && process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Group gone or never a leader; fall back to the direct child handle.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Child already exited.
  }
}

// `kimi acp` does not exit on SIGTERM. A live child handle keeps the relay's
// event loop alive, so without escalating to SIGKILL every finished task
// leaves its worker and its Kimi process running forever.
export async function terminate(
  child: ChildProcess,
  options: { readonly group?: boolean } = {},
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const group = options.group ?? false;
  const exited = once(child, "exit").then(() => true);
  signalChild(child, "SIGTERM", group);
  if (await Promise.race([exited, delay(TERMINATE_GRACE_MS, false, { ref: false })])) return;
  signalChild(child, "SIGKILL", group);
  await Promise.race([exited, delay(TERMINATE_GRACE_MS, false, { ref: false })]);
}

export class KimiAcpClient {
  private readonly policy = new PermissionPolicy();

  public constructor(private readonly config: RelayConfig) {}

  public async run(
    request: AgentRunRequest,
    onProgress: AgentProgressSink = () => undefined,
    externalSignal?: AbortSignal,
  ): Promise<AgentRunResult> {
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);

    const agentEnv = sanitizedAgentEnvironment();
    const child = spawn(this.config.kimiCliPath, [...(this.config.kimiCliArgs ?? ["acp"])], {
      cwd: request.workspaceDir,
      env: agentEnv,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal: controller.signal,
      // Own process group (POSIX) so termination can signal Kimi and every
      // helper it spawns, not just the direct child. Not unref'd — the relay
      // still awaits the protocol and reaps the group in the finally below.
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= 2 * 1024 * 1024) return;
      stderrBytes += chunk.byteLength;
      stderr.push(chunk);
    });

    const output = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);
    const chunks: string[] = [];
    const configWarnings: string[] = [];
    const configOutcomes: AgentConfigRequestOutcome[] = [];
    let resultBytes = 0;
    const mode = request.kind === "delegate" ? "delegate" : "review";

    let protocolFinished = false;
    const childFailure = new Promise<never>((_resolve, reject) => {
      child.once("error", (error) => {
        reject(
          new RelayError(
            `Could not start Kimi Code: ${toErrorMessage(error)}`,
            "KIMI_START_FAILED",
            { cause: error },
          ),
        );
      });
      child.once("exit", (code, signal) => {
        if (protocolFinished || controller.signal.aborted) return;
        // An agent that dies on startup explains itself on stderr and nowhere
        // else. Dropping that left the user with an exit code and no reason.
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new RelayError(
            `Kimi Code exited before ACP completed (${signal ?? `exit ${code ?? "unknown"}`}).${
              diagnostic ? `\n${diagnostic}` : ""
            }`,
            "KIMI_EXITED",
          ),
        );
      });
    });

    try {
      const protocolResult = acp
        .client({ name: "claude-kimi-relay" })
        .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
          const decision = this.policy.decide(ctx.params as PermissionRequestLike, {
            mode,
            workspaceDir: request.workspaceDir,
          });
          return { outcome: decision };
        })
        .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
          const params = ctx.params as {
            path: string;
            line?: number | null;
            limit?: number | null;
          };
          const path = await resolveInsideRoot(request.workspaceDir, params.path);
          await assertRegularFile(path, this.config.maxFileBytes);
          const text = await readFile(path, "utf8");
          const lines = text.split("\n");
          const line = Math.max(1, params.line ?? 1);
          const limit = Math.max(1, Math.min(params.limit ?? lines.length, 20_000));
          return { content: lines.slice(line - 1, line - 1 + limit).join("\n") };
        })
        .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
          if (mode !== "delegate") {
            throw new RelayError("File writes are disabled for review tasks.", "WRITE_DENIED");
          }
          const params = ctx.params as { path: string; content: string };
          const path = await resolveInsideRoot(request.workspaceDir, params.path);
          if (Buffer.byteLength(params.content, "utf8") > this.config.maxFileBytes) {
            throw new RelayError("Write exceeds the per-file safety limit.", "WRITE_TOO_LARGE");
          }
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, params.content, { encoding: "utf8", mode: 0o600 });
          return {};
        })
        .connectWith(stream, async (ctx) => {
          let initializeResponse;
          try {
            initializeResponse = await ctx.request(acp.methods.agent.initialize, {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {
                fs: {
                  readTextFile: true,
                  writeTextFile: mode === "delegate",
                },
              },
              clientInfo: { name: "claude-kimi-relay", version: VERSION },
            });
          } catch (error) {
            if (error instanceof acp.RequestError && error.code === -32000) {
              throw new RelayError(
                "Kimi Code is not authenticated. Run `kimi` interactively to sign in, then retry.",
                "KIMI_AUTH_REQUIRED",
                { cause: error },
              );
            }
            throw error;
          }
          if (initializeResponse.protocolVersion !== acp.PROTOCOL_VERSION) {
            throw new RelayError(
              `Kimi Code negotiated ACP protocol version ${initializeResponse.protocolVersion}, which this relay (built for version ${acp.PROTOCOL_VERSION}) does not support. Align the Kimi Code and claude-kimi-relay versions.`,
              "ACP_VERSION_MISMATCH",
            );
          }

          const agent = readAgentInfo(initializeResponse.agentInfo);

          return ctx.buildSession(request.workspaceDir).withSession(async (session) => {
            // The agent reports its model, reasoning level and mode here, before
            // the prompt is even sent. Reading it is the whole reason a result
            // can say what produced it.
            //
            // The model request must come first: setting it can rewrite the
            // reasoning scale, or remove it entirely for a model that cannot
            // reason, so the effort has to resolve against whatever comes back.
            const configRequests: ConfigRequest[] = [];
            if (request.model !== undefined) {
              configRequests.push({
                target: MODEL_TARGET,
                label: "model",
                requested: request.model,
              });
            }
            if (request.thinkingEffort !== undefined) {
              configRequests.push({
                target: EFFORT_TARGET,
                label: "thinking effort",
                requested: request.thinkingEffort,
              });
            }
            const applied = await applyConfigRequests(
              session.newSessionResponse.configOptions,
              configRequests,
              async (configId, value) =>
                ctx.request(acp.methods.agent.session.setConfigOption, {
                  sessionId: session.sessionId,
                  ...setRequestBody(configId, value),
                }),
            );
            configWarnings.push(...applied.warnings);
            configOutcomes.push(...applied.outcomes);
            for (const warning of applied.warnings) await onProgress(warning);
            // Baselined from the responses, so the notification the agent emits
            // for each of our own sets is recognised as an echo and not narrated
            // a second time.
            const tracker = new ConfigTracker(applied.state);
            const introduction = [
              `Kimi ACP session ${session.sessionId} started`,
              agent === undefined ? undefined : `${agent.name} ${agent.version}`.trim(),
              summarizeConfigOptions(tracker.state) || undefined,
            ].filter((part) => part !== undefined);
            await onProgress(`${introduction.join(" | ")}.`);

            void session.prompt(request.prompt);
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                return {
                  response: message.response,
                  sessionId: session.sessionId,
                  agent,
                  tracker,
                };
              }
              const text = extractText(message.notification.update);
              if (text !== undefined) {
                resultBytes += Buffer.byteLength(text, "utf8");
                if (resultBytes > this.config.maxResultBytes) {
                  throw new RelayError(
                    "Kimi result exceeded its configured size limit.",
                    "RESULT_TOO_LARGE",
                  );
                }
                chunks.push(text);
              }
              const progress = extractProgress(message.notification.update);
              if (progress !== undefined) await onProgress(progress);
              // An agent may switch model or reasoning level mid-turn, for
              // instance when it falls back after a rate limit. Reporting the
              // session-start snapshot as if it still held would be a lie.
              const configChange = tracker.observe(message.notification.update);
              if (configChange !== undefined) await onProgress(configChange);
            }
          });
        });

      const result = await Promise.race([protocolResult, childFailure]);
      protocolFinished = true;
      const envOverrides = environmentOverrides(agentEnv);
      const options = toConfigSnapshot(result.tracker.state);
      const agentConfig: AgentConfigReport | undefined =
        options.length === 0 && result.agent === undefined
          ? undefined
          : {
              summary: summarizeConfigOptions(result.tracker.state),
              options,
              ...(result.agent === undefined ? {} : { agent: result.agent }),
              ...(envOverrides.length === 0 ? {} : { envOverrides }),
              ...(configOutcomes.length === 0 ? {} : { requests: configOutcomes }),
              ...(result.tracker.changedDuringRun ? { changedDuringRun: true } : {}),
            };
      return {
        text: chunks.join("").trim(),
        stopReason: result.response.stopReason,
        sessionId: result.sessionId,
        ...(agentConfig === undefined ? {} : { agentConfig }),
        warnings: configWarnings,
      };
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = externalSignal?.aborted ? "cancelled" : "timed out";
        throw new RelayError(
          `Kimi task ${reason}.`,
          reason === "cancelled" ? "CANCELLED" : "TIMEOUT",
          {
            cause: error,
          },
        );
      }
      // A RelayError raised inside the protocol already carries a precise code
      // and a message written for the person reading it -- KIMI_AUTH_REQUIRED
      // tells them how to sign in, ACP_VERSION_MISMATCH which versions to align,
      // KIMI_EXITED that the agent died. Wrapping it would replace all of that
      // with a generic KIMI_ACP_FAILED and hide the code from the caller.
      if (error instanceof RelayError) throw error;
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      throw new RelayError(
        `Kimi ACP failed: ${toErrorMessage(error)}${diagnostic ? `\n${diagnostic}` : ""}`,
        "KIMI_ACP_FAILED",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      await terminate(child, { group: true });
    }
  }
}
