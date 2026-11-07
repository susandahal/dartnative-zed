#!/usr/bin/env node
"use strict";
/**
 * DartNative language server — a small, dependency-free LSP server that adds
 * DartNative-specific IntelliSense on top of the regular Dart analyzer:
 *
 *   - widget-name completion with DartNative support status (✅ / ⚠️) and notes
 *   - icon search completion (`home` → `Icon(CupertinoIcons.house_fill)`),
 *     member completion after `CupertinoIcons.` etc., auto-adding the
 *     `package:dartnative/dartnative.dart` import when it is missing
 *   - hover for widget names and icon identifiers
 *   - code actions: "Wrap with Column/Row/Center/…", "Extract to widget class",
 *     "Extract to method"
 *
 * Ported from jboylabo/dartnative-vscode (MIT). The VS Code extension API
 * calls were replaced with plain LSP over stdio so it can run in Zed (or any
 * other LSP client). The data comes from dartnative-api.json, generated from
 * DartNative's public docs and example code by scripts/generate-api-index.mjs.
 *
 * Runs on Node 18+ with no npm packages. Positions use UTF-16 code units (the
 * LSP default), which match JavaScript string indices directly.
 */

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

// ---------------------------------------------------------------------------
// API index
// ---------------------------------------------------------------------------

const ICON_CLASSES = [
  "MaterialSymbolsRounded",
  "MaterialSymbolsSharp",
  "MaterialSymbolsOutlined",
  "CupertinoIcons",
];

function loadApiIndex() {
  const file = path.join(__dirname, "dartnative-api.json");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const apiIndex = loadApiIndex();

function isIconClassName(value) {
  return ICON_CLASSES.includes(value);
}

// ---------------------------------------------------------------------------
// Pure helpers (ported from src/core/*.ts of dartnative-vscode)
// ---------------------------------------------------------------------------

function detectDartNativeDependency(pubspecYaml) {
  return /^\s*dartnative\s*:/m.test(pubspecYaml);
}

function searchWidgets(rawQuery, index = apiIndex, limit = 50) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const seen = new Set();
  const matches = index.widgets.filter((w) => {
    if (!w.name.toLowerCase().includes(query) || seen.has(w.name)) return false;
    seen.add(w.name);
    return true;
  });
  matches.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(query) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(query) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });
  return matches.slice(0, limit);
}

/** Convenience aliases, not part of DartNative's API (Cupertino says `house`, Material says `home`). */
const SEARCH_SYNONYMS = { home: ["house"], house: ["home"] };

function searchIcons(rawQuery, index = apiIndex, limit = 50) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [];
  const keywords = [query, ...(SEARCH_SYNONYMS[query] || [])];
  const results = [];
  for (const className of ICON_CLASSES) {
    for (const entry of index.icons[className] || []) {
      const hay = entry.name.toLowerCase();
      const spaced = hay.replace(/_/g, " ");
      if (!keywords.some((k) => hay.includes(k) || spaced.includes(k))) continue;
      results.push({
        className,
        name: entry.name,
        expression: `${className}.${entry.name}`,
        verified: entry.verified,
        derivedFrom: entry.derivedFrom,
      });
    }
  }
  results.sort((a, b) => {
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    const ap = a.name.toLowerCase().startsWith(query) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(query) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.localeCompare(b.name);
  });
  return results.slice(0, limit);
}

function membersOf(className, index = apiIndex) {
  return index.icons[className] || [];
}

function isInsideIconCallParen(linePrefixBeforeWord) {
  return /Icon\(\s*[A-Za-z0-9_.]*$/.test(linePrefixBeforeWord);
}

function widgetStatusLabel(widget) {
  return widget.status === "stable"
    ? "✅ Fully supported in DartNative"
    : "⚠️ Partially supported in DartNative (see notes)";
}

function iconProvenance(entry) {
  return entry.verified
    ? "Verified: used in DartNative's official example code."
    : `Derived from \`${entry.derivedFrom}\` (DartNative docs say Rounded/Sharp/Outlined share names); not yet seen in real code.`;
}

function sourceFooter() {
  return `Source: [DartNative/dartnative@${apiIndex.source.commit.slice(0, 7)}](${apiIndex.source.repo})`;
}

function hoverForToken(token, index = apiIndex) {
  const dot = token.lastIndexOf(".");
  if (dot >= 0) {
    const className = token.slice(0, dot);
    const member = token.slice(dot + 1);
    if (!isIconClassName(className)) return undefined;
    const entry = (index.icons[className] || []).find((e) => e.name === member);
    if (!entry) return undefined;
    return {
      title: `Icon(${className}.${member})`,
      lines: [
        iconProvenance(entry),
        entry.sourceFiles.length > 0 ? `Used in: ${entry.sourceFiles.slice(0, 3).join(", ")}` : "",
      ].filter((l) => l.length > 0),
    };
  }
  const widget = index.widgets.find((w) => w.name === token);
  if (widget) {
    return {
      title: widget.name,
      lines: [`${widgetStatusLabel(widget)} — ${widget.section}`, widget.note].filter((l) => l.length > 0),
    };
  }
  return undefined;
}

const OPEN_OF = { ")": "(", "]": "[", "}": "{" };

/**
 * Bracket-pair index for ()[]{} that skips strings and comments. Deliberately
 * lightweight (not a Dart parser); `${...}` interpolation reusing the
 * enclosing quote is not handled.
 */
function findBracketPairs(text) {
  const matchForward = new Map();
  const matchBackward = new Map();
  const stack = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl === -1 ? n : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if ((c === "r" || c === "R") && (text[i + 1] === "'" || text[i + 1] === '"') && !/[A-Za-z0-9_]/.test(text[i - 1] || "")) {
      const q = text[i + 1];
      const triple = text[i + 2] === q && text[i + 3] === q;
      const delim = triple ? q.repeat(3) : q;
      const end = text.indexOf(delim, i + 1 + delim.length);
      i = end === -1 ? n : end + delim.length;
      continue;
    }
    if (c === "'" || c === '"') {
      const triple = text[i + 1] === c && text[i + 2] === c;
      const delim = triple ? c.repeat(3) : c;
      i += delim.length;
      while (i < n) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text.startsWith(delim, i)) {
          i += delim.length;
          break;
        }
        i++;
      }
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      stack.push({ ch: c, idx: i });
      i++;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      const top = stack[stack.length - 1];
      if (top && top.ch === OPEN_OF[c]) {
        stack.pop();
        matchForward.set(top.idx, i);
        matchBackward.set(i, top.idx);
      }
      i++;
      continue;
    }
    i++;
  }
  return { matchForward, matchBackward };
}

function scanIdentifierBackward(text, endExclusive) {
  let i = endExclusive;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  const wordEnd = i;
  while (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1])) i--;
  if (i === wordEnd) return undefined;
  return { start: i, name: text.slice(i, wordEnd) };
}

/** Smallest enclosing bare `Uppercase(...)` call containing `offset`. */
function findWrapTarget(text, offset, pairs = findBracketPairs(text)) {
  let best;
  let bestLength = Infinity;
  for (const [openIdx, closeIdx] of pairs.matchForward) {
    if (text[openIdx] !== "(") continue;
    const id = scanIdentifierBackward(text, openIdx);
    if (!id || !/^[A-Z]/.test(id.name)) continue;
    let j = id.start - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j >= 0 && text[j] === ".") continue;
    const rangeEnd = closeIdx + 1;
    if (offset < id.start || offset > rangeEnd) continue;
    const length = rangeEnd - id.start;
    if (length < bestLength) {
      bestLength = length;
      best = { identifier: id.name, start: id.start, end: rangeEnd };
    }
  }
  return best;
}

const CLASS_HEADER_RE = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*\{/g;

function findEnclosingClass(text, offset, pairs = findBracketPairs(text)) {
  let best;
  let bestLength = Infinity;
  CLASS_HEADER_RE.lastIndex = 0;
  let m;
  while ((m = CLASS_HEADER_RE.exec(text))) {
    const openBrace = m.index + m[0].length - 1;
    const closeBrace = pairs.matchForward.get(openBrace);
    if (closeBrace === undefined) continue;
    if (offset < openBrace || offset > closeBrace) continue;
    const length = closeBrace - openBrace;
    if (length < bestLength) {
      bestLength = length;
      best = { name: m[1], headerStart: m.index, bodyStart: openBrace, bodyEnd: closeBrace + 1 };
    }
  }
  return best;
}

function lineIndentAt(text, offset) {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  let end = lineStart;
  while (end < text.length && (text[end] === " " || text[end] === "\t")) end++;
  return text.slice(lineStart, end);
}

function reindentContinuationLines(text, fromIndent, toIndent) {
  return text
    .split("\n")
    .map((line, i) => {
      if (i === 0) return line;
      const rest = line.startsWith(fromIndent) ? line.slice(fromIndent.length) : line.replace(/^[ \t]*/, "");
      return toIndent + rest;
    })
    .join("\n");
}

const WRAP_WIDGET_NAMES = ["Column", "Row", "Center", "Expanded", "Padding", "SizedBox", "Container"];

const WRAP_SPECS = {
  Column: { style: "children" },
  Row: { style: "children" },
  Center: { style: "child" },
  Expanded: { style: "child" },
  Padding: { style: "child", extraArgLines: ["padding: const EdgeInsets.all(8.0),"] },
  SizedBox: { style: "child" },
  Container: { style: "child" },
};

function buildWrapReplacement(fullText, target, wrapper) {
  const spec = WRAP_SPECS[wrapper];
  const originalText = fullText.slice(target.start, target.end);
  const lineIndent = lineIndentAt(fullText, target.start);
  const bodyIndent = lineIndent + "  ";
  const extraLines = (spec.extraArgLines || []).map((l) => bodyIndent + l);
  if (spec.style === "child") {
    const reindented = reindentContinuationLines(originalText, lineIndent, bodyIndent);
    return [`${wrapper}(`, ...extraLines, `${bodyIndent}child: ${reindented},`, `${lineIndent})`].join("\n");
  }
  const itemIndent = bodyIndent + "  ";
  const reindented = reindentContinuationLines(originalText, lineIndent, itemIndent);
  return [
    `${wrapper}(`,
    ...extraLines,
    `${bodyIndent}children: [`,
    `${itemIndent}${reindented},`,
    `${bodyIndent}],`,
    `${lineIndent})`,
  ].join("\n");
}

function buildExtractToClassEdits(fullText, target, enclosingClass, newClassName) {
  const extracted = fullText.slice(target.start, target.end);
  const reindented = reindentContinuationLines(extracted, lineIndentAt(fullText, target.start), "    ");
  const classText =
    `\nclass ${newClassName} extends StatelessWidget {\n` +
    `  const ${newClassName}({super.key});\n\n` +
    `  @override\n` +
    `  Widget build(BuildContext context) {\n` +
    `    return ${reindented};\n` +
    `  }\n` +
    `}\n`;
  return {
    usageReplacement: { start: target.start, end: target.end, text: `${newClassName}()` },
    insertion: { at: enclosingClass.bodyEnd, text: classText },
  };
}

function buildExtractToMethodEdits(fullText, target, enclosingClass, methodName) {
  const extracted = fullText.slice(target.start, target.end);
  const reindented = reindentContinuationLines(extracted, lineIndentAt(fullText, target.start), "    ");
  const methodText = `\n  Widget ${methodName}(BuildContext context) {\n` + `    return ${reindented};\n` + `  }\n`;
  return {
    usageReplacement: { start: target.start, end: target.end, text: `${methodName}(context)` },
    insertion: { at: enclosingClass.bodyEnd - 1, text: methodText },
  };
}

function nextFreeName(haystack, base) {
  if (!new RegExp(`\\b${base}\\b`).test(haystack)) return base;
  let i = 2;
  while (new RegExp(`\\b${base}${i}\\b`).test(haystack)) i++;
  return `${base}${i}`;
}

const suggestClassName = (fullText, base = "ExtractedWidget") => nextFreeName(fullText, base);
const suggestMethodName = (classBodyText, base = "_buildWidget") => nextFreeName(classBodyText, base);

const EXISTING_IMPORT_RE = /package:dartnative\/(dartnative|flutter_compat)\.dart/;
const DARTNATIVE_IMPORT = "import 'package:dartnative/dartnative.dart';\n";

/** Where to put the DartNative import: before the first existing import, else at the top. */
function importInsertOffset(text) {
  const m = /^import\s/m.exec(text);
  return m ? m.index : 0;
}

// ---------------------------------------------------------------------------
// Documents and positions
// ---------------------------------------------------------------------------

class TextDoc {
  constructor(uri, text, version) {
    this.uri = uri;
    this.version = version;
    this.setText(text);
  }
  setText(text) {
    this.text = text;
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
  }
  offsetAt(pos) {
    if (pos.line >= this.lineStarts.length) return this.text.length;
    const lineStart = this.lineStarts[Math.max(0, pos.line)];
    const lineEnd = pos.line + 1 < this.lineStarts.length ? this.lineStarts[pos.line + 1] : this.text.length;
    return Math.min(lineStart + Math.max(0, pos.character), lineEnd);
  }
  positionAt(offset) {
    offset = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo, character: offset - this.lineStarts[lo] };
  }
  lineText(line) {
    const start = this.lineStarts[line] ?? this.text.length;
    const next = line + 1 < this.lineStarts.length ? this.lineStarts[line + 1] : this.text.length;
    return this.text.slice(start, next).replace(/\r?\n$/, "");
  }
  range(start, end) {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }
}

// ---------------------------------------------------------------------------
// DartNative project detection
// ---------------------------------------------------------------------------

const pubspecCache = new Map(); // pubspec path -> { mtimeMs, isDartNative }

function nearestPubspecVerdict(filePath) {
  let dir = path.dirname(filePath);
  for (;;) {
    const candidate = path.join(dir, "pubspec.yaml");
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      stat = undefined;
    }
    if (stat && stat.isFile()) {
      const cached = pubspecCache.get(candidate);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.isDartNative;
      let isDartNative = true;
      try {
        isDartNative = detectDartNativeDependency(fs.readFileSync(candidate, "utf8"));
      } catch {}
      pubspecCache.set(candidate, { mtimeMs: stat.mtimeMs, isDartNative });
      return isDartNative;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

let enableMode = "auto"; // "auto" | "always"

/**
 * Widget/icon features only make sense in a DartNative project. A file is
 * enabled when its nearest pubspec.yaml declares `dartnative:`, or when no
 * pubspec.yaml is found at all (fail open, e.g. a loose .dart file).
 */
function isEnabledFor(uri) {
  if (enableMode === "always") return true;
  if (!uri.startsWith("file:")) return true;
  let filePath;
  try {
    filePath = fileURLToPath(uri);
  } catch {
    return true;
  }
  const verdict = nearestPubspecVerdict(filePath);
  return verdict === undefined ? true : verdict;
}

// ---------------------------------------------------------------------------
// LSP feature handlers
// ---------------------------------------------------------------------------

const CompletionItemKind = { Class: 7, Constant: 21, EnumMember: 20 };
const InsertTextFormat = { PlainText: 1 };

const CLASS_DOT_WORD_RE = new RegExp(`(?:^|[^A-Za-z0-9_.])(${ICON_CLASSES.join("|")})\\.([A-Za-z0-9_]*)$`);
const BARE_WORD_RE = /[A-Za-z_][A-Za-z0-9_]*$/;

function markdown(value) {
  return { kind: "markdown", value };
}

function iconDocs(match) {
  return markdown("```dart\nIcon(" + match.expression + ")\n```\n" + iconProvenance(match));
}

function widgetDocs(widget) {
  let md = `**${widgetStatusLabel(widget)}** — _${widget.section}_`;
  if (widget.note) md += `\n\n${widget.note}`;
  md += `\n\n---\nSource: [docs/widgets.md](${apiIndex.source.repo}/blob/${apiIndex.source.commit}/docs/widgets.md)`;
  return markdown(md);
}

/** Rough check that the cursor is in code, not in a line comment or a string on this line. */
function inCodeContext(linePrefix) {
  if (/^\s*(import|export|part)\b/.test(linePrefix)) return false;
  let quote = null;
  for (let i = 0; i < linePrefix.length; i++) {
    const c = linePrefix[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') quote = c;
    else if (c === "/" && linePrefix[i + 1] === "/") return false;
  }
  return quote === null;
}

function provideCompletion(doc, position) {
  if (!isEnabledFor(doc.uri)) return null;
  const line = doc.lineText(position.line);
  const linePrefix = line.slice(0, position.character);
  if (!inCodeContext(linePrefix)) return null;

  // `CupertinoIcons.` / `MaterialSymbolsRounded.ho` → icon members.
  const classDot = linePrefix.match(CLASS_DOT_WORD_RE);
  if (classDot) {
    const className = classDot[1];
    const word = classDot[2];
    const range = {
      start: { line: position.line, character: position.character - word.length },
      end: position,
    };
    const items = membersOf(className).map((entry) => ({
      label: entry.name,
      kind: CompletionItemKind.EnumMember,
      detail: entry.verified ? "DartNative icon (verified)" : "DartNative icon (derived)",
      documentation: iconDocs({ ...entry, className, expression: `${className}.${entry.name}` }),
      sortText: (entry.verified ? "0_" : "1_") + entry.name,
      textEdit: { range, newText: entry.name },
      insertTextFormat: InsertTextFormat.PlainText,
    }));
    return { isIncomplete: false, items };
  }

  const wordMatch = linePrefix.match(BARE_WORD_RE);
  if (!wordMatch || wordMatch[0].length < 2) return { isIncomplete: true, items: [] };
  const query = wordMatch[0];
  const wordStart = position.character - query.length;
  // `foo.bar` — a member access on something else; DartNative names don't belong here.
  if (/\.\s*$/.test(linePrefix.slice(0, wordStart))) return { isIncomplete: true, items: [] };
  const range = { start: { line: position.line, character: wordStart }, end: position };

  const items = [];
  for (const widget of searchWidgets(query)) {
    items.push({
      label: widget.name,
      kind: CompletionItemKind.Class,
      detail: `DartNative widget — ${widget.section}`,
      documentation: widgetDocs(widget),
      sortText: (widget.status === "stable" ? "0_" : "1_") + widget.name,
      filterText: widget.name,
      textEdit: { range, newText: widget.name },
      insertTextFormat: InsertTextFormat.PlainText,
    });
  }

  const icons = searchIcons(query);
  if (icons.length > 0) {
    const insideIconCall = isInsideIconCallParen(linePrefix.slice(0, wordStart));
    let additionalTextEdits;
    if (!EXISTING_IMPORT_RE.test(doc.text)) {
      const at = doc.positionAt(importInsertOffset(doc.text));
      additionalTextEdits = [{ range: { start: at, end: at }, newText: DARTNATIVE_IMPORT }];
    }
    for (const match of icons) {
      items.push({
        label: `Icon(${match.expression})`,
        kind: CompletionItemKind.Constant,
        detail: match.className,
        documentation: iconDocs(match),
        // Keep the typed word in filterText so synonym hits (home → house_fill) survive client-side filtering.
        filterText: `${query} ${match.name}`,
        sortText: (match.verified ? "2_" : "3_") + match.name,
        textEdit: { range, newText: insideIconCall ? match.expression : `Icon(${match.expression})` },
        insertTextFormat: InsertTextFormat.PlainText,
        additionalTextEdits,
      });
    }
  }

  // Results depend on the typed word (substring + synonym search), so ask to be re-queried.
  return { isIncomplete: true, items };
}

const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?/g;

function provideHover(doc, position) {
  if (!isEnabledFor(doc.uri)) return null;
  const line = doc.lineText(position.line);
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(line))) {
    const start = m.index;
    const end = start + m[0].length;
    if (position.character < start || position.character > end) continue;
    // Prefer the whole `Class.member`; if the cursor is on a plain widget name, fall back to the head.
    let token = m[0];
    let tokenEnd = end;
    let content = hoverForToken(token);
    if (!content && m[1]) {
      const head = token.slice(0, token.indexOf("."));
      if (position.character <= start + head.length) {
        token = head;
        tokenEnd = start + head.length;
        content = hoverForToken(token);
      }
    }
    if (!content) return null;
    let md = `**${content.title}**`;
    for (const l of content.lines) md += `\n\n${l}`;
    md += `\n\n---\n${sourceFooter()}`;
    return {
      contents: markdown(md),
      range: { start: { line: position.line, character: start }, end: { line: position.line, character: tokenEnd } },
    };
  }
  return null;
}

function kindAllowed(only, kind) {
  if (!only || only.length === 0) return true;
  return only.some((k) => kind === k || kind.startsWith(k + "."));
}

function provideCodeActions(doc, params) {
  if (!isEnabledFor(doc.uri)) return [];
  const only = params.context && params.context.only;
  const text = doc.text;
  const pairs = findBracketPairs(text);
  const target = findWrapTarget(text, doc.offsetAt(params.range.start), pairs);
  if (!target) return [];

  const actions = [];
  const targetRange = doc.range(target.start, target.end);

  if (kindAllowed(only, "refactor.rewrite")) {
    for (const name of WRAP_WIDGET_NAMES) {
      actions.push({
        title: `Wrap with ${name}`,
        kind: "refactor.rewrite",
        edit: { changes: { [doc.uri]: [{ range: targetRange, newText: buildWrapReplacement(text, target, name) }] } },
      });
    }
  }

  const enclosing = findEnclosingClass(text, target.start, pairs);
  if (enclosing && kindAllowed(only, "refactor.extract")) {
    const toEdits = (e) => [
      { range: doc.range(e.usageReplacement.start, e.usageReplacement.end), newText: e.usageReplacement.text },
      { range: doc.range(e.insertion.at, e.insertion.at), newText: e.insertion.text },
    ];
    const className = suggestClassName(text);
    actions.push({
      title: `Extract to widget class (${className})`,
      kind: "refactor.extract",
      edit: { changes: { [doc.uri]: toEdits(buildExtractToClassEdits(text, target, enclosing, className)) } },
    });
    const methodName = suggestMethodName(text.slice(enclosing.bodyStart, enclosing.bodyEnd));
    actions.push({
      title: `Extract to method (${methodName})`,
      kind: "refactor.extract",
      edit: { changes: { [doc.uri]: toEdits(buildExtractToMethodEdits(text, target, enclosing, methodName)) } },
    });
  }
  return actions;
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

/**
 * The Zed extension passes the user's `lsp.dartnative` settings as JSON in
 * DARTNATIVE_LSP_SETTINGS; its `initialization_options` are used here.
 */
function settingsFromEnv() {
  const raw = process.env.DARTNATIVE_LSP_SETTINGS;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    const opts = parsed && parsed.initialization_options;
    return opts && typeof opts === "object" ? opts : {};
  } catch {
    return {};
  }
}

function createServer(write) {
  const docs = new Map();
  let shuttingDown = false;

  function send(msg) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
    write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  function log(message) {
    send({ method: "window/logMessage", params: { type: 3, message } });
  }

  function handleRequest(method, params) {
    switch (method) {
      case "initialize": {
        const opts = { ...settingsFromEnv(), ...((params && params.initializationOptions) || {}) };
        if (opts.enable === "always" || opts.enable === true) enableMode = "always";
        return {
          capabilities: {
            textDocumentSync: { openClose: true, change: 1 },
            completionProvider: { triggerCharacters: ["."], resolveProvider: false },
            hoverProvider: true,
            codeActionProvider: { codeActionKinds: ["refactor.rewrite", "refactor.extract"] },
          },
          serverInfo: { name: "dartnative-lsp", version: "0.1.0" },
        };
      }
      case "shutdown":
        shuttingDown = true;
        return null;
      case "textDocument/completion": {
        const doc = docs.get(params.textDocument.uri);
        return doc ? provideCompletion(doc, params.position) : null;
      }
      case "textDocument/hover": {
        const doc = docs.get(params.textDocument.uri);
        return doc ? provideHover(doc, params.position) : null;
      }
      case "textDocument/codeAction": {
        const doc = docs.get(params.textDocument.uri);
        return doc ? provideCodeActions(doc, params) : [];
      }
      default: {
        const err = new Error(`Unhandled method ${method}`);
        err.code = -32601;
        throw err;
      }
    }
  }

  function handleNotification(method, params) {
    switch (method) {
      case "initialized":
        log(
          `dartnative-lsp ready: ${apiIndex.widgets.length} widgets, ` +
            `${ICON_CLASSES.reduce((n, c) => n + (apiIndex.icons[c] || []).length, 0)} icons ` +
            `(DartNative@${apiIndex.source.commit.slice(0, 7)})`,
        );
        break;
      case "textDocument/didOpen": {
        const td = params.textDocument;
        docs.set(td.uri, new TextDoc(td.uri, td.text, td.version));
        break;
      }
      case "textDocument/didChange": {
        const doc = docs.get(params.textDocument.uri);
        if (!doc) break;
        for (const change of params.contentChanges) {
          if (!change.range) doc.setText(change.text);
          else {
            const s = doc.offsetAt(change.range.start);
            const e = doc.offsetAt(change.range.end);
            doc.setText(doc.text.slice(0, s) + change.text + doc.text.slice(e));
          }
        }
        doc.version = params.textDocument.version;
        break;
      }
      case "textDocument/didClose":
        docs.delete(params.textDocument.uri);
        break;
      case "exit":
        process.exit(shuttingDown ? 0 : 1);
        break;
      default:
        break; // $/cancelRequest, didSave, didChangeConfiguration, … are ignored.
    }
  }

  function dispatch(msg) {
    if (msg.method === undefined) return; // a response to something we never send
    if (msg.id === undefined || msg.id === null) {
      try {
        handleNotification(msg.method, msg.params);
      } catch (e) {
        log(`error in ${msg.method}: ${e && e.stack ? e.stack : e}`);
      }
      return;
    }
    try {
      send({ id: msg.id, result: handleRequest(msg.method, msg.params) });
    } catch (e) {
      send({ id: msg.id, error: { code: e.code || -32603, message: String(e && e.message ? e.message : e) } });
    }
  }

  let buffer = Buffer.alloc(0);
  function feed(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.slice(0, headerEnd).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }
      const len = Number(m[1]);
      if (buffer.length < headerEnd + 4 + len) return;
      const body = buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8");
      buffer = buffer.slice(headerEnd + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      dispatch(msg);
    }
  }

  return { feed, docs };
}

if (require.main === module) {
  const server = createServer((buf) => process.stdout.write(buf));
  process.stdin.on("data", (chunk) => server.feed(chunk));
  process.stdin.on("end", () => process.exit(0));
} else {
  module.exports = {
    apiIndex,
    detectDartNativeDependency,
    searchWidgets,
    searchIcons,
    hoverForToken,
    findBracketPairs,
    findWrapTarget,
    findEnclosingClass,
    buildWrapReplacement,
    buildExtractToClassEdits,
    buildExtractToMethodEdits,
    suggestClassName,
    suggestMethodName,
    importInsertOffset,
    inCodeContext,
    TextDoc,
    createServer,
    provideCompletion,
    provideHover,
    provideCodeActions,
  };
}
