import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outdirUrl = new URL("../plugin/dist/", import.meta.url);
const outdir = fileURLToPath(outdirUrl);
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: {
    mcp: fileURLToPath(new URL("../src/mcp.ts", import.meta.url)),
    cli: fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
    worker: fileURLToPath(new URL("../src/worker.ts", import.meta.url)),
  },
  outdir,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  legalComments: "external",
});

await writeFile(new URL("package.json", outdirUrl), '{"type":"module"}\n');
