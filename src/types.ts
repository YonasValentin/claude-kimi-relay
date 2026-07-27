export const TASK_KINDS = ["review", "challenge", "delegate"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_STATUSES = [
  "queued",
  "preparing_workspace",
  "starting_agent",
  "running",
  "validating",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type PermissionMode = "review" | "delegate";

export interface TaskRequest {
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly projectDir: string;
  readonly background?: boolean;
  readonly baseRef?: string;
  readonly timeoutMs?: number;
  readonly keepWorkspace?: boolean;
  // Optional agent configuration to request for this task. Both are matched
  // against the values the agent advertises for the session; neither is ever
  // sent to the agent as a raw string. See AgentConfigReport for what comes
  // back, including whether the request was honoured.
  readonly model?: string;
  readonly thinkingEffort?: string;
}

export interface TaskEvent {
  readonly at: string;
  readonly status: TaskStatus;
  readonly message: string;
}

/** One session configuration option, exactly as the agent reported it. */
export interface AgentConfigOptionSnapshot {
  readonly id: string;
  readonly name: string;
  readonly currentValue: string;
  readonly category?: string;
}

/** What became of one requested configuration value. */
export interface AgentConfigRequestOutcome {
  readonly configId: string;
  readonly requested: string;
  readonly applied: boolean;
  readonly effectiveValue?: string;
  readonly detail?: string;
}

/**
 * What produced a result, as the agent itself reported it.
 *
 * There is deliberately no `model` field here. The relay does not know which of
 * an agent's options is "the model"; it reports the agent's own option ids,
 * names and current values, and lets the reader draw that conclusion. An agent
 * that advertises no configuration at all yields no options rather than a
 * guessed or "unknown" one.
 */
export interface AgentConfigReport {
  /** One line, built only from the agent's own option labels and values. */
  readonly summary: string;
  readonly options: readonly AgentConfigOptionSnapshot[];
  /** Name and version from the agent's `initialize` response, when it sent them. */
  readonly agent?: { readonly name: string; readonly version: string };
  /**
   * Names -- never values -- of the environment variables that were forwarded to
   * the agent and that its documentation says override the model, reasoning
   * level, endpoint, or data root. Their presence explains a session that
   * ignored what was asked of it.
   */
  readonly envOverrides?: readonly string[];
  readonly requests?: readonly AgentConfigRequestOutcome[];
  readonly changedDuringRun?: boolean;
}

export interface TaskResult {
  /**
   * The agent's own output. Absent when the task did not get far enough to
   * produce one -- a failed, cancelled or timed-out run still carries the
   * `agentConfig` and `warnings` below, because what ran and what went sideways
   * are worth knowing precisely when there is no result. `error` on the record
   * says why it ended.
   */
  readonly summary?: string;
  readonly stopReason?: string;
  readonly sessionId?: string;
  readonly patchPath?: string;
  readonly workspacePath?: string;
  readonly agentConfig?: AgentConfigReport;
  readonly warnings: readonly string[];
}

export interface TaskRecord {
  readonly id: string;
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly projectDir: string;
  readonly baseRef: string;
  readonly background: boolean;
  readonly keepWorkspace: boolean;
  readonly timeoutMs: number;
  // Persisted, not just held in memory: a background task is executed by a
  // detached worker that re-reads the record from disk, so a request that lived
  // only on TaskRequest would be silently dropped for every background run --
  // which is the default.
  readonly model?: string;
  readonly thinkingEffort?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: TaskStatus;
  readonly events: readonly TaskEvent[];
  readonly pid?: number;
  // PID of the process actually executing the task (the background worker, or
  // the server/CLI process for a foreground run). Used to reconcile tasks left
  // in a non-terminal state after that process dies.
  readonly ownerPid?: number;
  readonly workspaceDir?: string;
  readonly sessionId?: string;
  readonly result?: TaskResult;
  readonly error?: string;
}

export interface RelayConfig {
  readonly dataDir: string;
  readonly projectDir?: string;
  readonly kimiCliPath: string;
  // Arguments the Kimi CLI is spawned with, defaulting to the documented ACP
  // entry point. Set by a constructor only -- never from the environment, so no
  // ambient variable can change how the agent is launched. It exists so the ACP
  // client can be tested against a stand-in agent.
  readonly kimiCliArgs?: readonly string[];
  readonly defaultTimeoutMs: number;
  readonly maxFileBytes: number;
  readonly maxWorkspaceBytes: number;
  readonly maxResultBytes: number;
}

export interface AgentRunRequest {
  readonly taskId: string;
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly workspaceDir: string;
  readonly timeoutMs: number;
  readonly model?: string;
  readonly thinkingEffort?: string;
}

export interface AgentRunResult {
  readonly text: string;
  readonly stopReason: string;
  readonly sessionId: string;
  readonly agentConfig?: AgentConfigReport;
  readonly warnings: readonly string[];
}

export interface PermissionContext {
  readonly mode: PermissionMode;
  readonly workspaceDir: string;
}

export interface PermissionOptionLike {
  readonly optionId: string;
  readonly kind?: string;
  readonly name?: string;
}

export interface PermissionRequestLike {
  readonly toolCall?: {
    readonly title?: string;
    readonly kind?: string;
    readonly rawInput?: unknown;
    readonly locations?: readonly unknown[];
  };
  readonly options: readonly PermissionOptionLike[];
}

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}
