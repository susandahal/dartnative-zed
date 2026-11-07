# DartNative for Zed

Zed extension for [DartNative](https://github.com/DartNative/dartnative) — real native iOS/Android apps written in Dart. A port of [jboylabo/dartnative-vscode](https://github.com/jboylabo/dartnative-vscode) that fills the gaps the Dart analyzer leaves in DartNative projects.

It runs **alongside** the regular Dart language server from Zed's [Dart extension](https://github.com/zed-extensions/dart), which still provides syntax highlighting, diagnostics and normal completion.

## Features

| Feature | How it works in Zed |
|---|---|
| **`stl` / `stf` snippets** | StatelessWidget / StatefulWidget in the shape real DartNative apps use. Always on. |
| **Widget completion** | ~140 widget names from DartNative's `docs/widgets.md`, with ✅ fully / ⚠️ partially supported status and the doc notes in the completion docs. |
| **Icon search** | Type `home`, `camera`, `search`… and pick `Icon(CupertinoIcons.house_fill)` etc. Inside `Icon(` only the identifier is inserted. Adds `import 'package:dartnative/dartnative.dart';` if missing. |
| **Icon members** | `CupertinoIcons.` / `MaterialSymbolsRounded.` / `…Sharp.` / `…Outlined.` list the known identifiers. |
| **Hover** | Support status + notes for widgets; provenance for icons (verified in DartNative's example code vs. derived). |
| **Code actions** (`Ctrl/Cmd + .`) | *Wrap with* Column, Row, Center, Expanded, Padding, SizedBox, Container; *Extract to widget class*; *Extract to method*. |

Widget/icon features switch on only for files whose nearest `pubspec.yaml` declares a `dartnative:` dependency (or that have no `pubspec.yaml` at all), so they stay out of plain Flutter projects.

## Requirements

- Zed with the **Dart** extension installed (Zed offers it when you open a `.dart` file).
- Nothing else: the language server is a single dependency-free JavaScript file embedded in the extension and run with the Node.js that Zed already ships.

## Install (dev extension, needs Rust)

1. Install Rust with [rustup](https://rustup.rs) (Zed builds the extension to `wasm32-wasip2` and adds that target itself).
2. In Zed: **Extensions** → **Install Dev Extension** (or the `zed: install dev extension` command) → select this folder.
3. Open a DartNative project. Check `zed: open log` if the `DartNative` server doesn't start.

## Settings

Optional, in Zed's `settings.json`:

```jsonc
{
  "lsp": {
    "dartnative": {
      // Force the features on even when pubspec.yaml lacks `dartnative:`
      "initialization_options": { "enable": "always" }
    }
  },
  // To turn the extra server off for Dart files:
  // "languages": { "Dart": { "language_servers": ["dart", "!dartnative"] } }
}
```

## Differences from the VS Code extension

- VS Code's in-process providers became a small LSP server (`server/dartnative-lsp.js`), because Zed extensions can only add editor features through a language server.
- *Extract to widget class / method* apply immediately with a free name (`ExtractedWidget`, `_buildWidget`, …) instead of prompting, since LSP code actions can't ask for input. Rename afterwards with **Rename Symbol** (F2), which the Dart analyzer handles.
- Hover and completion text are in English (the VS Code version shows Japanese).
- The widget/icon index was regenerated from DartNative `main` (`f29f38b`, 4 Nov 2026): 140 widgets (was 115) and 129 Cupertino icons (was 111).
- The Dart analyzer will also suggest widget names; DartNative's entries are the ones carrying the support status.

## Development

```sh
node --test server/test/*.test.js        # unit + stdio end-to-end tests

# Refresh the widget/icon index from a DartNative checkout
git clone --depth 1 https://github.com/DartNative/dartnative /tmp/dartnative
node scripts/generate-api-index.mjs /tmp/dartnative
```

After changing anything under `server/`, rebuild with **Rebuild** on the dev extension in Zed's Extensions page — the server is compiled into the extension.

Since DartNative itself is closed-source, the icon list only contains identifiers seen in DartNative's public example code (`playground/`, `tutorials/`, `plugins/*/example/`), not the full Material Symbols / Cupertino sets.

## Credits

Based on [dartnative-vscode](https://github.com/jboylabo/dartnative-vscode) by Junichi Hashimoto (MIT). DartNative is a product of Presence Network Inc. MIT licensed.
