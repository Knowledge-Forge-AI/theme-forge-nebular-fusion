//! Native-owned target paths. Resolution never confers executable authority;
//! every consumer still authenticates the selected runtime before spawning it.
use std::path::{Path, PathBuf};

mod resource_root;

pub(crate) fn resource_dir(
    executable: &Path,
    tauri_resource_dir: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    resource_root::select_resource_root(
        executable,
        cfg!(target_os = "linux"),
        tauri::is_dev(),
        tauri_resource_dir,
    )
}

#[cfg(target_os = "macos")]
pub(crate) const O_NOFOLLOW: i32 = 0x0000_0100;

#[cfg(all(
    target_os = "linux",
    any(target_arch = "aarch64", target_arch = "x86_64")
))]
pub(crate) const O_NOFOLLOW: i32 = 0x0002_0000;

#[cfg(all(
    target_os = "linux",
    not(any(target_arch = "aarch64", target_arch = "x86_64"))
))]
compile_error!("Linux O_NOFOLLOW is only qualified for aarch64 and x86_64");

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
compile_error!("Nebular platform abstraction requires macOS or Linux");

fn target_triple(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => Some("aarch64-apple-darwin"),
        ("linux", "aarch64") => Some("aarch64-unknown-linux-gnu"),
        ("linux", "x86_64") => Some("x86_64-unknown-linux-gnu"),
        _ => None,
    }
}

pub(crate) fn is_packaged_bundle(current_exe: &Path) -> bool {
    if !tauri::is_dev() {
        return true;
    }
    current_exe
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.file_name())
        .is_some_and(|name| name == "Contents")
}

pub(crate) fn prepared_runtime(root: &Path) -> PathBuf {
    let target =
        target_triple(std::env::consts::OS, std::env::consts::ARCH).unwrap_or("unsupported-target");
    root.join("binaries")
        .join(format!("tfsb-studio-service-{target}"))
}

pub(crate) fn packaged_runtime(executable: &Path) -> PathBuf {
    executable
        .parent()
        .map(|parent| parent.join("tfsb-studio-service"))
        .unwrap_or_else(|| PathBuf::from("/nonexistent/tfsb-studio-service"))
}

pub(crate) fn development_runtime(root: &Path, executable: &Path) -> PathBuf {
    if let Some(parent) = executable.parent() {
        let sibling = parent.join("tfsb-studio-service");
        if sibling.is_file() {
            return sibling;
        }
    }
    prepared_runtime(root)
}

pub(crate) fn select_runtime(root: &Path, executable: &Path, packaged: bool) -> PathBuf {
    if packaged || !cfg!(debug_assertions) {
        packaged_runtime(executable)
    } else {
        development_runtime(root, executable)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, OpenOptions};
    use std::io;
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Self {
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path =
                std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
            let _ = fs::create_dir_all(&path);
            let path = path.canonicalize().unwrap_or(path);
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn product_target_map_has_no_foreign_fallback() {
        assert_eq!(
            target_triple("linux", "aarch64"),
            Some("aarch64-unknown-linux-gnu")
        );
        assert_eq!(
            target_triple("linux", "x86_64"),
            Some("x86_64-unknown-linux-gnu")
        );
        assert_eq!(
            target_triple("macos", "aarch64"),
            Some("aarch64-apple-darwin")
        );
        assert_eq!(target_triple("macos", "x86_64"), None);
        assert_eq!(target_triple("windows", "x86_64"), None);
    }

    #[test]
    fn hostile_path_missing_and_substituted_owned_runtime_rejected()
    -> Result<(), Box<dyn std::error::Error>> {
        let guard = TempDirGuard::new("nebular-runtime-rejection");
        let temp_dir = guard.path();
        let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));

        // Hostile environment directory containing ambient binaries
        let hostile_bin = temp_dir.join("hostile-bin");
        fs::create_dir_all(&hostile_bin)?;
        let hostile_node = hostile_bin.join("node");
        let hostile_sibling = hostile_bin.join("tfsb-studio-service");
        let sentinel = temp_dir.join("ambient-executed");
        fs::write(&hostile_node, b"#!/bin/sh\n: > \"$NEBULAR_SENTINEL\"\n")?;
        fs::set_permissions(&hostile_node, fs::Permissions::from_mode(0o755))?;
        fs::write(&hostile_sibling, b"#!/bin/sh\necho hostile-sibling\n")?;

        // 1. Missing runtime never selects ambient node or PATH commands
        let absent_app = temp_dir.join("isolated-app/bin/gui");
        let missing_root = temp_dir.join("missing-root");
        let selected_missing = development_runtime(&missing_root, &absent_app);
        assert!(selected_missing.starts_with(missing_root.join("binaries")));
        assert!(selected_missing.is_absolute());
        assert!(!selected_missing.exists());
        let rejected = std::process::Command::new(&selected_missing)
            .env_clear()
            .env("PATH", &hostile_bin)
            .env("NEBULAR_SENTINEL", &sentinel)
            .arg("--version")
            .spawn();
        assert!(rejected.is_err());
        assert!(!sentinel.exists(), "ambient runtime must never execute");
        assert_ne!(selected_missing, hostile_node);
        assert_ne!(selected_missing, hostile_sibling);

        // Missing runtime is rejected by all runner consumers
        let scene_adapter = manifest_root.join("scene-payload/bin/scene-batch.js");
        let batch_adapter = manifest_root.join("loom-payload/bin/tfsl-batch.js");
        let solar_adapter = manifest_root.join("solar-sail-adapter/solar-sail-adapter.mjs");

        let missing_scene_runner =
            crate::scene::runner::SceneRunner::new(selected_missing.clone(), scene_adapter.clone());
        assert!(!missing_scene_runner.is_available());

        let missing_theme_runner = crate::theme_lab::runner::ThemeLabRunner::new(
            selected_missing.clone(),
            batch_adapter.clone(),
        );
        assert!(!missing_theme_runner.is_available());

        let missing_app_runner =
            crate::app_theme::runner::AppThemeRunner::new(selected_missing.clone(), solar_adapter);
        assert!(!missing_app_runner.is_available());

        // 2. Substituted sibling runtime is discovered by path but rejected by cryptographic authentication
        let app_dir = temp_dir.join("app/bin");
        fs::create_dir_all(&app_dir)?;
        let app_exe = app_dir.join("gui");
        fs::write(&app_exe, b"")?;
        let substituted_sibling = app_dir.join("tfsb-studio-service");
        fs::write(
            &substituted_sibling,
            b"#!/bin/sh\necho substituted-evil-runtime\n",
        )?;

        let selected_sibling = development_runtime(manifest_root, &app_exe);
        assert_eq!(selected_sibling, substituted_sibling);
        assert!(selected_sibling.is_file());

        // Scene consumer authentication must reject the substituted sibling
        let scene_auth = crate::sidecar::scene_artifact::verify(&selected_sibling, &scene_adapter);
        assert!(scene_auth.is_err());
        assert_eq!(
            scene_auth.err().map(|e| e.reason_code()),
            Some(crate::errors::StudioReasonCode::SidecarArtifactUnavailable)
        );
        let sub_scene_runner =
            crate::scene::runner::SceneRunner::new(selected_sibling.clone(), scene_adapter);
        assert!(!sub_scene_runner.is_available());

        // Theme Lab consumer authentication must reject the substituted sibling
        let theme_auth = crate::sidecar::scene_artifact::authenticate_theme_payload(
            &selected_sibling,
            &batch_adapter,
        );
        assert!(theme_auth.is_err());
        assert_eq!(
            theme_auth.err().map(|e| e.reason_code()),
            Some(crate::errors::StudioReasonCode::SidecarArtifactUnavailable)
        );

        // Packaged runtime selection strictly resolves to bundle sibling and rejects missing
        let packaged_missing = packaged_runtime(&absent_app);
        assert_eq!(
            packaged_missing,
            absent_app
                .parent()
                .unwrap_or(Path::new("/"))
                .join("tfsb-studio-service")
        );
        assert!(!packaged_missing.exists());

        // Centralized selection matches packaged vs dev mode
        assert_eq!(
            select_runtime(manifest_root, &app_exe, true),
            packaged_runtime(&app_exe)
        );
        assert_eq!(
            select_runtime(manifest_root, &app_exe, false),
            selected_sibling
        );

        Ok(())
    }

    #[test]
    fn packaged_bundle_detection_requires_contents_ancestor() {
        let manifest_root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let non_bundle = manifest_root.join("target/debug/test-binary");
        assert!(!is_packaged_bundle(&non_bundle));

        let bundle_exe = Path::new("/Applications/TFSB.app/Contents/MacOS/tfsb-studio");
        assert!(is_packaged_bundle(bundle_exe));

        let flat_exe = Path::new("/usr/bin/tfsb-studio");
        assert!(!is_packaged_bundle(flat_exe));
    }

    #[test]
    fn nofollow_rejects_symlink_at_open() -> io::Result<()> {
        let guard = TempDirGuard::new("nebular-open");
        let root = guard.path();
        fs::write(root.join("file"), b"owned fixture")?;
        symlink("file", root.join("link"))?;
        let direct = OpenOptions::new()
            .read(true)
            .custom_flags(O_NOFOLLOW)
            .open(root.join("file"));
        let linked = OpenOptions::new()
            .read(true)
            .custom_flags(O_NOFOLLOW)
            .open(root.join("link"));
        assert!(direct.is_ok());
        assert!(linked.is_err());
        Ok(())
    }
}
