import { createHash } from "node:crypto";
import process from "node:process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function digest() {
  const hash = createHash("sha256");
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.name.endsWith(".md")) { hash.update(file); hash.update(await readFile(file)); }
    }
  }
  await visit("api-reports"); await visit("docs/reference");
  return hash.digest("hex");
}
const baseline = await digest();
if (!process.env.npm_execpath) throw new Error("Run through npm run docs:check");
const generated = spawnSync(process.execPath, [process.env.npm_execpath, "run", "docs:generate"], { stdio: "pipe", encoding: "utf8" });
if (generated.status !== 0) throw new Error(`Documentation generation failed\n${generated.stdout}\n${generated.stderr}`);
if (await digest() !== baseline) throw new Error("Documentation generation is not deterministic");
process.stdout.write("Generated runtime and testing references are deterministic.\n");
