import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { URL, fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../docs/.vitepress/dist/", import.meta.url));
const basePath = (process.env.DOCS_BASE ?? "").replace(/^\/+|\/+$/g, "");
const base = basePath.length > 0 ? `/${basePath}/` : "/";
const origin = "https://docs.invalid";
const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const homepage = new URL(manifest.homepage);
const files = new Set();
const html = new Map();

async function collect(directory, prefix = "") {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collect(path.join(directory, entry.name), `${relative}/`);
    else files.add(relative);
  }
}
await collect(root);
for (const file of files) {
  if (file.endsWith(".html")) html.set(file, await readFile(path.join(root, file), "utf8"));
}
if (!html.has("index.html") || !html.has("404.html")) throw new Error("The site must include its home and 404 pages");
if ([...files].some(file => file.startsWith("superpowers/"))) throw new Error("Internal plans must not appear in the site");

const errors = new Set();
let checked = 0;
let readmeLinks = 0;
function checkTarget(file, relative, hash, value) {
  const target = relative.endsWith("/") || relative === "" ? `${relative}index.html` : relative;
  if (!files.has(target)) {
    errors.add(`${file}: missing local target: ${value}`);
    return;
  }
  if (hash && html.has(target)) {
    const id = decodeURIComponent(hash.slice(1));
    if (!html.get(target).includes(`id="${id}"`)) errors.add(`${file}: missing anchor: ${value}`);
  }
}
for (const [file, content] of html) {
  if (file !== "404.html" && !/<h1\b/i.test(content)) errors.add(`${file}: missing primary page heading`);
  const page = new URL(`${base}${file}`, origin);
  for (const match of content.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
    const value = match[1].replaceAll("&amp;", "&");
    if (/^(?:data:|mailto:|tel:|javascript:)/i.test(value)) continue;
    const url = new URL(value, page);
    if (url.origin !== origin) continue;
    checked += 1;
    if (!url.pathname.startsWith(base)) {
      errors.add(`${file}: URL escapes the site base: ${value}`);
      continue;
    }
    const relative = decodeURIComponent(url.pathname.slice(base.length));
    checkTarget(file, relative, url.hash, value);
  }
}
for (const file of ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"]) {
  const markdown = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^\s)]+)\)/g)) {
    const value = match[1];
    if (value.startsWith("#")) continue;
    if (!/^https?:\/\//.test(value)) {
      if (!["LICENSE", "README.md", "CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"].includes(value)) {
        errors.add(`${file}: consumer documentation must link to the public site: ${value}`);
      }
      continue;
    }
    const url = new URL(value);
    if (url.origin !== homepage.origin) continue;
    if (!url.pathname.startsWith(homepage.pathname)) {
      errors.add(`${file}: documentation link escapes the public site: ${value}`);
      continue;
    }
    readmeLinks += 1;
    checkTarget(file, decodeURIComponent(url.pathname.slice(homepage.pathname.length)), url.hash, value);
  }
}
if (errors.size > 0) throw new Error(`Static site has ${errors.size} broken references:\n${[...errors].slice(0, 25).join("\n")}`);
process.stdout.write(`Static site verified: ${html.size} pages, ${checked} local links and assets, ${readmeLinks} public documentation links from package Markdown, base ${base}.\n`);
