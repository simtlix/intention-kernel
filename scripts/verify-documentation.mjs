import { access, readFile, readdir } from "node:fs/promises";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";
import ts from "typescript";

const apiReport = (await Promise.all(["intention-kernel.api.md", "intention-kernel-testing.api.md"].map((file) => readFile(new URL(`../api-reports/${file}`, import.meta.url), "utf8")))).join("\n");
const failures = [];
const entries = ["../dist/index.d.ts", "../dist/testing/index.d.ts"].map(file => fileURLToPath(new URL(file, import.meta.url)));
const program = ts.createProgram(entries, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true });
const checker = program.getTypeChecker();
let documentedExports = 0;
const publicModules = new Map();
for (const entry of entries) {
  const source = program.getSourceFile(entry);
  const module = source && checker.getSymbolAtLocation(source);
  if (!module) { failures.push(`Missing emitted public entry point: ${entry}`); continue; }
  publicModules.set(entry === entries[0] ? "intention-kernel" : "intention-kernel/testing", new Set(checker.getExportsOfModule(module).map(symbol => symbol.name)));
  for (const exported of checker.getExportsOfModule(module)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    if (symbol.getDocumentationComment(checker).length === 0) failures.push(`Public export lacks TSDoc: ${exported.name}`);
    documentedExports += 1;
  }
}
const guides = [new URL("../README.md", import.meta.url)];
async function collectGuides(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["reference", "superpowers", ".vitepress"].includes(entry.name)) continue;
    if (entry.isDirectory()) await collectGuides(new URL(`${entry.name}/`, directory));
    else if (entry.name.endsWith(".md")) guides.push(new URL(entry.name, directory));
  }
}
await collectGuides(new URL("../docs/", import.meta.url));
let checkedImports = 0;
for (const guide of guides) {
  const markdown = (await readFile(guide, "utf8")).replace(/\r\n?/g, "\n");
  for (const match of markdown.matchAll(/^```(?:ts|typescript|js|javascript)\b[^\n]*\n([\s\S]*?)^```/gm)) {
    const snippet = ts.createSourceFile("snippet.ts", match[1], ts.ScriptTarget.Latest, true);
    for (const node of snippet.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const moduleName = node.moduleSpecifier.text;
      if (moduleName !== "intention-kernel" && !moduleName.startsWith("intention-kernel/")) continue;
      const exports = publicModules.get(moduleName);
      if (!exports) { failures.push(`${guide.pathname}: unsupported package import ${moduleName}`); continue; }
      const clause = node.importClause;
      if (clause?.name && !exports.has("default")) failures.push(`${guide.pathname}: ${moduleName} has no default export`);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const binding of bindings.elements) {
          const name = (binding.propertyName ?? binding.name).text;
          if (!exports.has(name)) failures.push(`${guide.pathname}: ${moduleName} does not export ${name}`);
          checkedImports += 1;
        }
      }
    }
  }
}
if (apiReport.includes("(undocumented)")) failures.push("The public API report contains undocumented members.");
if (apiReport.includes("No @packageDocumentation")) failures.push("The package-level TSDoc comment is missing.");
try {
  await access(new URL("../docs/reference/index.md", import.meta.url));
  await access(new URL("../docs/reference/testing/index.md", import.meta.url));
  const referenceIndex = await readFile(new URL("../docs/reference/index.md", import.meta.url), "utf8");
  if (!referenceIndex.includes("(./intention-kernel.md)") || !referenceIndex.includes("(./testing/intention-kernel.md)")) {
    failures.push("The API reference index must expose both runtime and testing entry points.");
  }
} catch {
  failures.push("Generated API reference is missing docs/reference/index.md.");
}
if (failures.length > 0) throw new Error(failures.join("\n"));
process.stdout.write(`Public API documentation verification passed (${documentedExports} exports across runtime and testing, ${checkedImports} documented imports).\n`);
