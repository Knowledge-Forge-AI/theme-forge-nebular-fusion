use super::*;

use std::fs;
use std::path::{Path, PathBuf};

type TestResult<T> = Result<T, Box<dyn std::error::Error>>;

struct TempDir {
    path: PathBuf,
}

impl TempDir {
    fn new(prefix: &str) -> TestResult<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_nanos();
        let root = fs::canonicalize(std::env::temp_dir())?;
        let path = root.join(format!(
            "nebular-paired-v2-auth-{prefix}-{}-{nanos}",
            std::process::id()
        ));
        fs::create_dir(&path)?;
        Ok(Self { path })
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn seed_adapter_dir() -> TestResult<TempDir> {
    let temp = TempDir::new("adapter-members")?;
    for (path, bytes) in expected_members() {
        fs::write(temp.path.join(path), bytes)?;
    }
    fs::write(
        temp.path.join("paired-v2-binding.json"),
        PAIRED_V2_BINDING_BYTES,
    )?;
    fs::write(
        temp.path.join("solar-sail-adapter.mjs"),
        b"legacy adapter\n",
    )?;
    Ok(temp)
}

#[test]
fn compiled_inputs_and_binding_obey_the_closed_contract() -> TestResult<()> {
    validate_inputs().map_err(|error| std::io::Error::other(error.to_string()))?;
    validate_binding().map_err(|error| std::io::Error::other(error.to_string()))?;
    Ok(())
}

#[test]
fn compiled_recipe_and_template_match_reviewed_source_anchors() {
    assert_eq!(
        COMMON_APPEARANCE_RECIPE_BYTES.len() as u64,
        RECIPE_SOURCE_BYTES
    );
    assert_eq!(digest(COMMON_APPEARANCE_RECIPE_BYTES), RECIPE_SOURCE_SHA256);
    assert_eq!(
        COMMON_STTN_TEMPLATE_BYTES.len() as u64,
        TEMPLATE_SOURCE_BYTES
    );
    assert_eq!(digest(COMMON_STTN_TEMPLATE_BYTES), TEMPLATE_SOURCE_SHA256);
}

#[test]
fn binding_excludes_itself_and_has_the_exact_sorted_member_set() -> TestResult<()> {
    let binding: V2Binding = serde_json::from_slice(PAIRED_V2_BINDING_BYTES)?;
    let paths: Vec<&str> = binding
        .members
        .iter()
        .map(|member| member.path.as_str())
        .collect();
    let expected: Vec<&str> = expected_members()
        .into_iter()
        .map(|(path, _)| path)
        .collect();
    assert_eq!(paths, expected);
    assert!(!paths.contains(&"paired-v2-binding.json"));
    assert_eq!(binding.members.len(), V2_MEMBER_COUNT);
    Ok(())
}

#[test]
fn exact_read_accepts_compiled_bytes_and_rejects_tampering() -> TestResult<()> {
    let temp = TempDir::new("exact-read")?;
    let path = temp.path.join("member.mjs");
    let expected = b"export const pairedV2 = true;\n";
    fs::write(&path, expected)?;
    let _ = read_regular_no_follow(&path, expected, MAX_V2_MEMBER_BYTES)
        .map_err(|error| std::io::Error::other(error.to_string()))?;

    fs::write(&path, b"export const pairedV2 = false;\n")?;
    assert!(read_regular_no_follow(&path, expected, MAX_V2_MEMBER_BYTES).is_err());
    Ok(())
}

#[cfg(unix)]
#[test]
fn exact_read_rejects_symlink_even_when_target_bytes_match() -> TestResult<()> {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new("symlink")?;
    let target = temp.path.join("target.mjs");
    let link = temp.path.join("member.mjs");
    let expected = b"export const pairedV2 = true;\n";
    fs::write(&target, expected)?;
    symlink(&target, &link)?;
    assert!(read_regular_no_follow(&link, expected, MAX_V2_MEMBER_BYTES).is_err());
    Ok(())
}

#[test]
fn adapter_directory_rejects_extra_missing_and_tampered_members() -> TestResult<()> {
    let temp = seed_adapter_dir()?;
    assert!(authenticate_v2_members(&temp.path).is_ok());

    fs::write(temp.path.join("unexpected.mjs"), b"unexpected\n")?;
    assert!(authenticate_v2_members(&temp.path).is_err());
    fs::remove_file(temp.path.join("unexpected.mjs"))?;

    fs::remove_file(temp.path.join("paired-v2-compile.mjs"))?;
    assert!(authenticate_v2_members(&temp.path).is_err());
    fs::write(
        temp.path.join("paired-v2-compile.mjs"),
        PAIRED_V2_COMPILE_BYTES,
    )?;

    fs::write(temp.path.join("paired-v2-binding.json"), b"{}")?;
    assert!(authenticate_v2_members(&temp.path).is_err());
    Ok(())
}

#[test]
fn source_binding_rejects_untrusted_paths_and_hashes() -> TestResult<()> {
    let good = SourceBinding {
        owner: "cttn".to_owned(),
        path: RECIPE_SOURCE_PATH.to_owned(),
        bytes: RECIPE_SOURCE_BYTES,
        sha256: RECIPE_SOURCE_SHA256.to_owned(),
    };
    validate_source_binding(
        &good,
        "cttn",
        RECIPE_SOURCE_PATH,
        RECIPE_SOURCE_BYTES,
        RECIPE_SOURCE_SHA256,
    )
    .map_err(|error| std::io::Error::other(error.to_string()))?;

    let mut traversal = good.clone();
    traversal.path = "../appearance-catalog-lib.mjs".to_owned();
    assert!(
        validate_source_binding(
            &traversal,
            "cttn",
            RECIPE_SOURCE_PATH,
            RECIPE_SOURCE_BYTES,
            RECIPE_SOURCE_SHA256,
        )
        .is_err()
    );

    let mut absolute = good.clone();
    absolute.path = "/tmp/appearance-catalog-lib.mjs".to_owned();
    assert!(
        validate_source_binding(
            &absolute,
            "cttn",
            RECIPE_SOURCE_PATH,
            RECIPE_SOURCE_BYTES,
            RECIPE_SOURCE_SHA256,
        )
        .is_err()
    );

    let mut wrong_hash = good;
    wrong_hash.sha256 = "0".repeat(64);
    assert!(
        validate_source_binding(
            &wrong_hash,
            "cttn",
            RECIPE_SOURCE_PATH,
            RECIPE_SOURCE_BYTES,
            RECIPE_SOURCE_SHA256,
        )
        .is_err()
    );
    Ok(())
}

#[test]
fn legacy_adapter_path_shape_is_absolute_and_fixed() -> TestResult<()> {
    let temp = TempDir::new("legacy-shape")?;
    let adapter_dir = temp.path.join("solar-sail-adapter");
    fs::create_dir_all(&adapter_dir)?;
    let legacy = adapter_dir.join("solar-sail-adapter.mjs");
    assert!(validate_legacy_path_shape(&legacy).is_ok());
    assert!(
        validate_legacy_path_shape(Path::new(
            "relative/solar-sail-adapter/solar-sail-adapter.mjs",
        ))
        .is_err()
    );
    assert!(validate_legacy_path_shape(&adapter_dir.join("other.mjs")).is_err());
    assert!(
        validate_legacy_path_shape(&temp.path.join("other-dir/solar-sail-adapter.mjs")).is_err()
    );
    Ok(())
}

#[cfg(unix)]
#[test]
fn ancestor_symlink_is_rejected_before_directory_inventory() -> TestResult<()> {
    use std::os::unix::fs::symlink;

    let temp = TempDir::new("ancestor-symlink")?;
    let real = temp.path.join("real");
    let link = temp.path.join("link");
    fs::create_dir(&real)?;
    symlink(&real, &link)?;
    assert!(verify_real_ancestors(&real).is_ok());
    assert!(verify_real_ancestors(&link).is_err());
    Ok(())
}
