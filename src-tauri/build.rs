#[path = "src/command_inventory.rs"]
mod command_inventory;

use std::{env, fs, io, path::PathBuf};

fn valid_hex_64(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

fn validate_source_build_pins(content: &str, target_env: &str) -> Result<(), io::Error> {
    let root: serde_json::Value = serde_json::from_str(content).map_err(io::Error::other)?;

    let source_candidate = root
        .get("sourceCandidate")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sourceCandidate"))?;
    if !valid_hex_64(source_candidate) {
        return Err(io::Error::other("invalid sourceCandidate hex"));
    }

    let target = root
        .get("target")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing target"))?;
    if target != target_env {
        return Err(io::Error::other("pins target does not match TARGET"));
    }

    let sidecar_manifest = root
        .get("sidecarManifest")
        .ok_or_else(|| io::Error::other("missing sidecarManifest"))?;

    let manifest_target = sidecar_manifest
        .get("target")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sidecarManifest target"))?;
    if manifest_target != target_env {
        return Err(io::Error::other(
            "sidecarManifest target does not match TARGET",
        ));
    }

    let manifest_source = sidecar_manifest
        .get("source")
        .ok_or_else(|| io::Error::other("missing sidecarManifest source"))?;

    let model = manifest_source
        .get("model")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sidecarManifest source model"))?;
    if model != "source-candidate-v2" {
        return Err(io::Error::other(
            "sidecarManifest source model must be source-candidate-v2",
        ));
    }

    let manifest_source_candidate = manifest_source
        .get("sourceCandidate")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing sidecarManifest sourceCandidate"))?;
    if manifest_source_candidate != source_candidate {
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

    let scene_node = root
        .get("scene")
        .and_then(|s| s.get("node"))
        .ok_or_else(|| io::Error::other("missing scene node binding"))?;
    let scene_sha = scene_node
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing scene node sha256"))?;
    let scene_bytes = scene_node
        .get("bytes")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| io::Error::other("missing scene node bytes"))?;

    if scene_sha != runtime_sha || scene_bytes != runtime_size {
        return Err(io::Error::other(
            "scene.node runtime pin does not match sidecarManifest runtime identity",
        ));
    }

    let loom_node = root
        .get("loom")
        .and_then(|l| l.get("node"))
        .ok_or_else(|| io::Error::other("missing loom node binding"))?;
    let loom_sha = loom_node
        .get("sha256")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| io::Error::other("missing loom node sha256"))?;
    let loom_bytes = loom_node
        .get("bytes")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(|| io::Error::other("missing loom node bytes"))?;

    if loom_sha != runtime_sha || loom_bytes != runtime_size {
        return Err(io::Error::other(
            "loom.node runtime pin does not match sidecarManifest runtime identity",
        ));
    }

    Ok(())
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
    println!("cargo:rerun-if-env-changed=NEBULAR_BUILD_MODE");

    match env::var("NEBULAR_BUILD_MODE") {
        Ok(ref mode) if mode == "nix-source" || mode == "portable-source" => {
            let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
                Ok(val) => PathBuf::from(val),
                Err(_) => PathBuf::from("."),
            };
            let pins_path = manifest_dir.join("source-build-pins.json");
            println!("cargo:rerun-if-changed={}", pins_path.display());
            if !pins_path.is_file() {
                return Err(io::Error::other(
                    "source-build-pins.json is required for source build mode",
                )
                .into());
            }

            let content = fs::read_to_string(&pins_path)?;
            let target_env = match env::var("TARGET") {
                Ok(val) => val,
                Err(_) => {
                    return Err(io::Error::other("TARGET environment variable not set").into());
                }
            };
            validate_source_build_pins(&content, &target_env)?;

            let out_dir = match env::var("OUT_DIR") {
                Ok(val) => PathBuf::from(val),
                Err(_) => {
                    return Err(io::Error::other("OUT_DIR environment variable not set").into());
                }
            };
            let out_pins = out_dir.join("source-build-pins.json");
            fs::copy(&pins_path, &out_pins)?;

            println!("cargo:rustc-cfg=nebular_source_build");
        }
        _ => {
            let manifest_dir = match env::var("CARGO_MANIFEST_DIR") {
                Ok(val) => PathBuf::from(val),
                Err(_) => PathBuf::from("."),
            };
            let manifest_path = manifest_dir.join("sidecar-payload").join("manifest.json");
            println!("cargo:rerun-if-changed={}", manifest_path.display());
            if manifest_path.is_file() {
                let target_env = env::var("TARGET")
                    .map_err(|_| io::Error::other("TARGET environment variable not set"))?;
                let pin = tarball_runtime_pin(&fs::read_to_string(&manifest_path)?, &target_env)?;
                let out_dir = env::var("OUT_DIR")
                    .map_err(|_| io::Error::other("OUT_DIR environment variable not set"))?;
                fs::write(PathBuf::from(out_dir).join("runtime-pin.json"), pin)?;
                println!("cargo:rustc-cfg=nebular_runtime_pin");
            }
        }
    }

    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(command_inventory::STUDIO_COMMAND_NAMES),
    ))?;
    Ok(())
}
