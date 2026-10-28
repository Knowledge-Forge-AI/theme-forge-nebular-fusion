use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tfsb_studio_lib::app_theme::runner::{AppThemeRunner, authenticate_payload_closure};
use tfsb_studio_lib::app_theme::types::{
    AppThemePairedCompileRequest, AppThemeSaveProfileRequest, ColorTokensDto,
    LoomTargetOverridesDto, OwnerBindingInputOrigin, OwnerBindingRecord, PairedProfileDto,
    PairedProfileV2DocumentDto, PaletteDto, ProfileDocumentSchemaVersion, ProfileSaveMode,
    ProfileSemanticStatus, ProfileVerificationStatus, SurfacesDto, SyntaxOverridesDto,
    SyntaxPaletteDto, TargetOverridesDto, ThemeSpecificationDto, TypographyDto,
};
use tfsb_studio_lib::errors::StudioReasonCode;
use tfsb_studio_lib::state::app_theme::AppThemeState;

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map_or_else(|| PathBuf::from("../../.."), Path::to_path_buf)
}

fn find_node() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    for candidate in [
        manifest_dir.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
        repo_root().join("apps/studio/src-tauri/binaries/tfsb-studio-service-aarch64-apple-darwin"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
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
    for p in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("node runtime executable not found in PATH or standard locations".into())
}

fn find_real_adapter() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_adapter = manifest_dir.join("solar-sail-adapter/solar-sail-adapter.mjs");
    if let Ok(payload_root) = std::env::var("TFSB_APP_THEME_TEST_PAYLOAD_ROOT")
        && let Some(scratch_root) = PathBuf::from(payload_root).parent()
    {
        let scratch_adapter = scratch_root.join("solar-sail-adapter/solar-sail-adapter.mjs");
        if scratch_adapter.is_file() && repo_adapter.is_file() {
            assert_eq!(
                std::fs::read(&scratch_adapter)?,
                std::fs::read(&repo_adapter)?,
                "scratch adapter must match repo adapter byte-for-byte"
            );
            return Ok(scratch_adapter);
        }
    }
    for candidate in [
        repo_adapter,
        repo_root().join("apps/studio/src-tauri/solar-sail-adapter/solar-sail-adapter.mjs"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
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
        Self {
            path: path.canonicalize().unwrap_or(path),
        }
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

fn assert_err_code<T>(
    res: Result<T, tfsb_studio_lib::errors::StudioCommandError>,
    expected: StudioReasonCode,
) -> Result<(), Box<dyn std::error::Error>> {
    match res {
        Err(err) => {
            assert_eq!(err.reason_code(), expected);
            Ok(())
        }
        Ok(_) => Err("expected StudioCommandError, got Ok".into()),
    }
}

fn wait_for_path(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while !path.exists() {
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for marker {}", path.display()).into());
        }
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

fn wait_for_doc_tickets(
    state: &AppThemeState,
    min_next: u64,
) -> Result<(), Box<dyn std::error::Error>> {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    while state.document_ticket_counts().1 < min_next {
        if std::time::Instant::now() >= deadline {
            return Err(format!("timed out waiting for document next_ticket >= {min_next}").into());
        }
        thread::sleep(Duration::from_millis(2));
    }
    Ok(())
}

fn save_req(
    profile: Option<PairedProfileDto>,
    document_id: Option<String>,
    save_mode: ProfileSaveMode,
) -> AppThemeSaveProfileRequest {
    AppThemeSaveProfileRequest {
        profile,
        document_id,
        save_mode: Some(save_mode),
    }
}

fn make_color_tokens(t: [&str; 9], dfg: &str) -> ColorTokensDto {
    ColorTokensDto {
        background: t[0].into(),
        foreground: t[1].into(),
        card: t[0].into(),
        card_foreground: t[1].into(),
        popover: t[0].into(),
        popover_foreground: t[1].into(),
        primary: t[2].into(),
        primary_foreground: t[3].into(),
        secondary: t[4].into(),
        secondary_foreground: t[5].into(),
        muted: t[4].into(),
        muted_foreground: t[6].into(),
        accent: t[4].into(),
        accent_foreground: t[5].into(),
        destructive: t[7].into(),
        destructive_foreground: dfg.into(),
        border: t[8].into(),
        input: t[8].into(),
        ring: t[2].into(),
        ..ColorTokensDto::default()
    }
}

fn sample_specification() -> ThemeSpecificationDto {
    let light = make_color_tokens(
        [
            "#ffffff", "#000000", "#126475", "#ffffff", "#f1f5f9", "#0f172a", "#64748b", "#ef4444",
            "#e2e8f0",
        ],
        "#ffffff",
    );
    let dark = make_color_tokens(
        [
            "#09090b", "#fafafa", "#69d3e4", "#09090b", "#27272a", "#fafafa", "#a1a1aa", "#7f1d1d",
            "#27272a",
        ],
        "#fafafa",
    );
    ThemeSpecificationDto {
        schema_version: "tfss.theme-v1".to_string(),
        name: "test-theme".to_string(),
        version: "0.1.0".to_string(),
        description: Some("Test theme".to_string()),
        palette: PaletteDto { light, dark },
        surfaces: SurfacesDto {
            radius: "0.5rem".to_string(),
            border_width: Some("1px".to_string()),
            content: None,
        },
        typography: TypographyDto {
            font_sans: "Inter, sans-serif".to_string(),
            font_heading: None,
            font_mono: None,
        },
        target_overrides: None,
    }
}

fn sample_paired_v1() -> PairedProfileDto {
    let spec = sample_specification();
    PairedProfileDto {
        schema_version: "tf-paired-profile-v1".to_string(),
        name: "forge-console".to_string(),
        version: "0.1.0".to_string(),
        description: Some("Paired v1 test profile".to_string()),
        palette: spec.palette,
        surfaces: SurfacesDto {
            radius: "0.5rem".to_string(),
            border_width: Some("1px".to_string()),
            content: Some(1280),
        },
        typography: spec.typography,
        target_overrides: None,
    }
}

const RAW_V2_COLOR_BLOCK: &str = r##""color":{"light":{"canvas":"#ffffff","canvasText":"#111111","surface":"#f8f8f8","surfaceText":"#111111","elevatedSurface":"#ffffff","elevatedSurfaceText":"#111111","primaryAction":"#0066cc","primaryActionText":"#ffffff","secondaryAction":"#e5e5e5","secondaryActionText":"#111111","mutedSurface":"#f0f0f0","mutedText":"#666666","highlight":"#ff9900","highlightText":"#000000","danger":"#cc0000","dangerText":"#ffffff","border":"#cccccc","fieldBorder":"#999999","focus":"#0066cc"},"dark":{"canvas":"#111111","canvasText":"#ffffff","surface":"#1a1a1a","surfaceText":"#ffffff","elevatedSurface":"#222222","elevatedSurfaceText":"#ffffff","primaryAction":"#3399ff","primaryActionText":"#000000","secondaryAction":"#333333","secondaryActionText":"#ffffff","mutedSurface":"#222222","mutedText":"#999999","highlight":"#ffaa33","highlightText":"#000000","danger":"#ff4444","dangerText":"#000000","border":"#444444","fieldBorder":"#666666","focus":"#3399ff"}}"##;

fn sample_paired_v2() -> Result<PairedProfileV2DocumentDto, Box<dyn std::error::Error>> {
    let raw_v2 = format!(
        r#"{{"schemaVersion":"tf-paired-profile-v2","name":"nebula-v2","version":"1.0.0","description":"Verified v2 profile",{RAW_V2_COLOR_BLOCK}}}"#
    );
    Ok(serde_json::from_slice(raw_v2.as_bytes())?)
}

fn raw_v2_with_loom_content(content_literal: &str) -> String {
    format!(
        r#"{{"schemaVersion":"tf-paired-profile-v2","name":"nebula-v2","version":"1.0.0",{RAW_V2_COLOR_BLOCK},"targetOverrides":{{"version":"v2","loom":{{"content":{content_literal}}}}}}}"#
    )
}

#[test]
fn missing_runner_executable_fails_gracefully() -> Result<(), Box<dyn std::error::Error>> {
    let runner = AppThemeRunner::new(
        PathBuf::from("/nonexistent/node"),
        PathBuf::from("/nonexistent/adapter.mjs"),
    );
    assert!(!runner.is_available());
    assert_err_code(
        runner.compile(sample_specification(), Some(1)),
        StudioReasonCode::SidecarArtifactUnavailable,
    )
}

#[test]
fn discovery_packaged_vs_dev_mode() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let temp = TempDirGuard::new("tfsb-app-theme-discovery-test");
    let exe_dir = temp.path().join("bin");
    std::fs::create_dir_all(&exe_dir)?;
    let sibling_runtime = exe_dir.join("tfsb-studio-service");
    std::fs::copy(find_node()?, &sibling_runtime)?;
    let exe = exe_dir.join("test-binary");

    // A clean resource root exercises debug fallback without inheriting the
    // checkout's prepared payload.  This assertion is about route selection;
    // semantic availability is covered by the prepared and packaged cases.
    let clean_resources = temp.path().join("clean-resources");
    std::fs::create_dir_all(&clean_resources)?;
    let dev_runner = AppThemeRunner::discover_with_mode(&clean_resources, &exe, false);
    assert_eq!(dev_runner.node_binary_path(), sibling_runtime);
    assert_eq!(
        dev_runner.adapter_path(),
        manifest_dir.join("solar-sail-adapter/solar-sail-adapter.mjs")
    );

    let pkg_runner = AppThemeRunner::discover_with_mode(&clean_resources, &exe, true);
    assert_eq!(pkg_runner.node_binary_path(), sibling_runtime);
    assert_eq!(
        pkg_runner.adapter_path(),
        clean_resources.join("solar-sail-adapter/solar-sail-adapter.mjs")
    );
    assert!(!pkg_runner.is_available());

    let prepared_resources = temp.path().join("prepared-resources");
    let prepared_adapter = prepared_resources.join("solar-sail-adapter/solar-sail-adapter.mjs");
    std::fs::create_dir_all(prepared_adapter.parent().ok_or("prepared adapter parent")?)?;
    std::fs::copy(
        manifest_dir.join("solar-sail-adapter/solar-sail-adapter.mjs"),
        &prepared_adapter,
    )?;
    let prepared_dev_runner = AppThemeRunner::discover_with_mode(&prepared_resources, &exe, false);
    assert_eq!(prepared_dev_runner.adapter_path(), prepared_adapter);
    assert!(!prepared_dev_runner.is_available());
    Ok(())
}

#[test]
fn tfnc13_production_discovery_refuses_missing_payload_or_dist()
-> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let repo_adapter = manifest_dir.join("solar-sail-adapter/solar-sail-adapter.mjs");
    let repo_payload = manifest_dir.join("solar-sail-payload");
    let temp = TempDirGuard::new("tfsb-c6-discovery-neg");
    let exe_dir = temp.path().join("bin");
    std::fs::create_dir_all(&exe_dir)?;
    let sibling_runtime = exe_dir.join("tfsb-studio-service");
    std::fs::copy(find_node()?, &sibling_runtime)?;
    let exe = exe_dir.join("test-binary");

    let res_no_payload = temp.path().join("res-no-payload");
    std::fs::create_dir_all(res_no_payload.join("solar-sail-adapter"))?;
    let adapter_no_payload = res_no_payload.join("solar-sail-adapter/solar-sail-adapter.mjs");
    std::fs::copy(&repo_adapter, &adapter_no_payload)?;
    assert!(
        AppThemeRunner::new(sibling_runtime.clone(), adapter_no_payload.clone()).is_available()
    );
    assert_err_code(
        authenticate_payload_closure(&adapter_no_payload),
        StudioReasonCode::SidecarArtifactUnavailable,
    )?;
    for packaged in [true, false] {
        let runner = AppThemeRunner::discover_with_mode(&res_no_payload, &exe, packaged);
        assert!(
            runner.node_binary_path().is_file()
                && runner.adapter_path() == adapter_no_payload
                && !runner.is_available()
        );
        assert_err_code(
            runner.compile(sample_specification(), Some(1)),
            StudioReasonCode::SidecarArtifactUnavailable,
        )?;
    }

    let res_no_dist = temp.path().join("res-no-dist");
    std::fs::create_dir_all(res_no_dist.join("solar-sail-adapter"))?;
    std::fs::create_dir_all(res_no_dist.join("solar-sail-payload"))?;
    let adapter_no_dist = res_no_dist.join("solar-sail-adapter/solar-sail-adapter.mjs");
    std::fs::copy(&repo_adapter, &adapter_no_dist)?;
    for f in ["package.json", "solar-sail-binding.json"] {
        std::fs::copy(
            repo_payload.join(f),
            res_no_dist.join("solar-sail-payload").join(f),
        )?;
    }
    assert!(AppThemeRunner::new(sibling_runtime.clone(), adapter_no_dist.clone()).is_available());
    assert_err_code(
        authenticate_payload_closure(&adapter_no_dist),
        StudioReasonCode::SidecarArtifactUnavailable,
    )?;
    for packaged in [true, false] {
        let runner = AppThemeRunner::discover_with_mode(&res_no_dist, &exe, packaged);
        assert!(
            runner.node_binary_path().is_file()
                && runner.adapter_path() == adapter_no_dist
                && !runner.is_available()
        );
        assert_err_code(
            runner.compile(sample_specification(), Some(1)),
            StudioReasonCode::SidecarArtifactUnavailable,
        )?;
    }
    Ok(())
}

#[test]
fn tfnc13_production_discovery_semantic_positive() -> Result<(), Box<dyn std::error::Error>> {
    let payload_root = std::env::var("TFSB_APP_THEME_TEST_PAYLOAD_ROOT").map_err(
        |_| "TFSB_APP_THEME_TEST_PAYLOAD_ROOT is required for production discovery positive test",
    )?;
    let scratch_adapter = find_real_adapter()?;
    let scratch_root = PathBuf::from(payload_root)
        .parent()
        .ok_or("expected scratch root")?
        .to_path_buf();
    let temp = TempDirGuard::new("tfsb-c6-discovery-pos");
    let exe_dir = temp.path().join("bin");
    std::fs::create_dir_all(&exe_dir)?;
    let sibling_runtime = exe_dir.join("tfsb-studio-service");
    std::fs::copy(find_node()?, &sibling_runtime)?;
    let exe = exe_dir.join("test-binary");

    for packaged in [true, false] {
        let r = AppThemeRunner::discover_with_mode(&scratch_root, &exe, packaged);
        assert!(
            r.node_binary_path() == sibling_runtime
                && r.adapter_path() == scratch_adapter
                && r.is_available()
        );
    }
    let runner = AppThemeRunner::discover_with_mode(&scratch_root, &exe, true);
    let compiled = runner.compile(sample_specification(), Some(1))?;
    assert!(compiled.valid && compiled.compiled_css.is_some());
    let state = AppThemeState::new(runner);
    let v1_path = temp.path().join("discovered-v1.json");
    std::fs::write(&v1_path, serde_json::to_vec_pretty(&sample_paired_v1())?)?;
    let v1_doc = state
        .open_profile_path(v1_path)?
        .document
        .ok_or("expected v1 doc via discovered runner")?;
    assert!(
        v1_doc.schema_version == ProfileDocumentSchemaVersion::PairedProfileV1
            && v1_doc.verification_status == ProfileVerificationStatus::Verified
            && v1_doc.semantic == ProfileSemanticStatus::Validated
            && v1_doc.editable
    );
    let v2_path = temp.path().join("discovered-v2.json");
    std::fs::write(&v2_path, raw_v2_with_loom_content("4294967296"))?;
    let doc = state
        .open_profile_path(v2_path)?
        .document
        .ok_or("expected v2 doc via discovered runner")?;
    assert_eq!(
        doc.schema_version,
        ProfileDocumentSchemaVersion::PairedProfileV2
    );
    assert!(
        doc.verification_status == ProfileVerificationStatus::Verified
            && doc.semantic == ProfileSemanticStatus::Validated
    );
    assert!(doc.owner_binding.is_some() && doc.canonical_digest.is_some());
    Ok(())
}

#[test]
fn hanging_child_process_terminates_on_timeout() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-hang");
    let script_path = temp_dir.path().join("hang.js");
    std::fs::write(&script_path, "setInterval(() => {}, 1000);\n")?;
    let runner = AppThemeRunner::new(find_node()?, script_path);
    let start = std::time::Instant::now();
    let res = runner.compile(sample_specification(), Some(1));
    let duration = start.elapsed();
    assert!(duration >= Duration::from_secs(4) && duration <= Duration::from_secs(8));
    assert_err_code(res, StudioReasonCode::RequestTimeout)
}

#[test]
fn child_not_reading_stdin_handled_cleanly() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-nostdin");
    let script_path = temp_dir.path().join("nostdin.js");
    std::fs::write(
        &script_path,
        r##"setTimeout(() => { process.stdout.write(JSON.stringify({ status: "success", uiRevision: 42, valid: true, compiledCss: "/* nostdin test */", descriptor: null, diagnostics: [] })); process.exit(0); }, 100);"##,
    )?;
    let runner = AppThemeRunner::new(find_node()?, script_path);
    let res = runner.compile(sample_specification(), Some(42))?;
    assert!(res.status == "success" && res.ui_revision == 42);
    Ok(())
}

#[test]
fn noisy_stderr_drained_without_deadlock() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-noisy-stderr");
    let script_path = temp_dir.path().join("noisy.js");
    std::fs::write(
        &script_path,
        r##"process.stderr.write("E".repeat(128 * 1024)); process.stdout.write(JSON.stringify({ status: "success", uiRevision: 1, valid: true, compiledCss: "/* noisy ok */", descriptor: null, diagnostics: [] })); process.exit(0);"##,
    )?;
    let runner = AppThemeRunner::new(find_node()?, script_path);
    assert!(runner.compile(sample_specification(), Some(1))?.valid);
    Ok(())
}

#[test]
fn child_closing_stdout_early_reports_failure() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-close-stdout");
    let script_path = temp_dir.path().join("close_stdout.js");
    std::fs::write(&script_path, "process.stdout.destroy(); process.exit(0);\n")?;
    let runner = AppThemeRunner::new(find_node()?, script_path);
    assert_err_code(
        runner.compile(sample_specification(), Some(1)),
        StudioReasonCode::SidecarProtocolInvalid,
    )
}

#[test]
fn cancellation_terminates_child() -> Result<(), Box<dyn std::error::Error>> {
    let temp_dir = TempDirGuard::new("tfsb-app-runner-test-cancel");
    let script_path = temp_dir.path().join("hang_cancel.js");
    std::fs::write(&script_path, "setInterval(() => {}, 1000);\n")?;
    let runner = Arc::new(AppThemeRunner::new(find_node()?, script_path));
    let runner_clone = runner.clone();
    let handle = thread::spawn(move || runner_clone.compile(sample_specification(), Some(1)));
    thread::sleep(Duration::from_millis(100));
    runner.cancel_active();
    assert_err_code(
        handle.join().map_err(|_| "thread join failed")?,
        StudioReasonCode::Cancelled,
    )
}

#[test]
fn real_package_export_via_runner() -> Result<(), Box<dyn std::error::Error>> {
    let runner = AppThemeRunner::new(find_node()?, find_real_adapter()?);
    assert!(runner.is_available());
    let temp = TempDirGuard::new("tfsb-app-runner-export");
    let export_dir = temp.path().join("pkg-out");
    std::fs::create_dir_all(&export_dir)?;
    let spec = sample_specification();
    let dest = export_dir.to_string_lossy().to_string();
    let res = runner.export_package(spec.clone(), dest.clone(), Some("typescript".to_string()))?;
    assert!(
        !res.cancelled && res.error.is_none() && res.destination.as_deref() == Some(dest.as_str())
    );
    assert_eq!(res.file_count, Some(11));
    for rel in [
        "package.json",
        "styles/theme.css",
        "src/index.ts",
        "provenance.json",
        "theme.json",
    ] {
        assert!(export_dir.join(rel).is_file());
    }
    match runner.export_package(spec, dest, Some("typescript".to_string())) {
        Ok(r) => assert!(r.error.is_some()),
        Err(e) => assert_eq!(e.reason_code(), StudioReasonCode::SidecarProtocolInvalid),
    }
    Ok(())
}

#[test]
fn compile_strips_surfaces_content_on_plain_theme_path() -> Result<(), Box<dyn std::error::Error>> {
    let runner = AppThemeRunner::new(find_node()?, find_real_adapter()?);
    let mut spec = sample_specification();
    spec.surfaces.content = Some(704);
    let result = runner.compile(spec, Some(1))?;
    assert!(result.valid && result.compiled_css.is_some() && result.ui_revision == 1);
    Ok(())
}

fn direct_adapter_bind(
    raw_bytes: &[u8],
    parent_sha: Option<&str>,
) -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use base64::Engine;
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    let mut req = serde_json::json!({ "action": "bind_document", "rawBytesBase64": base64::engine::general_purpose::STANDARD.encode(raw_bytes) });
    if let Some(p) = parent_sha {
        req["parentSourceSha256"] = serde_json::json!(p);
    }
    let mut child = Command::new(find_node()?)
        .arg(find_real_adapter()?)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&serde_json::to_vec(&req)?)?;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while child.try_wait()?.is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err("direct_adapter_bind timed out after 5s".into());
        }
        thread::sleep(Duration::from_millis(5));
    }
    let mut out = Vec::new();
    if let Some(mut stdout) = child.stdout.take() {
        stdout.read_to_end(&mut out)?;
    }
    Ok(serde_json::from_slice(&out)?)
}

#[inline(never)]
fn verify_custody_v1_and_alias(
    state: &AppThemeState,
    temp: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let v1_profile = sample_paired_v1();
    let v1_bytes = serde_json::to_vec_pretty(&v1_profile)?;
    let v1_raw_sha = format!("{:x}", Sha256::digest(&v1_bytes));
    let v1_path = temp.join("canonical-v1.json");
    std::fs::write(&v1_path, &v1_bytes)?;

    let v1_doc = state
        .open_profile_path(v1_path)?
        .document
        .ok_or("expected v1 document")?;
    assert_eq!(
        v1_doc.schema_version,
        ProfileDocumentSchemaVersion::PairedProfileV1
    );
    assert!(!v1_doc.alias_resolved && v1_doc.editable && !v1_doc.is_transformed);
    assert_eq!(
        v1_doc.verification_status,
        ProfileVerificationStatus::Verified
    );
    assert!(
        v1_doc.parent_source_sha256.is_none()
            && v1_doc.semantic == ProfileSemanticStatus::Validated
    );
    assert!(
        v1_doc.display_name == "canonical-v1.json" && !v1_doc.document_id.contains("canonical-v1")
    );
    let v1_norm = v1_doc
        .normalized_sha256
        .clone()
        .ok_or("expected normalized sha256")?;
    assert_ne!(v1_norm, v1_raw_sha);
    assert_eq!(
        v1_doc.owner_binding,
        Some(OwnerBindingRecord {
            input_origin: OwnerBindingInputOrigin::SourceBytes,
            raw_source_sha256: v1_raw_sha,
            verification_status: ProfileVerificationStatus::Verified,
            is_transformed: false,
            byte_length: v1_bytes.len() as u64,
            normalized_sha256: Some(v1_norm.clone()),
            canonical_digest: None,
            parent_source_sha256: None,
        })
    );

    let mut alias_val = serde_json::to_value(&v1_profile)?;
    if let Some(obj) = alias_val.as_object_mut() {
        obj.remove("schemaVersion");
        obj.insert("schema".into(), serde_json::json!("tf-paired-profile-v1"));
    }
    let alias_bytes = serde_json::to_vec_pretty(&alias_val)?;
    let alias_expected_raw_sha = format!("{:x}", Sha256::digest(&alias_bytes));
    let alias_path = temp.join("legacy-alias-v1.json");
    std::fs::write(&alias_path, &alias_bytes)?;

    let alias_doc = state
        .open_profile_path(alias_path)?
        .document
        .ok_or("expected alias doc")?;
    assert!(alias_doc.alias_resolved && alias_doc.editable && !alias_doc.is_transformed);
    assert_eq!(
        alias_doc.verification_status,
        ProfileVerificationStatus::Verified
    );
    assert_eq!(alias_doc.raw_source_sha256, alias_expected_raw_sha);
    assert_eq!(
        alias_doc.normalized_sha256.as_deref(),
        Some(v1_norm.as_str())
    );
    let alias_owner = alias_doc
        .owner_binding
        .clone()
        .ok_or("expected alias owner_binding")?;
    assert_eq!(
        alias_owner.input_origin,
        OwnerBindingInputOrigin::ResolvedLegacyAlias
    );
    assert_ne!(alias_owner.raw_source_sha256, alias_expected_raw_sha);
    assert_eq!(
        alias_owner.verification_status,
        ProfileVerificationStatus::Verified
    );
    assert!(!alias_owner.is_transformed && alias_owner.parent_source_sha256.is_none());
    assert_eq!(
        alias_owner.normalized_sha256.as_deref(),
        Some(v1_norm.as_str())
    );

    let orig_save_path = temp.join("alias-original-saved.json");
    let orig_save = state.save_profile_path(
        save_req(
            None,
            Some(alias_doc.document_id.clone()),
            ProfileSaveMode::Original,
        ),
        orig_save_path.clone(),
    )?;
    assert!(orig_save.saved && std::fs::read(&orig_save_path)? == alias_bytes);

    let edited_save_path = temp.join("alias-edited-saved.json");
    let edited_save = state.save_profile_path(
        save_req(
            alias_doc.profile,
            Some(alias_doc.document_id),
            ProfileSaveMode::Edited,
        ),
        edited_save_path.clone(),
    )?;
    assert!(edited_save.saved);
    let edited_doc = edited_save.document.ok_or("expected edited doc")?;
    let edited_disk_bytes = std::fs::read(&edited_save_path)?;
    let edited_disk_sha = format!("{:x}", Sha256::digest(&edited_disk_bytes));
    let direct_ref: OwnerBindingRecord = serde_json::from_value(
        direct_adapter_bind(&edited_disk_bytes, None)?
            .get("ownerBinding")
            .cloned()
            .ok_or("missing ownerBinding")?,
    )?;
    assert!(!edited_doc.alias_resolved && edited_doc.is_transformed);
    assert_eq!(
        edited_doc.verification_status,
        ProfileVerificationStatus::Transformed
    );
    assert_eq!(
        edited_doc.parent_source_sha256.as_deref(),
        Some(alias_expected_raw_sha.as_str())
    );
    assert!(
        edited_doc.raw_source_sha256 == edited_disk_sha
            && edited_doc.owner_binding == Some(direct_ref.clone())
    );
    assert!(
        edited_doc.normalized_sha256.is_some()
            && edited_doc.normalized_sha256.as_deref() != Some(edited_disk_sha.as_str())
    );
    assert_ne!(
        direct_ref.normalized_sha256.as_deref(),
        Some(direct_ref.raw_source_sha256.as_str())
    );

    let reopened = state
        .open_profile_path(edited_save_path)?
        .document
        .ok_or("expected reopened doc")?;
    assert_eq!(
        reopened.verification_status,
        ProfileVerificationStatus::Verified
    );
    assert!(!reopened.is_transformed && reopened.parent_source_sha256.is_none());
    assert!(
        reopened.raw_source_sha256 == edited_disk_sha
            && reopened.normalized_sha256 == edited_doc.normalized_sha256
    );
    assert_eq!(reopened.owner_binding, Some(direct_ref));

    // NewDocument save while `reopened` is active must still be parentless
    let new_while_active = state
        .save_profile_path(
            save_req(Some(v1_profile), None, ProfileSaveMode::NewDocument),
            temp.join("new-while-active.json"),
        )?
        .document
        .ok_or("expected new doc while active")?;
    assert!(
        new_while_active.semantic == ProfileSemanticStatus::Validated
            && new_while_active.verification_status == ProfileVerificationStatus::Verified
    );
    assert!(
        !new_while_active.is_transformed
            && new_while_active.parent_source_sha256.is_none()
            && new_while_active.owner_binding.is_some()
    );

    for raw in [&v1_bytes[..], raw_v2_with_loom_content("704").as_bytes()] {
        let resp = direct_adapter_bind(raw, Some(&"a".repeat(64)))?;
        assert_eq!(resp.get("status").and_then(|v| v.as_str()), Some("error"));
        assert_eq!(
            resp.get("error").and_then(|v| v.as_str()),
            Some("UNSUPPORTED_PARENT_BINDING")
        );
        assert!(resp.get("schemaVersion").is_none());
    }
    Ok(())
}

#[inline(never)]
fn verify_custody_ext_v2_and_corrupt(
    state: &AppThemeState,
    temp: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let v1_profile = sample_paired_v1();
    let mut ext_val = serde_json::to_value(&v1_profile)?;
    if let Some(obj) = ext_val.as_object_mut() {
        obj.insert("surfaces".into(), serde_json::json!({ "radius": "0.5rem", "borderWidth": "1px", "content": 5_000_000_000u64 }));
        obj.insert(
            "targetOverrides".into(),
            serde_json::json!({
                "loom": { "primaryFamily": "cyan", "customLoomKey": { "nested": true } },
                "solarSail": { "surfaces": { "radius": "0.75rem" }, "customSolarSailKey": "ext" },
                "syntax": { "copy": "hover", "customSyntaxKey": "extra" },
            }),
        );
    }
    let ext_bytes = serde_json::to_vec_pretty(&ext_val)?;
    let ext_path = temp.join("extended-v1.json");
    std::fs::write(&ext_path, &ext_bytes)?;
    let ext_doc = state
        .open_profile_path(ext_path.clone())?
        .document
        .ok_or("expected ext doc")?;
    assert_eq!(
        ext_doc.schema_version,
        ProfileDocumentSchemaVersion::PairedProfileV1
    );
    assert!(!ext_doc.editable && ext_doc.profile.is_some() && ext_doc.owner_binding.is_some());
    assert!(
        ext_doc.verification_status == ProfileVerificationStatus::Verified
            && ext_doc.semantic == ProfileSemanticStatus::Validated
    );
    assert_eq!(
        ext_doc.diagnostic_code.as_deref(),
        Some("UNSUPPORTED_V1_EXTENSION")
    );

    let ext_copy_path = temp.join("extended-v1-copy.json");
    let ext_orig = state.save_profile_path(
        save_req(
            None,
            Some(ext_doc.document_id.clone()),
            ProfileSaveMode::Original,
        ),
        ext_copy_path.clone(),
    )?;
    assert!(ext_orig.saved && std::fs::read(&ext_copy_path)? == ext_bytes);

    let ext_rej = state.save_profile_path(
        save_req(
            ext_doc.profile,
            Some(ext_doc.document_id),
            ProfileSaveMode::Edited,
        ),
        ext_path,
    )?;
    assert!(!ext_rej.saved && ext_rej.error.is_some());

    let v2_profile = sample_paired_v2()?;
    let v2_bytes = serde_json::to_vec_pretty(&v2_profile)?;
    let v2_path = temp.join("verified-v2.json");
    std::fs::write(&v2_path, &v2_bytes)?;

    let v2_doc = state
        .open_profile_path(v2_path.clone())?
        .document
        .ok_or("expected v2 doc")?;
    assert_eq!(
        v2_doc.schema_version,
        ProfileDocumentSchemaVersion::PairedProfileV2
    );
    assert!(
        v2_doc.verification_status == ProfileVerificationStatus::Verified
            && v2_doc.semantic == ProfileSemanticStatus::Validated
    );
    assert!(!v2_doc.editable && v2_doc.profile.is_none() && v2_doc.normalized_sha256.is_none());
    assert!(
        v2_doc.canonical_digest.is_some()
            && v2_doc.owner_binding.is_some()
            && v2_doc.v2_profile == Some(v2_profile)
    );

    let rejected_v2_edit = state.save_profile_path(
        save_req(
            Some(v1_profile),
            Some(v2_doc.document_id.clone()),
            ProfileSaveMode::Edited,
        ),
        v2_path,
    )?;
    assert!(!rejected_v2_edit.saved && rejected_v2_edit.error.is_some());

    let v2_copy_path = temp.join("verified-v2-copy.json");
    let v2_orig_save = state.save_profile_path(
        save_req(None, Some(v2_doc.document_id), ProfileSaveMode::Original),
        v2_copy_path.clone(),
    )?;
    assert!(v2_orig_save.saved && std::fs::read(&v2_copy_path)? == v2_bytes);

    let v2_alias_path = temp.join("v2-alias.json");
    std::fs::write(&v2_alias_path, br#"{"schema":"tf-paired-profile-v2","name":"bad","version":"1.0.0","color":{"light":{},"dark":{}}}"#)?;
    let v2_alias_doc = state
        .open_profile_path(v2_alias_path)?
        .document
        .ok_or("expected corrupt doc")?;
    assert_eq!(
        v2_alias_doc.schema_version,
        ProfileDocumentSchemaVersion::Corrupt
    );
    assert!(!v2_alias_doc.editable && v2_alias_doc.owner_binding.is_none());
    assert_eq!(
        v2_alias_doc.diagnostic_code.as_deref(),
        Some("V2_ALIAS_FORBIDDEN")
    );

    let dup_path = temp.join("dup.json");
    std::fs::write(&dup_path, b"{\"schemaVersion\":\"tf-paired-profile-v1\",\"name\":\"a\x1b[31m\xe2\x80\xaeb\",\"name\":\"dup\"}")?;
    let dup_doc = state
        .open_profile_path(dup_path.clone())?
        .document
        .ok_or("expected corrupt doc")?;
    assert_eq!(
        dup_doc.schema_version,
        ProfileDocumentSchemaVersion::Corrupt
    );
    assert_eq!(dup_doc.diagnostic_code.as_deref(), Some("CANONICAL_ERROR"));
    let summary = dup_doc.diagnostic_summary.unwrap_or_default();
    assert!(!summary.contains('\u{001b}') && !summary.contains('\u{202e}'));

    let corrupt_save = state.save_profile_path(
        save_req(None, Some(dup_doc.document_id), ProfileSaveMode::Original),
        dup_path,
    )?;
    assert!(!corrupt_save.saved && corrupt_save.error.is_some());

    let oversize_path = temp.join("oversize.json");
    std::fs::write(&oversize_path, vec![b' '; 1_048_577])?;
    let oversize_open = state.open_profile_path(oversize_path)?;
    assert!(
        oversize_open.document.is_none()
            && oversize_open
                .error
                .unwrap_or_default()
                .contains("maximum size")
    );
    Ok(())
}

#[inline(never)]
fn verify_c1_v2_loom_content_safe_integers(
    state: &AppThemeState,
    temp: &Path,
) -> Result<(), Box<dyn std::error::Error>> {
    let (mut digest_5e9, mut digest_5b) = (None, None);
    for (idx, (lit, expected)) in [
        ("4294967295", 4_294_967_295u64),
        ("4294967296", 4_294_967_296u64),
        ("5e9", 5_000_000_000u64),
        ("5000000000", 5_000_000_000u64),
        ("9007199254740991", 9_007_199_254_740_991u64),
    ]
    .into_iter()
    .enumerate()
    {
        let raw_str = raw_v2_with_loom_content(lit);
        let expected_raw_sha = format!("{:x}", Sha256::digest(raw_str.as_bytes()));
        let path = temp.join(format!("c1-pos-{idx}.json"));
        std::fs::write(&path, raw_str.as_bytes())?;
        let doc = state
            .open_profile_path(path)?
            .document
            .ok_or("expected C1 v2 doc")?;
        assert_eq!(
            doc.schema_version,
            ProfileDocumentSchemaVersion::PairedProfileV2
        );
        assert!(
            doc.verification_status == ProfileVerificationStatus::Verified
                && doc.semantic == ProfileSemanticStatus::Validated
        );
        assert!(
            !doc.editable
                && doc.raw_source_sha256 == expected_raw_sha
                && doc.normalized_sha256.is_none()
        );
        let ob = doc
            .owner_binding
            .as_ref()
            .ok_or("expected C1 owner_binding")?;
        assert!(
            ob.input_origin == OwnerBindingInputOrigin::SourceBytes
                && ob.raw_source_sha256 == expected_raw_sha
                && ob.byte_length == raw_str.len() as u64
        );
        assert!(
            doc.canonical_digest.is_some()
                && doc.canonical_digest.as_deref() != Some(expected_raw_sha.as_str())
                && ob.canonical_digest == doc.canonical_digest
        );
        let loom_content = doc
            .v2_profile
            .as_ref()
            .and_then(|p| p.target_overrides.as_ref())
            .and_then(|t| t.loom.as_ref())
            .and_then(|l| l.content);
        assert_eq!(loom_content, Some(expected));
        if lit == "5e9" {
            digest_5e9 = doc.canonical_digest.clone();
            let save_path = temp.join("c1-saved-5e9.json");
            let saved = state.save_profile_path(
                save_req(None, Some(doc.document_id), ProfileSaveMode::Original),
                save_path.clone(),
            )?;
            assert!(saved.saved && std::fs::read_to_string(&save_path)? == raw_str);
        } else if lit == "5000000000" {
            digest_5b = doc.canonical_digest.clone();
        }
    }
    assert_eq!(digest_5e9, digest_5b);

    for (idx, bad_lit) in ["0", "-1", "1.5", "9007199254740992"]
        .into_iter()
        .enumerate()
    {
        let path = temp.join(format!("c1-neg-{idx}.json"));
        std::fs::write(&path, raw_v2_with_loom_content(bad_lit))?;
        let doc = state
            .open_profile_path(path.clone())?
            .document
            .ok_or("expected corrupt C1 doc")?;
        assert!(
            doc.schema_version == ProfileDocumentSchemaVersion::Corrupt
                && doc.verification_status == ProfileVerificationStatus::Corrupt
        );
        assert!(!doc.editable && doc.v2_profile.is_none() && doc.owner_binding.is_none());
        let rej = state.save_profile_path(
            save_req(None, Some(doc.document_id), ProfileSaveMode::Original),
            path,
        )?;
        assert!(!rej.saved && rej.error.is_some());
    }
    Ok(())
}

#[test]
fn tfnc13_adapter_and_custody_v1_alias_v2_and_corrupt_end_to_end()
-> Result<(), Box<dyn std::error::Error>> {
    let state = AppThemeState::new(AppThemeRunner::new(find_node()?, find_real_adapter()?));
    let temp = TempDirGuard::new("tfsb-tfnc13-custody");
    verify_custody_v1_and_alias(&state, temp.path())?;
    verify_custody_ext_v2_and_corrupt(&state, temp.path())?;
    verify_c1_v2_loom_content_safe_integers(&state, temp.path())?;
    Ok(())
}

#[test]
fn tfnc13_owner_rejected_v1_opens_editable_and_repairs_cleanly()
-> Result<(), Box<dyn std::error::Error>> {
    let state = AppThemeState::new(AppThemeRunner::new(find_node()?, find_real_adapter()?));
    let temp = TempDirGuard::new("tfsb-tfnc13-repair");

    let mut invalid_v1 = sample_paired_v1();
    invalid_v1.palette.light.primary = "not-a-valid-hex".to_string();
    let bad_bytes = serde_json::to_vec_pretty(&invalid_v1)?;
    let bad_raw_sha = format!("{:x}", Sha256::digest(&bad_bytes));
    let file_path = temp.path().join("needs-repair.json");
    std::fs::write(&file_path, &bad_bytes)?;

    let doc = state
        .open_profile_path(file_path.clone())?
        .document
        .ok_or("expected doc")?;
    assert_eq!(
        doc.schema_version,
        ProfileDocumentSchemaVersion::PairedProfileV1
    );
    assert!(
        doc.editable
            && doc.semantic == ProfileSemanticStatus::Rejected
            && doc.owner_binding.is_none()
            && doc.parent_source_sha256.is_none()
    );
    assert_eq!(doc.diagnostic_code.as_deref(), Some("SCHEMA_VALIDATION"));

    let bad_save = state.save_profile_path(
        save_req(
            doc.profile.clone(),
            Some(doc.document_id.clone()),
            ProfileSaveMode::Edited,
        ),
        file_path.clone(),
    )?;
    assert!(!bad_save.saved && bad_save.error.is_some());

    let mut repaired = doc.profile.ok_or("expected profile")?;
    repaired.palette.light.primary = "#126475".to_string();
    let good_save = state.save_profile_path(
        save_req(
            Some(repaired),
            Some(doc.document_id),
            ProfileSaveMode::Edited,
        ),
        file_path.clone(),
    )?;
    assert!(good_save.saved);
    let saved_doc = good_save.document.ok_or("expected saved doc")?;
    assert!(
        saved_doc.semantic == ProfileSemanticStatus::Validated
            && saved_doc.verification_status == ProfileVerificationStatus::Transformed
    );
    assert!(
        saved_doc.is_transformed
            && saved_doc.parent_source_sha256.as_deref() == Some(bad_raw_sha.as_str())
    );
    let owner = saved_doc
        .owner_binding
        .ok_or("expected repaired owner_binding")?;
    assert!(
        owner.input_origin == OwnerBindingInputOrigin::SourceBytes
            && owner.verification_status == ProfileVerificationStatus::Verified
    );
    assert!(!owner.is_transformed && owner.parent_source_sha256.is_none());

    let reopened_doc = state
        .open_profile_path(file_path)?
        .document
        .ok_or("expected reopened doc")?;
    assert!(reopened_doc.editable && reopened_doc.semantic == ProfileSemanticStatus::Validated);
    assert!(
        reopened_doc.verification_status == ProfileVerificationStatus::Verified
            && !reopened_doc.is_transformed
            && reopened_doc.parent_source_sha256.is_none()
    );
    Ok(())
}

#[test]
fn tfnc13_save_transport_failure_matrix_and_unavailable_fallback()
-> Result<(), Box<dyn std::error::Error>> {
    let temp = TempDirGuard::new("tfsb-c2-save-matrix");
    let mode_file = temp.path().join("fault-mode");
    std::fs::write(&mode_file, "pass")?;
    let fault_adapter = temp.path().join("fault-adapter.mjs");
    let mode_str = serde_json::to_string(&mode_file.to_string_lossy().into_owned())?;
    let real_str = serde_json::to_string(&find_real_adapter()?.to_string_lossy().into_owned())?;
    std::fs::write(
        &fault_adapter,
        format!(
            r#"import {{ readFileSync, writeFileSync }} from "node:fs";
import {{ spawnSync }} from "node:child_process";
const input = readFileSync(0, "utf8");
const mode = readFileSync({mode_str}, "utf8").trim();
if (mode === "second-bind-crash") {{ writeFileSync({mode_str}, "crash"); }}
else if (mode === "crash") process.exit(2);
else if (mode === "malformed") {{ process.stdout.write("not-json"); process.exit(0); }}
else if (mode === "protocol") {{ process.stdout.write(JSON.stringify({{ status: "bound", valid: true, schemaVersion: "tf-paired-profile-v1", aliasResolved: false, verificationStatus: "verified", rawSourceSha256: "bad" }})); process.exit(0); }}
else if (mode === "too-large") {{ process.stdout.write("x".repeat(2 * 1024 * 1024 + 2048)); process.exit(0); }}
else if (mode === "hang") {{ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 6500); process.exit(0); }}
const res = spawnSync(process.execPath, [{real_str}], {{ input, encoding: "utf8" }});
if (res.stdout) process.stdout.write(res.stdout);
if (res.stderr) process.stderr.write(res.stderr);
process.exit(res.status ?? 1);
"#
        ),
    )?;

    let state = AppThemeState::new(AppThemeRunner::new(find_node()?, fault_adapter));
    let orig_profile = sample_paired_v1();
    let orig_bytes = serde_json::to_vec_pretty(&orig_profile)?;
    let orig_path = temp.path().join("orig.json");
    std::fs::write(&orig_path, &orig_bytes)?;

    // Second-bind transport failure during V1 open must return open error, never UNSUPPORTED_V1_EXTENSION
    std::fs::write(&mode_file, "second-bind-crash")?;
    let second_bind_fail = state.open_profile_path(orig_path.clone())?;
    assert!(second_bind_fail.document.is_none() && second_bind_fail.error.is_some());
    std::fs::write(&mode_file, "pass")?;

    let orig_doc = state
        .open_profile_path(orig_path.clone())?
        .document
        .ok_or("expected orig doc")?;
    for fault in ["crash", "malformed", "protocol", "too-large", "hang"] {
        std::fs::write(&mode_file, fault)?;
        let (absent_edit, sentinel_edit) = (
            temp.path().join(format!("absent-edit-{fault}.json")),
            temp.path().join(format!("sentinel-edit-{fault}.json")),
        );
        std::fs::write(&sentinel_edit, b"SENTINEL_EDITED")?;
        for target in [&absent_edit, &sentinel_edit] {
            let res = state.save_profile_path(
                save_req(
                    Some(orig_profile.clone()),
                    Some(orig_doc.document_id.clone()),
                    ProfileSaveMode::Edited,
                ),
                target.clone(),
            )?;
            assert!(!res.saved && !res.cancelled && res.error.is_some());
        }
        assert!(!absent_edit.exists() && std::fs::read(&sentinel_edit)? == b"SENTINEL_EDITED");
        assert_eq!(
            state.status().active_document_id.as_deref(),
            Some(orig_doc.document_id.as_str())
        );
        let orig_copy = temp.path().join(format!("orig-after-{fault}.json"));
        let ok_orig = state.save_profile_path(
            save_req(
                None,
                Some(orig_doc.document_id.clone()),
                ProfileSaveMode::Original,
            ),
            orig_copy.clone(),
        )?;
        assert!(ok_orig.saved && std::fs::read(&orig_copy)? == orig_bytes);
    }

    state.reset()?;
    for fault in ["crash", "malformed", "protocol", "too-large"] {
        std::fs::write(&mode_file, fault)?;
        let (absent_new, sentinel_new) = (
            temp.path().join(format!("absent-new-{fault}.json")),
            temp.path().join(format!("sentinel-new-{fault}.json")),
        );
        std::fs::write(&sentinel_new, b"SENTINEL_NEW")?;
        for target in [&absent_new, &sentinel_new] {
            let res = state.save_profile_path(
                save_req(
                    Some(orig_profile.clone()),
                    None,
                    ProfileSaveMode::NewDocument,
                ),
                target.clone(),
            )?;
            assert!(!res.saved && !res.cancelled && res.error.is_some());
        }
        assert!(
            !absent_new.exists()
                && std::fs::read(&sentinel_new)? == b"SENTINEL_NEW"
                && state.status().active_document_id.is_none()
        );
    }

    let unavail_state = AppThemeState::new(AppThemeRunner::new(
        PathBuf::from("/nonexistent/node"),
        PathBuf::from("/nonexistent/adapter.mjs"),
    ));
    let unavail_open_doc = unavail_state
        .open_profile_path(orig_path)?
        .document
        .ok_or("expected unavailable open doc")?;
    assert!(
        !unavail_open_doc.alias_resolved
            && unavail_open_doc.editable
            && unavail_open_doc.semantic == ProfileSemanticStatus::Unavailable
            && unavail_open_doc.owner_binding.is_none()
    );
    let unavail_edited = unavail_state
        .save_profile_path(
            save_req(
                Some(orig_profile.clone()),
                Some(unavail_open_doc.document_id),
                ProfileSaveMode::Edited,
            ),
            temp.path().join("unavail-edited.json"),
        )?
        .document
        .ok_or("expected unavailable edited doc")?;
    assert!(
        unavail_edited.semantic == ProfileSemanticStatus::Unavailable
            && unavail_edited.verification_status == ProfileVerificationStatus::Transformed
    );
    assert!(unavail_edited.is_transformed && unavail_edited.owner_binding.is_none());
    assert_eq!(
        unavail_edited.parent_source_sha256.as_deref(),
        Some(unavail_open_doc.raw_source_sha256.as_str())
    );

    let mut alias_val = serde_json::to_value(&orig_profile)?;
    if let Some(obj) = alias_val.as_object_mut() {
        obj.remove("schemaVersion");
        obj.insert("schema".into(), serde_json::json!("tf-paired-profile-v1"));
    }
    let alias_unavail_path = temp.path().join("alias-unavail.json");
    std::fs::write(&alias_unavail_path, serde_json::to_vec(&alias_val)?)?;
    let alias_unavail_doc = unavail_state
        .open_profile_path(alias_unavail_path)?
        .document
        .ok_or("expected alias unavailable doc")?;
    assert!(
        alias_unavail_doc.alias_resolved
            && alias_unavail_doc.editable
            && alias_unavail_doc.semantic == ProfileSemanticStatus::Unavailable
            && alias_unavail_doc.owner_binding.is_none()
    );

    // Local fallback fail-closed negatives: wrong discriminator version, conflicting/missing discriminator, V2, duplicate/escaped keys, BOM/invalid UTF-8, unknown field, u32 overflow, oversize
    for (idx, key) in ["schemaVersion", "schema"].into_iter().enumerate() {
        let mut wrong_ver = serde_json::to_value(&orig_profile)?;
        if let Some(obj) = wrong_ver.as_object_mut() {
            obj.remove("schemaVersion");
            obj.insert(key.into(), serde_json::json!("tf-paired-profile-v2"));
        }
        let p = temp.path().join(format!("unavail-wrong-ver-{idx}.json"));
        std::fs::write(&p, serde_json::to_vec(&wrong_ver)?)?;
        let r = unavail_state.open_profile_path(p)?;
        assert!(
            r.document.is_none()
                && r.error
                    .unwrap_or_default()
                    .contains("expected 'tf-paired-profile-v1'")
        );
    }
    let mut bom_bytes = vec![0xEF, 0xBB, 0xBF];
    bom_bytes.extend_from_slice(&orig_bytes);
    let orig_str = String::from_utf8(orig_bytes.clone())?;
    let dup_lit = orig_str
        .replacen(
            "\"name\": \"forge-console\",",
            "\"name\": \"forge-console\", \"name\": \"dup\",",
            1,
        )
        .into_bytes();
    let dup_esc = orig_str
        .replacen(
            "\"name\": \"forge-console\",",
            "\"name\": \"forge-console\", \"\\u006eame\": \"dup\",",
            1,
        )
        .into_bytes();
    let both_disc = orig_str
        .replacen(
            "\"schemaVersion\": \"tf-paired-profile-v1\",",
            "\"schemaVersion\": \"tf-paired-profile-v1\", \"schema\": \"tf-paired-profile-v1\",",
            1,
        )
        .into_bytes();
    let no_disc = orig_str
        .replacen("\"schemaVersion\": \"tf-paired-profile-v1\",", "", 1)
        .into_bytes();
    let unknown_fld = orig_str
        .replacen(
            "\"name\": \"forge-console\",",
            "\"name\": \"forge-console\", \"unknownField\": 1,",
            1,
        )
        .into_bytes();
    let u32_over = orig_str
        .replacen("\"content\": 1280", "\"content\": 4294967296", 1)
        .into_bytes();
    for (idx, bad_bytes) in [
        both_disc,
        no_disc,
        raw_v2_with_loom_content("704").into_bytes(),
        dup_lit,
        dup_esc,
        bom_bytes,
        b"{\"schemaVersion\":\"tf-paired-profile-v1\",\"name\":\"\xff\xfe\"}".to_vec(),
        unknown_fld,
        u32_over,
    ]
    .into_iter()
    .enumerate()
    {
        let p = temp.path().join(format!("unavail-corrupt-{idx}.json"));
        std::fs::write(&p, bad_bytes)?;
        let d = unavail_state
            .open_profile_path(p)?
            .document
            .ok_or("expected corrupt fallback doc")?;
        assert!(
            d.schema_version == ProfileDocumentSchemaVersion::Corrupt
                && !d.editable
                && d.owner_binding.is_none()
                && d.diagnostic_code.as_deref() == Some("LOCAL_DTO_REJECTED")
        );
    }
    let over_unavail = temp.path().join("unavail-oversize.json");
    std::fs::write(&over_unavail, vec![b' '; 1_048_577])?;
    let over_res = unavail_state.open_profile_path(over_unavail)?;
    assert!(
        over_res.document.is_none() && over_res.error.unwrap_or_default().contains("maximum size")
    );

    unavail_state.reset()?;
    let unavail_new_doc = unavail_state
        .save_profile_path(
            save_req(Some(orig_profile), None, ProfileSaveMode::NewDocument),
            temp.path().join("unavail-new.json"),
        )?
        .document
        .ok_or("expected unavailable new doc")?;
    assert!(
        unavail_new_doc.semantic == ProfileSemanticStatus::Unavailable
            && unavail_new_doc.verification_status
                == ProfileVerificationStatus::UnverifiedAssertion
    );
    assert!(
        !unavail_new_doc.is_transformed
            && unavail_new_doc.parent_source_sha256.is_none()
            && unavail_new_doc.owner_binding.is_none()
    );
    Ok(())
}

#[path = "support/app_theme_fifo_fixture.rs"]
mod app_theme_fifo_fixture;

#[test]
fn tfnc13_fifo_document_lane_and_compile_isolation() -> Result<(), Box<dyn std::error::Error>> {
    app_theme_fifo_fixture::run_tfnc13_fifo_document_lane_and_compile_isolation()
}

#[test]
fn tfnc13_payload_closure_authentication_verifies_manifest_and_transitive_modules()
-> Result<(), Box<dyn std::error::Error>> {
    let adapter = find_real_adapter()?;
    authenticate_payload_closure(&adapter)?;
    let temp = TempDirGuard::new("tfsb-tfnc13-payload-auth");
    let (fake_adapter_dir, fake_payload_dir) = (
        temp.path().join("solar-sail-adapter"),
        temp.path().join("solar-sail-payload"),
    );
    std::fs::create_dir_all(&fake_adapter_dir)?;
    std::fs::create_dir_all(fake_payload_dir.join("dist/paired-v2"))?;
    let fake_adapter = fake_adapter_dir.join("solar-sail-adapter.mjs");
    std::fs::copy(&adapter, &fake_adapter)?;
    let real_payload = adapter
        .parent()
        .and_then(|p| p.parent())
        .map(|r| r.join("solar-sail-payload"))
        .ok_or("missing real payload dir")?;
    for rel in [
        "solar-sail-binding.json",
        "package.json",
        "dist/index.js",
        "dist/input.js",
        "dist/paired-v2/bound.js",
    ] {
        std::fs::copy(real_payload.join(rel), fake_payload_dir.join(rel))?;
    }
    assert_err_code(
        authenticate_payload_closure(&fake_adapter),
        StudioReasonCode::SidecarArtifactUnavailable,
    )?;
    for top in [
        "COMMERCIAL-LICENSE.md",
        "LICENSE",
        "NOTICE",
        "README.md",
        "package.json",
        "solar-sail-binding.json",
    ] {
        std::fs::copy(real_payload.join(top), fake_payload_dir.join(top))?;
    }
    for sub in ["dist", "dist/paired-v2"] {
        for entry in std::fs::read_dir(real_payload.join(sub))? {
            let p = entry?.path();
            if p.is_file() {
                std::fs::copy(
                    &p,
                    fake_payload_dir
                        .join(sub)
                        .join(p.file_name().ok_or("missing name")?),
                )?;
            }
        }
    }
    authenticate_payload_closure(&fake_adapter)?;
    std::fs::remove_file(fake_payload_dir.join("dist/paired-v2/bound.js"))?;
    assert_err_code(
        authenticate_payload_closure(&fake_adapter),
        StudioReasonCode::SidecarArtifactUnavailable,
    )
}

#[test]
fn tfnc13_sidebar_and_loom_override_forwarding_in_paired_compile()
-> Result<(), Box<dyn std::error::Error>> {
    let state = AppThemeState::new(AppThemeRunner::new(find_node()?, find_real_adapter()?));
    let mut profile = sample_paired_v1();
    profile.palette.light.sidebar = Some("#112233".to_string());
    profile.palette.dark.sidebar = Some("#445566".to_string());
    profile.target_overrides = Some(TargetOverridesDto {
        loom: Some(LoomTargetOverridesDto {
            content: Some(720),
            default_accent: Some("orange".to_string()),
            primary_family: Some("cyan".to_string()),
            secondary_family: Some("orange".to_string()),
            syntax: Some(SyntaxOverridesDto {
                light: Some(SyntaxPaletteDto {
                    comment: Some("#654321".to_string()),
                    ..SyntaxPaletteDto::default()
                }),
                dark: None,
            }),
            ..LoomTargetOverridesDto::default()
        }),
        solar_sail: None,
        syntax: None,
    });
    let compiled = state.paired_compile(AppThemePairedCompileRequest {
        profile,
        ui_revision: Some(1),
        session_id: None,
    })?;
    assert!(
        compiled.valid,
        "paired compile failed: {:?}",
        compiled.error
    );
    let ss_css = compiled
        .solar_sail
        .compiled_css
        .ok_or("expected solar sail css")?;
    assert!(ss_css.contains("#112233") && ss_css.contains("#445566"));
    Ok(())
}

#[test]
fn tfnc13_same_mtime_external_modification_rejected() -> Result<(), Box<dyn std::error::Error>> {
    let state = AppThemeState::new(AppThemeRunner::new(find_node()?, find_real_adapter()?));
    let temp = TempDirGuard::new("tfsb-tfnc13-same-mtime");
    let profile = sample_paired_v1();
    let path = temp.path().join("same-mtime.json");
    std::fs::write(&path, serde_json::to_vec_pretty(&profile)?)?;
    let doc = state
        .open_profile_path(path.clone())?
        .document
        .ok_or("expected opened doc")?;
    let orig_mtime = std::fs::metadata(&path)?.modified()?;
    let mut modified_profile = profile.clone();
    modified_profile.name = "externally-tampered".to_string();
    std::fs::write(&path, serde_json::to_vec_pretty(&modified_profile)?)?;
    let file = std::fs::File::options().write(true).open(&path)?;
    file.set_times(std::fs::FileTimes::new().set_modified(orig_mtime))?;
    drop(file);
    let save_res = state.save_profile_path(
        save_req(
            Some(profile),
            Some(doc.document_id),
            ProfileSaveMode::Edited,
        ),
        path,
    )?;
    assert!(
        !save_res.saved
            && save_res
                .error
                .unwrap_or_default()
                .contains("modified externally")
    );
    Ok(())
}
