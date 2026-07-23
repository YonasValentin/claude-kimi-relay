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
