import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["package.json", "NOTICE", "LICENSE", ".claude-plugin", "plugin"];
const placeholders = /YOUR_(?:ORG|NAME)/u;
const textExtensions = new Set(["", ".json", ".md", ".txt", ".yml", ".yaml"]);

async function files(path) {
  const info = await import("node:fs/promises").then(({ stat }) => stat(path));
  if (info.isFile()) return [path];
  const result = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name === "dist") continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await files(child)));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

const candidates = (await Promise.all(roots.map(files))).flat();
const failures = [];
for (const path of candidates) {
  if (!textExtensions.has(extname(path))) continue;
  if (placeholders.test(await readFile(path, "utf8"))) failures.push(path);
}
if (failures.length > 0) {
  console.error(
    `Replace release placeholders in:\n${failures.map((path) => `- ${path}`).join("\n")}`,
  );
  process.exit(1);
}

// Version consistency: the plugin manifests and (on a tag push) the pushed tag
// must all match package.json, so `npm publish` never ships a version the
// marketplace does not advertise or a tag does not name.
const pkg = JSON.parse(await readFile("package.json", "utf8"));
const { version } = pkg;
const manifestVersions = [
  ["plugin/.claude-plugin/plugin.json", (json) => json.version],
  [".claude-plugin/marketplace.json", (json) => json.plugins?.[0]?.version],
];
const versionFailures = [];
for (const [path, pick] of manifestVersions) {
  const found = pick(JSON.parse(await readFile(path, "utf8")));
  if (found !== version)
    versionFailures.push(`${path}: ${found ?? "(missing)"} (expected ${version})`);
}
const versionSource = await readFile("src/version.ts", "utf8");
const sourceVersion = /export const VERSION = "([^"]*)";/u.exec(versionSource)?.[1];
if (sourceVersion !== version) {
  versionFailures.push(`src/version.ts: ${sourceVersion ?? "(missing)"} (expected ${version})`);
}
const tag = process.env.GITHUB_REF_NAME ?? "";
if (/^v\d/u.test(tag) && tag !== `v${version}`) {
  versionFailures.push(`git tag ${tag} (expected v${version})`);
}
if (versionFailures.length > 0) {
  console.error(
    `Version does not match package.json ${version}:\n${versionFailures.map((line) => `- ${line}`).join("\n")}`,
  );
  process.exit(1);
}
