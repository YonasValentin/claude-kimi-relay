import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { RelayError } from "./errors.js";

const SENSITIVE_PATH_PATTERNS = [
  /(?:^|[/\\])\.env(?:$|\.(?!example$|sample$|template$))/iu,
  /(?:^|[/\\])\.ssh(?:[/\\]|$)/iu,
  /(?:^|[/\\])\.aws(?:[/\\]|$)/iu,
  /(?:^|[/\\])\.gnupg(?:[/\\]|$)/iu,
  /(?:^|[/\\])id_(?:rsa|ed25519)(?:\.|$)/iu,
  /(?:^|[/\\])(?:credentials?|private[_-]?key|secret[_-]?key)(?:\.|$)/iu,
  /(?:^|[/\\])\.(?:envrc|npmrc|netrc|pypirc|git-credentials)$/iu,
  /(?:^|[/\\])\.docker[/\\]config\.json$/iu,
  /(?:^|[/\\])secrets?\.(?:ya?ml|json|toml)$/iu,
  /\.tfstate(?:\.backup)?$/iu,
];

export function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

export function assertNotSensitivePath(path: string): void {
  if (isSensitivePath(path)) {
    throw new RelayError("Access to credential or secret files is blocked.", "SENSITIVE_PATH");
  }
}

async function canonicalizePotentialPath(path: string): Promise<string> {
  let cursor = path;
  const suffix: string[] = [];
  for (;;) {
    try {
      const existing = await realpath(cursor);
      return resolve(existing, ...suffix.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor)
        throw new RelayError("Path cannot be resolved safely.", "PATH_UNRESOLVABLE");
      suffix.push(relative(parent, cursor));
      cursor = parent;
    }
  }
}

export async function resolveInsideRoot(root: string, requestedPath: string): Promise<string> {
  const realRoot = await realpath(root);
  const absoluteCandidate = isAbsolute(requestedPath)
    ? resolve(requestedPath)
    : resolve(realRoot, requestedPath);

  // Containment is decided on canonical paths: the workspace root may itself
  // sit behind a symlink (for example /tmp on macOS), so a lexical comparison
  // alone would reject legitimate absolute paths inside the workspace.
  const canonicalCandidate = await canonicalizePotentialPath(absoluteCandidate);
  if (!isContained(realRoot, canonicalCandidate)) {
    if (isContained(realRoot, absoluteCandidate)) {
      throw new RelayError("Symlink or junction escapes the isolated workspace.", "SYMLINK_ESCAPE");
    }
    throw new RelayError("Path escapes the isolated workspace.", "PATH_OUTSIDE_WORKSPACE");
  }

  assertNotSensitivePath(relative(realRoot, canonicalCandidate));
  return canonicalCandidate;
}

export async function assertRegularFile(path: string, maxBytes: number): Promise<void> {
  const info = await stat(path);
  if (!info.isFile()) {
    throw new RelayError("Requested path is not a regular file.", "NOT_REGULAR_FILE");
  }
  if (info.size > maxBytes) {
    throw new RelayError(`File exceeds the ${maxBytes} byte safety limit.`, "FILE_TOO_LARGE");
  }
}
