import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, "dist");
const checkOnly = process.argv.includes("--check");

/**
 * Well-known key and token shapes. Raw 32-byte hex is intentionally absent:
 * transaction hashes use that shape, and flagging it would reject a correct bundle.
 */
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bASIA[0-9A-Z]{16}\b/,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bsk_live_[0-9a-zA-Z]{16,}/,
  /\bAIza[0-9A-Za-z\-_]{20,}/,
  /\b(?:api[_-]?key|private[_-]?key|mnemonic)\s*[:=]\s*["'][^"']{8,}["']/i,
];

if (checkOnly) {
  await checkBundle(dist);
} else {
  await build();
  await checkBundle(dist);
}

async function build() {
  await rm(dist, { recursive: true, force: true });
  const assets = path.join(dist, "assets");
  await mkdir(assets, { recursive: true });

  const jsResult = await esbuild.build({
    entryPoints: [path.join(root, "src/main.ts")],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    legalComments: "none",
    minify: true,
  });
  const js = jsResult.outputFiles[0].contents;
  const css = await readFile(path.join(root, "src/styles.css"));
  const jsName = `bridge-${sha8(js)}.js`;
  const cssName = `bridge-${sha8(css)}.css`;
  await writeFile(path.join(assets, jsName), js);
  await writeFile(path.join(assets, cssName), css);

  const htmlSrc = await readFile(path.join(root, "index.html"), "utf8");
  if (!htmlSrc.includes("/bridge/assets/bridge.js") || !htmlSrc.includes("/bridge/assets/bridge.css")) {
    throw new Error("index.html is missing the /bridge/assets/bridge.js and bridge.css placeholders");
  }
  const html = htmlSrc
    .replaceAll("/bridge/assets/bridge.css", `/bridge/assets/${cssName}`)
    .replaceAll("/bridge/assets/bridge.js", `/bridge/assets/${jsName}`);
  await writeFile(path.join(dist, "index.html"), html);
}

function sha8(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** Fails when dist contains eval, a Function constructor, inline script or style, or a token shape. */
async function checkBundle(dir) {
  let html = "";
  let jsCount = 0;
  let cssCount = 0;
  const files = await walk(dir);
  if (files.length === 0) throw new Error("dist/ is empty");

  for (const file of files) {
    const text = await readFile(file, "utf8");
    const rel = path.relative(dir, file);
    if (text.includes("eval(")) fail(rel, "eval(");
    if (text.includes("new Function")) fail(rel, "new Function");
    if (/new\s+Function\s*\(/.test(text)) fail(rel, "new Function");
    for (const pattern of TOKEN_PATTERNS) {
      if (pattern.test(text)) fail(rel, `token pattern ${pattern}`);
    }
    if (rel === "index.html") html = text;
    if (rel.startsWith("assets/") && rel.endsWith(".js")) jsCount += 1;
    if (rel.startsWith("assets/") && rel.endsWith(".css")) cssCount += 1;
  }

  if (jsCount !== 1 || cssCount !== 1) {
    throw new Error(`expected one hashed js and one hashed css, found js=${jsCount} css=${cssCount}`);
  }
  if (!html) throw new Error("dist/index.html is missing");
  assertHtml(html);
}

function assertHtml(html) {
  if (/\sstyle\s*=/i.test(html)) fail("index.html", "inline style=");
  if (/<style\b/i.test(html)) fail("index.html", "inline style element");
  const asset = /^\/bridge\/assets\/[A-Za-z0-9._-]+-[a-f0-9]{8}\.(js|css)$/;
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  if (scripts.length !== 1) fail("index.html", "expected one external script");
  const [attrs, body] = [scripts[0][1], scripts[0][2]];
  if (body.trim() !== "") fail("index.html", "inline script body");
  const src = attrs.match(/\bsrc\s*=\s*"([^"]*)"/i);
  if (!src || !asset.test(src[1]) || !src[1].endsWith(".js")) {
    fail("index.html", "script src must be an absolute /bridge/assets/*.js url");
  }
  const links = [...html.matchAll(/<link\b([^>]*)>/gi)].filter((match) =>
    /rel\s*=\s*"stylesheet"/i.test(match[1]),
  );
  if (links.length !== 1) fail("index.html", "expected one stylesheet");
  const href = links[0][1].match(/\bhref\s*=\s*"([^"]*)"/i);
  if (!href || !asset.test(href[1]) || !href[1].endsWith(".css")) {
    fail("index.html", "stylesheet href must be an absolute /bridge/assets/*.css url");
  }
  if (html.includes('="/assets/') || html.includes("='/assets/") || html.includes('="assets/')) {
    fail("index.html", "relative asset url");
  }
  if (!html.includes("<title>ForteL2 Bridge</title>")) fail("index.html", "title");
  if ((html.match(/<main\b/gi) || []).length !== 1) fail("index.html", "expected one main element");
}

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error(`dist/ is missing (${dir})`);
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function fail(file, reason) {
  throw new Error(`${file}: ${reason}`);
}
