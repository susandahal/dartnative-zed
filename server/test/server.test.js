"use strict";
// Run with: node --test server/test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const S = require("../dartnative-lsp.js");

const target = (text, needle) => {
  const t = S.findWrapTarget(text, text.indexOf(needle));
  assert.ok(t, `no wrap target around ${needle}`);
  return t;
};

test("pubspec detection", () => {
  assert.equal(S.detectDartNativeDependency("dependencies:\n  dartnative:\n    hosted: x\n"), true);
  assert.equal(S.detectDartNativeDependency("dependencies:\n  flutter:\n    sdk: flutter\n"), false);
});

test("widget search ranks prefix matches first", () => {
  const names = S.searchWidgets("col").map((w) => w.name);
  assert.ok(names.indexOf("Column") >= 0 && names.indexOf("Column") < names.indexOf("DynamicColor"));
  assert.ok(S.searchWidgets("ListView").some((w) => w.name === "ListView"));
});

test("icon search: synonyms and verified-first ordering", () => {
  const home = S.searchIcons("home");
  assert.ok(home.some((m) => m.expression.startsWith("CupertinoIcons.house")), "home → house synonym");
  const firstUnverified = home.findIndex((m) => !m.verified);
  if (firstUnverified >= 0) assert.ok(home.slice(firstUnverified).every((m) => !m.verified));
});

test("hover for widget and icon", () => {
  const h = S.hoverForToken("Column");
  assert.equal(h.title, "Column");
  assert.match(h.lines[0], /Fully supported/);
  const icon = S.apiIndex.icons.CupertinoIcons[0].name;
  assert.equal(S.hoverForToken(`CupertinoIcons.${icon}`).title, `Icon(CupertinoIcons.${icon})`);
  assert.equal(S.hoverForToken("Foo.bar"), undefined);
});

test("findWrapTarget (ported cases)", () => {
  assert.equal(target("Text('hi')", "hi").end, "Text('hi')".length);
  assert.equal(target("Padding(child: Text('hi'))", "hi'").identifier, "Text");
  assert.equal(target("Padding(child: Text('hi'))", "child").identifier, "Padding");
  assert.equal(S.findWrapTarget("foo('x')", 5), undefined);
  assert.equal(target("Text('a)b')", "a)b").end, "Text('a)b')".length);
  assert.equal(S.findWrapTarget("Foo.Bar(1)", 8), undefined);
  assert.equal(target("Padding(padding: EdgeInsets.all(8), child: Text('x'))", "8").identifier, "Padding");
});

test("buildWrapReplacement (ported cases)", () => {
  const t1 = "      child: Text('hi'),\n";
  assert.equal(S.buildWrapReplacement(t1, target(t1, "hi'"), "Container"), "Container(\n        child: Text('hi'),\n      )");
  assert.equal(
    S.buildWrapReplacement(t1, target(t1, "hi'"), "Column"),
    "Column(\n        children: [\n          Text('hi'),\n        ],\n      )",
  );
  assert.equal(
    S.buildWrapReplacement(t1, target(t1, "hi'"), "Padding"),
    "Padding(\n        padding: const EdgeInsets.all(8.0),\n        child: Text('hi'),\n      )",
  );
  const t2 = "    child: Container(\n      color: Colors.red,\n    ),\n";
  assert.equal(
    S.buildWrapReplacement(t2, target(t2, "Container"), "Column"),
    "Column(\n      children: [\n        Container(\n          color: Colors.red,\n        ),\n      ],\n    )",
  );
});

const FIXTURE = `class MyWidget extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Text('hi');
  }
}

class Other extends StatelessWidget {}
`;

test("extract to class / method", () => {
  const t = target(FIXTURE, "Text");
  const cls = S.findEnclosingClass(FIXTURE, t.start);
  assert.equal(cls.name, "MyWidget");
  const e = S.buildExtractToClassEdits(FIXTURE, t, cls, "Extracted");
  assert.equal(e.usageReplacement.text, "Extracted()");
  assert.equal(e.insertion.at, cls.bodyEnd);
  assert.match(e.insertion.text, /class Extracted extends StatelessWidget/);
  const m = S.buildExtractToMethodEdits(FIXTURE, t, cls, "_buildWidget");
  assert.equal(m.usageReplacement.text, "_buildWidget(context)");
  assert.equal(S.suggestClassName("class ExtractedWidget {}"), "ExtractedWidget2");
});

test("code context heuristic", () => {
  assert.equal(S.inCodeContext("    return Ic"), true);
  assert.equal(S.inCodeContext("    // home"), false);
  assert.equal(S.inCodeContext("    Text('hom"), false);
  assert.equal(S.inCodeContext("import 'package:dartn"), false);
});

// ---------------------------------------------------------------------------
// End-to-end over stdio, the way Zed talks to the server.
// ---------------------------------------------------------------------------

function lspClient(env = {}) {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "dartnative-lsp.js")], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...env },
  });
  let buf = Buffer.alloc(0);
  let nextId = 1;
  const pending = new Map();
  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const he = buf.indexOf("\r\n\r\n");
      if (he < 0) return;
      const len = Number(/Content-Length: (\d+)/.exec(buf.slice(0, he).toString())[1]);
      if (buf.length < he + 4 + len) return;
      const msg = JSON.parse(buf.slice(he + 4, he + 4 + len).toString("utf8"));
      buf = buf.slice(he + 4 + len);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const write = (obj) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...obj }));
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    proc.stdin.write(body);
  };
  return {
    request: (method, params) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        write({ id, method, params });
      }),
    notify: (method, params) => write({ method, params }),
    proc,
  };
}

test("stdio round trip: completion, hover, code actions, gating", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-lsp-"));
  const appDir = path.join(dir, "app");
  const flutterDir = path.join(dir, "flutter_app");
  fs.mkdirSync(path.join(appDir, "lib"), { recursive: true });
  fs.mkdirSync(path.join(flutterDir, "lib"), { recursive: true });
  fs.writeFileSync(path.join(appDir, "pubspec.yaml"), "name: app\ndependencies:\n  dartnative:\n    hosted: https://dartpub.dev\n");
  fs.writeFileSync(path.join(flutterDir, "pubspec.yaml"), "name: f\ndependencies:\n  flutter:\n    sdk: flutter\n");

  const uri = pathToFileURL(path.join(appDir, "lib", "main.dart")).href;
  const flutterUri = pathToFileURL(path.join(flutterDir, "lib", "main.dart")).href;
  const src = "import 'dart:math';\n\nclass A extends StatelessWidget {\n  Widget build(BuildContext context) {\n    return ho\n  }\n}\n";

  const c = lspClient();
  try {
    const init = await c.request("initialize", { processId: null, rootUri: pathToFileURL(dir).href, capabilities: {} });
    assert.ok(init.result.capabilities.completionProvider);
    c.notify("initialized", {});
    c.notify("textDocument/didOpen", { textDocument: { uri, languageId: "dart", version: 1, text: src } });
    c.notify("textDocument/didOpen", { textDocument: { uri: flutterUri, languageId: "dart", version: 1, text: src } });

    // Keyword icon completion with auto-import placed before the first import.
    let res = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 4, character: 13 } });
    const house = res.result.items.find((i) => i.label.startsWith("Icon(CupertinoIcons.house"));
    assert.ok(house, "house icon offered for 'ho'");
    assert.equal(house.textEdit.range.start.character, 11);
    assert.deepEqual(house.additionalTextEdits[0].range.start, { line: 0, character: 0 });
    assert.equal(res.result.isIncomplete, true);

    // Gated off in a plain Flutter project.
    res = await c.request("textDocument/completion", { textDocument: { uri: flutterUri }, position: { line: 4, character: 13 } });
    assert.equal(res.result, null);

    // Incremental edit → member completion after `CupertinoIcons.`.
    c.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 4, character: 11 }, end: { line: 4, character: 13 } }, text: "Icon(CupertinoIcons.)" }],
    });
    res = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 4, character: 31 } });
    assert.ok(res.result.items.length >= 100, "CupertinoIcons members");
    assert.equal(res.result.items[0].kind, 20);

    // Full-text sync, then hover on a widget and on an icon identifier.
    const icon = S.apiIndex.icons.CupertinoIcons[0].name;
    const src2 = `import 'package:dartnative/dartnative.dart';\nclass A extends StatelessWidget {\n  Widget build(BuildContext context) {\n    return Center(child: Icon(CupertinoIcons.${icon}));\n  }\n}\n`;
    c.notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: src2 }] });
    res = await c.request("textDocument/hover", { textDocument: { uri }, position: { line: 3, character: 13 } });
    assert.match(res.result.contents.value, /\*\*Center\*\*/);
    res = await c.request("textDocument/hover", { textDocument: { uri }, position: { line: 3, character: 45 } });
    assert.match(res.result.contents.value, new RegExp(`Icon\\(CupertinoIcons\\.${icon}\\)`));
    // Already imported → no additionalTextEdits.
    res = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 3, character: 11 } });
    assert.ok(res.result.items.length === 0 || res.result.items.every((i) => !i.additionalTextEdits));
    res = await c.request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: { line: 3, character: 33 }, end: { line: 3, character: 33 } },
      context: { diagnostics: [] },
    });
    const titles = res.result.map((a) => a.title);
    assert.ok(titles.includes("Wrap with Center"));
    assert.ok(titles.some((t) => t.startsWith("Extract to widget class")));
    res = await c.request("textDocument/codeAction", {
      textDocument: { uri },
      range: { start: { line: 3, character: 33 }, end: { line: 3, character: 33 } },
      context: { diagnostics: [], only: ["refactor.extract"] },
    });
    assert.ok(res.result.every((a) => a.kind === "refactor.extract"));

    res = await c.request("shutdown", null);
    assert.equal(res.result, null);
    const exited = new Promise((r) => c.proc.on("exit", r));
    c.notify("exit");
    assert.equal(await exited, 0);
  } finally {
    c.proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("settings from Zed (DARTNATIVE_LSP_SETTINGS) can force-enable outside DartNative projects", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dn-lsp-"));
  fs.writeFileSync(path.join(dir, "pubspec.yaml"), "name: f\ndependencies:\n  flutter:\n    sdk: flutter\n");
  const uri = pathToFileURL(path.join(dir, "main.dart")).href;
  const c = lspClient({
    DARTNATIVE_LSP_SETTINGS: JSON.stringify({ binary: null, initialization_options: { enable: "always" }, settings: null }),
  });
  try {
    await c.request("initialize", { processId: null, capabilities: {} });
    c.notify("textDocument/didOpen", { textDocument: { uri, languageId: "dart", version: 1, text: "Widget w = Col" } });
    const res = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 0, character: 14 } });
    assert.ok(res.result.items.some((i) => i.label === "Column"));
  } finally {
    c.proc.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
