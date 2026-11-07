#!/usr/bin/env bash
# Builds extension.wasm without Rust, using:
#   WASI_SDK     wasi-sdk 25+       https://github.com/WebAssembly/wasi-sdk/releases
#   WIT_BINDGEN  wit-bindgen CLI    https://github.com/bytecodealliance/wit-bindgen/releases
#   WASM_TOOLS   wasm-tools         https://github.com/bytecodealliance/wasm-tools/releases
#   ZED_WIT      Zed's extension API WIT folder for API 0.6/0.7:
#                zed/crates/extension_api/wit/since_v0.6.0
#
# Output: dist/dartnative/  (copy that folder into Zed's installed-extensions folder)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
: "${WASI_SDK:?set WASI_SDK}" "${WIT_BINDGEN:?set WIT_BINDGEN}" "${WASM_TOOLS:?set WASM_TOOLS}" "${ZED_WIT:?set ZED_WIT}"

version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$root/extension.toml" | head -1)"
build="$root/target/wasm-c"
dist="$root/dist/dartnative"
rm -rf "$build" "$dist"
mkdir -p "$build/gen" "$dist"

"$WIT_BINDGEN" c "$ZED_WIT" --world extension --out-dir "$build/gen" >/dev/null

# Embed the language server and its data as byte arrays.
python3 - "$root/server" "$build/embedded.h" <<'PY'
import sys, pathlib
src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
parts = []
for name, sym in [("dartnative-lsp.js", "SERVER_JS"), ("dartnative-api.json", "API_INDEX_JSON")]:
    data = (src / name).read_bytes()
    body = ",".join(str(b) for b in data)
    parts.append(f"static const unsigned char {sym}[] = {{{body}}};\n#define {sym}_LEN {len(data)}u\n")
out.write_text("".join(parts))
PY

"$WASI_SDK/bin/clang" --target=wasm32-wasip2 -mexec-model=reactor -O2 -g0 -Wall -Wno-unused-parameter \
  -DEXTENSION_VERSION="\"$version\"" \
  -I "$build/gen" -I "$build" \
  "$here/dartnative.c" "$build/gen/extension.c" "$build/gen/extension_component_type.o" \
  -Wl,--strip-debug \
  -o "$build/extension.wasm"

# Zed picks the extension API version from a `zed:api-version` custom section
# (u16 big-endian major, minor, patch). Append it to the component: 0.7.0.
python3 - "$build/extension.wasm" "$dist/extension.wasm" <<'PY'
import sys
def leb(n):
    out = bytearray()
    while True:
        b = n & 0x7F; n >>= 7
        out.append(b | (0x80 if n else 0))
        if not n: return bytes(out)
name = b"zed:api-version"
payload = leb(len(name)) + name + bytes([0, 0, 0, 7, 0, 0])
data = open(sys.argv[1], "rb").read()
open(sys.argv[2], "wb").write(data + b"\x00" + leb(len(payload)) + payload)
PY

"$WASM_TOOLS" validate --features all "$dist/extension.wasm"

# Installed-extension manifest: same as extension.toml plus the [lib] entry Zed
# would normally add after compiling.
cp "$root/extension.toml" "$dist/extension.toml"
printf '\n[lib]\nkind = "Rust"\nversion = "0.7.0"\n' >> "$dist/extension.toml"
cp -r "$root/snippets" "$dist/snippets"
cp "$root/LICENSE" "$dist/LICENSE"

echo "built $dist/extension.wasm ($(wc -c < "$dist/extension.wasm") bytes)"
