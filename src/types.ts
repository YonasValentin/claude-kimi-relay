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
}

export interface TaskEvent {
  readonly at: string;
  readonly status: TaskStatus;
  readonly message: string;
}

export interface TaskResult {
  readonly summary: string;
  readonly stopReason?: string;
  readonly sessionId?: string;
  readonly patchPath?: string;
  readonly workspacePath?: string;
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
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: TaskStatus;
  readonly events: readonly TaskEvent[];
  readonly pid?: number;
  readonly workspaceDir?: string;
  readonly sessionId?: string;
  readonly result?: TaskResult;
  readonly error?: string;
}

export interface RelayConfig {
  readonly dataDir: string;
  readonly projectDir?: string;
  readonly kimiCliPath: string;
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
}

export interface AgentRunResult {
  readonly text: string;
  readonly stopReason: string;
  readonly sessionId: string;
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
