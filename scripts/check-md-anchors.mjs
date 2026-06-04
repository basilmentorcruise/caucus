#!/usr/bin/env node
// Anchor-link checker for the repo's markdown (CAU-38).
//
// GitHub generates heading slugs (the `#anchor` fragment in a deep link) with
// its own rules: lowercase, strip a defined set of punctuation, drop emoji,
// collapse spaces to hyphens, and de-duplicate repeated slugs with `-1`, `-2`
// … suffixes. Hand-written anchors drift from that, so cross-doc links 404 to
// the top of the page. This script computes the real GitHub slug for every
// heading (via `github-slugger`, the canonical implementation) and verifies
// that every relative `[...](path#anchor)` and same-file `[...](#anchor)` link
// resolves to one.
//
// Run: `pnpm check:anchors` (also wired into `pnpm test` so drift fails CI).
// Exits non-zero and prints every broken link if anything fails to resolve.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

/** Recursively collect `.md` files under `dir` (repo-relative, /-separated). */
function findMarkdown(dir) {
  const out = [];
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...findMarkdown(rel));
    else if (entry.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// Markdown files in scope: root-level *.md and everything under docs/**.
const FILES = [
  ...readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => e.name),
  ...findMarkdown("docs"),
].sort();

/**
 * Collect every heading slug for a markdown file, mirroring GitHub: a fresh
 * slugger per file gives the duplicate-heading `-1`/`-2` suffix behaviour.
 * Lines inside fenced code blocks are not headings, so they're skipped.
 */
function slugsForFile(text) {
  const slugger = new GithubSlugger();
  const slugs = new Set();
  let inFence = false;
  let fence = "";
  for (const line of text.split("\n")) {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fence = fenceMatch[1][0];
      } else if (line.trimStart().startsWith(fence)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) slugs.add(slugger.slug(h[2]));
  }
  return slugs;
}

// Match markdown inline links `[text](target)`. The target is captured up to
// the first whitespace (which would begin an optional "title") or `)`.
const LINK_RE = /\[(?:[^\]]*)\]\(\s*([^)\s]+)[^)]*\)/g;

/** Build slug index for all in-scope files, keyed by repo-relative path. */
const slugIndex = new Map();
for (const file of FILES) {
  slugIndex.set(file, slugsForFile(readFileSync(resolve(ROOT, file), "utf8")));
}

const broken = [];
let linkCount = 0;

for (const file of FILES) {
  const text = readFileSync(resolve(ROOT, file), "utf8");
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(LINK_RE)) {
      const target = m[1];
      const hashAt = target.indexOf("#");
      if (hashAt === -1) continue; // no anchor → out of scope
      const pathPart = target.slice(0, hashAt);
      const anchor = decodeURIComponent(target.slice(hashAt + 1));

      // Skip external links (the path part has a scheme like http: / mailto:).
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
        continue;
      }

      linkCount++;

      // Resolve which file the anchor lives in.
      const targetFile = pathPart
        ? relative(ROOT, resolve(dirname(resolve(ROOT, file)), pathPart)).replaceAll("\\", "/")
        : file;

      const where = `${file}:${i + 1}`;
      const slugs = slugIndex.get(targetFile);

      if (!slugs) {
        broken.push(`${where}  ->  ${target}  (target file not in scope or missing: ${targetFile})`);
        continue;
      }
      if (!slugs.has(anchor)) {
        broken.push(`${where}  ->  ${target}  (no heading slug "#${anchor}" in ${targetFile})`);
      }
    }
  }
}

if (broken.length > 0) {
  console.error(`Checked ${linkCount} anchor link(s) across ${FILES.length} file(s).`);
  console.error(`\n${broken.length} broken anchor link(s):\n`);
  for (const b of broken) console.error(`  ${b}`);
  console.error("");
  process.exit(1);
}

console.log(`OK: ${linkCount} anchor link(s) across ${FILES.length} file(s) resolve to real headings.`);
