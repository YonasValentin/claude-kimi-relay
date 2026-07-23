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
];

const SAFE_REVIEW_HINTS = [
  /\bread\b|\bview\b|\bsearch\b|\bfind\b|\blist\b|\bglob\b|\bgrep\b|\brg\b/iu,
  /\bgit\s+(?:status|diff|show|log|branch|rev-parse)\b/iu,
  /\b(?:cat|head|tail|sed\s+-n|wc|pwd|ls)\b/iu,
];

function serializeRequest(request: PermissionRequestLike): string {
  try {
    return JSON.stringify(request.toolCall ?? {}).slice(0, 100_000);
  } catch {
    return request.toolCall?.title ?? "";
  }
}

function optionMatching(
  options: readonly PermissionOptionLike[],
  pattern: RegExp,
): PermissionOptionLike | undefined {
  return options.find((option) => pattern.test(`${option.kind ?? ""} ${option.name ?? ""}`));
}

export class PermissionPolicy {
  public decide(
    request: PermissionRequestLike,
    context: PermissionContext,
  ):
    | { readonly outcome: "selected"; readonly optionId: string }
    | { readonly outcome: "cancelled" } {
    const description = serializeRequest(request);

    if (DENY_ALWAYS.some((pattern) => pattern.test(description))) {
      return this.cancelOrDeny(request.options);
    }

    if (context.mode === "review") {
      const mutating = MUTATION_HINTS.some((pattern) => pattern.test(description));
      const safeRead = SAFE_REVIEW_HINTS.some((pattern) => pattern.test(description));
      if (mutating || !safeRead) return this.cancelOrDeny(request.options);
    }

    const allow = optionMatching(request.options, /allow|approve|accept/iu);
    return allow ? { outcome: "selected", optionId: allow.optionId } : { outcome: "cancelled" };
  }

  private cancelOrDeny(
    options: readonly PermissionOptionLike[],
  ):
    | { readonly outcome: "selected"; readonly optionId: string }
    | { readonly outcome: "cancelled" } {
    const deny = optionMatching(options, /deny|reject/iu);
    return deny ? { outcome: "selected", optionId: deny.optionId } : { outcome: "cancelled" };
  }
}
