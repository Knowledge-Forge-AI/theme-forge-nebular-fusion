use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tfsb_studio_lib::commands::theme_lab::{open_selected_path, save_to_selected_path};
use tfsb_studio_lib::errors::StudioReasonCode;
use tfsb_studio_lib::state::theme_lab::ThemeLabState;
use tfsb_studio_lib::theme_lab::runner::ThemeLabRunner;
use tfsb_studio_lib::theme_lab::types::ThemeLabCompileRequest;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map_or_else(|| PathBuf::from("../../.."), |p| p.to_path_buf())
}

fn find_node() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let sidecar_candidates = [
        manifest_dir.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
        repo_root().join("apps/studio/src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin"),
    ];
    for candidate in &sidecar_candidates {
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
    Err("node runtime executable not found in PATH or standard locations - failing closed".into())
}

fn find_loom_batch() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("loom-payload/bin/tfsl-batch.js"),
        repo_root().join("packages/stellar-loom/bin/tfsl-batch.js"),
    ];
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "tfsl-batch.js not found in expected locations: {:?}",
        candidates
    )
    .into())
}

fn find_loom_dist() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("loom-payload/dist"),
        repo_root().join("packages/stellar-loom/dist"),
    ];
    for candidate in &candidates {
        if candidate.is_dir() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "Loom dist not found in expected locations: {:?}",
        candidates
    )
    .into())
}

fn find_loom_payload_source() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("loom-payload"),
        repo_root().join("apps/studio/src-tauri/loom-payload"),
    ];
    for candidate in &candidates {
        if candidate.is_dir() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "loom-payload source not found in expected locations: {:?}",
        candidates
    )
    .into())
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

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
        }
    }
    Ok(())
}

#[test]
fn missing_runner_executable_fails_gracefully() -> Result<(), Box<dyn std::error::Error>> {
    let runner = ThemeLabRunner::new(
        PathBuf::from("/nonexistent/node"),
        PathBuf::from("/nonexistent/batch.js"),
    );
    assert!(!runner.is_available());

    let result = runner.example("stellar-cyan".to_string(), Some(1));
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
fn nonzero_exit_code_reports_failure() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-nonzero");
    let script_path = temp_dir.path().join("exit_nonzero.js");
    std::fs::write(
        &script_path,
        "process.stderr.write('fatal boom\\n'); process.exit(1);\n",
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));

    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::SidecarCrashed);
        }
        Ok(_) => {
            return Err("expected error for nonzero exit, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn malformed_json_output_reports_failure() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-malformed");
    let script_path = temp_dir.path().join("bad_output.js");
    std::fs::write(
        &script_path,
        "process.stdout.write('not valid json {\\n'); process.exit(0);\n",
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));

    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid);
        }
        Ok(_) => {
            return Err("expected error for malformed json, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn oversized_output_reports_failure() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-oversized");
    let script_path = temp_dir.path().join("oversized.js");
    std::fs::write(
        &script_path,
        "process.stdout.write('A'.repeat(3 * 1024 * 1024));\n",
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));

    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::ResultTooLarge);
        }
        Ok(_) => {
            return Err("expected error for oversized output, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn hanging_child_process_terminates_on_timeout() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-hang");
    let script_path = temp_dir.path().join("hang.js");
    std::fs::write(&script_path, "setInterval(() => {}, 1000);\n")?;

    let runner = ThemeLabRunner::new(node, script_path);
    let start = std::time::Instant::now();
    let result = runner.example("stellar-cyan".to_string(), Some(1));
    let duration = start.elapsed();

    assert!(duration >= std::time::Duration::from_secs(4));
    assert!(duration <= std::time::Duration::from_secs(8));

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
fn child_not_reading_stdin_handled() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-nostdin");
    let script_path = temp_dir.path().join("nostdin.js");
    std::fs::write(
        &script_path,
        r##"
setTimeout(() => {
    const crypto = require("crypto");
    const css = "/* nostdin test css */";
    const digest = crypto.createHash("sha256").update(css).digest("hex");
    const resp = {
        status: "success",
        uiRevision: 1,
        valid: true,
        exampleName: "nostdin",
        specification: {
            name: "nostdin",
            version: "0.1.0",
            schemaVersion: "tfsl.theme-v1",
            adapter: "starlight-v0.42",
            colors: {
                dark: {
                    accent: { base: "#000", low: "#000", high: "#000" },
                    neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" },
                    grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" }
                },
                light: {
                    accent: { base: "#000", low: "#000", high: "#000" },
                    neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" },
                    grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" }
                }
            },
            typography: { bodyFont: "sans", codeFont: "mono" },
            layout: { contentWidth: "60rem", sidebarWidth: "18rem" }
        },
        descriptor: {
            schema: "tfsl.theme-descriptor-v1",
            schemaVersion: 1,
            themeSchemaVersion: "tfsl.theme-v1",
            themeName: "nostdin",
            themeVersion: "0.1.0",
            adapter: "starlight-v0.42",
            inputDigest: "0000000000000000000000000000000000000000000000000000000000000000",
            outputDigest: digest,
            cssFile: "theme.css",
            provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
        },
        compiledCss: css,
        diagnostics: []
    };
    process.stdout.write(JSON.stringify(resp));
    process.exit(0);
}, 200);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("nostdin".to_string(), Some(1));
    assert!(result.is_ok());
    Ok(())
}

#[test]
fn child_closing_stdout_early_reports_failure() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-close-stdout");
    let script_path = temp_dir.path().join("close_stdout.js");
    std::fs::write(&script_path, "process.stdout.destroy(); process.exit(0);\n")?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));

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
fn noisy_stderr_capped_without_error_or_leak() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-noisy-stderr");
    let script_path = temp_dir.path().join("noisy.js");
    std::fs::write(
        &script_path,
        "process.stderr.write('E'.repeat(128 * 1024)); process.exit(1);\n",
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));

    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::SidecarCrashed);
        }
        Ok(_) => {
            return Err("expected SidecarCrashed for noisy stderr nonzero exit, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn mismatched_css_digest_reports_digest_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-bad-digest");
    let script_path = temp_dir.path().join("bad_digest.js");
    std::fs::write(
        &script_path,
        r##"
const resp = {
    status: "success",
    uiRevision: 1,
    valid: true,
    exampleName: "stellar-cyan",
    specification: {
        name: "stellar-cyan",
        version: "0.1.0",
        schemaVersion: "tfsl.theme-v1",
        adapter: "starlight-v0.42",
        colors: {
            dark: {
                accent: { base: "#000", low: "#000", high: "#000" },
                neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" },
                grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" }
            },
            light: {
                accent: { base: "#000", low: "#000", high: "#000" },
                neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" },
                grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" }
            }
        },
        typography: { bodyFont: "sans", codeFont: "mono" },
        layout: { contentWidth: "60rem", sidebarWidth: "18rem" }
    },
    descriptor: {
        schema: "tfsl.theme-descriptor-v1",
        schemaVersion: 1,
        themeSchemaVersion: "tfsl.theme-v1",
        themeName: "stellar-cyan",
        themeVersion: "0.1.0",
        adapter: "starlight-v0.42",
        inputDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        outputDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        cssFile: "theme.css",
        provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
    },
    compiledCss: "/* non-empty css not matching zero digest */",
    diagnostics: []
};
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));

    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::DigestMismatch);
        }
        Ok(_) => {
            return Err("expected DigestMismatch for mismatched digest, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn cancellation_terminates_child_promptly() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-cancel");
    let script_path = temp_dir.path().join("cancel.js");
    std::fs::write(&script_path, "setInterval(() => {}, 10000);\n")?;

    let runner = ThemeLabRunner::new(node, script_path);
    let runner_clone = runner.clone();
    let cancel_handle = std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        runner_clone.cancel_active();
    });

    let start = std::time::Instant::now();
    let result = runner.example("stellar-cyan".to_string(), Some(1));
    let elapsed = start.elapsed();
    let _ = cancel_handle.join();

    assert!(elapsed < std::time::Duration::from_secs(3));
    match result {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::Cancelled);
        }
        Ok(_) => {
            return Err("expected Cancelled, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn real_tfsl_batch_runner_success_and_sha256_agreement() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;

    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    assert!(runner.is_available());

    // 1. Test example "stellar-cyan"
    let response = runner.example("stellar-cyan".to_string(), Some(42))?;
    assert_eq!(response.ui_revision, 42);
    assert!(response.valid);
    assert_eq!(response.example_name, "stellar-cyan");

    let descriptor = response
        .descriptor
        .ok_or("missing descriptor in example response")?;
    let css = response
        .compiled_css
        .ok_or("missing compiled_css in example response")?;

    assert_eq!(descriptor.adapter(), "starlight-v0.42");
    assert_eq!(descriptor.theme_name(), "stellar-cyan");
    let spec = response
        .specification
        .ok_or("missing specification in example response")?;
    assert_eq!(spec.name(), "stellar-cyan");
    assert!(!css.is_empty());

    // Verify SHA-256 agreement
    let mut hasher = Sha256::new();
    hasher.update(css.as_bytes());
    let computed_digest = format!("{:x}", hasher.finalize());
    assert_eq!(computed_digest, descriptor.output_digest());

    // 2. Test compile with the theme from example
    let compile_req = ThemeLabCompileRequest {
        session_id: None,
        ui_revision: Some(43),
        specification: spec,
        options: None,
    };
    let compile_response = runner.compile(compile_req)?;
    assert_eq!(compile_response.ui_revision, 43);
    assert!(compile_response.valid);

    let compiled_descriptor = compile_response
        .descriptor
        .ok_or("missing descriptor in compile response")?;
    let compiled_css = compile_response
        .compiled_css
        .ok_or("missing compiled_css in compile response")?;

    assert_eq!(compiled_descriptor.theme_name(), "stellar-cyan");
    let mut hasher2 = Sha256::new();
    hasher2.update(compiled_css.as_bytes());
    let compile_digest = format!("{:x}", hasher2.finalize());
    assert_eq!(compile_digest, compiled_descriptor.output_digest());
    assert_eq!(compiled_css, css);

    // 3. Test example "amber-forge"
    let amber_resp = runner.example("amber-forge".to_string(), Some(44))?;
    assert_eq!(amber_resp.ui_revision, 44);
    assert!(amber_resp.valid);
    assert_eq!(amber_resp.example_name, "amber-forge");

    let amber_desc = amber_resp.descriptor.ok_or("missing amber descriptor")?;
    let amber_css = amber_resp.compiled_css.ok_or("missing amber css")?;
    assert_eq!(amber_desc.theme_name(), "amber-forge");

    let mut hasher3 = Sha256::new();
    hasher3.update(amber_css.as_bytes());
    assert_eq!(
        format!("{:x}", hasher3.finalize()),
        amber_desc.output_digest()
    );

    Ok(())
}

#[test]
fn runner_discovery_modes_dev_and_packaged() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let exe = manifest_dir.join("target/debug/test-binary");
    let resource = manifest_dir.join("loom-payload");

    // 1. Development discovery mode
    let dev_runner = ThemeLabRunner::discover_with_mode(&resource, &exe, false);
    assert!(dev_runner.is_available(), "dev runner should be available");

    // 2. Packaged discovery mode must point to bundled sidecar and not fall back to PATH
    let pkg_runner = ThemeLabRunner::discover_with_mode(&resource, &exe, true);
    let exe_parent = exe.parent().ok_or("missing parent")?;
    assert_eq!(
        pkg_runner.node_binary_path(),
        exe_parent.join("tfsb-studio-service")
    );
    assert_ne!(pkg_runner.node_binary_path(), Path::new("node"));

    // Packaged mode with missing payload must not fall back to dev checkout
    let temp = TempDirGuard::new("tfsb-discovery-test");
    let empty_resources = temp.path().join("empty-resources");
    std::fs::create_dir_all(&empty_resources)?;
    let missing_pkg_runner = ThemeLabRunner::discover_with_mode(&empty_resources, &exe, true);
    assert!(!missing_pkg_runner.is_available());
    assert_eq!(
        missing_pkg_runner.batch_adapter_path(),
        empty_resources
            .join("loom-payload")
            .join("bin/tfsl-batch.js")
    );

    // 3. Freshly prepared application-shaped payload regression
    let app_contents = temp
        .path()
        .join("Theme Forge Nebular Fusion.app")
        .join("Contents");
    let app_macos = app_contents.join("MacOS");
    let app_resources = app_contents.join("Resources");
    std::fs::create_dir_all(&app_macos)?;
    let node = find_node()?;
    let packaged_sidecar = app_macos.join("tfsb-studio-service");
    std::fs::copy(&node, &packaged_sidecar)?;
    let app_exe = app_macos.join("theme-forge-nebular-fusion");
    let payload_source = find_loom_payload_source()?;
    copy_dir_all(&payload_source, &app_resources.join("loom-payload"))?;
    let adapter_source = manifest_dir.join("loom-adapter");
    copy_dir_all(&adapter_source, &app_resources.join("loom-adapter"))?;

    let discovered = ThemeLabRunner::discover(&app_resources, &app_exe);
    assert!(discovered.is_available());
    assert_eq!(discovered.node_binary_path(), packaged_sidecar);
    assert_eq!(
        discovered.batch_adapter_path(),
        app_resources.join("loom-payload/bin/tfsl-batch.js")
    );

    // Verify example and compile agreement on application-shaped payload
    let ex = discovered.example("stellar-cyan".to_string(), Some(1))?;
    assert!(ex.valid);
    let desc = ex.descriptor.ok_or("missing descriptor")?;
    let css = ex.compiled_css.ok_or("missing css")?;
    let mut hasher = Sha256::new();
    hasher.update(css.as_bytes());
    assert_eq!(format!("{:x}", hasher.finalize()), desc.output_digest());

    let comp = discovered.compile(ThemeLabCompileRequest {
        session_id: None,
        ui_revision: Some(2),
        specification: ex.specification.ok_or("missing spec")?,
        options: None,
    })?;
    assert!(comp.valid);
    assert_eq!(comp.compiled_css, Some(css));

    Ok(())
}

#[test]
fn selected_path_save_and_open_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    let state = ThemeLabState::new(runner);

    let ex_res = state.example("stellar-cyan".to_string(), Some(1), None)?;
    let spec = ex_res.specification.ok_or("missing specification")?;

    let temp = TempDirGuard::new("tfsb-roundtrip");
    let target_file = temp.path().join("my_theme.theme.json");

    let save_res = save_to_selected_path(Some(target_file.clone()), spec.clone(), &state)?;
    assert!(!save_res.cancelled);
    assert_eq!(
        save_res.display_name.as_deref(),
        Some("my_theme.theme.json")
    );
    assert!(target_file.is_file());

    let open_res = open_selected_path(Some(target_file.clone()), &state)?;
    assert!(!open_res.cancelled);
    assert_eq!(
        open_res.display_name.as_deref(),
        Some("my_theme.theme.json")
    );
    assert!(open_res.error.is_none());
    let loaded_spec = open_res
        .specification
        .ok_or("missing loaded specification")?;
    assert_eq!(loaded_spec.name(), spec.name());

    Ok(())
}

#[test]
fn selected_path_save_collision_detection() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    let state = ThemeLabState::new(runner);

    let ex_res = state.example("stellar-cyan".to_string(), Some(1), None)?;
    let spec = ex_res.specification.ok_or("missing specification")?;

    let temp = TempDirGuard::new("tfsb-collision");
    let target_file = temp.path().join("colliding.theme.json");
    let _ = save_to_selected_path(Some(target_file.clone()), spec.clone(), &state)?;

    // Simulate external disk edit
    std::thread::sleep(std::time::Duration::from_millis(50));
    std::fs::write(&target_file, "{\"modified\": true}")?;

    let collision_res = save_to_selected_path(Some(target_file.clone()), spec, &state);
    match collision_res {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::SelectionRejected);
        }
        Ok(_) => {
            return Err("expected SelectionRejected for collision, got Ok".into());
        }
    }

    Ok(())
}

#[test]
fn selected_path_save_validation_failure() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    let state = ThemeLabState::new(runner);

    let ex_res = state.example("stellar-cyan".to_string(), Some(1), None)?;
    let mut invalid_spec = ex_res.specification.ok_or("missing specification")?;
    match &mut invalid_spec {
        tfsb_studio_lib::theme_lab::types::ThemeDocument::V1(s) => s.name = "".to_string(),
        tfsb_studio_lib::theme_lab::types::ThemeDocument::V2(s) => s.name = "".to_string(),
    }

    let temp = TempDirGuard::new("tfsb-invalid-save");
    let target_file = temp.path().join("invalid.theme.json");
    let val_res = save_to_selected_path(Some(target_file.clone()), invalid_spec, &state);
    match val_res {
        Err(err) => {
            assert_eq!(err.reason_code(), StudioReasonCode::PlanInvalid);
        }
        Ok(_) => {
            return Err("expected PlanInvalid for invalid spec, got Ok".into());
        }
    }
    assert!(!target_file.exists());

    Ok(())
}

#[test]
fn theme_lab_state_monotonic_revision_and_leave_reenter() -> Result<(), Box<dyn std::error::Error>>
{
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    let state = ThemeLabState::new(runner);

    // Initial status reports revision 0
    let status = state.status();
    assert_eq!(status.latest_revision, 0);

    // Initial load advances revision to 5
    let ex_res = state.example("stellar-cyan".to_string(), Some(5), None)?;
    assert!(ex_res.valid);
    let spec = ex_res.specification.ok_or("missing spec")?;
    assert_eq!(state.status().latest_revision, 5);

    // Stale compile with revision 3 is rejected
    let stale_compile = state.compile(ThemeLabCompileRequest {
        session_id: None,
        ui_revision: Some(3),
        specification: spec.clone(),
        options: None,
    })?;
    assert!(!stale_compile.valid);
    assert_eq!(
        stale_compile.error.map(|e| e.code),
        Some("STALE_REVISION".to_string())
    );

    // Stale example with revision 4 is rejected
    let stale_example = state.example("amber-forge".to_string(), Some(4), None)?;
    assert!(!stale_example.valid);
    assert_eq!(
        stale_example.error.map(|e| e.code),
        Some("STALE_REVISION".to_string())
    );
    assert!(stale_example.specification.is_none());

    // Simulate leave and re-enter: UI reads status.latest_revision (5)
    let reentered_status = state.status();
    assert_eq!(reentered_status.latest_revision, 5);

    // Re-entered session sends operation 6 (greater than high-water mark 5) -> succeeds
    let reentered_load = state.example("stellar-cyan".to_string(), Some(6), None)?;
    assert!(reentered_load.valid);
    assert_eq!(state.status().latest_revision, 6);

    // Subsequent edit with revision 7 succeeds
    let edit_compile = state.compile(ThemeLabCompileRequest {
        session_id: None,
        ui_revision: Some(7),
        specification: spec,
        options: None,
    })?;
    assert!(edit_compile.valid);
    assert_eq!(state.status().latest_revision, 7);

    Ok(())
}

#[test]
fn open_file_rejection_and_error_paths() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    let state = ThemeLabState::new(runner);
    let temp = TempDirGuard::new("tfsb-open-errors");

    // 1. Invalid JSON returns structured error with code INVALID_JSON
    let invalid_json_path = temp.path().join("invalid.theme.json");
    std::fs::write(&invalid_json_path, "{ broken json ...")?;
    let res = state.open_file(invalid_json_path)?;
    assert!(!res.cancelled);
    assert!(res.specification.is_none());
    let err = res.error.ok_or("expected error for invalid json")?;
    assert_eq!(err.code, "INVALID_JSON");

    // 2. Non-regular path (directory) returns SelectionRejected
    let dir_path = temp.path().join("subdir");
    std::fs::create_dir_all(&dir_path)?;
    let dir_res = state.open_file(dir_path);
    match dir_res {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SelectionRejected),
        Ok(_) => return Err("expected SelectionRejected for directory open, got Ok".into()),
    }

    // 3. Oversize file (> 2MB) returns ResultTooLarge
    let large_path = temp.path().join("oversize.theme.json");
    let large_data = vec![b' '; 2 * 1024 * 1024 + 10];
    std::fs::write(&large_path, &large_data)?;
    let large_res = state.open_file(large_path);
    match large_res {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::ResultTooLarge),
        Ok(_) => return Err("expected ResultTooLarge for oversize open, got Ok".into()),
    }

    // 4. Permission denied returns SelectionRejected
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let no_perm_path = temp.path().join("unreadable.theme.json");
        std::fs::write(&no_perm_path, "{}")?;
        std::fs::set_permissions(&no_perm_path, std::fs::Permissions::from_mode(0o000))?;
        let perm_res = state.open_file(no_perm_path.clone());
        match perm_res {
            Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SelectionRejected),
            Ok(_) => return Err("expected SelectionRejected for unreadable open, got Ok".into()),
        }
        let _ = std::fs::set_permissions(&no_perm_path, std::fs::Permissions::from_mode(0o644));
    }

    Ok(())
}

#[test]
fn status_unknown_reports_protocol_invalid() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-unknown-status");
    let script_path = temp_dir.path().join("unknown_status.js");
    std::fs::write(
        &script_path,
        r##"
const resp = { status: "ok", uiRevision: 1, valid: true };
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));
    match result {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => return Err("expected SidecarProtocolInvalid for status: ok, got Ok".into()),
    }
    Ok(())
}

#[test]
fn incomplete_success_missing_css_reports_protocol_invalid()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-missing-css");
    let script_path = temp_dir.path().join("missing_css.js");
    std::fs::write(
        &script_path,
        r##"
const resp = {
    status: "success",
    uiRevision: 1,
    valid: true,
    exampleName: "stellar-cyan",
    specification: { name: "stellar-cyan", version: "0.1.0", schemaVersion: "tfsl.theme-v1", adapter: "starlight-v0.42", colors: { dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }, light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } } }, typography: { bodyFont: "sans", codeFont: "mono" }, layout: { contentWidth: "60rem", sidebarWidth: "18rem" } },
    descriptor: {
        schema: "tfsl.theme-descriptor-v1",
        schemaVersion: 1,
        themeSchemaVersion: "tfsl.theme-v1",
        themeName: "stellar-cyan",
        themeVersion: "0.1.0",
        adapter: "starlight-v0.42",
        inputDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        outputDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        cssFile: "theme.css",
        provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
    },
    compiledCss: null,
    diagnostics: []
};
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));
    match result {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => return Err("expected SidecarProtocolInvalid for missing css, got Ok".into()),
    }
    Ok(())
}

#[test]
fn incomplete_success_missing_descriptor_reports_protocol_invalid()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-missing-desc");
    let script_path = temp_dir.path().join("missing_desc.js");
    std::fs::write(
        &script_path,
        r##"
const resp = {
    status: "success",
    uiRevision: 1,
    valid: true,
    exampleName: "stellar-cyan",
    specification: { name: "stellar-cyan", version: "0.1.0", schemaVersion: "tfsl.theme-v1", adapter: "starlight-v0.42", colors: { dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }, light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } } }, typography: { bodyFont: "sans", codeFont: "mono" }, layout: { contentWidth: "60rem", sidebarWidth: "18rem" } },
    descriptor: null,
    compiledCss: "/* valid css */",
    diagnostics: []
};
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));
    match result {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => {
            return Err("expected SidecarProtocolInvalid for missing descriptor, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn wrong_echoed_revision_reports_protocol_invalid() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-wrong-rev");
    let script_path = temp_dir.path().join("wrong_rev.js");
    std::fs::write(
        &script_path,
        r##"
const resp = {
    status: "success",
    uiRevision: 9, // Requested was 10
    valid: true,
    exampleName: "stellar-cyan",
    specification: { name: "stellar-cyan", version: "0.1.0", schemaVersion: "tfsl.theme-v1", adapter: "starlight-v0.42", colors: { dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }, light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } } }, typography: { bodyFont: "sans", codeFont: "mono" }, layout: { contentWidth: "60rem", sidebarWidth: "18rem" } },
    descriptor: {
        schema: "tfsl.theme-descriptor-v1",
        schemaVersion: 1,
        themeSchemaVersion: "tfsl.theme-v1",
        themeName: "stellar-cyan",
        themeVersion: "0.1.0",
        adapter: "starlight-v0.42",
        inputDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        outputDigest: "0000000000000000000000000000000000000000000000000000000000000000",
        cssFile: "theme.css",
        provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
    },
    compiledCss: "/* valid css */",
    diagnostics: []
};
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(10));
    match result {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => {
            return Err("expected SidecarProtocolInvalid for wrong echoed revision, got Ok".into());
        }
    }
    Ok(())
}

#[test]
fn contradictory_error_with_css_reports_protocol_invalid() -> Result<(), Box<dyn std::error::Error>>
{
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-contradict-err");
    let script_path = temp_dir.path().join("contradict_err.js");
    std::fs::write(
        &script_path,
        r##"
const resp = {
    status: "error",
    uiRevision: 1,
    valid: false,
    error: { code: "SOME_ERROR", message: "Failed" },
    compiledCss: "/* css should not be returned on error */",
    diagnostics: []
};
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));
    match result {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => {
            return Err(
                "expected SidecarProtocolInvalid for error status with compiledCss, got Ok".into(),
            );
        }
    }
    Ok(())
}

#[test]
fn contradictory_error_valid_true_reports_protocol_invalid()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-test-contradict-valid");
    let script_path = temp_dir.path().join("contradict_valid.js");
    std::fs::write(
        &script_path,
        r##"
const resp = {
    status: "error",
    uiRevision: 1,
    valid: true, // Error status must have valid: false
    error: { code: "SOME_ERROR", message: "Failed" },
    diagnostics: []
};
process.stdout.write(JSON.stringify(resp));
process.exit(0);
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let result = runner.example("stellar-cyan".to_string(), Some(1));
    match result {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => {
            return Err(
                "expected SidecarProtocolInvalid for error status with valid: true, got Ok".into(),
            );
        }
    }
    Ok(())
}

#[test]
fn descriptor_mismatches_report_protocol_invalid() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;

    // 1. Schema mismatch
    let temp1 = TempDirGuard::new("tfsb-desc-schema");
    let p1 = temp1.path().join("desc_schema.js");
    std::fs::write(
        &p1,
        r##"
const crypto = require("crypto");
const css = "/* test */";
const d = crypto.createHash("sha256").update(css).digest("hex");
process.stdout.write(JSON.stringify({
    status: "success", uiRevision: 1, valid: true, exampleName: "stellar-cyan",
    specification: { name: "stellar-cyan", version: "0.1.0", schemaVersion: "tfsl.theme-v1", adapter: "starlight-v0.42", colors: { dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }, light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } } }, typography: { bodyFont: "sans", codeFont: "mono" }, layout: { contentWidth: "60rem", sidebarWidth: "18rem" } },
    descriptor: { schema: "wrong-schema", schemaVersion: 1, themeSchemaVersion: "tfsl.theme-v1", themeName: "stellar-cyan", themeVersion: "0.1.0", adapter: "starlight-v0.42", inputDigest: "0", outputDigest: d, cssFile: "theme.css", provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" } },
    compiledCss: css, diagnostics: []
}));
"##,
    )?;
    let runner1 = ThemeLabRunner::new(node.clone(), p1);
    match runner1.example("stellar-cyan".to_string(), Some(1)) {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => return Err("expected protocol invalid for bad descriptor schema".into()),
    }

    // 2. SchemaVersion mismatch
    let temp2 = TempDirGuard::new("tfsb-desc-version");
    let p2 = temp2.path().join("desc_version.js");
    std::fs::write(
        &p2,
        r##"
const crypto = require("crypto");
const css = "/* test */";
const d = crypto.createHash("sha256").update(css).digest("hex");
process.stdout.write(JSON.stringify({
    status: "success", uiRevision: 1, valid: true, exampleName: "stellar-cyan",
    specification: { name: "stellar-cyan", version: "0.1.0", schemaVersion: "tfsl.theme-v1", adapter: "starlight-v0.42", colors: { dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }, light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } } }, typography: { bodyFont: "sans", codeFont: "mono" }, layout: { contentWidth: "60rem", sidebarWidth: "18rem" } },
    descriptor: { schema: "tfsl.theme-descriptor-v1", schemaVersion: 99, themeSchemaVersion: "tfsl.theme-v1", themeName: "stellar-cyan", themeVersion: "0.1.0", adapter: "starlight-v0.42", inputDigest: "0", outputDigest: d, cssFile: "theme.css", provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" } },
    compiledCss: css, diagnostics: []
}));
"##,
    )?;
    let runner2 = ThemeLabRunner::new(node.clone(), p2);
    match runner2.example("stellar-cyan".to_string(), Some(1)) {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => return Err("expected protocol invalid for bad descriptor schemaVersion".into()),
    }

    // 3. Adapter mismatch
    let temp3 = TempDirGuard::new("tfsb-desc-adapter");
    let p3 = temp3.path().join("desc_adapter.js");
    std::fs::write(
        &p3,
        r##"
const crypto = require("crypto");
const css = "/* test */";
const d = crypto.createHash("sha256").update(css).digest("hex");
process.stdout.write(JSON.stringify({
    status: "success", uiRevision: 1, valid: true, exampleName: "stellar-cyan",
    specification: { name: "stellar-cyan", version: "0.1.0", schemaVersion: "tfsl.theme-v1", adapter: "starlight-v0.42", colors: { dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }, light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } } }, typography: { bodyFont: "sans", codeFont: "mono" }, layout: { contentWidth: "60rem", sidebarWidth: "18rem" } },
    descriptor: { schema: "tfsl.theme-descriptor-v1", schemaVersion: 1, themeSchemaVersion: "tfsl.theme-v1", themeName: "stellar-cyan", themeVersion: "0.1.0", adapter: "astro-v4", inputDigest: "0", outputDigest: d, cssFile: "theme.css", provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" } },
    compiledCss: css, diagnostics: []
}));
"##,
    )?;
    let runner3 = ThemeLabRunner::new(node, p3);
    match runner3.example("stellar-cyan".to_string(), Some(1)) {
        Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
        Ok(_) => return Err("expected protocol invalid for bad descriptor adapter".into()),
    }

    Ok(())
}

#[test]
fn rapid_concurrency_bounded_to_single_active_and_replaceable_pending()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-runner-concurrency");
    let script_path = temp_dir.path().join("delayed.js");

    // Script takes 150ms to simulate compilation time and tracks live concurrent children
    std::fs::write(
        &script_path,
        r##"
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
    const req = JSON.parse(raw);
    const marker = path.join(__dirname, "active_" + process.pid);
    fs.writeFileSync(marker, "active");

    const existing = fs.readdirSync(__dirname).filter(f => f.startsWith("active_"));
    const live = existing.filter(f => {
        const pid = parseInt(f.replace("active_", ""), 10);
        try { process.kill(pid, 0); return true; } catch (_) { return false; }
    });

    let max = 0;
    const maxPath = path.join(__dirname, "max_active.txt");
    try { max = parseInt(fs.readFileSync(maxPath, "utf8"), 10) || 0; } catch (_) {}
    if (live.length > max) {
        fs.writeFileSync(maxPath, String(live.length));
    }
    if (live.length > 1) {
        fs.writeFileSync(path.join(__dirname, "concurrency_violation.txt"), "live: " + live.join(","));
    }

    setTimeout(() => {
        try { fs.unlinkSync(marker); } catch (_) {}
        const css = `/* css for rev ${req.uiRevision} */`;
        const d = crypto.createHash("sha256").update(css).digest("hex");
        const resp = {
            status: "success",
            uiRevision: req.uiRevision,
            valid: true,
            exampleName: "stellar-cyan",
            specification: { name: "stellar-cyan", version: "0.1.0", schemaVersion: "tfsl.theme-v1", adapter: "starlight-v0.42", colors: { dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }, light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } } }, typography: { bodyFont: "sans", codeFont: "mono" }, layout: { contentWidth: "60rem", sidebarWidth: "18rem" } },
            descriptor: { schema: "tfsl.theme-descriptor-v1", schemaVersion: 1, themeSchemaVersion: "tfsl.theme-v1", themeName: "stellar-cyan", themeVersion: "0.1.0", adapter: "starlight-v0.42", inputDigest: "0", outputDigest: d, cssFile: "theme.css", provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" } },
            compiledCss: css,
            diagnostics: []
        };
        process.stdout.write(JSON.stringify(resp));
        process.exit(0);
    }, 150);
});
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);

    // Launch 8 rapid concurrent requests
    let mut handles = Vec::new();
    for i in 1..=8 {
        let r = runner.clone();
        handles.push(std::thread::spawn(move || {
            r.example("stellar-cyan".to_string(), Some(i))
        }));
        std::thread::sleep(std::time::Duration::from_millis(15));
    }

    let mut completed_success = 0;
    let mut cancelled_count = 0;

    for h in handles {
        match h.join().map_err(|_| "thread join failed")? {
            Ok(resp) => {
                assert!(resp.valid);
                completed_success += 1;
            }
            Err(err) => {
                if err.reason_code() == StudioReasonCode::Cancelled {
                    cancelled_count += 1;
                } else {
                    return Err(format!("unexpected error reason: {:?}", err).into());
                }
            }
        }
    }

    // Since requests were launched rapidly while each takes 150ms, intermediate requests
    // should have been superseded/cancelled, leaving at least 1 completed and at least 1 cancelled.
    assert!(completed_success >= 1);
    assert!(cancelled_count >= 1);
    assert_eq!(completed_success + cancelled_count, 8);

    // Concurrency boundary check: verify at no point did concurrent child processes exceed 1
    assert!(
        !temp_dir.path().join("concurrency_violation.txt").exists(),
        "concurrent child execution violation observed"
    );
    let max_active = std::fs::read_to_string(temp_dir.path().join("max_active.txt"))
        .unwrap_or_default()
        .trim()
        .parse::<usize>()
        .unwrap_or(0);
    assert!(
        max_active <= 1,
        "max concurrent active children was {}",
        max_active
    );

    Ok(())
}

#[test]
fn node_compile_theme_independent_bit_for_bit_agreement() -> Result<(), Box<dyn std::error::Error>>
{
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let dist_index = find_loom_dist()?.join("index.js");

    let runner = ThemeLabRunner::new(node.clone(), batch_script);
    let example_resp = runner.example("stellar-cyan".to_string(), Some(1))?;
    let spec = example_resp
        .specification
        .ok_or("missing spec from example")?;
    let runner_css = example_resp.compiled_css.ok_or("missing runner css")?;
    let runner_desc = example_resp.descriptor.ok_or("missing runner descriptor")?;

    // Directly call compileTheme via Node and import from dist
    let test_script = format!(
        r#"
import {{ compileTheme, STELLAR_CYAN_EXAMPLE }} from "file://{}";
const res = compileTheme(STELLAR_CYAN_EXAMPLE);
process.stdout.write(JSON.stringify({{
    css: res.css,
    outputDigest: res.descriptor.outputDigest,
    schema: res.descriptor.schema,
    adapter: res.descriptor.adapter
}}));
"#,
        dist_index.display()
    );

    let child = std::process::Command::new(node)
        .arg("--input-type=module")
        .arg("-e")
        .arg(test_script)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()?;

    let output = child.wait_with_output()?;
    assert!(output.status.success(), "direct node compile failed");

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DirectNodeOutput {
        css: String,
        output_digest: String,
        schema: String,
        adapter: String,
    }

    let direct: DirectNodeOutput = serde_json::from_slice(&output.stdout)?;

    // Bit-for-bit independent verification
    assert_eq!(runner_css, direct.css, "compiled CSS bit-for-bit mismatch");
    assert_eq!(
        runner_desc.output_digest(),
        direct.output_digest,
        "output digest mismatch"
    );
    assert_eq!(runner_desc.schema(), direct.schema);
    assert_eq!(runner_desc.adapter(), direct.adapter);
    assert_eq!(spec.name(), "stellar-cyan");

    Ok(())
}

#[test]
fn theme_lab_state_superseded_compile_rejects_stale_success()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-state-stale-compile");
    let script_path = temp_dir.path().join("delayed_compile.js");

    std::fs::write(
        &script_path,
        r##"
const crypto = require("crypto");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
    const req = JSON.parse(raw);
    setTimeout(() => {
        const css = `/* compiled rev ${req.uiRevision} */`;
        const d = crypto.createHash("sha256").update(css).digest("hex");
        const resp = {
            status: "success",
            uiRevision: req.uiRevision,
            valid: true,
            specification: req.specification,
            descriptor: {
                schema: "tfsl.theme-descriptor-v1",
                schemaVersion: 1,
                themeSchemaVersion: "tfsl.theme-v1",
                themeName: req.specification ? req.specification.name : "custom",
                themeVersion: "0.1.0",
                adapter: "starlight-v0.42",
                inputDigest: "0",
                outputDigest: d,
                cssFile: "theme.css",
                provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
            },
            compiledCss: css,
            diagnostics: []
        };
        process.stdout.write(JSON.stringify(resp));
        process.exit(0);
    }, 120);
});
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let state = ThemeLabState::new(runner);

    let spec = tfsb_studio_lib::theme_lab::types::ThemeSpecification {
        schema: None,
        name: "test-theme".to_string(),
        version: "0.1.0".to_string(),
        schema_version: "tfsl.theme-v1".to_string(),
        adapter: "starlight-v0.42".to_string(),
        colors: tfsb_studio_lib::theme_lab::types::ThemeColors {
            dark: tfsb_studio_lib::theme_lab::types::ThemePalette {
                accent: tfsb_studio_lib::theme_lab::types::ThemePaletteAccent {
                    base: "#000".into(),
                    low: "#000".into(),
                    high: "#000".into(),
                },
                neutrals: tfsb_studio_lib::theme_lab::types::ThemePaletteNeutrals {
                    bg: "#000".into(),
                    bg_nav: "#000".into(),
                    bg_sidebar: "#000".into(),
                    bg_inline_code: "#000".into(),
                    bg_accent: "#000".into(),
                    text: "#000".into(),
                    text_accent: "#000".into(),
                    text_invert: "#000".into(),
                    hairline: "#000".into(),
                    hairline_light: "#000".into(),
                    hairline_shade: "#000".into(),
                },
                grays: tfsb_studio_lib::theme_lab::types::ThemePaletteGrays {
                    gray1: "#000".into(),
                    gray2: "#000".into(),
                    gray3: "#000".into(),
                    gray4: "#000".into(),
                    gray5: "#000".into(),
                    gray6: "#000".into(),
                    gray7: "#000".into(),
                },
            },
            light: tfsb_studio_lib::theme_lab::types::ThemePalette {
                accent: tfsb_studio_lib::theme_lab::types::ThemePaletteAccent {
                    base: "#000".into(),
                    low: "#000".into(),
                    high: "#000".into(),
                },
                neutrals: tfsb_studio_lib::theme_lab::types::ThemePaletteNeutrals {
                    bg: "#000".into(),
                    bg_nav: "#000".into(),
                    bg_sidebar: "#000".into(),
                    bg_inline_code: "#000".into(),
                    bg_accent: "#000".into(),
                    text: "#000".into(),
                    text_accent: "#000".into(),
                    text_invert: "#000".into(),
                    hairline: "#000".into(),
                    hairline_light: "#000".into(),
                    hairline_shade: "#000".into(),
                },
                grays: tfsb_studio_lib::theme_lab::types::ThemePaletteGrays {
                    gray1: "#000".into(),
                    gray2: "#000".into(),
                    gray3: "#000".into(),
                    gray4: "#000".into(),
                    gray5: "#000".into(),
                    gray6: "#000".into(),
                    gray7: "#000".into(),
                },
            },
        },
        typography: tfsb_studio_lib::theme_lab::types::ThemeTypography {
            body_font: "sans".into(),
            code_font: "mono".into(),
            base_font_size: None,
            line_height: None,
        },
        layout: tfsb_studio_lib::theme_lab::types::ThemeLayout {
            content_width: "60rem".into(),
            sidebar_width: "18rem".into(),
        },
    };

    // 1. Thread 1 launches compile with revision 1
    let state_clone = state.clone();
    let spec_clone = spec.clone();
    let handle1 = std::thread::spawn(move || {
        state_clone.compile(ThemeLabCompileRequest {
            specification: spec_clone.into(),
            options: None,
            ui_revision: Some(1),
            session_id: None,
        })
    });

    std::thread::sleep(std::time::Duration::from_millis(30));

    // 2. Thread 2 launches compile with revision 2 (superseding revision 1)
    let state_clone2 = state.clone();
    let spec_clone2 = spec.clone();
    let handle2 = std::thread::spawn(move || {
        state_clone2.compile(ThemeLabCompileRequest {
            specification: spec_clone2.into(),
            options: None,
            ui_revision: Some(2),
            session_id: None,
        })
    });

    let res1 = handle1.join().map_err(|_| "thread 1 failed")??;
    let res2 = handle2.join().map_err(|_| "thread 2 failed")??;

    // Revision 1 must be rejected as stale because revision 2 superseded it
    assert!(!res1.valid, "stale compile revision 1 should be rejected");
    assert_eq!(
        res1.error.as_ref().map(|e| e.code.as_str()),
        Some("STALE_REVISION")
    );
    assert!(res1.compiled_css.is_none());

    // Revision 2 is the winning latest revision and succeeds
    assert!(res2.valid, "latest compile revision 2 should succeed");
    assert!(res2.compiled_css.is_some());
    assert_eq!(state.status().latest_revision, 2);

    Ok(())
}

#[test]
fn theme_lab_state_cancelled_compile_rejects_stale_success()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-state-cancel-compile");
    let script_path = temp_dir.path().join("cancel_compile.js");

    std::fs::write(
        &script_path,
        r##"
const crypto = require("crypto");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
    const req = JSON.parse(raw);
    setTimeout(() => {
        const css = `/* compiled rev ${req.uiRevision} */`;
        const d = crypto.createHash("sha256").update(css).digest("hex");
        const resp = {
            status: "success",
            uiRevision: req.uiRevision,
            valid: true,
            specification: req.specification,
            descriptor: {
                schema: "tfsl.theme-descriptor-v1",
                schemaVersion: 1,
                themeSchemaVersion: "tfsl.theme-v1",
                themeName: "cancel-theme",
                themeVersion: "0.1.0",
                adapter: "starlight-v0.42",
                inputDigest: "0",
                outputDigest: d,
                cssFile: "theme.css",
                provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
            },
            compiledCss: css,
            diagnostics: []
        };
        process.stdout.write(JSON.stringify(resp));
        process.exit(0);
    }, 150);
});
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let state = ThemeLabState::new(runner);

    let batch_script = find_loom_batch()?;
    let batch_runner = ThemeLabRunner::new(find_node()?, batch_script);
    let batch_state = ThemeLabState::new(batch_runner);
    let ex = batch_state.example("stellar-cyan".to_string(), Some(1), None)?;
    let spec = ex.specification.ok_or("missing spec")?;

    let state_clone = state.clone();
    let spec_clone = spec.clone();
    let handle = std::thread::spawn(move || {
        state_clone.compile(ThemeLabCompileRequest {
            specification: spec_clone,
            options: None,
            ui_revision: Some(1),
            session_id: None,
        })
    });

    std::thread::sleep(std::time::Duration::from_millis(30));
    state.cancel_active();

    let res = handle.join().map_err(|_| "thread join failed")??;
    assert!(!res.valid, "cancelled compile should return valid: false");
    assert_eq!(
        res.error.as_ref().map(|e| e.code.as_str()),
        Some("STALE_REVISION")
    );
    assert!(res.compiled_css.is_none());

    Ok(())
}

#[test]
fn theme_lab_state_out_of_order_example_rejects_stale_and_preserves_state()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-state-stale-example");
    let script_path = temp_dir.path().join("delayed_example.js");

    std::fs::write(
        &script_path,
        r##"
const crypto = require("crypto");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
    const req = JSON.parse(raw);
    const exName = req.exampleName || "stellar-cyan";
    const delay = exName.includes("amber") ? 150 : 20;
    setTimeout(() => {
        const css = `/* example ${exName} rev ${req.uiRevision} */`;
        const d = crypto.createHash("sha256").update(css).digest("hex");
        const resp = {
            status: "success",
            uiRevision: req.uiRevision,
            valid: true,
            exampleName: exName,
            specification: {
                name: exName,
                version: "0.1.0",
                schemaVersion: "tfsl.theme-v1",
                adapter: "starlight-v0.42",
                colors: {
                    dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } },
                    light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }
                },
                typography: { bodyFont: "sans", codeFont: "mono" },
                layout: { contentWidth: "60rem", sidebarWidth: "18rem" }
            },
            descriptor: {
                schema: "tfsl.theme-descriptor-v1",
                schemaVersion: 1,
                themeSchemaVersion: "tfsl.theme-v1",
                themeName: exName,
                themeVersion: "0.1.0",
                adapter: "starlight-v0.42",
                inputDigest: "0",
                outputDigest: d,
                cssFile: "theme.css",
                provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
            },
            compiledCss: css,
            diagnostics: []
        };
        process.stdout.write(JSON.stringify(resp));
        process.exit(0);
    }, delay);
});
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let state = ThemeLabState::new(runner);

    // Initial baseline: revision 1 with stellar-cyan
    let base = state.example("stellar-cyan".to_string(), Some(1), None)?;
    assert!(base.valid);
    assert_eq!(
        state.active_display_name()?.as_deref(),
        Some("stellar-cyan.theme.json")
    );
    assert_eq!(state.status().latest_revision, 1);

    // 1. Thread 1 launches amber-forge with revision 2 (slow, 150ms)
    let state_clone = state.clone();
    let handle1 =
        std::thread::spawn(move || state_clone.example("amber-forge".to_string(), Some(2), None));

    std::thread::sleep(std::time::Duration::from_millis(30));

    // 2. Thread 2 launches stellar-cyan with revision 3 (fast, 20ms)
    let state_clone2 = state.clone();
    let handle2 =
        std::thread::spawn(move || state_clone2.example("stellar-cyan".to_string(), Some(3), None));

    let res2 = handle2.join().map_err(|_| "thread 2 join failed")??;
    assert!(res2.valid, "fast revision 3 should succeed");
    assert_eq!(res2.ui_revision, 3);
    assert_eq!(
        state.active_display_name()?.as_deref(),
        Some("stellar-cyan.theme.json")
    );
    assert_eq!(state.status().latest_revision, 3);

    let res1 = handle1.join().map_err(|_| "thread 1 join failed")??;

    // Revision 2 must be rejected as STALE because revision 3 superseded it
    assert!(!res1.valid, "slow revision 2 must be rejected as stale");
    assert_eq!(
        res1.error.as_ref().map(|e| e.code.as_str()),
        Some("STALE_REVISION")
    );
    assert!(res1.specification.is_none());

    // CRITICAL: session state must NOT have been contaminated by the stale amber-forge!
    assert_eq!(
        state.active_display_name()?.as_deref(),
        Some("stellar-cyan.theme.json"),
        "active_display_name must remain stellar-cyan from winning revision 3"
    );
    assert_eq!(state.status().latest_revision, 3);

    Ok(())
}

#[test]
fn theme_lab_state_cancelled_example_rejects_and_preserves_state()
-> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let temp_dir = TempDirGuard::new("tfsb-state-cancel-example");
    let script_path = temp_dir.path().join("cancel_example.js");

    std::fs::write(
        &script_path,
        r##"
const crypto = require("crypto");
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
    const req = JSON.parse(raw);
    setTimeout(() => {
        const css = `/* example rev ${req.uiRevision} */`;
        const d = crypto.createHash("sha256").update(css).digest("hex");
        const resp = {
            status: "success",
            uiRevision: req.uiRevision,
            valid: true,
            exampleName: req.exampleName || "amber-forge",
            specification: {
                name: req.exampleName || "amber-forge",
                version: "0.1.0",
                schemaVersion: "tfsl.theme-v1",
                adapter: "starlight-v0.42",
                colors: {
                    dark: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } },
                    light: { accent: { base: "#000", low: "#000", high: "#000" }, neutrals: { bg: "#000", bgNav: "#000", bgSidebar: "#000", bgInlineCode: "#000", bgAccent: "#000", text: "#000", textAccent: "#000", textInvert: "#000", hairline: "#000", hairlineLight: "#000", hairlineShade: "#000" }, grays: { gray1: "#000", gray2: "#000", gray3: "#000", gray4: "#000", gray5: "#000", gray6: "#000", gray7: "#000" } }
                },
                typography: { bodyFont: "sans", codeFont: "mono" },
                layout: { contentWidth: "60rem", sidebarWidth: "18rem" }
            },
            descriptor: {
                schema: "tfsl.theme-descriptor-v1",
                schemaVersion: 1,
                themeSchemaVersion: "tfsl.theme-v1",
                themeName: req.exampleName || "amber-forge",
                themeVersion: "0.1.0",
                adapter: "starlight-v0.42",
                inputDigest: "0",
                outputDigest: d,
                cssFile: "theme.css",
                provenance: { categories: [], compiler: "tfsl", compilerVersion: "0.1.0" }
            },
            compiledCss: css,
            diagnostics: []
        };
        process.stdout.write(JSON.stringify(resp));
        process.exit(0);
    }, 150);
});
"##,
    )?;

    let runner = ThemeLabRunner::new(node, script_path);
    let state = ThemeLabState::new(runner);

    let state_clone = state.clone();
    let handle =
        std::thread::spawn(move || state_clone.example("amber-forge".to_string(), Some(1), None));

    std::thread::sleep(std::time::Duration::from_millis(30));
    state.cancel_active();

    let res = handle.join().map_err(|_| "thread join failed")??;
    assert!(!res.valid, "cancelled example should return valid: false");
    assert_eq!(
        res.error.as_ref().map(|e| e.code.as_str()),
        Some("STALE_REVISION")
    );
    assert!(res.specification.is_none());

    // Verify session state was not set to amber-forge
    assert_eq!(state.active_display_name()?, None);

    Ok(())
}

fn load_sample_v2_theme()
-> Result<tfsb_studio_lib::theme_lab::types::ThemeDocument, Box<dyn std::error::Error>> {
    let payload_source = find_loom_payload_source()?;
    let fixture_path = payload_source
        .join("protocol/tfsl-theme-evidence-v2/examples/candidate-a.tfsl-candidate-v2.json");
    let content = std::fs::read_to_string(fixture_path)?;
    let val: serde_json::Value = serde_json::from_str(&content)?;
    let theme_json = serde_json::to_string(&val["theme"])?;
    let doc: tfsb_studio_lib::theme_lab::types::ThemeDocument = serde_json::from_str(&theme_json)?;
    Ok(doc)
}

#[test]
fn v2_compile_verifies_typed_ordered_styles_and_inventory() -> Result<(), Box<dyn std::error::Error>>
{
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);

    let doc = load_sample_v2_theme()?;
    let res = runner.compile(tfsb_studio_lib::theme_lab::types::ThemeLabCompileRequest {
        specification: doc,
        options: None,
        ui_revision: Some(1),
        session_id: None,
    })?;

    assert!(res.valid, "v2 compile should succeed: {:?}", res.error);
    let styles = res.styles.ok_or("missing styles in v2 response")?;
    let expected_paths = [
        "styles/layers.css",
        "styles/tokens.css",
        "styles/base.css",
        "styles/accent.css",
        "styles/overrides.css",
    ];
    let actual_paths: Vec<&str> = styles.iter().map(|s| s.path.as_str()).collect();
    assert_eq!(
        actual_paths, expected_paths,
        "styles must match exact ordered sequence"
    );

    let css = res.compiled_css.ok_or("missing compiled css")?;
    let joined = styles
        .iter()
        .map(|s| s.css.as_str())
        .collect::<Vec<&str>>()
        .join("\n\n")
        + "\n";
    assert_eq!(joined, css, "joined styles must match compiled css");

    let desc = res.descriptor.ok_or("missing descriptor")?;
    match desc {
        tfsb_studio_lib::theme_lab::types::ThemeDescriptor::V2(d) => {
            assert_eq!(d.schema, "tfsl.theme-descriptor-v2");
            assert_eq!(d.schema_version, 2);
            assert_eq!(d.compiler_semantic, "tfsl.theme-compiler-v2-core-1");
            let mut hasher = sha2::Sha256::new();
            hasher.update(css.as_bytes());
            let computed_digest = format!("{:x}", hasher.finalize());
            assert_eq!(computed_digest, d.output_digest);
        }
        _ => return Err("expected V2 descriptor".into()),
    }

    Ok(())
}

#[test]
fn v2_document_save_and_open_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    let state = ThemeLabState::new(runner);

    let doc = load_sample_v2_theme()?;
    let temp = TempDirGuard::new("tfsb-v2-save-open");
    let target_file = temp.path().join("black-core.theme.json");

    let status_before = state.status();
    let display_name = state.save_file_with_binding(
        doc.clone(),
        &target_file,
        Some(status_before.session_id.clone()),
        Some(1),
    )?;

    assert_eq!(display_name, "black-core.theme.json");
    let status_after_save = state.status();
    assert_eq!(status_after_save.dirty, Some(false));
    assert_eq!(
        state.active_display_name()?,
        Some("black-core.theme.json".to_string())
    );
    assert_eq!(state.active_file_path()?, Some(target_file.clone()));

    // Open file back
    let open_res =
        state.open_file_with_binding(target_file, Some(status_after_save.session_id), Some(2))?;
    assert!(!open_res.cancelled);
    assert!(open_res.error.is_none());
    assert_eq!(
        open_res.display_name.as_deref(),
        Some("black-core.theme.json")
    );
    let opened_doc = open_res.specification.ok_or("missing opened spec")?;
    assert_eq!(opened_doc, doc);
    assert_eq!(state.status().dirty, Some(false));

    Ok(())
}

#[test]
fn theme_draft_update_invalidates_state_and_marks_dirty() -> Result<(), Box<dyn std::error::Error>>
{
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    let runner = ThemeLabRunner::new(node, batch_script);
    let state = ThemeLabState::new(runner);

    let doc = load_sample_v2_theme()?;
    let temp = TempDirGuard::new("tfsb-draft-update");
    let target_file = temp.path().join("active.theme.json");

    let status_init = state.status();
    state.save_file_with_binding(
        doc,
        &target_file,
        Some(status_init.session_id.clone()),
        Some(1),
    )?;

    assert_eq!(state.status().dirty, Some(false));
    assert!(state.active_file_path()?.is_some());
    assert!(state.active_display_name()?.is_some());

    // Execute draft update
    let current_status = state.status();
    let saved_path = state.active_file_path()?;
    let saved_name = state.active_display_name()?;
    let update_res =
        state.draft_update(tfsb_studio_lib::theme_lab::types::ThemeDraftUpdateRequest {
            session_id: current_status.session_id.clone(),
            ui_revision: current_status.latest_revision + 1,
        })?;

    assert_eq!(update_res.ui_revision, current_status.latest_revision + 1);
    let after_update = state.status();
    assert_eq!(after_update.dirty, Some(true));
    assert_eq!(state.active_file_path()?, saved_path);
    assert_eq!(state.active_display_name()?, saved_name);
    assert_eq!(after_update.adopted_theme_digest, None);

    // Stale revision is rejected
    let stale_err =
        state.draft_update(tfsb_studio_lib::theme_lab::types::ThemeDraftUpdateRequest {
            session_id: after_update.session_id.clone(),
            ui_revision: after_update.latest_revision,
        });
    assert!(stale_err.is_err());
    assert_eq!(
        stale_err.err().map(|e| e.reason_code()),
        Some(StudioReasonCode::Cancelled)
    );

    // Wrong session is rejected
    let wrong_session_err =
        state.draft_update(tfsb_studio_lib::theme_lab::types::ThemeDraftUpdateRequest {
            session_id: "wrong-session".to_string(),
            ui_revision: after_update.latest_revision + 1,
        });
    assert!(wrong_session_err.is_err());
    assert_eq!(
        wrong_session_err.err().map(|e| e.reason_code()),
        Some(StudioReasonCode::Cancelled)
    );

    Ok(())
}

#[test]
fn tampered_theme_adapter_is_rejected_by_authenticator() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let temp = TempDirGuard::new("tfsb-tampered-adapter");
    let tampered_adapter_dir = temp.path().join("loom-adapter");
    std::fs::create_dir_all(&tampered_adapter_dir)?;
    let tampered_adapter = tampered_adapter_dir.join("theme-adapter.mjs");

    let original = std::fs::read(manifest_dir.join("loom-adapter/theme-adapter.mjs"))?;
    let mut tampered = original.clone();
    tampered.push(b'\n'); // modify bytes

    std::fs::write(&tampered_adapter, &tampered)?;

    // 1. Discover with tampered adapter in packaged mode
    let node = find_node()?;
    let app_contents = temp.path().join("Contents");
    let app_macos = app_contents.join("MacOS");
    let app_resources = app_contents.join("Resources");
    std::fs::create_dir_all(&app_macos)?;
    let packaged_sidecar = app_macos.join("tfsb-studio-service");
    std::fs::copy(&node, &packaged_sidecar)?;
    let payload_source = find_loom_payload_source()?;
    copy_dir_all(&payload_source, &app_resources.join("loom-payload"))?;

    // Place tampered adapter in resources
    let res_adapter_dir = app_resources.join("loom-adapter");
    std::fs::create_dir_all(&res_adapter_dir)?;
    std::fs::write(res_adapter_dir.join("theme-adapter.mjs"), &tampered)?;

    let app_exe = app_macos.join("theme-forge-nebular-fusion");
    let runner = ThemeLabRunner::discover(&app_resources, &app_exe);
    assert!(
        !runner.is_available(),
        "runner must report unavailable when v2 adapter is tampered"
    );

    // 3. Attempting execute_v2 must fail authentication
    let batch_req = tfsb_studio_lib::theme_lab::types::BatchSubprocessRequest {
        action: "exchange-packet-parse-v2".to_string(),
        packet_json: Some("{}".to_string()),
        ..Default::default()
    };
    let exec_res = runner.execute_v2(&batch_req);
    assert!(
        exec_res.is_err(),
        "execute_v2 must fail on tampered adapter"
    );

    Ok(())
}

#[test]
fn v2_transport_rejects_unknown_fields_without_lossy_normalization()
-> Result<(), Box<dyn std::error::Error>> {
    use tfsb_studio_lib::theme_lab::types::ThemeDocument;
    let original = serde_json::to_value(load_sample_v2_theme()?)?;
    for path in ["", "/typography/body", "/surfaces", "/components"] {
        let mut malformed = original.clone();
        malformed
            .pointer_mut(path)
            .and_then(serde_json::Value::as_object_mut)
            .ok_or("missing fixture object")?
            .insert("unsupportedGuiField".to_owned(), serde_json::json!(true));
        assert!(
            serde_json::from_value::<ThemeDocument>(malformed).is_err(),
            "accepted unknown field at {path}"
        );
    }
    Ok(())
}

#[test]
fn production_discovery_authenticates_loom_independently_and_refuses_tampering()
-> Result<(), Box<dyn std::error::Error>> {
    let temporary = TempDirGuard::new("tfsb-loom-authentication");
    let root = temporary.path().canonicalize()?;
    copy_dir_all(&find_loom_payload_source()?, &root.join("loom-payload"))?;
    let runner = ThemeLabRunner::discover_with_mode(&root, Path::new("unavailable-parent"), false);
    let request = ThemeLabCompileRequest {
        specification: load_sample_v2_theme()?,
        options: None,
        ui_revision: Some(1),
        session_id: None,
    };
    assert!(runner.compile(request.clone())?.valid);
    // No Burst resources are present in the selected resource root.
    assert!(!root.join("scene-payload").exists());
    std::fs::write(
        root.join("loom-payload/bin/tfsl-batch.js"),
        "throw new Error('tampered');",
    )?;
    let error = runner
        .compile(request)
        .err()
        .ok_or("tampered payload executed")?;
    assert_eq!(
        error.reason_code(),
        StudioReasonCode::SidecarArtifactUnavailable
    );
    Ok(())
}
