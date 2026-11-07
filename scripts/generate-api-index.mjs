#!/usr/bin/env node
/**
 * Regenerates server/dartnative-api.json from a local checkout of
 * https://github.com/DartNative/dartnative.
 *
 * Ported from jboylabo/dartnative-vscode's scripts/generate-api-index.ts, but
 * reads files from disk instead of the GitHub API, so it needs no network
 * access or dependencies — just Node 18+ and git.
 *
 *   git clone --depth 1 https://github.com/DartNative/dartnative /tmp/dartnative
 *   node scripts/generate-api-index.mjs /tmp/dartnative
 *
 * Every entry is either parsed straight out of docs/widgets.md, or an icon
 * identifier observed in real DartNative source under playground/, tutorials/
 * or plugins/. Nothing is invented.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ICON_CLASSES = [
  "MaterialSymbolsRounded",
  "MaterialSymbolsSharp",
  "MaterialSymbolsOutlined",
  "CupertinoIcons",
];

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(here, "..", "server", "dartnative-api.json");

function parseWidgetsMd(markdown) {
  const widgets = [];
  let section = "General";
  const rowRe = /^\|\s*(.+?)\s*\|\s*(✅|⚠️|❌)\s*\|(.*)\|\s*$/;
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      section = heading[1].trim();
      continue;
    }
    const m = line.match(rowRe);
    if (!m) continue;
    const [, nameCell, statusEmoji, notesCell] = m;
    if (statusEmoji === "❌") continue;
    const names = [...nameCell.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    const status = statusEmoji === "✅" ? "stable" : "partial";
    const note = notesCell.trim();
    for (const name of names) {
      if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) continue;
      widgets.push({ name, status, note, section });
    }
  }
  const seen = new Set();
  return widgets.filter((w) => {
    const key = `${w.name}|${w.section}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function walkDart(root, rel, out) {
  const abs = path.join(root, rel);
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "build") continue;
    const childRel = path.posix.join(rel, entry.name);
    if (entry.isDirectory()) walkDart(root, childRel, out);
    else if (entry.isFile() && entry.name.endsWith(".dart")) out.push(childRel);
  }
}

function main() {
  const repoDir = process.argv[2];
  if (!repoDir || !statSync(repoDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error("usage: node scripts/generate-api-index.mjs <path-to-dartnative-checkout>");
    process.exit(2);
  }

  const widgets = parseWidgetsMd(readFileSync(path.join(repoDir, "docs", "widgets.md"), "utf8"));
  console.log(`Parsed ${widgets.length} widget entries.`);

  const dartFiles = [];
  for (const top of ["playground", "tutorials", "plugins"]) {
    if (statSync(path.join(repoDir, top), { throwIfNoEntry: false })?.isDirectory()) {
      walkDart(repoDir, top, dartFiles);
    }
  }
  dartFiles.sort();

  const usages = Object.fromEntries(ICON_CLASSES.map((c) => [c, new Map()]));
  const usageRe = new RegExp(`(${ICON_CLASSES.join("|")})\\.([A-Za-z_][A-Za-z0-9_]*)`, "g");
  for (const file of dartFiles) {
    const content = readFileSync(path.join(repoDir, file), "utf8");
    for (const [, className, identifier] of content.matchAll(usageRe)) {
      if (identifier.length < 2) continue;
      const perClass = usages[className];
      if (!perClass.has(identifier)) perClass.set(identifier, new Set());
      perClass.get(identifier).add(file);
    }
  }

  const icons = Object.fromEntries(ICON_CLASSES.map((c) => [c, []]));
  for (const c of ICON_CLASSES) {
    for (const [name, files] of usages[c]) {
      icons[c].push({ name, verified: true, sourceFiles: [...files].sort() });
    }
    icons[c].sort((a, b) => a.name.localeCompare(b.name));
  }
  // docs/widgets.md: the same icon name works across Rounded / Sharp / Outlined.
  for (const target of ["MaterialSymbolsSharp", "MaterialSymbolsOutlined"]) {
    const existing = new Set(icons[target].map((e) => e.name));
    for (const e of icons.MaterialSymbolsRounded) {
      if (existing.has(e.name)) continue;
      icons[target].push({
        name: e.name,
        verified: false,
        sourceFiles: [],
        derivedFrom: "MaterialSymbolsRounded",
      });
    }
    icons[target].sort((a, b) => a.name.localeCompare(b.name));
  }
  for (const c of ICON_CLASSES) {
    console.log(`  ${c}: ${icons[c].filter((e) => e.verified).length} verified, ${icons[c].length} total`);
  }

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {}

  const index = {
    generatedAt: new Date().toISOString(),
    source: {
      repo: "https://github.com/DartNative/dartnative",
      commit,
      branch: "main",
      docs: ["docs/widgets.md"],
      scannedDartFileCount: dartFiles.length,
    },
    widgets,
    icons,
  };
  writeFileSync(OUT_FILE, JSON.stringify(index, null, 2) + "\n", "utf8");
  console.log(`Wrote ${OUT_FILE}`);
}

main();
