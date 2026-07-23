#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { TaskRunner } from "./runner.js";

function taskIdFromArgs(args: readonly string[]): string {
  const index = args.indexOf("--task");
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) throw new Error("Usage: worker --task <id>");
  return value;
}

const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());

const runner = new TaskRunner(loadConfig());
runner
  .run(taskIdFromArgs(process.argv.slice(2)), controller.signal)
  .then((record) => {
    process.exitCode = record.status === "completed" ? 0 : 1;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
