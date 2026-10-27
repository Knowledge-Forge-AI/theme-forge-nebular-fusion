use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

pub(crate) const EXPECTED_SOLAR_SAIL_NAME: &str = "@knowledge-forge-ai/theme-forge-solar-sail";
pub(crate) const SOLAR_SAIL_BINDING_SCHEMA: &str = "tfsb.solar-sail-binding-v1";
pub(crate) const SOLAR_SAIL_BUILD_PIN_SCHEMA: &str = "nebular-solar-sail-build-pin-v1";
pub(crate) const ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION: &str = "0.3.0";
pub(crate) const ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE: u64 = 110_836;
pub(crate) const ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256: &str =
    "65070c3478a1d55476c1b09fbe1dcadfdf7c3d3aa54a154bc9ac9e299411f415";

pub(crate) const SOLAR_SAIL_METADATA_LEAVES: [&str; 6] = [
    "COMMERCIAL-LICENSE.md",
    "LICENSE",
    "NOTICE",
    "README.md",
    "package.json",
    "solar-sail-binding.json",
];

const MAX_BINDING_BYTES: u64 = 1024 * 1024;
const MAX_METADATA_FILE_BYTES: u64 = 1024 * 1024;
const MAX_MEMBER_COUNT: usize = 4096;
const MAX_MEMBER_PATH_BYTES: usize = 256;
const MAX_MEMBER_PATH_DEPTH: usize = 16;
const MAX_MEMBER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_TOTAL_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(nebular_solar_sail_pin)]
const COMPILED_SOLAR_SAIL_BUILD_PIN_JSON: &str =
    include_str!(concat!(env!("OUT_DIR"), "/solar-sail-build-pin.json"));
#[cfg(nebular_solar_sail_pin)]
const COMPILED_SOLAR_SAIL_PIN_ROUTE: &str = env!("NEBULAR_SOLAR_SAIL_PIN_ROUTE");
#[cfg(nebular_solar_sail_pin)]
const COMPILED_SOLAR_SAIL_PIN_TARGET: &str = env!("NEBULAR_SOLAR_SAIL_PIN_TARGET");
#[cfg(nebular_solar_sail_pin)]
const COMPILED_SOLAR_SAIL_SOURCE_CANDIDATE: &str = env!("NEBULAR_SOLAR_SAIL_SOURCE_CANDIDATE");

#[inline]
fn sidecar_unavail() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable)
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SolarSailBindingMemberDto {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SolarSailBindingManifestDto {
    pub schema: String,
    pub name: String,
    pub version: String,
    pub package_json_sha256: String,
    pub inventory_digest: String,
    pub runtime_member_count: usize,
    pub members: Vec<SolarSailBindingMemberDto>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SolarSailBuildPinPackageDto {
    pub name: String,
    pub version: String,
    pub package_json_sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SolarSailBuildPinBindingDto {
    pub size: u64,
    pub sha256: String,
    pub inventory_digest: String,
    pub member_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StructuredSourceProvenanceDto {
    pub source_candidate: String,
    pub component_source: String,
    pub output: String,
    pub producer: String,
    pub version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PublishedArchiveProvenanceDto {
    pub name: String,
    pub version: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum SolarSailProvenanceDto {
    StructuredSource(StructuredSourceProvenanceDto),
    PublishedArchive(PublishedArchiveProvenanceDto),
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SolarSailBuildPinDto {
    pub schema: String,
    pub target: String,
    pub package: SolarSailBuildPinPackageDto,
    pub binding: SolarSailBuildPinBindingDto,
    pub provenance: SolarSailProvenanceDto,
}

#[derive(Debug, serde::Deserialize)]
struct PackageJsonIdentityDto {
    name: String,
    version: String,
}

pub(crate) fn parse_build_pin_expectation(
    raw_json: &str,
    expected_route: &str,
    expected_target: &str,
    enclosing_source_candidate: Option<&str>,
) -> StudioResult<SolarSailBuildPinDto> {
    let pin: SolarSailBuildPinDto =
        serde_json::from_str(raw_json).map_err(|_| sidecar_unavail())?;
    if pin.schema != SOLAR_SAIL_BUILD_PIN_SCHEMA
        || pin.target.is_empty()
        || pin.target != expected_target
        || pin.package.name != EXPECTED_SOLAR_SAIL_NAME
        || pin.package.version.is_empty()
        || !is_lower_hex_sha256(&pin.package.package_json_sha256)
        || pin.binding.size == 0
        || pin.binding.size > MAX_BINDING_BYTES
        || !is_lower_hex_sha256(&pin.binding.sha256)
        || !is_lower_hex_sha256(&pin.binding.inventory_digest)
        || pin.binding.member_count == 0
        || pin.binding.member_count > MAX_MEMBER_COUNT
    {
        return Err(sidecar_unavail());
    }

    match &pin.provenance {
        SolarSailProvenanceDto::StructuredSource(src) => {
            if expected_route != "structured-source"
                || !is_lower_hex_sha256(&src.source_candidate)
                || !is_lower_hex_sha256(&src.component_source)
                || !is_lower_hex_sha256(&src.output)
                || !is_lower_hex_sha256(&src.producer)
                || src.version.is_empty()
                || src.version != pin.package.version
            {
                return Err(sidecar_unavail());
            }
            if let Some(enclosing) = enclosing_source_candidate
                && src.source_candidate != enclosing
            {
                return Err(sidecar_unavail());
            }
        }
        SolarSailProvenanceDto::PublishedArchive(arch) => {
            if expected_route != "published-archive"
                || enclosing_source_candidate.is_some()
                || arch.name != EXPECTED_SOLAR_SAIL_NAME
                || arch.version != ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION
                || pin.package.version != ADMITTED_SOLAR_SAIL_ARCHIVE_VERSION
                || arch.size != ADMITTED_SOLAR_SAIL_ARCHIVE_SIZE
                || arch.sha256 != ADMITTED_SOLAR_SAIL_ARCHIVE_SHA256
            {
                return Err(sidecar_unavail());
            }
        }
    }

    Ok(pin)
}

fn compiled_expectation() -> StudioResult<SolarSailBuildPinDto> {
    #[cfg(nebular_solar_sail_pin)]
    {
        let enclosing = if COMPILED_SOLAR_SAIL_SOURCE_CANDIDATE.is_empty() {
            None
        } else {
            Some(COMPILED_SOLAR_SAIL_SOURCE_CANDIDATE)
        };
        parse_build_pin_expectation(
            COMPILED_SOLAR_SAIL_BUILD_PIN_JSON,
            COMPILED_SOLAR_SAIL_PIN_ROUTE,
            COMPILED_SOLAR_SAIL_PIN_TARGET,
            enclosing,
        )
    }
    #[cfg(not(nebular_solar_sail_pin))]
    {
        Err(sidecar_unavail())
    }
}

fn open_regular_no_follow(path: &Path) -> StudioResult<(File, fs::Metadata)> {
    let lstat_meta = fs::symlink_metadata(path).map_err(|_| sidecar_unavail())?;
    if !lstat_meta.is_file() || lstat_meta.file_type().is_symlink() {
        return Err(sidecar_unavail());
    }
    let mut opts = fs::OpenOptions::new();
    opts.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.custom_flags(libc::O_NOFOLLOW);
    }
    let file = opts.open(path).map_err(|_| sidecar_unavail())?;
    let fstat_meta = file.metadata().map_err(|_| sidecar_unavail())?;
    if !fstat_meta.is_file() || fstat_meta.file_type().is_symlink() {
        return Err(sidecar_unavail());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if lstat_meta.dev() != fstat_meta.dev() || lstat_meta.ino() != fstat_meta.ino() {
            return Err(sidecar_unavail());
        }
    }
    Ok((file, fstat_meta))
}

fn read_regular_no_follow_under(
    root: &Path,
    target: &Path,
    max_bytes: u64,
) -> StudioResult<Vec<u8>> {
    let rel = target.strip_prefix(root).map_err(|_| sidecar_unavail())?;
    let mut cur = root.to_path_buf();
    let mut comps = rel.components().peekable();
    while let Some(comp) = comps.next() {
        match comp {
            Component::Normal(seg) => cur.push(seg),
            _ => return Err(sidecar_unavail()),
        }
        let meta = fs::symlink_metadata(&cur).map_err(|_| sidecar_unavail())?;
        if meta.file_type().is_symlink() {
            return Err(sidecar_unavail());
        }
        if comps.peek().is_some() && !meta.is_dir() {
            return Err(sidecar_unavail());
        }
    }
    let (file, fstat_meta) = open_regular_no_follow(target)?;
    let expected_len = fstat_meta.len();
    if expected_len == 0 || expected_len > max_bytes {
        return Err(sidecar_unavail());
    }
    let mut bytes = Vec::with_capacity(expected_len as usize);
    file.take(expected_len.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| sidecar_unavail())?;
    if bytes.len() as u64 != expected_len {
        return Err(sidecar_unavail());
    }
    Ok(bytes)
}

fn is_valid_segment_char(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')
}

fn is_valid_dist_member_path(path: &str) -> bool {
    if path.is_empty()
        || path.len() > MAX_MEMBER_PATH_BYTES
        || !path.starts_with("dist/")
        || path.ends_with('/')
        || path.contains('\\')
    {
        return false;
    }
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2 || segments.len() > MAX_MEMBER_PATH_DEPTH {
        return false;
    }
    segments.iter().all(|seg| {
        !seg.is_empty() && *seg != "." && *seg != ".." && seg.bytes().all(is_valid_segment_char)
    })
}

fn verify_top_level_layout(payload_dir: &Path) -> StudioResult<()> {
    let payload_meta = fs::symlink_metadata(payload_dir).map_err(|_| sidecar_unavail())?;
    if !payload_meta.is_dir() || payload_meta.file_type().is_symlink() {
        return Err(sidecar_unavail());
    }
    let mut names = Vec::new();
    for entry_res in fs::read_dir(payload_dir).map_err(|_| sidecar_unavail())? {
        let entry = entry_res.map_err(|_| sidecar_unavail())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| sidecar_unavail())?;
        let meta = fs::symlink_metadata(entry.path()).map_err(|_| sidecar_unavail())?;
        if meta.file_type().is_symlink() {
            return Err(sidecar_unavail());
        }
        if name == "dist" {
            if !meta.is_dir() {
                return Err(sidecar_unavail());
            }
        } else {
            let _ =
                read_regular_no_follow_under(payload_dir, &entry.path(), MAX_METADATA_FILE_BYTES)?;
        }
        names.push(name);
    }
    names.sort();
    let mut expected: Vec<String> = SOLAR_SAIL_METADATA_LEAVES
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
    expected.push("dist".to_owned());
    expected.sort();
    if names != expected {
        return Err(sidecar_unavail());
    }
    Ok(())
}

fn collect_physical_dist_files(
    dir: &Path,
    rel_prefix: &str,
    depth: usize,
    out: &mut Vec<String>,
) -> StudioResult<()> {
    if depth > MAX_MEMBER_PATH_DEPTH {
        return Err(sidecar_unavail());
    }
    let meta = fs::symlink_metadata(dir).map_err(|_| sidecar_unavail())?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err(sidecar_unavail());
    }
    let mut entries = Vec::new();
    let mut lower_names = BTreeSet::new();
    for entry_res in fs::read_dir(dir).map_err(|_| sidecar_unavail())? {
        let entry = entry_res.map_err(|_| sidecar_unavail())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| sidecar_unavail())?;
        if name.is_empty()
            || name == "."
            || name == ".."
            || !name.bytes().all(is_valid_segment_char)
            || !lower_names.insert(name.to_ascii_lowercase())
        {
            return Err(sidecar_unavail());
        }
        entries.push((name, entry.path()));
    }
    if entries.is_empty() {
        return Err(sidecar_unavail());
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, full_path) in entries {
        let entry_meta = fs::symlink_metadata(&full_path).map_err(|_| sidecar_unavail())?;
        if entry_meta.file_type().is_symlink() {
            return Err(sidecar_unavail());
        }
        let rel_path = format!("{rel_prefix}/{name}");
        if rel_path.len() > MAX_MEMBER_PATH_BYTES {
            return Err(sidecar_unavail());
        }
        if entry_meta.is_dir() {
            collect_physical_dist_files(&full_path, &rel_path, depth + 1, out)?;
        } else if entry_meta.is_file() {
            out.push(rel_path);
            if out.len() > MAX_MEMBER_COUNT {
                return Err(sidecar_unavail());
            }
        } else {
            return Err(sidecar_unavail());
        }
    }
    Ok(())
}

fn extract_relative_esm_specifiers(source: &str) -> Vec<String> {
    let mut specs = Vec::new();
    for line in source.lines() {
        let trimmed = line.trim();
        if !(trimmed.starts_with("import ") || trimmed.starts_with("export ")) {
            continue;
        }
        for quote in ['"', '\''] {
            if let Some(end) = trimmed.rfind(quote)
                && let Some(start) = trimmed[..end].rfind(quote)
            {
                let spec = &trimmed[start + 1..end];
                if (spec.starts_with("./") || spec.starts_with("../"))
                    && (spec.ends_with(".js") || spec.ends_with(".mjs"))
                {
                    specs.push(spec.to_owned());
                }
            }
        }
    }
    specs
}

fn verify_esm_reachability(
    payload_dir: &Path,
    declared_paths: &BTreeSet<String>,
) -> StudioResult<()> {
    let dist_dir = payload_dir.join("dist");
    if !declared_paths.contains("dist/index.js") {
        return Err(sidecar_unavail());
    }
    let mut stack = vec![dist_dir.join("index.js")];
    let mut visited = BTreeSet::new();
    while let Some(mod_path) = stack.pop() {
        if !visited.insert(mod_path.clone()) {
            continue;
        }
        let rel = mod_path
            .strip_prefix(payload_dir)
            .map_err(|_| sidecar_unavail())?
            .to_str()
            .ok_or_else(sidecar_unavail)?
            .replace('\\', "/");
        if !declared_paths.contains(&rel) {
            return Err(sidecar_unavail());
        }
        let bytes = read_regular_no_follow_under(&dist_dir, &mod_path, MAX_MEMBER_BYTES)?;
        let src = String::from_utf8(bytes).map_err(|_| sidecar_unavail())?;
        let parent = mod_path.parent().ok_or_else(sidecar_unavail)?;
        for spec in extract_relative_esm_specifiers(&src) {
            let mut next = parent.to_path_buf();
            for comp in Path::new(&spec).components() {
                match comp {
                    Component::CurDir => {}
                    Component::ParentDir => {
                        if !next.pop() || !next.starts_with(&dist_dir) {
                            return Err(sidecar_unavail());
                        }
                    }
                    Component::Normal(seg) => next.push(seg),
                    _ => return Err(sidecar_unavail()),
                }
            }
            stack.push(next);
        }
    }
    if !visited.contains(&dist_dir.join("input.js"))
        || !visited.contains(&dist_dir.join("paired-v2/bound.js"))
    {
        return Err(sidecar_unavail());
    }
    Ok(())
}

pub(crate) fn verify_payload_with_expectation(
    payload_dir: &Path,
    expectation: &SolarSailBuildPinDto,
) -> StudioResult<()> {
    verify_top_level_layout(payload_dir)?;

    let binding_path = payload_dir.join("solar-sail-binding.json");
    let binding_bytes =
        read_regular_no_follow_under(payload_dir, &binding_path, MAX_BINDING_BYTES)?;
    if binding_bytes.len() as u64 != expectation.binding.size
        || sha256_hex(&binding_bytes) != expectation.binding.sha256
    {
        return Err(sidecar_unavail());
    }

    let binding: SolarSailBindingManifestDto =
        serde_json::from_slice(&binding_bytes).map_err(|_| sidecar_unavail())?;
    if binding.schema != SOLAR_SAIL_BINDING_SCHEMA
        || binding.name != EXPECTED_SOLAR_SAIL_NAME
        || binding.name != expectation.package.name
        || binding.version != expectation.package.version
        || !is_lower_hex_sha256(&binding.package_json_sha256)
        || binding.package_json_sha256 != expectation.package.package_json_sha256
        || !is_lower_hex_sha256(&binding.inventory_digest)
        || binding.inventory_digest != expectation.binding.inventory_digest
        || binding.runtime_member_count != binding.members.len()
        || binding.runtime_member_count != expectation.binding.member_count
        || binding.members.is_empty()
        || binding.members.len() > MAX_MEMBER_COUNT
    {
        return Err(sidecar_unavail());
    }

    let pkg_path = payload_dir.join("package.json");
    let pkg_bytes = read_regular_no_follow_under(payload_dir, &pkg_path, MAX_METADATA_FILE_BYTES)?;
    if sha256_hex(&pkg_bytes) != expectation.package.package_json_sha256 {
        return Err(sidecar_unavail());
    }
    let pkg: PackageJsonIdentityDto =
        serde_json::from_slice(&pkg_bytes).map_err(|_| sidecar_unavail())?;
    if pkg.name != expectation.package.name || pkg.version != expectation.package.version {
        return Err(sidecar_unavail());
    }

    let mut declared_paths = Vec::with_capacity(binding.members.len());
    let mut declared_set = BTreeSet::new();
    let mut lower_set = BTreeSet::new();
    for (idx, member) in binding.members.iter().enumerate() {
        if !is_valid_dist_member_path(&member.path)
            || member.size == 0
            || member.size > MAX_MEMBER_BYTES
            || !is_lower_hex_sha256(&member.sha256)
        {
            return Err(sidecar_unavail());
        }
        if idx > 0 && binding.members[idx - 1].path >= member.path {
            return Err(sidecar_unavail());
        }
        if !declared_set.insert(member.path.clone())
            || !lower_set.insert(member.path.to_ascii_lowercase())
        {
            return Err(sidecar_unavail());
        }
        declared_paths.push(member.path.clone());
    }

    let mut physical_paths = Vec::new();
    collect_physical_dist_files(&payload_dir.join("dist"), "dist", 2, &mut physical_paths)?;
    physical_paths.sort();
    if physical_paths != declared_paths {
        return Err(sidecar_unavail());
    }

    let mut total_bytes: u64 = 0;
    let mut summary_lines = Vec::with_capacity(binding.members.len());
    for member in &binding.members {
        let member_path = PathBuf::from(&member.path);
        let full_path = payload_dir.join(&member_path);
        let bytes = read_regular_no_follow_under(payload_dir, &full_path, MAX_MEMBER_BYTES)?;
        if bytes.len() as u64 != member.size {
            return Err(sidecar_unavail());
        }
        total_bytes = total_bytes
            .checked_add(member.size)
            .ok_or_else(sidecar_unavail)?;
        if total_bytes > MAX_TOTAL_PAYLOAD_BYTES {
            return Err(sidecar_unavail());
        }
        let actual_sha = sha256_hex(&bytes);
        if actual_sha != member.sha256 {
            return Err(sidecar_unavail());
        }
        summary_lines.push(format!("{}:{}", member.path, member.sha256));
    }

    let computed_inventory = sha256_hex(summary_lines.join("\n").as_bytes());
    if computed_inventory != binding.inventory_digest
        || computed_inventory != expectation.binding.inventory_digest
    {
        return Err(sidecar_unavail());
    }

    verify_esm_reachability(payload_dir, &declared_set)?;
    Ok(())
}

pub fn authenticate_payload_closure(adapter_path: &Path) -> StudioResult<()> {
    let payload_dir = adapter_path
        .parent()
        .and_then(|p| p.parent())
        .map(|r| r.join("solar-sail-payload"))
        .ok_or_else(sidecar_unavail)?;
    let expectation = compiled_expectation()?;
    verify_payload_with_expectation(&payload_dir, &expectation)
}

#[cfg(test)]
#[path = "payload_authentication_tests.rs"]
mod tests;
