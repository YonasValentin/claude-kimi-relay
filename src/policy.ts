import type { PermissionContext, PermissionOptionLike, PermissionRequestLike } from "./types.js";

const DENY_ALWAYS = [
  /\bgit\s+(?:push|commit|tag|clean|reset\s+--hard)\b/iu,
  /\bnpm\s+(?:publish|unpublish|deprecate|owner|install|i|update|add)\b/iu,
  /\bpnpm\s+(?:publish|install|add|update)\b/iu,
  /\byarn\s+(?:npm\s+publish|install|add|up|upgrade)\b/iu,
  /\brm\s+-rf\s+(?:\/|~|\.\.)/iu,
  /\b(?:sudo|su)\b/iu,
  /\b(?:curl|wget|nc|ncat|netcat|telnet|ftp|sftp)\b/iu,
  /\bssh\b|\bscp\b|\brsync\b/iu,
  /\bchmod\s+(?:777|a\+w)\b/iu,
  /\bchown\b/iu,
  /\bmkfs\b|\bdd\s+if=/iu,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/iu,
  /\/etc\/(?:passwd|shadow|sudoers)/iu,
  /\.ssh[/\\]/iu,
  /\.aws[/\\]/iu,
  /\.gnupg[/\\]/iu,
  /(?:^|[/\\])\.env(?:\.|$)/iu,
  /credential|private[_-]?key|secret[_-]?key/iu,
];

const MUTATION_HINTS = [
  /\bwrite\b|\bedit\b|\bdelete\b|\bremove\b|\bmove\b|\brename\b|\bpatch\b/iu,
  /\binstall\b|\bpublish\b|\bdeploy\b|\bcommit\b|\bpush\b/iu,
  /\bmkdir\b|\btouch\b|\btruncate\b/iu,
  // Writer binaries a "safe" read verb could shell out to.
  /\b(?:tee|cp|mv|rm|rmdir|mkfifo)\b/iu,
  // find(1) actions that write or execute, so `find . -fprint`/`-exec`/`-delete`
  // cannot pass as a read.
  /(?:^|\s)-(?:exec|execdir|ok|delete|fprint|fprintf|fprint0)\b/iu,
];

const SAFE_REVIEW_HINTS = [
  /\bread\b|\bview\b|\bsearch\b|\bfind\b|\blist\b|\bglob\b|\bgrep\b|\brg\b/iu,
  /\bgit\s+(?:status|diff|show|log|branch|rev-parse)\b/iu,
  /\b(?:cat|head|tail|sed\s+-n|wc|pwd|ls)\b/iu,
];

// Shell operators that can smuggle a write past a safe-read verb (a redirect,
// append, pipe-into-writer, or command chain — including a bare `&`, and a
// newline/CR which JSON-serializes to `\n`/`\r` in the inspected string). In
// review mode any command carrying one is treated as mutating: a leading
// `cat`/`grep` must not launder a trailing `> ~/.bashrc`, `; rm ...`, or a
// second line. This is best-effort defense-in-depth over a string policy, not
// a sandbox — see THREAT_MODEL.md; untrusted repos still warrant OS isolation.
const SHELL_CHAIN = /(?:>>?|\||;|&|`|\$\(|\\n|\\r)/u;

// A permission request whose serialization exceeds this cannot be fully
// inspected by the deny list. Truncating it (the previous behaviour) let a
// caller hide a denied command behind >100KB of padding so `DENY_ALWAYS` never
// saw it; in delegate mode, where the deny list is the only content gate, that
// silently failed OPEN. Un-inspectable requests are now rejected (fail closed),
// matching how review mode refuses anything it cannot positively classify.
const MAX_INSPECTABLE_BYTES = 100_000;

function serializeRequest(request: PermissionRequestLike): string | undefined {
  try {
    const serialized = JSON.stringify(request.toolCall ?? {});
    return serialized.length > MAX_INSPECTABLE_BYTES ? undefined : serialized;
  } catch {
    return undefined;
  }
}

function optionMatching(
  options: readonly PermissionOptionLike[],
  pattern: RegExp,
): PermissionOptionLike | undefined {
  return options.find((option) => pattern.test(`${option.kind ?? ""} ${option.name ?? ""}`));
}

// Select an allow option WITHOUT ever granting a session-wide `*_always` grant:
// a conforming agent records those persistently and stops re-requesting, which
// would defeat the deny-first gate after a single approval. Prefer an explicit
// one-shot allow; otherwise a non-"always" allow; never an "always" option.
function selectAllow(options: readonly PermissionOptionLike[]): PermissionOptionLike | undefined {
  const isAlways = (option: PermissionOptionLike): boolean =>
    /always/iu.test(`${option.kind ?? ""} ${option.name ?? ""}`);
  const oneShot = options.find((option) => option.kind === "allow_once");
  if (oneShot) return oneShot;
  return options.find(
    (option) =>
      !isAlways(option) &&
      /allow|approve|accept/iu.test(`${option.kind ?? ""} ${option.name ?? ""}`),
  );
}

export class PermissionPolicy {
  public decide(
    request: PermissionRequestLike,
    context: PermissionContext,
  ):
    | { readonly outcome: "selected"; readonly optionId: string }
    | { readonly outcome: "cancelled" } {
    const description = serializeRequest(request);

    // Un-serializable or too large to inspect: cannot be proven safe -> deny.
    if (description === undefined) {
      return this.cancelOrDeny(request.options);
    }

    if (DENY_ALWAYS.some((pattern) => pattern.test(description))) {
      return this.cancelOrDeny(request.options);
    }

    if (context.mode === "review") {
      const mutating =
        MUTATION_HINTS.some((pattern) => pattern.test(description)) ||
        SHELL_CHAIN.test(description);
      const safeRead = SAFE_REVIEW_HINTS.some((pattern) => pattern.test(description));
      if (mutating || !safeRead) return this.cancelOrDeny(request.options);
    }

    const allow = selectAllow(request.options);
    return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
  }

  private cancelOrDeny(
    options: readonly PermissionOptionLike[],
  ):
    | { readonly outcome: "selected"; readonly optionId: string }
    | { readonly outcome: "cancelled" } {
    // Prefer a one-shot reject so we never leave a persistent session decision.
    const deny =
      options.find((option) => option.kind === "reject_once") ??
      optionMatching(options, /deny|reject/iu);
    return deny ? { outcome: "selected", optionId: deny.optionId } : { outcome: "cancelled" };
  }
}
