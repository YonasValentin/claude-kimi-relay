import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";

import type {
  AgentRunRequest,
  AgentRunResult,
  PermissionRequestLike,
  RelayConfig,
} from "./types.js";
import { RelayError, toErrorMessage } from "./errors.js";
import { assertRegularFile, resolveInsideRoot } from "./fs-security.js";
import { PermissionPolicy } from "./policy.js";
import { sanitizedAgentEnvironment } from "./process.js";

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

    const child = spawn(this.config.kimiCliPath, ["acp"], {
      cwd: request.workspaceDir,
      env: sanitizedAgentEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      signal: controller.signal,
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
        reject(
          new RelayError(
            `Kimi Code exited before ACP completed (${signal ?? `exit ${code ?? "unknown"}`}).`,
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
              clientInfo: { name: "claude-kimi-relay", version: "0.1.0" },
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
              `Kimi Code speaks ACP protocol version ${initializeResponse.protocolVersion}, but this relay supports version ${acp.PROTOCOL_VERSION}.`,
              "ACP_VERSION_MISMATCH",
            );
          }

          return ctx.buildSession(request.workspaceDir).withSession(async (session) => {
            await onProgress(`Kimi ACP session ${session.sessionId} started.`);
            void session.prompt(request.prompt);
            for (;;) {
              const message = await session.nextUpdate();
              if (message.kind === "stop") {
                return {
                  response: message.response,
                  sessionId: session.sessionId,
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
            }
          });
        });

      const result = await Promise.race([protocolResult, childFailure]);
      protocolFinished = true;
      return {
        text: chunks.join("").trim(),
        stopReason: result.response.stopReason,
        sessionId: result.sessionId,
        warnings: [],
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
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      throw new RelayError(
        `Kimi ACP failed: ${toErrorMessage(error)}${diagnostic ? `\n${diagnostic}` : ""}`,
        "KIMI_ACP_FAILED",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
      if (!child.killed) child.kill("SIGTERM");
    }
  }
}
