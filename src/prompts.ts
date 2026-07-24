import type { TaskKind } from "./types.js";

const SHARED = `
You are operating inside an isolated copy of the user's repository.
Never publish, deploy, push, access credentials, or modify files outside the current workspace.
Do not claim that tests passed unless you actually ran them and saw a successful result.
Return a concise but complete Markdown report with evidence, file paths, and commands executed.
`;

export function buildPrompt(kind: TaskKind, userPrompt: string, diffIsEmpty = false): string {
  const comparison = diffIsEmpty
    ? "The base and current snapshots are IDENTICAL — `git diff HEAD^ HEAD` is empty, so there is no base-vs-current change set to inspect; review the full current tree with `git show HEAD` and `git ls-files`. Because there is no diff, you MUST NOT label any issue as newly introduced by these changes versus pre-existing — you cannot tell them apart here."
    : "The latest commit is an isolated relay baseline containing the requested comparison; inspect it with `git show HEAD` and `git diff HEAD^ HEAD` when applicable.";
  switch (kind) {
    case "review":
      return `${SHARED}
This is a read-only code review. ${comparison} Inspect the repository state and identify correctness, security, reliability, architecture, and maintainability issues. Prioritize findings by severity. Do not change files. If no material issue is found, say so explicitly and mention remaining uncertainty.

User focus:
${userPrompt}`;
    case "challenge":
      return `${SHARED}
This is an adversarial design review. ${comparison} Challenge assumptions, architecture choices, failure modes, race conditions, rollback behavior, data-loss risks, security boundaries, and simpler alternatives. Do not change files. Distinguish proven defects from hypotheses.

User focus:
${userPrompt}`;
    case "delegate":
      return `${SHARED}
Implement the requested task with the smallest safe, production-quality patch. Read project instructions before editing. Preserve public APIs unless the task requires a change. Add or update tests, run the relevant validation commands, and summarize every changed file. Do not commit, push, publish, deploy, or access credentials.

Task:
${userPrompt}`;
  }
}
