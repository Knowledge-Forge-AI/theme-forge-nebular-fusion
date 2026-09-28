//! Product resource selection; locating bytes does not authenticate them.
use std::path::{Path, PathBuf};

// Cargo's package name is the installed executable/resource slug. The focused
// wiring test binds it to the assembler's maintained APPLICATION_NAME.
const APPLICATION_NAME: &str = env!("CARGO_PKG_NAME");

pub(crate) fn select_resource_root(
    executable: &Path,
    linux: bool,
    development: bool,
    tauri_resource_dir: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if !linux || development {
        return tauri_resource_dir();
    }

    // current_exe supplies the running image, not argv[0], cwd or PATH. Resolve
    // symlinks before walking up to the package prefix. Do not canonicalize the
    // resource path: missing content must reach the existing artifact verifier,
    // never trigger a search in another installation or an ambient APPDIR.
    let executable = executable
        .canonicalize()
        .map_err(|_| "application executable unavailable".to_owned())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "application executable has no parent".to_owned())?;
    // Preserve locked Tauri's Cargo-output behavior, including release builds.
    // This selects this executable's own directory, never an ambient fallback.
    let cargo_parent = executable_dir.parent();
    let in_cargo_target = cargo_parent
        .and_then(Path::file_name)
        .is_some_and(|name| name == "target")
        || cargo_parent
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .is_some_and(|name| name == "target");
    if in_cargo_target && executable_dir.join(".cargo-lock").exists() {
        return Ok(executable_dir.to_path_buf());
    }
    let prefix = executable_dir
        .parent()
        .ok_or_else(|| "application executable has no package prefix".to_owned())?;
    Ok(prefix.join("lib").join(APPLICATION_NAME))
}
