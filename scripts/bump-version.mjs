// Set the release version across every file `release:check` reconciles, then
// rebuild the committed plugin bundle so the drift guard stays green. Keeps a
// human from editing three JSON files by hand and tripping the version gate.
//
// Usage: node scripts/bump-version.mjs <x.y.z>
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";

const version = process.argv[2] ?? "";
const parts = version.split(".");
if (parts.length !== 3 || !parts.every((part) => /^\d+$/u.test(part))) {
  console.error("Usage: node scripts/bump-version.mjs <x.y.z>");
  process.exit(1);
}

const targets = [
  ["package.json", (json) => (json.version = version)],
  ["plugin/.claude-plugin/plugin.json", (json) => (json.version = version)],
  [".claude-plugin/marketplace.json", (json) => (json.plugins[0].version = version)],
];

for (const [path, mutate] of targets) {
  const json = JSON.parse(await readFile(path, "utf8"));
  mutate(json);
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
}

// The version the relay reports over ACP/MCP lives in a build-time constant.
const versionSource = "src/version.ts";
const source = await readFile(versionSource, "utf8");
await writeFile(
  versionSource,
  source.replace(/export const VERSION = "[^"]*";/u, `export const VERSION = "${version}";`),
);

// Normalize to the repo's Prettier format so `npm run verify` stays green.
execFileSync("npx", ["prettier", "--write", versionSource, ...targets.map(([path]) => path)], {
  stdio: "inherit",
});

// The committed plugin/dist is what marketplace users run, so keep it current.
execFileSync("npm", ["run", "build:plugin"], { stdio: "inherit" });

console.log(
  `\nSet version ${version} in package.json, both plugin manifests, and src/version.ts, and rebuilt plugin/dist.`,
);
console.log("Next:");
console.log("  npm run verify");
console.log(`  git commit -am "release: v${version}"`);
console.log(`  git tag v${version} && git push --follow-tags`);
