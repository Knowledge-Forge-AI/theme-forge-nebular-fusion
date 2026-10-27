use super::*;

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self { path }
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Builds a synthetic structural verifier control (for unit-testing verifier failure modes only,
/// never used as a semantic production discovery positive).
fn build_synthetic_verifier_control(root: &Path) -> (PathBuf, SolarSailBuildPinDto) {
    let payload_dir = root.join("solar-sail-payload");
    fs::create_dir_all(payload_dir.join("dist/paired-v2")).expect("create dist/paired-v2");
    fs::create_dir_all(payload_dir.join("dist/assets")).expect("create dist/assets");

    let pkg_bytes = br#"{"name":"@knowledge-forge-ai/theme-forge-solar-sail","version":"0.3.0","type":"module"}"#;
    fs::write(payload_dir.join("package.json"), pkg_bytes).expect("write package.json");
    for doc in ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"] {
        fs::write(payload_dir.join(doc), format!("{doc} content\n")).expect("write metadata");
    }

    let dist_files: [(&str, &str); 10] = [
        ("dist/assets/tokens.json", "{\"schema\":\"tokens\"}\n"),
        ("dist/cli.d.ts", "export declare const cli: string;\n"),
        ("dist/cli.js", "export const cli = 'cli';\n"),
        ("dist/compiler.d.ts", "export declare const compile: string;\n"),
        ("dist/compiler.js", "export const compile = 'compile';\n"),
        ("dist/index.d.ts", "export declare const index: string;\n"),
        ("dist/index.d.ts.map", "{\"version\":3,\"file\":\"index.d.ts\"}\n"),
        (
            "dist/index.js",
            "import './input.js';\nimport './compiler.js';\nimport './paired-v2/bound.js';\nexport const ok = true;\n",
        ),
        ("dist/input.js", "export const input = 'input';\n"),
        ("dist/paired-v2/bound.js", "export const bound = 'bound';\n"),
    ];
    for (rel, content) in dist_files {
        fs::write(payload_dir.join(rel), content).expect("write dist member");
    }

    let pin = seal_synthetic_payload(&payload_dir, "aarch64-apple-darwin");
    (payload_dir, pin)
}

fn seal_synthetic_payload(payload_dir: &Path, target: &str) -> SolarSailBuildPinDto {
    let pkg_bytes = fs::read(payload_dir.join("package.json")).expect("read package.json");
    let pkg_sha = sha256_hex(&pkg_bytes);
    let mut rel_paths = Vec::new();
    collect_physical_dist_files(&payload_dir.join("dist"), "dist", 2, &mut rel_paths)
        .expect("collect dist");
    rel_paths.sort();

    let mut members_json = Vec::new();
    let mut summary_lines = Vec::new();
    for rel in &rel_paths {
        let bytes = fs::read(payload_dir.join(rel)).expect("read member");
        let sha = sha256_hex(&bytes);
        summary_lines.push(format!("{rel}:{sha}"));
        members_json.push(serde_json::json!({
            "path": rel,
            "size": bytes.len() as u64,
            "sha256": sha,
        }));
    }
    let inv_digest = sha256_hex(summary_lines.join("\n").as_bytes());
    let binding_val = serde_json::json!({
        "schema": SOLAR_SAIL_BINDING_SCHEMA,
        "name": EXPECTED_SOLAR_SAIL_NAME,
        "version": ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION,
        "packageJsonSha256": pkg_sha,
        "inventoryDigest": inv_digest,
        "runtimeMemberCount": members_json.len(),
        "members": members_json,
    });
    let mut binding_bytes = serde_json::to_vec_pretty(&binding_val).expect("serialize binding");
    binding_bytes.push(b'\n');
    fs::write(payload_dir.join("solar-sail-binding.json"), &binding_bytes)
        .expect("write binding");

    SolarSailBuildPinDto {
        schema: SOLAR_SAIL_BUILD_PIN_SCHEMA.to_owned(),
        target: target.to_owned(),
        package: SolarSailBuildPinPackageDto {
            name: EXPECTED_SOLAR_SAIL_NAME.to_owned(),
            version: ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION.to_owned(),
            package_json_sha256: pkg_sha,
        },
        binding: SolarSailBuildPinBindingDto {
            size: binding_bytes.len() as u64,
            sha256: sha256_hex(&binding_bytes),
            inventory_digest: inv_digest,
            member_count: rel_paths.len(),
        },
        provenance: SolarSailProvenanceDto::PublishedArchive(PublishedArchiveProvenanceDto {
            name: EXPECTED_SOLAR_SAIL_NAME.to_owned(),
            version: ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION.to_owned(),
            size: ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE,
            sha256: ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256.to_owned(),
        }),
    }
}

#[test]
fn n1_to_n5_tamper_transitive_legacy_declarations_and_assets_rejected() {
    let tmp = TempDir::new("ss-auth-n1-n5");
    let (payload_dir, pin) = build_synthetic_verifier_control(&tmp.path);
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_ok());

    for rel in [
        "dist/input.js",
        "dist/paired-v2/bound.js",
        "dist/compiler.js",
        "dist/index.d.ts",
        "dist/index.d.ts.map",
        "dist/assets/tokens.json",
    ] {
        let full = payload_dir.join(rel);
        let orig = fs::read(&full).expect("read orig");
        let mut tampered = orig.clone();
        tampered[0] ^= 0x01;
        fs::write(&full, &tampered).expect("write tampered");
        let err = verify_payload_with_expectation(&payload_dir, &pin).unwrap_err();
        assert_eq!(err.reason_code(), StudioReasonCode::SidecarArtifactUnavailable);
        fs::write(&full, &orig).expect("restore orig");
        assert!(verify_payload_with_expectation(&payload_dir, &pin).is_ok());
    }
}

#[test]
fn n6_consistent_payload_and_binding_rewrite_fails_against_compiled_pin() {
    let tmp = TempDir::new("ss-auth-n6");
    let (payload_dir, compiled_pin) = build_synthetic_verifier_control(&tmp.path);
    fs::write(
        payload_dir.join("dist/paired-v2/bound.js"),
        "export const bound = 'rewritten';\n",
    )
    .expect("rewrite bound.js");
    let _rewritten_pin = seal_synthetic_payload(&payload_dir, "aarch64-apple-darwin");
    let err = verify_payload_with_expectation(&payload_dir, &compiled_pin).unwrap_err();
    assert_eq!(err.reason_code(), StudioReasonCode::SidecarArtifactUnavailable);
}

#[test]
fn n7_n8_n9_extra_or_missing_dist_and_top_level_leaves_rejected() {
    let tmp = TempDir::new("ss-auth-n7-n9");
    let (payload_dir, pin) = build_synthetic_verifier_control(&tmp.path);

    // N7: extra dist leaf
    let extra_dist = payload_dir.join("dist/extra.js");
    fs::write(&extra_dist, "export const x = 1;\n").expect("write extra");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&extra_dist).expect("remove extra");

    // N8: missing dist leaf
    let input_path = payload_dir.join("dist/input.js");
    let input_orig = fs::read(&input_path).expect("read input");
    fs::remove_file(&input_path).expect("remove input");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::write(&input_path, &input_orig).expect("restore input");

    // N9a: extra top-level file
    let extra_top = payload_dir.join("EXTRA.md");
    fs::write(&extra_top, "extra\n").expect("write extra top");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&extra_top).expect("remove extra top");

    // N9b: missing README.md
    let readme = payload_dir.join("README.md");
    let readme_orig = fs::read(&readme).expect("read readme");
    fs::remove_file(&readme).expect("remove readme");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::write(&readme, &readme_orig).expect("restore readme");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_ok());
}

#[cfg(unix)]
#[test]
fn n10_n11_n12_symlinks_and_special_socket_files_rejected() {
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;

    let tmp = TempDir::new("ss-auth-n10-n12");
    let (payload_dir, pin) = build_synthetic_verifier_control(&tmp.path);

    // N10: symlinked dist member
    let cli_path = payload_dir.join("dist/cli.js");
    let cli_orig = fs::read(&cli_path).expect("read cli");
    let outside = tmp.path.join("outside-cli.js");
    fs::write(&outside, &cli_orig).expect("write outside");
    fs::remove_file(&cli_path).expect("remove cli");
    symlink(&outside, &cli_path).expect("symlink cli");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&cli_path).expect("remove symlink");
    fs::write(&cli_path, &cli_orig).expect("restore cli");

    // N11: symlinked subdirectory in dist
    let pv2_dir = payload_dir.join("dist/paired-v2");
    let pv2_backup = tmp.path.join("paired-v2-backup");
    fs::rename(&pv2_dir, &pv2_backup).expect("move paired-v2");
    symlink(&pv2_backup, &pv2_dir).expect("symlink paired-v2");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&pv2_dir).expect("remove dir symlink");
    fs::rename(&pv2_backup, &pv2_dir).expect("restore paired-v2");

    // N12: bind at a short owned socket-root path, then move the live
    // socket into the deep fixture path before verification.  The bind
    // path must stay below the native sockaddr limit; only this test's
    // uniquely named entry is removed.  Qualification may provide a
    // shared scratch root; ordinary hosts use their platform temp root.
    let scratch_root = std::env::var_os("TFSB_APP_THEME_TEST_SOCKET_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let scratch_metadata = fs::metadata(&scratch_root).expect("socket fixture root metadata");
    assert!(
        scratch_metadata.is_dir(),
        "socket fixture root must be a directory: {}",
        scratch_root.display()
    );
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut bound = None;
    for attempt in 0..8 {
        let candidate = scratch_root.join(format!(
            "tfsb-socket-{}-{nonce}-{attempt}",
            std::process::id()
        ));
        match UnixListener::bind(&candidate) {
            Ok(listener) => {
                bound = Some((listener, candidate));
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => panic!("bind owned unix socket: {err}"),
        }
    }
    let (listener, bind_path) = bound.expect("reserve unique short socket path");
    let sock_path = payload_dir.join("dist/ipc.sock");
    fs::rename(&bind_path, &sock_path).expect("move live socket into fixture");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    drop(listener);
    fs::remove_file(&sock_path).expect("remove fixture socket");
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_ok());
}

#[test]
fn n13_to_n22_binding_path_order_collision_count_size_package_and_overflow_negatives() {
    let tmp = TempDir::new("ss-auth-n13-n22");
    let (payload_dir, base_pin) = build_synthetic_verifier_control(&tmp.path);
    for bad_path in [
        "../outside.js",
        "/dist/index.js",
        "dist/../index.js",
        "dist/./index.js",
        "dist/back\\slash.js",
        "dist/non-ascii-é.js",
        "dist//empty.js",
        "src/index.js",
    ] {
        assert!(!is_valid_dist_member_path(bad_path), "must reject {bad_path}");
    }

    let binding_path = payload_dir.join("solar-sail-binding.json");
    let orig_binding_bytes = fs::read(&binding_path).expect("read binding");
    let orig_val: serde_json::Value =
        serde_json::from_slice(&orig_binding_bytes).expect("parse binding");
    let re_pin_and_verify = |mutated: &serde_json::Value| -> StudioResult<()> {
        let bytes = serde_json::to_vec_pretty(mutated).expect("serialize mutated");
        fs::write(&binding_path, &bytes).expect("write mutated");
        let mut pin = base_pin.clone();
        pin.binding.size = bytes.len() as u64;
        pin.binding.sha256 = sha256_hex(&bytes);
        if let Some(inv) = mutated.get("inventoryDigest").and_then(|v| v.as_str()) {
            pin.binding.inventory_digest = inv.to_owned();
        }
        if let Some(cnt) = mutated.get("runtimeMemberCount").and_then(|v| v.as_u64()) {
            pin.binding.member_count = cnt as usize;
        }
        verify_payload_with_expectation(&payload_dir, &pin)
    };

    // N14: duplicate member path
    let mut dup = orig_val.clone();
    let first_member = dup["members"][0].clone();
    dup["members"].as_array_mut().unwrap().insert(0, first_member);
    dup["runtimeMemberCount"] = serde_json::json!(dup["members"].as_array().unwrap().len());
    assert!(re_pin_and_verify(&dup).is_err());

    // N15: out-of-order members
    let mut rev = orig_val.clone();
    rev["members"].as_array_mut().unwrap().reverse();
    assert!(re_pin_and_verify(&rev).is_err());

    // N16: ASCII case collision
    let mut case_coll = orig_val.clone();
    let mut colliding = case_coll["members"][0].clone();
    colliding["path"] = serde_json::json!("dist/ASSETS/tokens.json");
    case_coll["members"].as_array_mut().unwrap().insert(0, colliding);
    case_coll["runtimeMemberCount"] =
        serde_json::json!(case_coll["members"].as_array().unwrap().len());
    assert!(re_pin_and_verify(&case_coll).is_err());

    // N17 & N18: runtimeMemberCount and member size mismatch
    let mut bad_count = orig_val.clone();
    bad_count["runtimeMemberCount"] = serde_json::json!(99);
    assert!(re_pin_and_verify(&bad_count).is_err());
    let mut bad_size = orig_val.clone();
    bad_size["members"][0]["size"] = serde_json::json!(999_999u64);
    assert!(re_pin_and_verify(&bad_size).is_err());

    // N19 & N20: package.json tamper / SHA mismatch
    fs::write(&binding_path, &orig_binding_bytes).expect("restore binding");
    let pkg_path = payload_dir.join("package.json");
    let orig_pkg = fs::read(&pkg_path).expect("read pkg");
    fs::write(&pkg_path, br#"{"name":"@knowledge-forge-ai/theme-forge-solar-sail","version":"0.2.0"}"#).expect("tamper pkg");
    assert!(verify_payload_with_expectation(&payload_dir, &base_pin).is_err());
    fs::write(&pkg_path, &orig_pkg).expect("restore pkg");

    // N21 & N22: unknown binding field (generatedAt) and overflow limit
    let mut with_gen = orig_val.clone();
    with_gen["generatedAt"] = serde_json::json!("2026-10-19T00:00:00.000Z");
    assert!(re_pin_and_verify(&with_gen).is_err());
    let mut overflow_member = orig_val;
    overflow_member["members"][0]["size"] = serde_json::json!(MAX_MEMBER_BYTES + 1);
    assert!(re_pin_and_verify(&overflow_member).is_err());
}

#[test]
fn n23_n24_build_pin_grammar_and_provenance_negatives() {
    let valid_pub = serde_json::json!({
        "schema": SOLAR_SAIL_BUILD_PIN_SCHEMA,
        "target": "aarch64-apple-darwin",
        "package": { "name": EXPECTED_SOLAR_SAIL_NAME, "version": ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION, "packageJsonSha256": "a".repeat(64) },
        "binding": { "size": 512, "sha256": "b".repeat(64), "inventoryDigest": "c".repeat(64), "memberCount": 10 },
        "provenance": { "publishedArchive": { "name": EXPECTED_SOLAR_SAIL_NAME, "version": ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION, "size": ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE, "sha256": ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256 } }
    });
    assert!(parse_build_pin_expectation(&valid_pub.to_string(), "published-archive", "aarch64-apple-darwin", None).is_ok());
    assert!(parse_build_pin_expectation(&valid_pub.to_string(), "structured-source", "aarch64-apple-darwin", Some(&"d".repeat(64))).is_err());
    assert!(parse_build_pin_expectation(&valid_pub.to_string(), "published-archive", "x86_64-unknown-linux-gnu", None).is_err());

    let mut both = valid_pub.clone();
    both["provenance"]["structuredSource"] = serde_json::json!({
        "sourceCandidate": "d".repeat(64), "componentSource": "e".repeat(64), "output": "f".repeat(64), "producer": "1".repeat(64), "version": "0.2.1",
    });
    assert!(parse_build_pin_expectation(&both.to_string(), "published-archive", "aarch64-apple-darwin", None).is_err());

    let mut neither = valid_pub.clone();
    neither["provenance"] = serde_json::json!({});
    assert!(parse_build_pin_expectation(&neither.to_string(), "published-archive", "aarch64-apple-darwin", None).is_err());

    let mut unknown_key = valid_pub.clone();
    unknown_key["extra"] = serde_json::json!(true);
    assert!(parse_build_pin_expectation(&unknown_key.to_string(), "published-archive", "aarch64-apple-darwin", None).is_err());

    let mut wrong_schema = valid_pub.clone();
    wrong_schema["schema"] = serde_json::json!("nebular-solar-sail-build-pin-v0");
    assert!(parse_build_pin_expectation(&wrong_schema.to_string(), "published-archive", "aarch64-apple-darwin", None).is_err());

    for (field, bad_val) in [
        ("version", serde_json::json!("0.2.0")),
        ("size", serde_json::json!(110_659u64)),
        ("sha256", serde_json::json!("0".repeat(64))),
    ] {
        let mut bad = valid_pub.clone();
        bad["provenance"]["publishedArchive"][field] = bad_val;
        assert!(parse_build_pin_expectation(&bad.to_string(), "published-archive", "aarch64-apple-darwin", None).is_err());
    }

    let valid_src = serde_json::json!({
        "schema": SOLAR_SAIL_BUILD_PIN_SCHEMA,
        "target": "aarch64-apple-darwin",
        "package": { "name": EXPECTED_SOLAR_SAIL_NAME, "version": "0.2.1", "packageJsonSha256": "a".repeat(64) },
        "binding": { "size": 512, "sha256": "b".repeat(64), "inventoryDigest": "c".repeat(64), "memberCount": 16 },
        "provenance": { "structuredSource": { "sourceCandidate": "d".repeat(64), "componentSource": "e".repeat(64), "output": "f".repeat(64), "producer": "1".repeat(64), "version": "0.2.1" } }
    });
    assert!(parse_build_pin_expectation(&valid_src.to_string(), "structured-source", "aarch64-apple-darwin", Some(&"d".repeat(64))).is_ok());
    assert!(parse_build_pin_expectation(&valid_src.to_string(), "structured-source", "aarch64-apple-darwin", Some(&"9".repeat(64))).is_err());
    for (field, bad_val) in [
        ("componentSource", serde_json::json!("bad")),
        ("output", serde_json::json!("bad")),
        ("producer", serde_json::json!("bad")),
        ("version", serde_json::json!("0.2.0")),
    ] {
        let mut bad_src = valid_src.clone();
        bad_src["provenance"]["structuredSource"][field] = bad_val;
        assert!(parse_build_pin_expectation(&bad_src.to_string(), "structured-source", "aarch64-apple-darwin", Some(&"d".repeat(64))).is_err());
    }
    #[cfg(not(nebular_solar_sail_pin))]
    assert!(compiled_expectation().is_err());
}
