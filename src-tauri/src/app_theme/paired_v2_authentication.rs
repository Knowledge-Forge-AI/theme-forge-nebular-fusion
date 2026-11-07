//! Authentication for the optional paired-profile v2 adapter closure.
//!
//! This module is deliberately separate from the v1 runner.  The five optional
//! v2 members plus the binding are compiled into the native image with
//! `include_bytes!`; the staged copies are compared with those compiled bytes
//! before a caller can spawn the v2 adapter.  The binding JSON is therefore
//! descriptive and checked, but is not its own trust root.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Component, Path};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

const V2_BINDING_SCHEMA: &str = "nebular.paired-v2-binding.v1";
const V2_INPUTS_SCHEMA: &str = "nebular.paired-v2-inputs.v1";
const V2_MEMBER_COUNT: usize = 5;
const MAX_V2_MEMBER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_V2_TOTAL_BYTES: u64 = 32 * 1024 * 1024;
const MAX_V2_BINDING_BYTES: u64 = 1024 * 1024;
const MAX_SOURCE_PATH_BYTES: usize = 256;

const RECIPE_SOURCE_PATH: &str = "tools/appearance-catalog-lib.mjs";
const RECIPE_SOURCE_BYTES: u64 = 25_026;
const RECIPE_SOURCE_SHA256: &str =
    "4dbd64a4bf1739e3f809c9d5a27e0334d2344140e55e4af25272b5ef9c752f06";
const TEMPLATE_SOURCE_PATH: &str = "tools/source/sttn/v0.4/terminal-nova.theme.json";
const TEMPLATE_SOURCE_BYTES: u64 = 11_161;
const TEMPLATE_SOURCE_SHA256: &str =
    "436e278cdbe3a37e06048504df3897d65230318f17b7ebd754060c2866703324";

const PAIRED_V2_ADAPTER_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/paired-v2-adapter.mjs");
const PAIRED_V2_COMPILE_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/paired-v2-compile.mjs");
const COMMON_APPEARANCE_RECIPE_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/common-appearance-recipe.mjs");
const COMMON_STTN_TEMPLATE_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/common-sttn-template.json");
const APPEARANCE_INPUTS_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/appearance-inputs.json");
const PAIRED_V2_BINDING_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/paired-v2-binding.json");

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppearanceInputs {
    schema: String,
    family_bindings: BTreeMap<String, String>,
    application_baseline_layer: String,
    template_sha256: String,
    recipe_sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceBinding {
    owner: String,
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceBindings {
    recipe: SourceBinding,
    template: SourceBinding,
    transport: SourceBinding,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V2Member {
    path: String,
    bytes: u64,
    sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct V2Binding {
    schema: String,
    members: Vec<V2Member>,
    sources: SourceBindings,
}

// The binding intentionally does not include itself in `members`. Its own
// exact bytes are authenticated against PAIRED_V2_BINDING_BYTES, which is the
// compiled authority; the parsed JSON cannot authorize a replacement.

fn unavailable() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable)
}

fn lower_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn same_identity(before: &fs::Metadata, opened: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        before.dev() == opened.dev() && before.ino() == opened.ino()
    }
    #[cfg(not(unix))]
    {
        before.len() == opened.len()
    }
}

fn read_regular_no_follow(path: &Path, expected: &[u8], max_bytes: u64) -> StudioResult<Vec<u8>> {
    let before = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() != expected.len() as u64
    {
        return Err(unavailable());
    }
    if before.len() == 0 || before.len() > max_bytes {
        return Err(unavailable());
    }

    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(crate::platform::O_NOFOLLOW | crate::platform::O_NONBLOCK);
    }
    let mut file = options.open(path).map_err(|_| unavailable())?;
    let opened = file.metadata().map_err(|_| unavailable())?;
    if !opened.is_file()
        || opened.file_type().is_symlink()
        || !same_identity(&before, &opened)
        || opened.len() != expected.len() as u64
    {
        return Err(unavailable());
    }

    let mut actual = Vec::with_capacity(expected.len());
    file.by_ref()
        .take(max_bytes.saturating_add(1))
        .read_to_end(&mut actual)
        .map_err(|_| unavailable())?;
    if actual != expected {
        return Err(unavailable());
    }

    let after = fs::symlink_metadata(path).map_err(|_| unavailable())?;
    if !after.is_file()
        || after.file_type().is_symlink()
        || !same_identity(&opened, &after)
        || after.len() != expected.len() as u64
        || before.modified().ok() != after.modified().ok()
    {
        return Err(unavailable());
    }
    Ok(actual)
}

fn verify_real_ancestors(path: &Path) -> StudioResult<()> {
    if !path.is_absolute() {
        return Err(unavailable());
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor).map_err(|_| unavailable())?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(unavailable());
        }
    }
    Ok(())
}

fn valid_member_leaf(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_SOURCE_PATH_BYTES
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn expected_members() -> [(&'static str, &'static [u8]); V2_MEMBER_COUNT] {
    [
        ("appearance-inputs.json", APPEARANCE_INPUTS_BYTES),
        (
            "common-appearance-recipe.mjs",
            COMMON_APPEARANCE_RECIPE_BYTES,
        ),
        ("common-sttn-template.json", COMMON_STTN_TEMPLATE_BYTES),
        ("paired-v2-adapter.mjs", PAIRED_V2_ADAPTER_BYTES),
        ("paired-v2-compile.mjs", PAIRED_V2_COMPILE_BYTES),
    ]
}

fn expected_member(path: &str) -> Option<&'static [u8]> {
    expected_members()
        .into_iter()
        .find_map(|(expected_path, bytes)| (expected_path == path).then_some(bytes))
}

fn validate_source_binding(
    actual: &SourceBinding,
    owner: &str,
    path: &str,
    bytes: u64,
    sha256: &str,
) -> StudioResult<()> {
    if actual.owner != owner
        || actual.path != path
        || actual.bytes != bytes
        || actual.sha256 != sha256
        || !valid_member_leaf(&actual.path)
        || !lower_sha256(&actual.sha256)
    {
        return Err(unavailable());
    }
    Ok(())
}

fn validate_inputs() -> StudioResult<()> {
    if COMMON_APPEARANCE_RECIPE_BYTES.len() as u64 != RECIPE_SOURCE_BYTES
        || digest(COMMON_APPEARANCE_RECIPE_BYTES) != RECIPE_SOURCE_SHA256
        || COMMON_STTN_TEMPLATE_BYTES.len() as u64 != TEMPLATE_SOURCE_BYTES
        || digest(COMMON_STTN_TEMPLATE_BYTES) != TEMPLATE_SOURCE_SHA256
    {
        return Err(unavailable());
    }
    if APPEARANCE_INPUTS_BYTES.is_empty()
        || APPEARANCE_INPUTS_BYTES.len() as u64 > MAX_V2_MEMBER_BYTES
    {
        return Err(unavailable());
    }
    let inputs: AppearanceInputs =
        serde_json::from_slice(APPEARANCE_INPUTS_BYTES).map_err(|_| unavailable())?;
    if inputs.schema != V2_INPUTS_SCHEMA
        || inputs.application_baseline_layer != "theme-forge-application-baseline"
        || inputs.family_bindings
            != BTreeMap::from([
                ("monospace".to_owned(), "system-mono".to_owned()),
                ("system-ui".to_owned(), "system-sans".to_owned()),
            ])
        || inputs.template_sha256 != TEMPLATE_SOURCE_SHA256
        || inputs.recipe_sha256 != RECIPE_SOURCE_SHA256
        || !lower_sha256(&inputs.template_sha256)
        || !lower_sha256(&inputs.recipe_sha256)
    {
        return Err(unavailable());
    }
    Ok(())
}

fn validate_binding_bytes(raw: &[u8]) -> StudioResult<()> {
    if raw.is_empty() || raw.len() as u64 > MAX_V2_BINDING_BYTES {
        return Err(unavailable());
    }
    let binding: V2Binding = serde_json::from_slice(raw).map_err(|_| unavailable())?;
    if binding.schema != V2_BINDING_SCHEMA || binding.members.len() != V2_MEMBER_COUNT {
        return Err(unavailable());
    }
    validate_source_binding(
        &binding.sources.recipe,
        "cttn",
        RECIPE_SOURCE_PATH,
        RECIPE_SOURCE_BYTES,
        RECIPE_SOURCE_SHA256,
    )?;
    validate_source_binding(
        &binding.sources.template,
        "cttn",
        TEMPLATE_SOURCE_PATH,
        TEMPLATE_SOURCE_BYTES,
        TEMPLATE_SOURCE_SHA256,
    )?;
    validate_source_binding(
        &binding.sources.transport,
        "nebular",
        "paired-v2-compile.mjs",
        PAIRED_V2_COMPILE_BYTES.len() as u64,
        &digest(PAIRED_V2_COMPILE_BYTES),
    )?;

    let mut seen = BTreeSet::new();
    let mut lower_seen = BTreeSet::new();
    let mut total = 0u64;
    let mut previous = None;
    for member in &binding.members {
        if !valid_member_leaf(&member.path)
            || !seen.insert(member.path.clone())
            || !lower_seen.insert(member.path.to_ascii_lowercase())
            || previous.is_some_and(|path: &str| path >= member.path.as_str())
            || member.bytes == 0
            || member.bytes > MAX_V2_MEMBER_BYTES
            || !lower_sha256(&member.sha256)
        {
            return Err(unavailable());
        }
        let expected = expected_member(&member.path).ok_or_else(unavailable)?;
        if member.bytes != expected.len() as u64 || member.sha256 != digest(expected) {
            return Err(unavailable());
        }
        total = total.checked_add(member.bytes).ok_or_else(unavailable)?;
        if total > MAX_V2_TOTAL_BYTES {
            return Err(unavailable());
        }
        previous = Some(member.path.as_str());
    }
    if seen.len() != V2_MEMBER_COUNT {
        return Err(unavailable());
    }
    Ok(())
}

fn validate_binding() -> StudioResult<()> {
    validate_binding_bytes(PAIRED_V2_BINDING_BYTES)
}

fn authenticate_v2_members(adapter_dir: &Path) -> StudioResult<()> {
    let mut actual = BTreeSet::new();
    for entry in fs::read_dir(adapter_dir).map_err(|_| unavailable())? {
        let entry = entry.map_err(|_| unavailable())?;
        let path = entry.path();
        let name = entry.file_name().into_string().map_err(|_| unavailable())?;
        let metadata = fs::symlink_metadata(&path).map_err(|_| unavailable())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(unavailable());
        }
        if !actual.insert(name) {
            return Err(unavailable());
        }
    }
    let mut expected_names: BTreeSet<String> = expected_members()
        .into_iter()
        .map(|(path, _)| path.to_owned())
        .collect();
    expected_names.insert("solar-sail-adapter.mjs".to_owned());
    expected_names.insert("paired-v2-binding.json".to_owned());
    if actual != expected_names {
        return Err(unavailable());
    }

    for (relative, expected) in expected_members() {
        let path = adapter_dir.join(relative);
        let _ = read_regular_no_follow(&path, expected, MAX_V2_MEMBER_BYTES)?;
    }
    let binding_bytes = read_regular_no_follow(
        &adapter_dir.join("paired-v2-binding.json"),
        PAIRED_V2_BINDING_BYTES,
        MAX_V2_BINDING_BYTES,
    )?;
    // Parse the actual staged manifest after its exact-byte and identity
    // checks. Its bytes are already bound to the compiled authority, but the
    // actual parse keeps the verification boundary explicit.
    validate_binding_bytes(&binding_bytes)?;
    Ok(())
}

fn validate_legacy_path_shape(legacy_adapter_path: &Path) -> StudioResult<()> {
    if !legacy_adapter_path.is_absolute()
        || legacy_adapter_path
            .file_name()
            .and_then(|name| name.to_str())
            != Some("solar-sail-adapter.mjs")
    {
        return Err(unavailable());
    }
    let adapter_dir = legacy_adapter_path.parent().ok_or_else(unavailable)?;
    if adapter_dir.file_name().and_then(|name| name.to_str()) != Some("solar-sail-adapter") {
        return Err(unavailable());
    }
    Ok(())
}

/// Authenticates the optional v2 adapter and its complete Solar/Loom closure.
///
/// `legacy_adapter_path` is intentionally the existing v1 adapter path.  The
/// optional v2 entrypoint is derived as its fixed sibling; callers cannot
/// provide an arbitrary adapter or payload path.  Every v2 member is compared
/// with its compile-time `include_bytes!` authority before the existing Solar
/// and Loom authenticators are invoked.
pub(crate) fn authenticate_paired_v2_closure(
    node_binary: &Path,
    legacy_adapter_path: &Path,
) -> StudioResult<()> {
    validate_legacy_path_shape(legacy_adapter_path)?;
    let adapter_dir = legacy_adapter_path.parent().ok_or_else(unavailable)?;
    if adapter_dir.file_name().and_then(|name| name.to_str()) != Some("solar-sail-adapter") {
        return Err(unavailable());
    }
    let resource_root = adapter_dir.parent().ok_or_else(unavailable)?;
    verify_real_ancestors(adapter_dir)?;
    validate_inputs()?;
    validate_binding()?;
    authenticate_v2_members(adapter_dir)?;

    // Keep the existing v1 path as a prerequisite and trust boundary.  This
    // also authenticates the complete Solar payload and its ESM closure.
    super::runner::authenticate_solar_sail_adapter(legacy_adapter_path)?;

    // The Loom authenticator owns its maintained binding and complete nested
    // inventory.  Its existing File::open implementation has the documented
    // no-follow residual; this module intentionally does not rewrite it.
    let loom_adapter = resource_root.join("loom-payload/bin/tfsl-batch.js");
    crate::sidecar::scene_artifact::authenticate_theme_payload(node_binary, &loom_adapter)?;
    Ok(())
}

#[cfg(test)]
#[path = "paired_v2_authentication_tests.rs"]
mod tests;
