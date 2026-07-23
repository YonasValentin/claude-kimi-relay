import { rm } from "node:fs/promises";

await Promise.all([
  rm(new URL("../dist", import.meta.url), { recursive: true, force: true }),
  rm(new URL("../dist-types", import.meta.url), { recursive: true, force: true }),
  rm(new URL("../plugin/dist", import.meta.url), { recursive: true, force: true }),
]);
