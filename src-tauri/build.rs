#[path = "src/command_inventory.rs"]
mod command_inventory;

use std::{env, fs, io, path::PathBuf};

fn valid_hex_64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn has_exact_keys(obj: &serde_json::Map<String, serde_json::Value>, expected: &[&str]) -> bool {
    obj.len() == expected.len() && expected.iter().all(|k| obj.contains_key(*k))
}

const ADMITTED_SOLAR_SAIL_NAME: &str = "@knowledge-forge-ai/theme-forge-solar-sail";
const ADMITTED_SOLAR_SAIL_VERSION: &str = "0.3.0";
const ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE: u64 = 110_836;
const ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256: &str =
    "5d1c30f55e52b7fbbf5313e70971961bfbe2e2bf8ffec6a706e748058ea3873f";

fn validate_solar_sail_provenance(
    prov: &serde_json::Map<String, serde_json::Value>,
    pkg_version: &str,
    expected_route: &str,
    expected_source_candidate: Option<&str>,
) -> Result<(), io::Error> {
    if expected_route == "structured-source" {
        if !has_exact_keys(prov, &["structuredSource"]) {
            return Err(io::Error::other(
                "structured-source solar pin must contain only structuredSource provenance",
            ));
        }
        let src = prov
            .get("structuredSource")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| io::Error::other("missing solar.provenance.structuredSource"))?;
        if !has_exact_keys(
            src,
            &[
                "sourceCandidate",
                "componentSource",
                "output",
                "producer",
                "version",
            ],
        ) {
            return Err(io::Error::other(
                "structuredSource provenance has invalid key set",
            ));
        }
        let sc = src
            .get("sourceCandidate")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let cs = src
            .get("componentSource")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let out = src
            .get("output")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let prod = src
            .get("producer")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let ver = src
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if !valid_hex_64(sc)
            || Some(sc) != expected_source_candidate
            || !valid_hex_64(cs)
            || !valid_hex_64(out)
            || !valid_hex_64(prod)
            || ver != pkg_version
        {
            return Err(io::Error::other(
                "invalid structured-source solar provenance",
            ));
        }
        Ok(())
    } else if expected_route == "published-archive" {
        if expected_source_candidate.is_some() || !has_exact_keys(prov, &["publishedArchive"]) {
            return Err(io::Error::other(
                "published-archive solar pin must contain only publishedArchive provenance",
            ));
        }
        let arch = prov
            .get("publishedArchive")
            .and_then(serde_json::Value::as_object)
            .ok_or_else(|| io::Error::other("missing solar.provenance.publishedArchive"))?;
        if !has_exact_keys(arch, &["name", "version", "size", "sha256"]) {
            return Err(io::Error::other(
                "publishedArchive provenance has invalid key set",
            ));
        }
        let name = arch
            .get("name")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let ver = arch
            .get("version")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let size = arch
            .get("size")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let sha = arch
            .get("sha256")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if name != ADMITTED_SOLAR_SAIL_NAME
            || ver != ADMITTED_SOLAR_SAIL_VERSION
            || pkg_version != ADMITTED_SOLAR_SAIL_VERSION
            || size != ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE
            || sha != ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256
        {
            return Err(io::Error::other(
                "invalid published-archive solar provenance",
            ));
        }
        Ok(())
    } else {
        Err(io::Error::other("unsupported solar provenance route"))
    }
}

fn validate_solar_sail_build_pin(
    pin: &serde_json::Value,
    expected_route: &str,
    target_env: &str,
    expected_source_candidate: Option<&str>,
) -> Result<(), io::Error> {
    let obj = pin
        .as_object()
        .ok_or_else(|| io::Error::other("solar build pin must be an object"))?;
    if !has_exact_keys(
        obj,
        &["schema", "target", "package", "binding", "provenance"],
    ) {
        return Err(io::Error::other("solar build pin has invalid key set"));
    }
    if obj.get("schema").and_then(serde_json::Value::as_str)
        != Some("nebular-solar-sail-build-pin-v1")
    {
        return Err(io::Error::other("invalid solar build pin schema"));
    }
    if obj.get("target").and_then(serde_json::Value::as_str) != Some(target_env)
        || target_env.is_empty()
    {
        return Err(io::Error::other("solar build pin target mismatch"));
    }
    let pkg = obj
        .get("package")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| io::Error::other("missing solar.package object"))?;
    if !has_exact_keys(pkg, &["name", "version", "packageJsonSha256"]) {
        return Err(io::Error::other("solar.package has invalid key set"));
    }
    let pkg_name = pkg
        .get("name")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let pkg_ver = pkg
        .get("version")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let pkg_sha = pkg
        .get("packageJsonSha256")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if pkg_name != ADMITTED_SOLAR_SAIL_NAME
        || pkg_ver != ADMITTED_SOLAR_SAIL_VERSION
        || !valid_hex_64(pkg_sha)
    {
        return Err(io::Error::other("invalid solar.package identity fields"));
    }
    let bnd = obj
        .get("binding")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| io::Error::other("missing solar.binding object"))?;
    if !has_exact_keys(bnd, &["size", "sha256", "inventoryDigest", "memberCount"]) {
        return Err(io::Error::other("solar.binding has invalid key set"));
    }
    let bnd_size = bnd
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let bnd_sha = bnd
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let inv_sha = bnd
        .get("inventoryDigest")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let member_count = bnd
        .get("memberCount")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if bnd_size == 0
        || bnd_size > 1024 * 1024
        || !valid_hex_64(bnd_sha)
        || !valid_hex_64(inv_sha)
        || member_count == 0
        || member_count > 4096
    {
        return Err(io::Error::other("invalid solar.binding fields"));
    }
    let prov = obj
        .get("provenance")
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| io::Error::other("missing solar.provenance object"))?;
    validate_solar_sail_provenance(prov, pkg_ver, expected_route, expected_source_candidate)
}

fn validate_source_build_pins(
    content: &str,
    target_env: &str,
) -> Result<(String, String, String), io::Error> {
    let mut root: serde_json::Value = serde_json::from_str(content).map_err(io::Error::other)?;
    let source_candidate = root
        .get("sourceCandidate")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sourceCandidate"))?
        .to_owned();
    if !valid_hex_64(&source_candidate) {
        return Err(io::Error::other("invalid sourceCandidate hex"));
    }
    if root.get("target").and_then(serde_json::Value::as_str) != Some(target_env) {
        return Err(io::Error::other("pins target does not match TARGET"));
    }
    let sidecar_manifest = root
        .get("sidecarManifest")
        .ok_or_else(|| io::Error::other("missing sidecarManifest"))?;
    if sidecar_manifest
        .get("target")
        .and_then(serde_json::Value::as_str)
        != Some(target_env)
    {
        return Err(io::Error::other(
            "sidecarManifest target does not match TARGET",
        ));
    }
    let manifest_source = sidecar_manifest
        .get("source")
        .ok_or_else(|| io::Error::other("missing sidecarManifest source"))?;
    if manifest_source
        .get("model")
        .and_then(serde_json::Value::as_str)
        != Some("source-candidate-v2")
    {
        return Err(io::Error::other(
            "sidecarManifest source model must be source-candidate-v2",
        ));
    }
    if manifest_source
        .get("sourceCandidate")
        .and_then(serde_json::Value::as_str)
        != Some(source_candidate.as_str())
    {
        return Err(io::Error::other("sidecarManifest sourceCandidate mismatch"));
    }
    let runtime = sidecar_manifest
        .get("runtime")
        .ok_or_else(|| io::Error::other("missing sidecarManifest runtime"))?;
    let runtime_sha = runtime
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sidecarManifest runtime sha256"))?;
    let runtime_size = runtime
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| io::Error::other("missing sidecarManifest runtime size"))?;
    if !valid_hex_64(runtime_sha) {
        return Err(io::Error::other(
            "invalid sidecarManifest runtime sha256 hex",
        ));
    }
    for (comp, err_msg) in [
        (
            "scene",
            "scene.node runtime pin does not match sidecarManifest runtime identity",
        ),
        (
            "loom",
            "loom.node runtime pin does not match sidecarManifest runtime identity",
        ),
    ] {
        let node = root
            .get(comp)
            .and_then(|c| c.get("node"))
            .ok_or_else(|| io::Error::other(format!("missing {comp} node binding")))?;
        if node.get("sha256").and_then(serde_json::Value::as_str) != Some(runtime_sha)
            || node.get("bytes").and_then(serde_json::Value::as_u64) != Some(runtime_size)
        {
            return Err(io::Error::other(err_msg));
        }
    }
    let solar_val = root
        .get("solar")
        .cloned()
        .ok_or_else(|| io::Error::other("missing solar build pin in source-build-pins.json"))?;
    validate_solar_sail_build_pin(
        &solar_val,
        "structured-source",
        target_env,
        Some(&source_candidate),
    )?;
    if let Some(obj) = root.as_object_mut() {
        obj.remove("solar");
    }
    let projected_pins = serde_json::to_string_pretty(&root).map_err(io::Error::other)?;
    let solar_json = serde_json::to_string_pretty(&solar_val).map_err(io::Error::other)?;
    Ok((projected_pins, solar_json, source_candidate))
}

/// Tarball builds pin the Theme Lab and Scene runtime to the embedded Node that the prepared sidecar
/// payload records for this build target -- the identity source builds pin through
/// source-build-pins.json. The maintained protocol bindings keep pinning the payload files.
fn tarball_runtime_pin(content: &str, target_env: &str) -> Result<String, io::Error> {
    let manifest: serde_json::Value = serde_json::from_str(content).map_err(io::Error::other)?;
    let target = manifest
        .get("target")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sidecar manifest target"))?;
    let runtime = manifest
        .get("runtime")
        .ok_or_else(|| io::Error::other("missing sidecar manifest runtime"))?;
    let runtime_target = runtime
        .get("target")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sidecar manifest runtime target"))?;
    if target != target_env || runtime_target != target_env {
        return Err(io::Error::other(
            "prepared sidecar payload is for a different target",
        ));
    }
    let sha256 = runtime
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sidecar manifest runtime sha256"))?;
    let bytes = runtime
        .get("size")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| io::Error::other("missing sidecar manifest runtime size"))?;
    if !valid_hex_64(sha256) || bytes == 0 {
        return Err(io::Error::other(
            "invalid sidecar manifest runtime identity",
        ));
    }
    Ok(serde_json::json!({ "sha256": sha256, "bytes": bytes }).to_string())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("cargo:rustc-check-cfg=cfg(nebular_source_build)");
    println!("cargo:rustc-check-cfg=cfg(nebular_runtime_pin)");
    println!("cargo:rustc-check-cfg=cfg(nebular_solar_sail_pin)");
    println!("cargo:rerun-if-env-changed=NEBULAR_BUILD_MODE");
    println!("cargo:rerun-if-env-changed=TARGET");

    let manifest_dir = env::var("CARGO_MANIFEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    let pins_path = manifest_dir.join("source-build-pins.json");
    let solar_pin_path = manifest_dir.join("solar-sail-build-pin.json");
    println!("cargo:rerun-if-changed={}", pins_path.display());
    println!("cargo:rerun-if-changed={}", solar_pin_path.display());

    let out_dir = PathBuf::from(
        env::var("OUT_DIR")
            .map_err(|_| io::Error::other("OUT_DIR environment variable not set"))?,
    );
    let out_solar_pin = out_dir.join("solar-sail-build-pin.json");
    let _ = fs::remove_file(&out_solar_pin);

    let target_env =
        env::var("TARGET").map_err(|_| io::Error::other("TARGET environment variable not set"))?;

    match env::var("NEBULAR_BUILD_MODE") {
        Ok(ref mode) if mode == "nix-source" || mode == "portable-source" => {
            if !pins_path.is_file() {
                return Err(io::Error::other(
                    "source-build-pins.json is required for source build mode",
                )
                .into());
            }
            let content = fs::read_to_string(&pins_path)?;
            let (projected_pins, solar_json, source_candidate) =
                validate_source_build_pins(&content, &target_env)?;
            fs::write(out_dir.join("source-build-pins.json"), projected_pins)?;
            fs::write(&out_solar_pin, solar_json)?;
            println!("cargo:rustc-cfg=nebular_source_build");
            println!("cargo:rustc-cfg=nebular_solar_sail_pin");
            println!("cargo:rustc-env=NEBULAR_SOLAR_SAIL_PIN_ROUTE=structured-source");
            println!("cargo:rustc-env=NEBULAR_SOLAR_SAIL_PIN_TARGET={target_env}");
            println!("cargo:rustc-env=NEBULAR_SOLAR_SAIL_SOURCE_CANDIDATE={source_candidate}");
        }
        _ => {
            let manifest_path = manifest_dir.join("sidecar-payload").join("manifest.json");
            println!("cargo:rerun-if-changed={}", manifest_path.display());
            if manifest_path.is_file() {
                let pin = tarball_runtime_pin(&fs::read_to_string(&manifest_path)?, &target_env)?;
                fs::write(out_dir.join("runtime-pin.json"), pin)?;
                println!("cargo:rustc-cfg=nebular_runtime_pin");
            }
            if solar_pin_path.is_file() {
                let solar_raw = fs::read_to_string(&solar_pin_path)?;
                let solar_val: serde_json::Value =
                    serde_json::from_str(&solar_raw).map_err(io::Error::other)?;
                validate_solar_sail_build_pin(&solar_val, "published-archive", &target_env, None)?;
                fs::write(
                    &out_solar_pin,
                    serde_json::to_string_pretty(&solar_val).map_err(io::Error::other)?,
                )?;
                println!("cargo:rustc-cfg=nebular_solar_sail_pin");
                println!("cargo:rustc-env=NEBULAR_SOLAR_SAIL_PIN_ROUTE=published-archive");
                println!("cargo:rustc-env=NEBULAR_SOLAR_SAIL_PIN_TARGET={target_env}");
                println!("cargo:rustc-env=NEBULAR_SOLAR_SAIL_SOURCE_CANDIDATE=");
            }
        }
    }

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(command_inventory::STUDIO_COMMAND_NAMES),
    ))?;
    Ok(())
}
