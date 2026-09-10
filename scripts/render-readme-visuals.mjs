import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";

// Optional authoring tool. Its native renderer is installed outside the library's dependencies.
const root = fileURLToPath(new URL("../", import.meta.url));
const tools = path.join(root, ".tmp", "readme-visual-tools");
const require = createRequire(path.join(tools, "package.json"));
const { Resvg } = require("@resvg/resvg-js");
const output = path.join(root, "docs", "public", "readme");
const working = path.join(root, ".tmp", "readme-visuals");
const fontDirectory = process.env.README_FONT_DIR ?? path.join(process.env.WINDIR ?? "C:/Windows", "Fonts");
const fontFiles = ["Inter-Regular.ttf", "Inter-SemiBold.ttf"].map(file => path.join(fontDirectory, file));
for (const file of fontFiles) if (!existsSync(file)) throw new Error(`Missing ${file}; set README_FONT_DIR to a directory containing the two Inter fonts.`);
const rendererOptions = { font: { fontFiles, loadSystemFonts: false, defaultFontFamily: "Inter" } };
const logoSource = await readFile(path.join(root, "docs", "public", "intention-kernel-mark.svg"), "utf8");
const logoShape = logoSource.match(/<g fill="currentColor">([\s\S]*?)<\/g>/)?.[1];
if (!logoShape) throw new Error("The canonical brand mark must contain its vector geometry");

const W = 1280;
const FPS = 20;
const moments = [
  { id: "request", frames: 24 },
  { id: "interpret", frames: 32 },
  { id: "authorize", frames: 40 },
  { id: "execute", frames: 36 },
  { id: "ground-and-commit", frames: 36 },
  { id: "read-result", frames: 52 },
  { id: "reset", frames: 20 },
];
let cursor = 0;
const timeline = Object.fromEntries(moments.map(moment => {
  const start = cursor;
  cursor += moment.frames;
  return [moment.id, { start, end: cursor }];
}));
const totalFrames = cursor;
const colors = {
  bg: "#090e13", surface: "#10191f", raised: "#142229", ink: "#edf7f2",
  muted: "#a8bab4", subtle: "#78918a", line: "#2b403b", accent: "#83f3c8",
  green: "#1c6e54", violet: "#c5b4ed", amber: "#efc98b",
};

const escape = value => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const progress = (frame, name) => {
  const moment = timeline[name];
  return clamp((frame - moment.start) / (moment.end - moment.start));
};
function text(x, y, value, size = 22, fill = colors.ink, weight = 400, extra = "") {
  return `<text x="${x}" y="${y}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" ${extra}>${escape(value)}</text>`;
}
function label(x, y, value, fill = colors.subtle, size = 14) {
  return text(x, y, value, size, fill, 600, 'letter-spacing="1.6"');
}
function rect(x, y, width, height, fill = colors.surface, stroke = colors.line, radius = 16, extra = "") {
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}" stroke="${stroke}" ${extra}/>`;
}
function line(x1, y1, x2, y2, color = colors.line, extra = "") {
  return `<path d="M${x1} ${y1}L${x2} ${y2}" fill="none" stroke="${color}" stroke-width="2" ${extra}/>`;
}
function mark(x, y, size = 44, color = colors.accent) {
  return `<g transform="translate(${x} ${y}) scale(${size / 300})" fill="${color}">${logoShape}</g>`;
}
function check(x, y, color = colors.accent, scale = 1) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><circle r="12" fill="${colors.green}"/><path d="m-5 0 3.5 3.5L6-4" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}
function background(height) {
  let grid = "";
  for (let x = 48; x < W; x += 40) for (let y = 24; y < height; y += 40) {
    grid += `<circle cx="${x}" cy="${y}" r="0.8" fill="${colors.subtle}" opacity="0.13"/>`;
  }
  return `<rect width="${W}" height="${height}" fill="${colors.bg}"/>
    <rect width="${W}" height="${height}" fill="url(#ambient)"/>
    ${grid}${rect(1, 1, W - 2, height - 2, "none", colors.line, 22)}`;
}
function masthead(tag) {
  return `${mark(48, 27, 45)}${text(108, 52, "Intention Kernel", 23, colors.ink, 600)}
    ${label(1230, 50, tag, colors.muted, 13).replace('<text ', '<text text-anchor="end" ')}`;
}
function svg(body, height, title, description) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" role="img" aria-labelledby="visual-title visual-description">
    <title id="visual-title">${escape(title)}</title><desc id="visual-description">${escape(description)}</desc>
    <defs>
      <radialGradient id="ambient" cx="84%" cy="22%" r="76%"><stop stop-color="#16382d" stop-opacity="0.48"/><stop offset="1" stop-color="#090e13" stop-opacity="0"/></radialGradient>
      <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M1 1L8 5L1 9" fill="none" stroke="${colors.accent}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker>
    </defs>${background(height)}${body}</svg>`;
}

function hero(frame) {
  const reset = 1 - ease((frame - timeline.reset.start) / (timeline.reset.end - timeline.reset.start - 1));
  const completed = ["interpret", "authorize", "execute", "ground-and-commit"].map(name => ease(progress(frame, name)) * reset);
  const starts = [timeline.interpret.start, timeline.authorize.start, timeline.execute.start, timeline["ground-and-commit"].start];
  const active = starts.map((start, index) => ease((frame - start) / 8) * (1 - ease((frame - (starts[index + 1] ?? timeline.reset.start)) / 10)) * reset);
  const ready = ease((frame - timeline["ground-and-commit"].end) / 12) * reset;
  const request = `${label(790, 141, "USER REQUEST", colors.accent)}
    ${text(790, 185, "Find a family option.", 29, colors.ink, 600)}
    ${text(790, 220, "A meaning to resolve. Not a tool call.", 18, colors.muted)}`;
  const result = `${label(790, 141, "GROUNDED RESULT", colors.accent)}
    ${text(790, 185, "Family One · 25,000 USD", 27, colors.ink, 600)}
    ${check(801, 215)}${text(824, 221, "Evidence attached · state committed", 18, colors.muted)}`;
  let body = `${masthead("TYPESCRIPT · CAPABILITY-FIRST")}
    ${text(56, 164, "Models propose.", 63, colors.ink, 600, 'letter-spacing="-2.5"')}
    ${text(56, 237, "The kernel decides.", 63, colors.accent, 600, 'letter-spacing="-2.5"')}
    ${rect(760, 102, 464, 153, colors.surface, colors.line, 18)}
    <g opacity="${1 - ready}">${request}</g><g opacity="${ready}">${result}</g>
    ${line(191, 338, 1099, 338)}`;
  const cards = [
    { x: 56, title: "Interpret", main: "product.search", detail: "Model proposes an intention", color: colors.violet },
    { x: 362, title: "Authorize", main: "Validated plan", detail: "Schemas · policies · facts", color: colors.accent },
    { x: 668, title: "Execute", main: "Catalog lookup", detail: "Capability calls a host port", color: colors.accent },
    { x: 974, title: "Ground + commit", main: "Supported answer", detail: "Evidence + durable state", color: colors.accent },
  ];
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index];
    const width = index === 3 ? 250 : 270;
    const center = card.x + width / 2;
    const intensity = Math.max(active[index], completed[index] * 0.55);
    body += `<circle cx="${center}" cy="338" r="${8 + active[index] * 8}" fill="${card.color}" opacity="${active[index] * 0.16}"/>
      <circle cx="${center}" cy="338" r="5" fill="${card.color}" opacity="${0.3 + intensity * 0.7}"/>
      ${line(center, 345, center, 367)}
      ${rect(card.x, 367, width, 162)}
      <g opacity="${intensity}">${rect(card.x, 367, width, 162, "none", card.color, 16, 'stroke-width="1.8"')}</g>
      ${label(card.x + 22, 400, `${String(index + 1).padStart(2, "0")} / ${card.title.toUpperCase()}`, card.color, 12)}
      ${text(card.x + 22, 442, card.main, index === 3 ? 24 : 26, colors.ink, 600)}
      ${text(card.x + 22, 475, card.detail, 16, colors.muted)}
      ${rect(card.x + 22, 502, width - 44, 3, colors.line, "none", 1.5)}
      ${rect(card.x + 22, 502, Math.max(0.01, (width - 44) * completed[index]), 3, card.color, "none", 1.5)}`;
  }
  const centers = [191, 497, 803, 1099];
  for (let index = 0; index < 3; index++) {
    const end = starts[index + 1];
    const flight = (frame - (end - 10)) / 14;
    if (flight >= 0 && flight <= 1) {
      const x = centers[index] + (centers[index + 1] - centers[index]) * ease(flight);
      body += `<g opacity="${Math.sin(Math.PI * flight) * reset}"><circle cx="${x}" cy="338" r="15" fill="${colors.accent}" opacity="0.12"/><circle cx="${x}" cy="338" r="5" fill="${colors.accent}"/></g>`;
    }
  }
  const captions = [
    ["The request enters a bounded, observable turn.", 1 - ease((frame - starts[0]) / 8) * reset],
    ["The model proposes. Registered contracts define what can run.", ease((frame - starts[0]) / 8) * (1 - ease((frame - starts[1]) / 8)) * reset],
    ["Execution follows validated schemas, policies and dependencies.", ease((frame - starts[1]) / 8) * (1 - ease((frame - starts[2]) / 8)) * reset],
    ["Host code supplies the result and the evidence behind it.", ease((frame - starts[2]) / 8) * (1 - ease((frame - starts[3]) / 8)) * reset],
    ["A supported response and its checkpoint are committed together.", ease((frame - starts[3]) / 8) * reset],
  ];
  for (const [caption, opacity] of captions) body += `<g opacity="${opacity}">${text(56, 581, caption, 20, colors.muted)}</g>`;
  body += `${line(56, 614, 1224, 614)}
    ${label(56, 645, "DURABLE · OBSERVABLE · EVIDENCE-BACKED", colors.subtle, 12)}
    ${text(1224, 645, "Illustrative catalog fixture", 14, colors.subtle, 400, 'text-anchor="end"')}`;
  return svg(body, 672, "From intention to grounded execution", "A catalog request moves through model interpretation, kernel authorization, capability execution, grounding, and atomic commit. The model proposes; the kernel decides.");
}

function architecture() {
  const cards = [
    { x: 56, y: 238, number: "01", role: "MODEL", title: "Interpret", lines: ["Select capabilities.", "Propose typed intentions."], color: colors.violet },
    { x: 464, y: 238, number: "02", role: "KERNEL", title: "Authorize", lines: ["Validate schemas, policies", "and declared dependencies."], color: colors.accent },
    { x: 872, y: 238, number: "03", role: "HOST CODE", title: "Execute", lines: ["Run capabilities through", "injected infrastructure ports."], color: colors.amber },
    { x: 872, y: 480, number: "04", role: "KERNEL", title: "Reduce", lines: ["Publish evidenced facts.", "Update pending work."], color: colors.accent },
    { x: 464, y: 480, number: "05", role: "KERNEL + MODEL", title: "Ground", lines: ["Compose a response", "supported by evidence."], color: colors.accent },
    { x: 56, y: 480, number: "06", role: "DURABILITY ADAPTER", title: "Commit", lines: ["Store result, checkpoint", "and event outbox atomically."], color: colors.accent },
  ];
  let body = `${masthead("EXECUTION ARCHITECTURE")}
    ${text(56, 142, "Clear boundaries. Explicit authority.", 47, colors.ink, 600, 'letter-spacing="-1.8"')}
    ${text(56, 188, "One durable turn, from a user request to a supported response.", 23, colors.muted)}`;
  for (const card of cards) {
    body += `${rect(card.x, card.y, 352, 170)}
      ${label(card.x + 24, card.y + 32, `${card.number} / ${card.role}`, card.color, 12)}
      ${text(card.x + 24, card.y + 77, card.title, 33, colors.ink, 600)}
      ${text(card.x + 24, card.y + 116, card.lines[0], 20, colors.muted)}
      ${text(card.x + 24, card.y + 144, card.lines[1], 20, colors.muted)}`;
  }
  body += `${line(414, 323, 450, 323, colors.accent, 'marker-end="url(#arrow)"')}
    ${line(822, 323, 858, 323, colors.accent, 'marker-end="url(#arrow)"')}
    ${line(1048, 418, 1048, 466, colors.accent, 'marker-end="url(#arrow)"')}
    ${line(858, 565, 822, 565, colors.accent, 'marker-end="url(#arrow)"')}
    ${line(450, 565, 414, 565, colors.accent, 'marker-end="url(#arrow)"')}
    ${line(56, 690, 1224, 690)}
    ${check(69, 729)}${text(94, 736, "Writes require explicit confirmation and durable effect coordination.", 21, colors.muted)}`;
  return svg(body, 776, "Intention Kernel execution architecture", "Interpret, authorize, execute, reduce facts, ground the response, and atomically commit. Models propose intentions; the kernel validates authority; host capabilities own infrastructure access.");
}

function evaluation() {
  let body = `${masthead("PUBLIC API / INTENTION-KERNEL/TESTING")}
    ${text(56, 143, "Make every criterion explicit.", 51, colors.ink, 600, 'letter-spacing="-1.7"')}
    ${text(56, 188, "Run conversation scenarios. Inspect evidence. Iterate.", 24, colors.muted)}
    ${rect(56, 242, 364, 326)}${label(80, 278, "SCENARIO DEFINITION", colors.violet, 13)}
    ${text(80, 323, "find-products", 30, colors.ink, 600)}
    ${text(80, 357, "2 input variants · 4 criteria", 19, colors.muted)}
    ${line(80, 380, 394, 380)}
    ${rect(840, 242, 384, 326)}${label(864, 278, "REPORT + DIAGNOSTIC EVIDENCE", colors.accent, 12)}
    ${text(864, 320, "Run completed", 29, colors.ink, 600)}
    ${text(864, 355, "1 case passed · 1 case failed", 20, colors.amber)}
    ${line(864, 380, 1198, 380)}
    ${label(864, 413, "FAILED CRITERION", colors.amber, 12)}
    ${text(864, 447, "candidates-recorded", 23, colors.ink, 600)}
    ${text(864, 483, "Expected: product.candidates", 17, colors.muted)}
    ${text(864, 516, "Observed: no candidate fact", 17, colors.muted)}
    ${mark(586, 290, 100)}
    ${text(630, 430, "runEvaluation()", 26, colors.accent, 600, 'text-anchor="middle"')}
    ${text(630, 472, "Your agent. Your adapter.", 18, colors.muted, 400, 'text-anchor="middle"')}
    ${text(630, 500, "Your acceptance criteria.", 18, colors.muted, 400, 'text-anchor="middle"')}
    ${line(435, 346, 552, 346, colors.accent, 'marker-end="url(#arrow)"')}
    ${line(710, 346, 824, 346, colors.accent, 'marker-end="url(#arrow)"')}`;
  const criteria = ["Response completed", "Response grounded", "Candidates recorded", "No pending choice"];
  for (let index = 0; index < criteria.length; index++) {
    body += `${check(93, 410 + index * 37, colors.violet, 0.8)}${text(114, 417 + index * 37, criteria[index], 20, colors.muted)}`;
  }
  body += `${text(56, 625, "Execution finished ≠ acceptance passed.", 28, colors.ink, 600)}
    ${text(56, 664, "Call the public API from your application or existing test runner.", 21, colors.muted)}
    ${text(1224, 706, "Illustrative report · not a benchmark", 14, colors.subtle, 400, 'text-anchor="end"')}`;
  return svg(body, 734, "Evaluate scenarios through the public testing API", "Scenario inputs and acceptance criteria are executed by runEvaluation. Its report distinguishes completed execution from passing criteria and retains evidence for diagnosing failures. This report is illustrative.");
}

await mkdir(output, { recursive: true });
await mkdir(working, { recursive: true });
const stills = [
  ["intention-kernel-overview", hero(timeline["read-result"].start + 20)],
  ["intention-kernel-architecture", architecture()],
  ["intention-kernel-evaluation", evaluation()],
];
for (const [name, source] of stills) {
  const renderer = new Resvg(source, rendererOptions);
  await writeFile(path.join(output, `${name}.png`), renderer.render().asPng());
  // Keep the authored SVG alongside working frames; the source of truth is this script.
  await writeFile(path.join(working, `${name}.svg`), source);
}
if (!process.argv.includes("--stills")) {
  const frames = path.join(working, "frames");
  await mkdir(frames, { recursive: true });
  for (let frame = 0; frame < totalFrames; frame++) {
    const source = hero(frame);
    await writeFile(path.join(frames, `${String(frame).padStart(4, "0")}.png`), new Resvg(source, rendererOptions).render().asPng());
  }
  const pattern = path.join(frames, "%04d.png");
  const palette = path.join(working, "palette.png");
  ffmpeg(["-framerate", String(FPS), "-i", pattern, "-vf", `trim=end_frame=${totalFrames},palettegen=max_colors=192:stats_mode=full`, "-frames:v", "1", "-update", "1", palette]);
  ffmpeg(["-framerate", String(FPS), "-i", pattern, "-i", palette, "-lavfi", "paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle", "-frames:v", String(totalFrames), "-loop", "0", path.join(output, "intention-kernel-flow.gif")]);
  // A local MP4 aids frame-accurate playback review; the public README uses the GIF.
  ffmpeg(["-framerate", String(FPS), "-i", pattern, "-frames:v", String(totalFrames), "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(working, "intention-kernel-flow.mp4")]);
}
const files = [...stills.map(([name]) => `${name}.png`), "intention-kernel-flow.gif"].filter(file => existsSync(path.join(output, file)));
for (const file of files) {
  const info = await stat(path.join(output, file));
  process.stdout.write(`${file}: ${(info.size / 1024).toFixed(1)} KiB\n`);
}
process.stdout.write(`Timeline: ${totalFrames} frames, ${FPS} fps, ${totalFrames / FPS} seconds.\n`);

function ffmpeg(args) {
  const result = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? "FFmpeg failed");
}
