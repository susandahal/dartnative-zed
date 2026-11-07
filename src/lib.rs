use std::{env, fs, path::Path};

use zed_extension_api::{self as zed, serde_json, settings::LspSettings, LanguageServerId, Result};

/// The server and its data are embedded in the extension's Wasm binary, so the
/// extension works offline and needs no npm package or GitHub release: on
/// start it writes them into its own work directory and runs them with the
/// Node.js runtime that Zed uses.
const SERVER_JS: &str = include_str!("../server/dartnative-lsp.js");
const API_INDEX_JSON: &str = include_str!("../server/dartnative-api.json");

/// Versioned folder name, so an extension update never runs stale files.
const SERVER_DIR: &str = concat!("dartnative-lsp-", env!("CARGO_PKG_VERSION"));
const SERVER_SCRIPT: &str = concat!("dartnative-lsp-", env!("CARGO_PKG_VERSION"), "/dartnative-lsp.js");
const SERVER_DATA: &str = concat!("dartnative-lsp-", env!("CARGO_PKG_VERSION"), "/dartnative-api.json");

/// Key under `lsp` in Zed's settings.json.
const SETTINGS_KEY: &str = "dartnative";

struct DartNativeExtension {
    files_written: bool,
}

impl DartNativeExtension {
    /// Writes the server into the work directory. File operations use paths
    /// *relative* to the work directory: the sandbox resolves those reliably on
    /// every OS, while an absolute host path (e.g. `C:\Users\…` on Windows) is
    /// not a valid sandbox path.
    fn ensure_server_files(&mut self) -> Result<()> {
        if self.files_written && Path::new(SERVER_SCRIPT).exists() {
            return Ok(());
        }

        fs::create_dir_all(SERVER_DIR).map_err(|e| format!("cannot create {SERVER_DIR}: {e}"))?;
        write_if_changed(SERVER_SCRIPT, SERVER_JS)?;
        write_if_changed(SERVER_DATA, API_INDEX_JSON)?;

        // Clean up servers left behind by older extension versions.
        if let Ok(entries) = fs::read_dir(".") {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("dartnative-lsp-") && name != SERVER_DIR {
                    fs::remove_dir_all(entry.path()).ok();
                }
            }
        }

        self.files_written = true;
        Ok(())
    }
}

fn write_if_changed(path: &str, contents: &str) -> Result<()> {
    if fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    fs::write(path, contents).map_err(|e| format!("cannot write {path}: {e}"))
}

impl zed::Extension for DartNativeExtension {
    fn new() -> Self {
        Self { files_written: false }
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        let binary = LspSettings::for_worktree(SETTINGS_KEY, worktree)
            .ok()
            .and_then(|s| s.binary);

        self.ensure_server_files()?;

        // The absolute host path is only needed for the command Node.js runs,
        // outside the sandbox.
        let work_dir = env::current_dir().map_err(|e| format!("cannot read work dir: {e}"))?;
        let script = format!("{}/{}", work_dir.to_string_lossy(), SERVER_SCRIPT);

        // `lsp.dartnative.binary.path` may point at a different Node.js binary.
        let node = match binary.as_ref().and_then(|b| b.path.clone()) {
            Some(path) => path,
            None => zed::node_binary_path()?,
        };

        let mut args = vec![script];
        if let Some(extra) = binary.as_ref().and_then(|b| b.arguments.clone()) {
            args.extend(extra);
        }

        let env = binary
            .and_then(|b| b.env)
            .map(|env| env.into_iter().collect())
            .unwrap_or_default();

        Ok(zed::Command {
            command: node,
            args,
            env,
        })
    }

    fn language_server_initialization_options(
        &mut self,
        _language_server_id: &LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<Option<serde_json::Value>> {
        Ok(LspSettings::for_worktree(SETTINGS_KEY, worktree)
            .ok()
            .and_then(|s| s.initialization_options))
    }
}

zed::register_extension!(DartNativeExtension);
