use std::path::{Path, PathBuf};
use tfsb_studio_lib::state::theme_lab::ThemeLabState;
use tfsb_studio_lib::theme_lab::runner::{COMPILER_VERSION, ThemeLabRunner};
use tfsb_studio_lib::theme_lab::types::ThemeCandidateAdoptRequest;

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
    Err("node runtime executable not found in PATH or standard locations".into())
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

fn find_loom_fixtures() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("loom-payload/protocol/tfsl-theme-evidence-v1/examples"),
        repo_root().join("packages/stellar-loom/protocol/tfsl-theme-evidence-v1/examples"),
    ];
    for candidate in &candidates {
        if candidate.is_dir() {
            return Ok(candidate.clone());
        }
    }
    Err(format!(
        "Loom fixtures not found in expected locations: {:?}",
        candidates
    )
    .into())
}

fn create_test_runner() -> Result<ThemeLabRunner, Box<dyn std::error::Error>> {
    let node = find_node()?;
    let batch_script = find_loom_batch()?;
    Ok(ThemeLabRunner::new(node, batch_script))
}

#[test]
fn compiler_version_cross_boundary_agreement() -> Result<(), Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let candidates = [
        manifest_dir.join("loom-payload/package.json"),
        repo_root().join("packages/stellar-loom/package.json"),
    ];
    let pkg_json_path = candidates.iter().find(|p| p.is_file()).ok_or_else(|| {
        format!(
            "Loom package.json not found in expected locations: {:?}",
            candidates
        )
    })?;
    let content = std::fs::read_to_string(pkg_json_path)?;
    let parsed: serde_json::Value = serde_json::from_str(&content)?;
    let pkg_version = parsed["version"]
        .as_str()
        .ok_or("missing version in package.json")?;
    assert_eq!(
        COMPILER_VERSION, pkg_version,
        "Rust COMPILER_VERSION must match stellar-loom package.json version"
    );
    Ok(())
}

#[test]
fn packet_commands_reject_frontend_paths() {
    use tfsb_studio_lib::theme_lab::types::{ThemePacketExportRequest, ThemePacketImportRequest};
    for key in ["filePath", "file_path"] {
        let import = format!(r#"{{"{key}":"unselected.json"}}"#);
        assert!(serde_json::from_str::<ThemePacketImportRequest>(&import).is_err());
        let export = format!(r#"{{"packetJson":"{{}}","{key}":"unselected.json"}}"#);
        assert!(serde_json::from_str::<ThemePacketExportRequest>(&export).is_err());
    }
}

#[test]
fn adoption_rejects_forgery_and_expired_lifetime() -> Result<(), Box<dyn std::error::Error>> {
    let state = ThemeLabState::new(create_test_runner()?);
    let fixtures = find_loom_fixtures()?;
    let brief = std::fs::read_to_string(fixtures.join("brief.tfsl-brief.json"))?;
    let candidate = std::fs::read_to_string(fixtures.join("candidate-a.tfsl-candidate.json"))?;
    let original = state.status();
    let forged = candidate.replace(
        "\"themeDigest\": \"sha256:",
        "\"themeDigest\": \"sha256:0000",
    );
    let result = state.adopt_candidate(ThemeCandidateAdoptRequest {
        candidate: forged,
        brief: brief.clone(),
        session_id: original.session_id.clone(),
        ui_revision: original.latest_revision + 1,
        force: true,
        options: None,
    })?;
    assert!(!result.adopted);
    assert_eq!(state.status().dirty, Some(false));
    assert_eq!(state.status().adopted_theme_digest, None);
    state.cancel_active();
    let expired = state.adopt_candidate(ThemeCandidateAdoptRequest {
        candidate,
        brief,
        session_id: original.session_id,
        ui_revision: state.status().latest_revision + 1,
        force: true,
        options: None,
    });
    assert!(expired.is_err());
    assert_eq!(state.status().dirty, Some(false));
    assert_eq!(state.status().adopted_theme_digest, None);
    Ok(())
}

#[test]
fn theme_brief_create_and_parse_roundtrip() -> Result<(), Box<dyn std::error::Error>> {
    let runner = create_test_runner()?;

    let brief_fixture_path = find_loom_fixtures()?.join("brief.tfsl-brief.json");
    let brief_json = std::fs::read_to_string(&brief_fixture_path)?;
    let brief_val: serde_json::Value = serde_json::from_str(&brief_json)?;

    let brief_input = serde_json::json!({
        "briefId": "brief-rust-test",
        "title": "Rust Test Brief",
        "goal": "Integration test brief created from Rust host",
        "baselineTheme": brief_val["baselineTheme"]
    });

    let res = runner.create_brief(brief_input.to_string())?;
    assert!(res.valid, "create_brief should succeed: {:?}", res.error);
    let packet: serde_json::Value = serde_json::from_str(
        res.canonical_json
            .as_deref()
            .ok_or("missing canonical packet")?,
    )?;
    let canonical = res
        .canonical_json
        .ok_or("missing canonical_json in response")?;
    let digest = res.digest.ok_or("missing digest in response")?;

    assert_eq!(packet["schema"], "tfsl.theme-brief");
    assert_eq!(packet["schemaVersion"], 1);
    assert_eq!(packet["briefId"], "brief-rust-test");
    assert!(digest.starts_with("sha256:"));

    // Parse packet back
    let parse_res = runner.parse_packet(canonical, Some("brief".to_string()))?;
    assert!(parse_res.valid, "parse_packet should succeed");
    assert_eq!(parse_res.kind.as_deref(), Some("brief"));
    assert_eq!(parse_res.digest.as_deref(), Some(digest.as_str()));

    Ok(())
}

#[test]
fn theme_candidate_verify_and_adopt_lifecycle() -> Result<(), Box<dyn std::error::Error>> {
    let runner = create_test_runner()?;
    let state = ThemeLabState::new(runner.clone());

    let fixtures = find_loom_fixtures()?;
    let brief_fixture_path = fixtures.join("brief.tfsl-brief.json");
    let candidate_fixture_path = fixtures.join("candidate-a.tfsl-candidate.json");

    let brief_json = std::fs::read_to_string(&brief_fixture_path)?;
    let candidate_json = std::fs::read_to_string(&candidate_fixture_path)?;

    let candidate_val: serde_json::Value = serde_json::from_str(&candidate_json)?;

    // 1. Verify candidate against brief
    let verify_res = runner.verify_candidate(candidate_json.clone(), brief_json.clone(), None)?;
    assert!(
        verify_res.valid,
        "verify_candidate should succeed: {:?}",
        verify_res.error
    );
    let candidate_verification = verify_res
        .candidate_verification
        .ok_or("missing candidate_verification")?;
    assert!(candidate_verification.valid);

    // 2. Initial state is clean
    let status_initial = state.status();
    assert_eq!(status_initial.dirty, Some(false));
    assert_eq!(status_initial.adopted_theme_digest, None);

    // 3. Adopt candidate into session
    let adopt_res = state.adopt_candidate(ThemeCandidateAdoptRequest {
        candidate: candidate_json.clone(),
        brief: brief_json.clone(),
        session_id: state.status().session_id,
        ui_revision: state.status().latest_revision + 1,
        force: false,
        options: None,
    })?;
    assert!(adopt_res.adopted, "first adoption should succeed");
    assert!(!adopt_res.requires_confirmation);
    assert!(adopt_res.specification.is_some());
    assert!(adopt_res.compiled_css.is_some());

    // Verify state is now dirty and adopted_theme_digest matches candidate
    let status_after = state.status();
    assert_eq!(status_after.dirty, Some(true));
    let expected_digest = candidate_val["themeDigest"]
        .as_str()
        .ok_or("fixture digest missing")?;
    assert_eq!(
        status_after.adopted_theme_digest.as_deref(),
        Some(expected_digest)
    );

    // 4. Second adoption without force should require confirmation because session is dirty
    let adopt_second = state.adopt_candidate(ThemeCandidateAdoptRequest {
        candidate: candidate_json.clone(),
        brief: brief_json.clone(),
        session_id: state.status().session_id,
        ui_revision: state.status().latest_revision + 1,
        force: false,
        options: None,
    })?;
    assert!(!adopt_second.adopted);
    assert!(adopt_second.requires_confirmation);
    assert_eq!(
        state.status().adopted_theme_digest,
        status_after.adopted_theme_digest
    );

    // 5. Adoption with force = true should succeed even when dirty
    let adopt_forced = state.adopt_candidate(ThemeCandidateAdoptRequest {
        candidate: candidate_json,
        brief: brief_json,
        session_id: state.status().session_id,
        ui_revision: state.status().latest_revision + 1,
        force: true,
        options: None,
    })?;
    assert!(adopt_forced.adopted, "forced adoption should succeed");
    assert!(!adopt_forced.requires_confirmation);

    Ok(())
}

#[test]
fn theme_review_create_with_annotations_and_dispositions() -> Result<(), Box<dyn std::error::Error>>
{
    let runner = create_test_runner()?;

    let fixtures = find_loom_fixtures()?;
    let brief_fixture_path = fixtures.join("brief.tfsl-brief.json");
    let candidate_fixture_path = fixtures.join("candidate-a.tfsl-candidate.json");

    let brief_json = std::fs::read_to_string(&brief_fixture_path)?;
    let candidate_json = std::fs::read_to_string(&candidate_fixture_path)?;

    let brief_val: serde_json::Value = serde_json::from_str(&brief_json)?;
    let candidate_val: serde_json::Value = serde_json::from_str(&candidate_json)?;

    let brief_digest = brief_val["briefDigest"]
        .as_str()
        .ok_or("fixture digest missing")?;
    let candidate_digest = candidate_val["candidateDigest"]
        .as_str()
        .ok_or("fixture digest missing")?;

    let review_input = serde_json::json!({
        "reviewId": "review-rust-test",
        "brief": brief_digest,
        "candidateDigests": [candidate_digest],
        "overallDisposition": {
            "kind": "approved",
            "candidateDigest": candidate_digest
        },
        "summary": "Rust integration review test: candidate approved.",
        "dispositions": [
            {
                "candidateDigest": candidate_digest,
                "disposition": "approved",
                "comment": "Candidate meets all brand criteria and WCAG AA contrast."
            }
        ],
        "annotations": [
            {
                "annotationId": "ann-1",
                "candidateDigest": candidate_digest,
                "category": "contrast",
                "comment": "Good accent vibrancy.",
                "severity": "note",
                "target": {
                    "kind": "field",
                    "fieldPath": "colors.dark.accent.base",
                    "mode": "dark"
                }
            }
        ]
    });

    let res = runner.create_review(review_input.to_string())?;
    assert!(res.valid, "create_review should succeed: {:?}", res.error);
    let packet: serde_json::Value = serde_json::from_str(
        res.canonical_json
            .as_deref()
            .ok_or("missing canonical packet")?,
    )?;
    assert_eq!(packet["schema"], "tfsl.theme-review");
    assert_eq!(packet["reviewId"], "review-rust-test");
    assert_eq!(packet["overallDisposition"]["kind"], "approved");

    Ok(())
}

#[test]
fn theme_packet_export_absent_only_and_import_roundtrip() -> Result<(), Box<dyn std::error::Error>>
{
    use tfsb_studio_lib::commands::theme_packet::{
        export_theme_packet_to_path, import_theme_packet_from_path,
    };
    use tfsb_studio_lib::theme_lab::types::ThemePacketExportRequest;

    let runner = create_test_runner()?;
    let state = ThemeLabState::new(runner);

    let brief_fixture_path = find_loom_fixtures()?.join("brief.tfsl-brief.json");
    let brief_json = std::fs::read_to_string(&brief_fixture_path)?;

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)?
        .as_nanos();
    let temp_dir = std::env::temp_dir().join(format!("tfsb-packet-test-{nanos}"));
    std::fs::create_dir_all(&temp_dir)?;

    let target_file = temp_dir.join("exported-brief.tfsl-brief.json");

    // 1. Export to target file - must succeed
    let export_req = ThemePacketExportRequest {
        packet_json: brief_json.clone(),
        default_name: None,
    };
    let export_res = export_theme_packet_to_path(
        Some(target_file.clone()),
        export_req.packet_json.clone(),
        &state,
    )?;
    assert!(export_res.saved, "export should succeed for new file");
    assert!(target_file.is_file(), "exported file must exist");

    // 2. Export to the SAME target file - must FAIL (absent-only write)
    let export_collision =
        export_theme_packet_to_path(Some(target_file.clone()), export_req.packet_json, &state);
    assert!(
        export_collision.is_err(),
        "exporting over existing packet must fail"
    );

    // 3. Export with wrong extension - must FAIL
    let wrong_ext_file = temp_dir.join("exported-brief.txt");
    let export_wrong_ext = export_theme_packet_to_path(Some(wrong_ext_file), brief_json, &state);
    assert!(
        export_wrong_ext.is_err(),
        "exporting with wrong extension must fail"
    );

    // 4. Import the exported packet from path - must succeed
    let import_res = import_theme_packet_from_path(
        Some(target_file.clone()),
        Some("brief".to_string()),
        &state,
    )?;
    assert!(!import_res.cancelled);
    assert_eq!(import_res.kind.as_deref(), Some("brief"));
    assert!(import_res.canonical_json.is_some());

    let original_bytes = std::fs::read(&target_file)?;
    let wrong_kind = import_theme_packet_from_path(
        Some(target_file.clone()),
        Some("review".to_owned()),
        &state,
    )?;
    assert!(wrong_kind.error.is_some());
    assert!(!wrong_kind.cancelled);
    assert!(import_theme_packet_from_path(None, None, &state)?.cancelled);
    assert!(export_theme_packet_to_path(None, "{}".to_owned(), &state)?.cancelled);
    let invalid_output = temp_dir.join("invalid.json");
    let invalid =
        export_theme_packet_to_path(Some(invalid_output.clone()), "{}".to_owned(), &state)?;
    assert!(invalid.error.is_some());
    assert!(!invalid.saved);
    assert!(!invalid_output.exists());
    let linked = temp_dir.join("linked.json");
    std::os::unix::fs::symlink(&target_file, &linked)?;
    assert!(import_theme_packet_from_path(Some(linked), None, &state).is_err());
    assert!(import_theme_packet_from_path(Some(temp_dir.clone()), None, &state).is_err());
    let oversized = temp_dir.join("oversized.json");
    std::fs::File::create(&oversized)?.set_len(16 * 1024 * 1024 + 1)?;
    assert!(import_theme_packet_from_path(Some(oversized), None, &state).is_err());
    assert_eq!(std::fs::read(&target_file)?, original_bytes);

    // Clean up
    let _ = std::fs::remove_dir_all(temp_dir);

    Ok(())
}
