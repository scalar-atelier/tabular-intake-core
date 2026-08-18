#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { IntakeError, runIntake, type RuleValue } from "./core.js";

function usage(): never {
  console.error("usage: scalar-tabular-intake run --source FILE --rules FILE --output DIR [--history FILE]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.shift() !== "run") usage();
  const options = new Map<string, string>();
  while (args.length) {
    const key = args.shift();
    const value = args.shift();
    if (!key?.startsWith("--") || !value) usage();
    options.set(key.slice(2), value);
  }
  const source = options.get("source");
  const rules = options.get("rules");
  const output = options.get("output");
  if (!source || !rules || !output || [...options.keys()].some(key => !["source", "history", "rules", "output"].includes(key))) usage();
  const result = await runIntake({
    source: await readFile(source),
    history: options.get("history") ? await readFile(options.get("history")!) : undefined,
    rules: JSON.parse(await readFile(rules, "utf8")) as RuleValue,
  });
  const destination = resolve(output);
  await mkdir(destination, { recursive: true });
  await Promise.all([
    writeFile(resolve(destination, "normalized.csv"), result.normalizedCsv),
    writeFile(resolve(destination, "review.csv"), result.reviewCsv),
    writeFile(resolve(destination, "result-manifest.json"), result.manifestJson),
  ]);
}

main().catch(error => {
  console.error(error instanceof IntakeError ? `${error.code}: ${error.message}` : String(error));
  process.exitCode = 1;
});
