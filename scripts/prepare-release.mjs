import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const versionSource = await readFile(path.join(root, "src/version.ts"), "utf8");
const expectedTag = `v${manifest.version}`;
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;
if (tag !== expectedTag) throw new Error(`Release tag must be ${expectedTag}; received ${tag ?? "no tag"}`);
if (lock.version !== manifest.version || lock.packages[""].version !== manifest.version ||
  !versionSource.includes(`export const VERSION = "${manifest.version}" as const;`)) {
  throw new Error("Package, lockfile and runtime versions must match before release");
}
if (manifest.license !== "Apache-2.0" || lock.packages[""].license !== manifest.license) throw new Error("Release license metadata is inconsistent");
const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
const section = changelog.split(/^## /m).find(part => part.split(/\r?\n/)[0].split(" - ")[0] === manifest.version);
if (!section || section.trim().split(/\r?\n/).length < 3) throw new Error(`CHANGELOG.md must describe ${manifest.version}`);
if (!process.env.npm_execpath) throw new Error("Run through npm run release:prepare -- <tag>");
const output = path.join(root, ".tmp", "release");
await mkdir(output, { recursive: true });
const packed = spawnSync(process.execPath, [process.env.npm_execpath, "pack", "--ignore-scripts", "--json", "--pack-destination", output], {
  cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
if (packed.status !== 0) throw new Error(`Release packaging failed:\n${packed.stdout}\n${packed.stderr}`);
const report = JSON.parse(packed.stdout)[0];
if (report?.version !== manifest.version || typeof report.filename !== "string") throw new Error("Packed release version is inconsistent");
const digest = createHash("sha256").update(await readFile(path.join(output, report.filename))).digest("hex");
await writeFile(path.join(output, "SHA256SUMS"), `${digest}  ${report.filename}\n`);
await writeFile(path.join(output, "RELEASE_NOTES.md"), `## ${section.trim()}\n\nInstall the attached package with npm. SHA256SUMS identifies the release artifact.\n`);
process.stdout.write(`Prepared ${report.filename}, SHA256SUMS and RELEASE_NOTES.md in .tmp/release/.\n`);
