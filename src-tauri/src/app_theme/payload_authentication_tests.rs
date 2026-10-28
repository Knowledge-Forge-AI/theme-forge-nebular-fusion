use super::*;

type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

fn test_failure(message: impl Into<String>) -> Box<dyn std::error::Error> {
    Box::new(std::io::Error::other(message.into()))
}

fn required_error<T, E>(result: Result<T, E>) -> TestResult<E>
where
    E: std::error::Error + 'static,
{
    match result {
        Ok(_) => Err(test_failure("expected verifier error")),
        Err(error) => Ok(error),
    }
}

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> TestResult<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path)?;
        Ok(Self { path })
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

/// Builds a synthetic structural verifier control (for unit-testing verifier failure modes only,
/// never used as a semantic production discovery positive).
fn build_synthetic_verifier_control(root: &Path) -> TestResult<(PathBuf, SolarSailBuildPinDto)> {
    let payload_dir = root.join("solar-sail-payload");
    fs::create_dir_all(payload_dir.join("dist/paired-v2"))?;
    fs::create_dir_all(payload_dir.join("dist/assets"))?;

    let pkg_bytes = br#"{"name":"@knowledge-forge-ai/theme-forge-solar-sail","version":"0.3.0","type":"module"}"#;
    fs::write(payload_dir.join("package.json"), pkg_bytes)?;
    for doc in ["LICENSE", "NOTICE", "COMMERCIAL-LICENSE.md", "README.md"] {
        fs::write(payload_dir.join(doc), format!("{doc} content\n"))?;
    }

    let dist_files: [(&str, &str); 10] = [
        ("dist/assets/tokens.json", "{\"schema\":\"tokens\"}\n"),
        ("dist/cli.d.ts", "export declare const cli: string;\n"),
        ("dist/cli.js", "export const cli = 'cli';\n"),
        (
            "dist/compiler.d.ts",
            "export declare const compile: string;\n",
        ),
        ("dist/compiler.js", "export const compile = 'compile';\n"),
        ("dist/index.d.ts", "export declare const index: string;\n"),
        (
            "dist/index.d.ts.map",
            "{\"version\":3,\"file\":\"index.d.ts\"}\n",
        ),
        (
            "dist/index.js",
            "import './input.js';\nimport './compiler.js';\nimport './paired-v2/bound.js';\nexport const ok = true;\n",
        ),
        ("dist/input.js", "export const input = 'input';\n"),
        ("dist/paired-v2/bound.js", "export const bound = 'bound';\n"),
    ];
    for (rel, content) in dist_files {
        fs::write(payload_dir.join(rel), content)?;
    }

    let pin = seal_synthetic_payload(&payload_dir, "aarch64-apple-darwin")?;
    Ok((payload_dir, pin))
}

fn seal_synthetic_payload(payload_dir: &Path, target: &str) -> TestResult<SolarSailBuildPinDto> {
    let pkg_bytes = fs::read(payload_dir.join("package.json"))?;
    let pkg_sha = sha256_hex(&pkg_bytes);
    let mut rel_paths = Vec::new();
    collect_physical_dist_files(&payload_dir.join("dist"), "dist", 2, &mut rel_paths)?;
    rel_paths.sort();

    let mut members_json = Vec::new();
    let mut summary_lines = Vec::new();
    for rel in &rel_paths {
        let bytes = fs::read(payload_dir.join(rel))?;
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
    let mut binding_bytes = serde_json::to_vec_pretty(&binding_val)?;
    binding_bytes.push(b'\n');
    fs::write(payload_dir.join("solar-sail-binding.json"), &binding_bytes)?;

    Ok(SolarSailBuildPinDto {
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
    })
}

#[test]
fn n1_to_n5_tamper_transitive_legacy_declarations_and_assets_rejected() -> TestResult<()> {
    let tmp = TempDir::new("ss-auth-n1-n5")?;
    let (payload_dir, pin) = build_synthetic_verifier_control(&tmp.path)?;
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
        let orig = fs::read(&full)?;
        let mut tampered = orig.clone();
        tampered[0] ^= 0x01;
        fs::write(&full, &tampered)?;
        let err = required_error(verify_payload_with_expectation(&payload_dir, &pin))?;
        assert_eq!(
            err.reason_code(),
            StudioReasonCode::SidecarArtifactUnavailable
        );
        fs::write(&full, &orig)?;
        assert!(verify_payload_with_expectation(&payload_dir, &pin).is_ok());
    }
    Ok(())
}

#[test]
fn n6_consistent_payload_and_binding_rewrite_fails_against_compiled_pin() -> TestResult<()> {
    let tmp = TempDir::new("ss-auth-n6")?;
    let (payload_dir, compiled_pin) = build_synthetic_verifier_control(&tmp.path)?;
    fs::write(
        payload_dir.join("dist/paired-v2/bound.js"),
        "export const bound = 'rewritten';\n",
    )?;
    let _rewritten_pin = seal_synthetic_payload(&payload_dir, "aarch64-apple-darwin")?;
    let err = required_error(verify_payload_with_expectation(&payload_dir, &compiled_pin))?;
    assert_eq!(
        err.reason_code(),
        StudioReasonCode::SidecarArtifactUnavailable
    );
    Ok(())
}

#[test]
fn n7_n8_n9_extra_or_missing_dist_and_top_level_leaves_rejected() -> TestResult<()> {
    let tmp = TempDir::new("ss-auth-n7-n9")?;
    let (payload_dir, pin) = build_synthetic_verifier_control(&tmp.path)?;

    // N7: extra dist leaf
    let extra_dist = payload_dir.join("dist/extra.js");
    fs::write(&extra_dist, "export const x = 1;\n")?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&extra_dist)?;

    // N8: missing dist leaf
    let input_path = payload_dir.join("dist/input.js");
    let input_orig = fs::read(&input_path)?;
    fs::remove_file(&input_path)?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::write(&input_path, &input_orig)?;

    // N9a: extra top-level file
    let extra_top = payload_dir.join("EXTRA.md");
    fs::write(&extra_top, "extra\n")?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&extra_top)?;

    // N9b: missing README.md
    let readme = payload_dir.join("README.md");
    let readme_orig = fs::read(&readme)?;
    fs::remove_file(&readme)?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::write(&readme, &readme_orig)?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_ok());
    Ok(())
}

#[cfg(unix)]
#[test]
fn n10_n11_n12_symlinks_and_special_socket_files_rejected() -> TestResult<()> {
    use std::os::unix::fs::symlink;
    use std::os::unix::net::UnixListener;

    let tmp = TempDir::new("ss-auth-n10-n12")?;
    let (payload_dir, pin) = build_synthetic_verifier_control(&tmp.path)?;

    // N10: symlinked dist member
    let cli_path = payload_dir.join("dist/cli.js");
    let cli_orig = fs::read(&cli_path)?;
    let outside = tmp.path.join("outside-cli.js");
    fs::write(&outside, &cli_orig)?;
    fs::remove_file(&cli_path)?;
    symlink(&outside, &cli_path)?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&cli_path)?;
    fs::write(&cli_path, &cli_orig)?;

    // N11: symlinked subdirectory in dist
    let pv2_dir = payload_dir.join("dist/paired-v2");
    let pv2_backup = tmp.path.join("paired-v2-backup");
    fs::rename(&pv2_dir, &pv2_backup)?;
    symlink(&pv2_backup, &pv2_dir)?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    fs::remove_file(&pv2_dir)?;
    fs::rename(&pv2_backup, &pv2_dir)?;

    // N12: bind at a short owned socket-root path, then move the live
    // socket into the deep fixture path before verification.  The bind
    // path must stay below the native sockaddr limit; only this test's
    // uniquely named entry is removed.  Qualification may provide a
    // shared scratch root; ordinary hosts use their platform temp root.
    let scratch_root = std::env::var_os("TFSB_APP_THEME_TEST_SOCKET_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let scratch_metadata = fs::metadata(&scratch_root)?;
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
            Err(err) => return Err(test_failure(format!("bind owned unix socket: {err}"))),
        }
    }
    let (listener, bind_path) = match bound {
        Some(value) => value,
        None => return Err(test_failure("reserve unique short socket path")),
    };
    let sock_path = payload_dir.join("dist/ipc.sock");
    fs::rename(&bind_path, &sock_path)?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_err());
    drop(listener);
    fs::remove_file(&sock_path)?;
    assert!(verify_payload_with_expectation(&payload_dir, &pin).is_ok());
    Ok(())
}

#[test]
fn n13_to_n22_binding_path_order_collision_count_size_package_and_overflow_negatives()
-> TestResult<()> {
    let tmp = TempDir::new("ss-auth-n13-n22")?;
    let (payload_dir, base_pin) = build_synthetic_verifier_control(&tmp.path)?;
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
        assert!(
            !is_valid_dist_member_path(bad_path),
            "must reject {bad_path}"
        );
    }

    let binding_path = payload_dir.join("solar-sail-binding.json");
    let orig_binding_bytes = fs::read(&binding_path)?;
    let orig_val: serde_json::Value = serde_json::from_slice(&orig_binding_bytes)?;
    let re_pin_and_verify = |mutated: &serde_json::Value| -> TestResult<bool> {
        let bytes = serde_json::to_vec_pretty(mutated)?;
        fs::write(&binding_path, &bytes)?;
        let mut pin = base_pin.clone();
        pin.binding.size = bytes.len() as u64;
        pin.binding.sha256 = sha256_hex(&bytes);
        if let Some(inv) = mutated.get("inventoryDigest").and_then(|v| v.as_str()) {
            pin.binding.inventory_digest = inv.to_owned();
        }
        if let Some(cnt) = mutated.get("runtimeMemberCount").and_then(|v| v.as_u64()) {
            pin.binding.member_count = cnt as usize;
        }
        Ok(verify_payload_with_expectation(&payload_dir, &pin).is_err())
    };

    // N14: duplicate member path
    let mut dup = orig_val.clone();
    let first_member = dup["members"][0].clone();
    dup["members"]
        .as_array_mut()
        .ok_or_else(|| test_failure("members must be an array"))?
        .insert(0, first_member);
    let dup_count = dup["members"]
        .as_array()
        .ok_or_else(|| test_failure("members must remain an array"))?
        .len();
    dup["runtimeMemberCount"] = serde_json::json!(dup_count);
    assert!(re_pin_and_verify(&dup)?);

    // N15: out-of-order members
    let mut rev = orig_val.clone();
    rev["members"]
        .as_array_mut()
        .ok_or_else(|| test_failure("members must be an array"))?
        .reverse();
    assert!(re_pin_and_verify(&rev)?);

    // N16: ASCII case collision
    let mut case_coll = orig_val.clone();
    let mut colliding = case_coll["members"][0].clone();
    colliding["path"] = serde_json::json!("dist/ASSETS/tokens.json");
    case_coll["members"]
        .as_array_mut()
        .ok_or_else(|| test_failure("members must be an array"))?
        .insert(0, colliding);
    let collision_count = case_coll["members"]
        .as_array()
        .ok_or_else(|| test_failure("members must remain an array"))?
        .len();
    case_coll["runtimeMemberCount"] = serde_json::json!(collision_count);
    assert!(re_pin_and_verify(&case_coll)?);

    // N17 & N18: runtimeMemberCount and member size mismatch
    let mut bad_count = orig_val.clone();
    bad_count["runtimeMemberCount"] = serde_json::json!(99);
    assert!(re_pin_and_verify(&bad_count)?);
    let mut bad_size = orig_val.clone();
    bad_size["members"][0]["size"] = serde_json::json!(999_999u64);
    assert!(re_pin_and_verify(&bad_size)?);

    // N19 & N20: package.json tamper / SHA mismatch
    fs::write(&binding_path, &orig_binding_bytes)?;
    let pkg_path = payload_dir.join("package.json");
    let orig_pkg = fs::read(&pkg_path)?;
    fs::write(
        &pkg_path,
        br#"{"name":"@knowledge-forge-ai/theme-forge-solar-sail","version":"0.2.0"}"#,
    )?;
    assert!(verify_payload_with_expectation(&payload_dir, &base_pin).is_err());
    fs::write(&pkg_path, &orig_pkg)?;

    // N21 & N22: unknown binding field (generatedAt) and overflow limit
    let mut with_gen = orig_val.clone();
    with_gen["generatedAt"] = serde_json::json!("2026-10-19T00:00:00.000Z");
    assert!(re_pin_and_verify(&with_gen)?);
    let mut overflow_member = orig_val;
    overflow_member["members"][0]["size"] = serde_json::json!(MAX_MEMBER_BYTES + 1);
    assert!(re_pin_and_verify(&overflow_member)?);
    Ok(())
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
    assert!(
        parse_build_pin_expectation(
            &valid_pub.to_string(),
            "published-archive",
            "aarch64-apple-darwin",
            None
        )
        .is_ok()
    );
    assert!(
        parse_build_pin_expectation(
            &valid_pub.to_string(),
            "structured-source",
            "aarch64-apple-darwin",
            Some(&"d".repeat(64))
        )
        .is_err()
    );
    assert!(
        parse_build_pin_expectation(
            &valid_pub.to_string(),
            "published-archive",
            "x86_64-unknown-linux-gnu",
            None
        )
        .is_err()
    );

    let mut both = valid_pub.clone();
    both["provenance"]["structuredSource"] = serde_json::json!({
        "sourceCandidate": "d".repeat(64), "componentSource": "e".repeat(64), "output": "f".repeat(64), "producer": "1".repeat(64), "version": "0.2.1",
    });
    assert!(
        parse_build_pin_expectation(
            &both.to_string(),
            "published-archive",
            "aarch64-apple-darwin",
            None
        )
        .is_err()
    );

    let mut neither = valid_pub.clone();
    neither["provenance"] = serde_json::json!({});
    assert!(
        parse_build_pin_expectation(
            &neither.to_string(),
            "published-archive",
            "aarch64-apple-darwin",
            None
        )
        .is_err()
    );

    let mut unknown_key = valid_pub.clone();
    unknown_key["extra"] = serde_json::json!(true);
    assert!(
        parse_build_pin_expectation(
            &unknown_key.to_string(),
            "published-archive",
            "aarch64-apple-darwin",
            None
        )
        .is_err()
    );

    let mut wrong_schema = valid_pub.clone();
    wrong_schema["schema"] = serde_json::json!("nebular-solar-sail-build-pin-v0");
    assert!(
        parse_build_pin_expectation(
            &wrong_schema.to_string(),
            "published-archive",
            "aarch64-apple-darwin",
            None
        )
        .is_err()
    );

    for (field, bad_val) in [
        ("version", serde_json::json!("0.2.0")),
        ("size", serde_json::json!(110_659u64)),
        ("sha256", serde_json::json!("0".repeat(64))),
    ] {
        let mut bad = valid_pub.clone();
        bad["provenance"]["publishedArchive"][field] = bad_val;
        assert!(
            parse_build_pin_expectation(
                &bad.to_string(),
                "published-archive",
                "aarch64-apple-darwin",
                None
            )
            .is_err()
        );
    }

    let valid_src = serde_json::json!({
        "schema": SOLAR_SAIL_BUILD_PIN_SCHEMA,
        "target": "aarch64-apple-darwin",
        "package": { "name": EXPECTED_SOLAR_SAIL_NAME, "version": "0.2.1", "packageJsonSha256": "a".repeat(64) },
        "binding": { "size": 512, "sha256": "b".repeat(64), "inventoryDigest": "c".repeat(64), "memberCount": 16 },
        "provenance": { "structuredSource": { "sourceCandidate": "d".repeat(64), "componentSource": "e".repeat(64), "output": "f".repeat(64), "producer": "1".repeat(64), "version": "0.2.1" } }
    });
    assert!(
        parse_build_pin_expectation(
            &valid_src.to_string(),
            "structured-source",
            "aarch64-apple-darwin",
            Some(&"d".repeat(64))
        )
        .is_ok()
    );
    assert!(
        parse_build_pin_expectation(
            &valid_src.to_string(),
            "structured-source",
            "aarch64-apple-darwin",
            Some(&"9".repeat(64))
        )
        .is_err()
    );
    for (field, bad_val) in [
        ("componentSource", serde_json::json!("bad")),
        ("output", serde_json::json!("bad")),
        ("producer", serde_json::json!("bad")),
        ("version", serde_json::json!("0.2.0")),
    ] {
        let mut bad_src = valid_src.clone();
        bad_src["provenance"]["structuredSource"][field] = bad_val;
        assert!(
            parse_build_pin_expectation(
                &bad_src.to_string(),
                "structured-source",
                "aarch64-apple-darwin",
                Some(&"d".repeat(64))
            )
            .is_err()
        );
    }
    #[cfg(not(nebular_solar_sail_pin))]
    assert!(compiled_expectation().is_err());
}
