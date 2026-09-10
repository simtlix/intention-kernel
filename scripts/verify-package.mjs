import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(join(tmpdir(), "intention-kernel-package-"));
if (!resolve(temporary).startsWith(resolve(tmpdir()) + sep)) throw new Error("Unsafe temporary package directory");
const packageDirectory = join(temporary, "package");
const consumer = join(temporary, "consumer");
const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli.trim().length === 0) {
  throw new Error("npm_execpath is required; run this verifier through npm run pack:check");
}

try {
  await mkdir(packageDirectory, { recursive: true });
  const packed = runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packageDirectory], project);
  const report = JSON.parse(packed)[0];
  if (report === undefined || typeof report.filename !== "string" || !Array.isArray(report.files)) {
    throw new Error("npm pack did not return a valid package report");
  }
  const paths = report.files.map((entry) => entry.path);
  const allowedRoots = new Set([
    "package.json",
    "README.md",
    "LICENSE",
    "CHANGELOG.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
  ]);
  const unexpected = paths.filter((path) =>
    !path.startsWith("dist/") &&
    !(path.startsWith("src/") && path.endsWith(".ts")) &&
    !allowedRoots.has(path),
  );
  if (unexpected.length > 0) throw new Error(`Unexpected package files: ${unexpected.join(", ")}`);
  for (const required of ["package.json", "LICENSE", "README.md", "CHANGELOG.md", "SECURITY.md", "CONTRIBUTING.md", "dist/index.js", "dist/index.d.ts", "dist/testing/index.js", "dist/testing/index.d.ts", "src/index.ts", "src/testing/index.ts"]) {
    if (!paths.includes(required)) throw new Error(`Packed artifact is missing ${required}`);
  }
  if (paths.some((path) => /(^|\/)(\.env(?:\.[^/]*)?|\.lh|\.history|\.tmp|\.temp|\.cache|tests|coverage|temp|tmp|design|superpowers)(\/|$)|\.(?:log|tgz|tmp|temp)$/i.test(path))) {
    throw new Error("Packed artifact contains development tests, environment or temporary files");
  }

  await mkdir(consumer, { recursive: true });
  await writeFile(join(consumer, "package.json"), JSON.stringify({
    name: "intention-kernel-packed-consumer",
    private: true,
    type: "module",
  }, null, 2));
  await writeFile(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      rootDir: "src",
      outDir: "dist",
      types: ["node"],
    },
    include: ["src/**/*.ts"],
  }, null, 2));
  await mkdir(join(consumer, "src"), { recursive: true });
  await copyFile(join(project, "tests", "consumer", "install-packed-package.ts"), join(consumer, "src", "index.ts"));
  await copyDocumentedExamples();
  await copyFile(join(project, "examples", "evaluateConsumer.ts"), join(consumer, "src", "evaluation-tutorial.ts"));

  const tarball = join(packageDirectory, report.filename);
  runNpm([
    "install",
    "--no-audit",
    "--no-fund",
    tarball,
    "typescript@5.9.3",
    "@types/node@22.20.1",
  ], consumer);
  run(process.execPath, [join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], consumer);
  run(process.execPath, [join(consumer, "dist", "index.js")], consumer);

  const installed = join(consumer, "node_modules", "intention-kernel");
  const manifest = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  if (manifest.version !== report.version) throw new Error("Installed package version differs from packed version");
  if (manifest.license !== "Apache-2.0") throw new Error("Installed package must declare Apache-2.0");
  const installedLicense = await readFile(join(consumer, "node_modules", "intention-kernel", "LICENSE"), "utf8");
  if (installedLicense !== await readFile(join(project, "LICENSE"), "utf8")) throw new Error("Installed license differs from the repository license");
  let mapCount = 0;
  for (const file of paths.filter((path) => path.endsWith(".map"))) {
    const map = JSON.parse(await readFile(join(installed, file), "utf8"));
    if (!Array.isArray(map.sources) || map.sources.length === 0) throw new Error(`Invalid source map: ${file}`);
    for (const source of map.sources) {
      const target = resolve(installed, dirname(file), map.sourceRoot ?? "", source);
      if (!target.startsWith(installed + sep) || !paths.includes(target.slice(installed.length + 1).split(sep).join("/"))) {
        throw new Error(`Source map ${file} points outside the installed package: ${source}`);
      }
      await readFile(target, "utf8");
    }
    mapCount += 1;
  }
  await copyFile(join(project, "tests", "consumer", "packed-smoke.mjs"), join(consumer, "version-smoke.mjs"));
  run(process.execPath, [join(consumer, "version-smoke.mjs"), manifest.version], consumer);
  process.stdout.write(`Packed consumer verification passed (${String(paths.length)} files, ${mapCount} source maps, actual README examples and public testing API).\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function copyDocumentedExamples() {
  const examples = [
    ["README.md", "Define a read capability", "search-products.ts"],
    ["README.md", "Compile and run an agent", "agent.ts"],
    ["README.md", "Declarative evaluations", "evaluation.ts"],
    ["docs/guide/capabilities.md", "Definition anatomy", "submit-request.ts"],
  ];
  const output = join(consumer, "src", "readme");
  await mkdir(output, { recursive: true });
  for (const [source, heading, file] of examples) {
    const markdown = (await readFile(join(project, source), "utf8")).replace(/\r\n?/g, "\n");
    const section = markdown.split(`## ${heading}\n`)[1]?.split("\n## ")[0];
    const code = section?.match(/```ts\r?\n([\s\S]*?)```/)?.[1];
    if (!code) throw new Error(`${source} example is missing: ${heading}`);
    await writeFile(join(output, file), code);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args[0]} failed${output.length === 0 ? "" : `:\n${output}`}`);
  }
  return result.stdout.trim();
}

function runNpm(args, cwd) {
  return run(process.execPath, [npmCli, ...args], cwd);
}
