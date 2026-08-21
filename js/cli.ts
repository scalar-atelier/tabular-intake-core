#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  IntakeError,
  runIntake,
  runTableCleanup,
  type RuleValue,
  type TableCleanupProfileV1,
} from "./core.js";

function usage(): never {
  console.error("usage: scalar-tabular-intake run --source FILE --rules FILE --output DIR [--history FILE]\n"
    + "   or: scalar-tabular-intake cleanup --source FILE --profile FILE --output DIR [--previous FILE]");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || !["run", "cleanup"].includes(command)) usage();
  const options = new Map<string, string>();
  while (args.length) {
    const key = args.shift();
    const value = args.shift();
    if (!key?.startsWith("--") || !value) usage();
    options.set(key.slice(2), value);
  }
  const source = options.get("source");
  const output = options.get("output");
  const allowed = command === "run" ? ["source", "history", "rules", "output"] : ["source", "previous", "profile", "output"];
  if (!source || !output || [...options.keys()].some(key => !allowed.includes(key))) usage();
  const destination = resolve(output);
  await mkdir(destination, { recursive: true });
  if (command === "run") {
    const rules = options.get("rules");
    if (!rules) usage();
    const result = await runIntake({
      source: await readFile(source),
      history: options.get("history") ? await readFile(options.get("history")!) : undefined,
      rules: JSON.parse(await readFile(rules, "utf8")) as RuleValue,
    });
    await Promise.all([
      writeFile(resolve(destination, "normalized.csv"), result.normalizedCsv),
      writeFile(resolve(destination, "review.csv"), result.reviewCsv),
      writeFile(resolve(destination, "result-manifest.json"), result.manifestJson),
    ]);
    return;
  }
  const profile = options.get("profile");
  if (!profile) usage();
  const result = await runTableCleanup({
    source: await readFile(source),
    previous: options.get("previous") ? await readFile(options.get("previous")!) : undefined,
    profile: JSON.parse(await readFile(profile, "utf8")) as TableCleanupProfileV1,
  });
  await Promise.all([
    writeFile(resolve(destination, "cleaned.csv"), result.cleanedCsv),
    writeFile(resolve(destination, "review.csv"), result.reviewCsv),
    writeFile(resolve(destination, "comparison.csv"), result.comparisonCsv),
    writeFile(resolve(destination, "result-manifest.json"), result.manifestJson),
  ]);
}

main().catch(error => {
  console.error(error instanceof IntakeError ? `${error.code}: ${error.message}` : String(error));
  process.exitCode = 1;
});
