use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tfsb_studio_lib::app_theme::runner::AppThemeRunner;
use tfsb_studio_lib::app_theme::types::{
    ColorTokensDto, PaletteDto, SurfacesDto, ThemeSpecificationDto, TypographyDto,
};
use tfsb_studio_lib::errors::StudioReasonCode;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map_or_else(|| PathBuf::from("../../.."), |p| p.to_path_buf())
}

fn find_node() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
        repo_root().join("apps/studio/src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin"),
    ];
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for segment in path_var.split(':') {
            let candidate = PathBuf::from(segment).join("node");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    let common = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ];
    for p in &common {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("node runtime executable not found in PATH or standard locations".into())
}

fn find_real_adapter() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("solar-sail-adapter/solar-sail-adapter.mjs"),
        repo_root().join("apps/studio/src-tauri/solar-sail-adapter/solar-sail-adapter.mjs"),
    ];
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }
    Err("solar-sail-adapter.mjs not found".into())
}

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        let _ = std::fs::create_dir_all(&path);
        let path = path.canonicalize().unwrap_or(path);
        Self { path }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn sample_specification() -> ThemeSpecificationDto {
    ThemeSpecificationDto {
        schema_version: "tfss.theme-v1".to_string(),
        name: "test-theme".to_string(),
        version: "0.1.0".to_string(),
        description: Some("Test theme".to_string()),
        palette: PaletteDto {
            light: ColorTokensDto {
                background: "#ffffff".to_string(),
                foreground: "#000000".to_string(),
                card: "#ffffff".to_string(),
                card_foreground: "#000000".to_string(),
                popover: "#ffffff".to_string(),
                popover_foreground: "#000000".to_string(),
                primary: "#126475".to_string(),
                primary_foreground: "#ffffff".to_string(),
                secondary: "#f1f5f9".to_string(),
                secondary_foreground: "#0f172a".to_string(),
                muted: "#f1f5f9".to_string(),
                muted_foreground: "#64748b".to_string(),
                accent: "#f1f5f9".to_string(),
                accent_foreground: "#0f172a".to_string(),
                destructive: "#ef4444".to_string(),
                destructive_foreground: "#ffffff".to_string(),
                border: "#e2e8f0".to_string(),
                input: "#e2e8f0".to_string(),
                ring: "#126475".to_string(),
                chart1: None,
                chart2: None,
                chart3: None,
                chart4: None,
                chart5: None,
            },
            dark: ColorTokensDto {
                background: "#09090b".to_string(),
                foreground: "#fafafa".to_string(),
                card: "#09090b".to_string(),
                card_foreground: "#fafafa".to_string(),
                popover: "#09090b".to_string(),
                popover_foreground: "#fafafa".to_string(),
                primary: "#69d3e4".to_string(),
                primary_foreground: "#09090b".to_string(),
                secondary: "#27272a".to_string(),
                secondary_foreground: "#fafafa".to_string(),
                muted: "#27272a".to_string(),
                muted_foreground: "#a1a1aa".to_string(),
                accent: "#27272a".to_string(),
                accent_foreground: "#fafafa".to_string(),
                destructive: "#7f1d1d".to_string(),
                destructive_foreground: "#fafafa".to_string(),
                border: "#27272a".to_string(),
                input: "#27272a".to_string(),
                ring: "#69d3e4".to_string(),
                chart1: None,
                chart2: None,
                chart3: None,
                chart4: None,
                chart5: None,
            },
        },
        surfaces: SurfacesDto {
            radius: "0.5rem".to_string(),
            border_width: Some("1px".to_string()),
            content: Some(704),
        },
        typography: TypographyDto {
            font_sans: "Inter, sans-serif".to_string(),
            font_heading: None,
            font_mono: None,
        },
        target_overrides: None,
    }
}

#[test]
fn missing_runner_executable_fails_gracefully() -> Result<(), Box<dyn std::error::Error>> {
    let runner = AppThemeRunner::new(
        PathBuf::from("/nonexistent/node"),
        PathBuf::from("/nonexistent/adapter.mjs"),
    );
    assert!(!runner.is_available());

    let result = runner.compile(sample_specification(), Some(1));
    match result {
        Err(err) => {
            assert_eq!(
                err.reason_code(),
                StudioReasonCode::SidecarArtifactUnavailable
            );
        }
        Ok(_) => {
            return Err("expected error for missing runner, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn discovery_packaged_vs_dev_mode() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let exe = manifest_dir.join("target/debug/test-binary");
    let resource = manifest_dir.join("solar-sail-payload");

    // 1. Development discovery mode
    let dev_runner = AppThemeRunner::discover_with_mode(&resource, &exe, false);
    assert!(dev_runner.is_available(), "dev runner should be available");

    // 2. Packaged discovery mode must point to bundled sidecar and not fall back to PATH
    let pkg_runner = AppThemeRunner::discover_with_mode(&resource, &exe, true);
    let exe_parent = exe.parent().ok_or("missing parent")?;
    assert_eq!(
        pkg_runner.node_binary_path(),
        exe_parent.join("tfsb-studio-service")
    );
    assert_ne!(pkg_runner.node_binary_path(), Path::new("node"));
    assert_eq!(
        pkg_runner.adapter_path(),
        resource.join("solar-sail-adapter/solar-sail-adapter.mjs")
    );

    // 3. Packaged mode with missing resource must fail closed and not fall back to dev checkout
    let temp = TempDirGuard::new("tfsb-app-theme-discovery-test");
    let empty_resources = temp.path().join("empty-resources");
    std::fs::create_dir_all(&empty_resources)?;
    let missing_pkg_runner = AppThemeRunner::discover_with_mode(&empty_resources, &exe, true);
    assert!(!missing_pkg_runner.is_available());
    assert_eq!(
        missing_pkg_runner.adapter_path(),
        empty_resources.join("solar-sail-adapter/solar-sail-adapter.mjs")
    );

    Ok(())
}

#[test]
fn hanging_child_process_terminates_on_timeout() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-hang");
    let script_path = temp_dir.path().join("hang.js");
    std::fs::write(&script_path, "setInterval(() => {}, 1000);\n")?;

    let runner = AppThemeRunner::new(node, script_path);
    let start = std::time::Instant::now();
    let result = runner.compile(sample_specification(), Some(1));
    let duration = start.elapsed();

    assert!(duration >= Duration::from_secs(4));
    assert!(duration <= Duration::from_secs(8));

    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::RequestTimeout);
        }
        Ok(_) => {
            return Err("expected RequestTimeout error for hanging child, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn child_not_reading_stdin_handled_cleanly() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-nostdin");
    let script_path = temp_dir.path().join("nostdin.js");
    std::fs::write(
        &script_path,
        r##"
setTimeout(() => {
    const resp = {
        status: "success",
        uiRevision: 42,
        valid: true,
        compiledCss: "/* nostdin test */",
        descriptor: null,
        diagnostics: []
    };
    process.stdout.write(JSON.stringify(resp));
    process.exit(0);
}, 100);
"##,
    )?;

    let runner = AppThemeRunner::new(node, script_path);
    let result = runner.compile(sample_specification(), Some(42));
    assert!(
        result.is_ok(),
        "child ignoring stdin should succeed: {:?}",
        result.err()
    );
    let res = result?;
    assert_eq!(res.status, "success");
    assert_eq!(res.ui_revision, 42);
    Ok(())
}

#[test]
fn noisy_stderr_drained_without_deadlock() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-noisy-stderr");
    let script_path = temp_dir.path().join("noisy.js");
    std::fs::write(
        &script_path,
        r##"
process.stderr.write("E".repeat(128 * 1024));
const resp = {
    status: "success",
    uiRevision: 1,
    valid: true,
    compiledCss: "/* noisy ok */",
    descriptor: null,
    diagnostics: []
};
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = AppThemeRunner::new(node, script_path);
    let result = runner.compile(sample_specification(), Some(1));
    assert!(
        result.is_ok(),
        "noisy stderr should be drained without deadlock: {:?}",
        result.err()
    );
    Ok(())
}

#[test]
fn child_closing_stdout_early_reports_failure() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-close-stdout");
    let script_path = temp_dir.path().join("close_stdout.js");
    std::fs::write(&script_path, "process.stdout.destroy(); process.exit(0);\n")?;

    let runner = AppThemeRunner::new(node, script_path);
    let result = runner.compile(sample_specification(), Some(1));

    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid);
        }
        Ok(_) => {
            return Err("expected protocol invalid for closed stdout, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn cancellation_terminates_child() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-cancel");
    let script_path = temp_dir.path().join("hang_cancel.js");
    std::fs::write(&script_path, "setInterval(() => {}, 1000);\n")?;

    let runner = Arc::new(AppThemeRunner::new(node, script_path));
    let runner_clone = runner.clone();

    let handle = thread::spawn(move || runner_clone.compile(sample_specification(), Some(1)));

    thread::sleep(Duration::from_millis(100));
    runner.cancel_active();

    let result = handle.join().map_err(|_| "thread join failed")?;
    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::Cancelled);
        }
        Ok(_) => {
            return Err("expected Cancelled error for cancelled runner, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn real_package_export_via_runner() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let adapter = find_real_adapter()?;

    let runner = AppThemeRunner::new(node, adapter);
    assert!(runner.is_available());

    let temp = TempDirGuard::new("tfsb-app-runner-export");
    let export_dir = temp.path().join("pkg-out");
    std::fs::create_dir_all(&export_dir)?;

    let spec = sample_specification();
    let res = runner.export_package(
        spec.clone(),
        export_dir.to_string_lossy().to_string(),
        Some("typescript".to_string()),
    )?;

    assert!(!res.cancelled);
    assert_eq!(res.error, None);
    assert_eq!(
        res.destination,
        Some(export_dir.to_string_lossy().to_string())
    );
    assert_eq!(res.file_count, Some(11));

    // Verify written files
    assert!(export_dir.join("package.json").is_file());
    assert!(export_dir.join("styles/theme.css").is_file());
    assert!(export_dir.join("src/index.ts").is_file());
    assert!(export_dir.join("provenance.json").is_file());
    assert!(export_dir.join("theme.json").is_file());

    // Exporting to non-empty directory must fail closed
    let non_empty_res = runner.export_package(
        spec,
        export_dir.to_string_lossy().to_string(),
        Some("typescript".to_string()),
    );
    match non_empty_res {
        Ok(r) => {
            assert!(
                r.error.is_some(),
                "expected error when exporting to non-empty dir"
            );
        }
        Err(e) => {
            assert_eq!(e.reason_code(), StudioReasonCode::SidecarProtocolInvalid);
        }
    }

    Ok(())
}
