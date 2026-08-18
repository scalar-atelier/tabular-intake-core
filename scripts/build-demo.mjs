import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "demo-dist");
await mkdir(output, { recursive: true });
await build({
  entryPoints: [resolve(root, "demo/app.ts")],
  outfile: resolve(output, "app.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  loader: { ".csv": "text" },
});
await Promise.all([
  copyFile(resolve(root, "demo/index.html"), resolve(output, "index.html")),
  copyFile(resolve(root, "demo/styles.css"), resolve(output, "styles.css")),
]);
const names = ["index.html", "styles.css", "app.js"];
const files = Object.fromEntries(await Promise.all(names.map(async name => [
  name, createHash("sha256").update(await readFile(resolve(output, name))).digest("hex"),
])));
const sourceCommit = process.env.GITHUB_SHA || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
await writeFile(resolve(output, "demo-build.json"), `${JSON.stringify({
  schemaVersion: "scalar-tabular-intake-demo-build/v1",
  packageVersion: "0.2.0",
  coreVersion: "0.1.0",
  sourceTag: process.env.SOURCE_TAG || "dev",
  sourceCommit,
  files,
}, null, 2)}\n`);
