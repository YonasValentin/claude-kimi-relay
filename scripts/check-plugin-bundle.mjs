import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";

// Marketplace installs copy only committed files, so a repo-wide `dist/` ignore
// rule would silently ship a plugin without its runtime bundle.
const ignored = spawnSync("git", ["check-ignore", "-q", "plugin/dist"], { stdio: "ignore" });
if (ignored.status === 0) {
  throw new Error(
    "plugin/dist is excluded by .gitignore; marketplace installs would ship without the runtime bundle.",
  );
}

const required = [
  "plugin/dist/mcp.js",
  "plugin/dist/worker.js",
  "plugin/dist/cli.js",
  "plugin/dist/package.json",
];

for (const path of required) {
  await access(path);
}

const mcp = await readFile("plugin/dist/mcp.js", "utf8");
if (!mcp.includes("claude-kimi-relay")) {
  throw new Error("The generated MCP bundle does not contain the expected relay marker.");
}
