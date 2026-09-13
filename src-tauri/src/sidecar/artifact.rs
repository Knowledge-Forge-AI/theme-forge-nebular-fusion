use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(test)]
pub(crate) static DISTRIBUTION_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

use crate::sidecar::framing::validate_strict_object;

const O_NOFOLLOW: i32 = 0x0000_0100;
const MAX_AGGREGATE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_FILES: usize = 10_000;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 512;
const NATIVE_PATH: &str =
    "native/directory-snapshot/prebuilds/darwin-arm64/native-addon-posix-openat-v1.node";
const RASTER_PACKAGE_PATH: &str = "node_modules/@knowledge-forge-ai/tfsb-raster-resvg/package.json";
const WASM_PATH: &str = "node_modules/@resvg/resvg-wasm/index_bg.wasm";
const ENTRYPOINT: &str = "dist/service-protocol/server-cli.js";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    core: CoreIdentity,
    entrypoint: String,
    files: Vec<ManifestFile>,
    manifest_digest: String,
    native: NativeIdentity,
    protocol: BTreeMap<String, ProtocolIdentity>,
    raster: RasterIdentity,
    resvg: ResvgIdentity,
    runtime: RuntimeIdentity,
    runtime_kind: String,
    schema: String,
    schema_version: u8,
    source: SourceIdentity,
    target: String,
    totals: Totals,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CoreIdentity {
    name: String,
    tarball: TarballIdentity,
    version: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TarballIdentity {
    sha1: String,
    sha256: String,
    size: u64,
    sri: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeIdentity {
    mode: u32,
    sha256: String,
    size: u64,
    target: String,
    v8: String,
    version: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourceIdentity {
    actual_input_digest: String,
    base_commit: String,
    model: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtocolIdentity {
    inventory_sha256: String,
    requests_sha256: String,
    results_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct NativeIdentity {
    abi: u8,
    backend: String,
    sha256: String,
    size: u64,
    target: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RasterIdentity {
    name: String,
    package_json_sha256: String,
    version: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResvgIdentity {
    name: String,
    version: String,
    wasm_sha256: String,
    wasm_size: u64,
}

#[derive(Debug, Deserialize, Serialize, Clone, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct ManifestFile {
    mode: u32,
    path: String,
    sha256: String,
    size: u64,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Totals {
    bytes: u64,
    file_count: usize,
    inventory_digest: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActualInputIdentity<'a> {
    core_tarball: &'a TarballIdentity,
    files: &'a [ManifestFile],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
    length: u64,
    mode: u32,
    modified_seconds: i64,
    modified_nanoseconds: i64,
}

impl FileIdentity {
    fn from(metadata: &fs::Metadata) -> Self {
        Self {
            device: metadata.dev(),
            inode: metadata.ino(),
            length: metadata.len(),
            mode: metadata.mode(),
            modified_seconds: metadata.mtime(),
            modified_nanoseconds: metadata.mtime_nsec(),
        }
    }
}

#[derive(Debug)]
struct RetainedFile {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
    sha256: String,
}

#[derive(Debug)]
struct RetainedDirectory {
    path: PathBuf,
    file: File,
    identity: FileIdentity,
}

#[derive(Debug)]
struct TreeInventory {
    files: Vec<CurrentFile>,
    directories: Vec<RetainedDirectory>,
}

#[derive(Debug, PartialEq, Eq)]
struct CurrentFile {
    path: PathBuf,
    identity: FileIdentity,
    sha256: String,
}

#[derive(Debug, PartialEq, Eq)]
struct CurrentDirectory {
    path: PathBuf,
    identity: FileIdentity,
}

#[derive(Debug)]
struct CurrentTree {
    files: Vec<CurrentFile>,
    directories: Vec<CurrentDirectory>,
}

#[derive(Debug)]
pub(crate) struct VerifiedDistribution {
    pub(crate) binary: PathBuf,
    pub(crate) payload: PathBuf,
    pub(crate) manifest_digest: String,
    runtime: RetainedFile,
    payload_root: File,
    payload_root_identity: FileIdentity,
    files: Vec<CurrentFile>,
    directories: Vec<RetainedDirectory>,
    manifest: RetainedFile,
}

fn open_nofollow(path: &Path) -> io::Result<File> {
    OpenOptions::new()
        .read(true)
        .custom_flags(O_NOFOLLOW)
        .open(path)
}

fn named_identity(path: &Path, regular: bool, maximum: u64) -> io::Result<FileIdentity> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || (regular && !metadata.is_file())
        || (!regular && !metadata.is_dir())
        || metadata.len() > maximum
    {
        return Err(io::Error::other("distribution object identity"));
    }
    Ok(FileIdentity::from(&metadata))
}

fn open_directory(path: &Path) -> io::Result<(File, FileIdentity)> {
    let before = named_identity(path, false, u64::MAX)?;
    let file = open_nofollow(path)?;
    let opened = FileIdentity::from(&file.metadata()?);
    let after = named_identity(path, false, u64::MAX)?;
    if before != opened || opened != after {
        return Err(io::Error::other("distribution directory changed"));
    }
    Ok((file, opened))
}

fn open_retained(path: &Path, maximum: u64) -> io::Result<RetainedFile> {
    let before = named_identity(path, true, maximum)?;
    let mut file = open_nofollow(path)?;
    let opened = FileIdentity::from(&file.metadata()?);
    if before != opened {
        return Err(io::Error::other("distribution file changed before read"));
    }
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let post_read = FileIdentity::from(&file.metadata()?);
    let final_named = named_identity(path, true, maximum)?;
    if opened != post_read || post_read != final_named {
        return Err(io::Error::other("distribution file changed during read"));
    }
    file.seek(SeekFrom::Start(0))?;
    Ok(RetainedFile {
        path: path.to_path_buf(),
        file,
        identity: opened,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

impl RetainedFile {
    fn revalidate_named(&self, maximum: u64) -> io::Result<()> {
        let current = open_retained(&self.path, maximum)?;
        if self.identity != current.identity || self.sha256 != current.sha256 {
            return Err(io::Error::other(
                "distribution file changed after verification",
            ));
        }
        Ok(())
    }
}

impl RetainedDirectory {
    fn revalidate_named(&self) -> io::Result<()> {
        let (current, identity) = open_directory(&self.path)?;
        if self.identity != identity || FileIdentity::from(&self.file.metadata()?) != self.identity
        {
            return Err(io::Error::other(
                "distribution directory changed after verification",
            ));
        }
        drop(current);
        Ok(())
    }
}

fn safe_relative(path: &str) -> bool {
    if path.is_empty() || path.len() > MAX_PATH_BYTES || !path.is_ascii() || path.contains('\\') {
        return false;
    }
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return false;
    }
    candidate.components().all(|component| match component {
        Component::Normal(value) => {
            let text = value.to_string_lossy();
            !text.is_empty()
                && text != "."
                && text != ".."
                && text.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric()
                        || matches!(byte, b'/' | b'.' | b'_' | b'-' | b'@' | b'+')
                })
        }
        _ => false,
    })
}

fn enumerate(root: &Path) -> io::Result<TreeInventory> {
    fn visit(
        root: &Path,
        directory: &Path,
        files: &mut Vec<CurrentFile>,
        directories: &mut Vec<RetainedDirectory>,
    ) -> io::Result<()> {
        let (directory_file, before) = open_directory(directory)?;
        let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(fs::DirEntry::file_name);
        let mut names = BTreeSet::new();
        for entry in entries {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| io::Error::other("non-UTF-8 distribution name"))?;
            if !name.is_ascii() || !names.insert(name.to_ascii_lowercase()) {
                return Err(io::Error::other("distribution name collision"));
            }
            let path = entry.path();
            let kind = fs::symlink_metadata(&path)?.file_type();
            if kind.is_symlink() {
                return Err(io::Error::other("distribution symlink"));
            }
            if kind.is_dir() {
                visit(root, &path, files, directories)?;
            } else if kind.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| io::Error::other("distribution path escape"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative != "manifest.json" {
                    if files.len() >= MAX_FILES {
                        return Err(io::Error::other("distribution file count"));
                    }
                    let retained = open_retained(&path, MAX_FILE_BYTES)?;
                    files.push(CurrentFile {
                        path,
                        identity: retained.identity,
                        sha256: retained.sha256,
                    });
                }
            } else {
                return Err(io::Error::other("distribution special file"));
            }
        }
        if before != named_identity(directory, false, u64::MAX)? {
            return Err(io::Error::other(
                "distribution directory changed during enumeration",
            ));
        }
        if directory != root {
            if directories.len() >= MAX_FILES {
                return Err(io::Error::other("distribution directory count"));
            }
            directories.push(RetainedDirectory {
                path: directory.to_path_buf(),
                file: directory_file,
                identity: before,
            });
        }
        Ok(())
    }
    let mut files = Vec::new();
    let mut directories = Vec::new();
    visit(root, root, &mut files, &mut directories)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    directories.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(TreeInventory { files, directories })
}

fn snapshot_tree(root: &Path) -> io::Result<CurrentTree> {
    fn visit(
        root: &Path,
        directory: &Path,
        files: &mut Vec<CurrentFile>,
        directories: &mut Vec<CurrentDirectory>,
    ) -> io::Result<()> {
        let (directory_file, before) = open_directory(directory)?;
        let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
        entries.sort_by_key(fs::DirEntry::file_name);
        let mut names = BTreeSet::new();
        for entry in entries {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| io::Error::other("non-UTF-8 distribution name"))?;
            if !name.is_ascii() || !names.insert(name.to_ascii_lowercase()) {
                return Err(io::Error::other("distribution name collision"));
            }
            let path = entry.path();
            let kind = fs::symlink_metadata(&path)?.file_type();
            if kind.is_symlink() {
                return Err(io::Error::other("distribution symlink"));
            }
            if kind.is_dir() {
                visit(root, &path, files, directories)?;
            } else if kind.is_file() {
                let relative = path
                    .strip_prefix(root)
                    .map_err(|_| io::Error::other("distribution path escape"))?
                    .to_string_lossy()
                    .replace('\\', "/");
                if relative != "manifest.json" {
                    if files.len() >= MAX_FILES {
                        return Err(io::Error::other("distribution file count"));
                    }
                    let retained = open_retained(&path, MAX_FILE_BYTES)?;
                    files.push(CurrentFile {
                        path,
                        identity: retained.identity,
                        sha256: retained.sha256,
                    });
                }
            } else {
                return Err(io::Error::other("distribution special file"));
            }
        }
        if before != named_identity(directory, false, u64::MAX)? {
            return Err(io::Error::other(
                "distribution directory changed during enumeration",
            ));
        }
        if directory != root {
            if directories.len() >= MAX_FILES {
                return Err(io::Error::other("distribution directory count"));
            }
            directories.push(CurrentDirectory {
                path: directory.to_path_buf(),
                identity: before,
            });
        }
        drop(directory_file);
        Ok(())
    }
    let mut files = Vec::new();
    let mut directories = Vec::new();
    visit(root, root, &mut files, &mut directories)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    directories.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(CurrentTree { files, directories })
}

fn verify_self_digest(raw: &str, digest: &str) -> bool {
    if !valid_hex(digest, 64) {
        return false;
    }
    let needle = format!("\"manifestDigest\":\"{digest}\",");
    if raw.matches(&needle).count() != 1 {
        return false;
    }
    let unsigned = raw.replacen(&needle, "", 1);
    format!("{:x}", Sha256::digest(unsigned.as_bytes())) == digest
}

fn valid_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn valid_sri(value: &str) -> bool {
    let Some(encoded) = value.strip_prefix("sha512-") else {
        return false;
    };
    !encoded.is_empty()
        && encoded.len() <= 128
        && encoded
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
        && !encoded.trim_end_matches('=').contains('=')
}

fn required<'a>(
    files: &'a BTreeMap<&str, &'a ManifestFile>,
    path: &str,
) -> io::Result<&'a ManifestFile> {
    files
        .get(path)
        .copied()
        .ok_or_else(|| io::Error::other("required payload file"))
}

fn protocol_file(version: &str, kind: &str) -> String {
    let suffix = match version {
        "1.0" => "",
        "1.1" => "-1.1",
        "1.2" => "-1.2",
        _ => return String::new(),
    };
    let schema = if kind == "inventory" { "" } else { ".schema" };
    format!("protocol/tfsb-studio-v1/{kind}{suffix}{schema}.json")
}

fn verify_manifest(
    manifest: &Manifest,
    raw: &str,
    actual: &[CurrentFile],
    root: &Path,
) -> io::Result<()> {
    if serde_json::to_string(manifest).map_err(|_| io::Error::other("manifest serialization"))?
        != raw
        || !verify_self_digest(raw, &manifest.manifest_digest)
        || manifest.schema != "tfsb.studio-sidecar-distribution"
        || manifest.schema_version != 1
        || manifest.target != "aarch64-apple-darwin"
        || manifest.runtime_kind != "node-runtime-payload-v1"
        || manifest.entrypoint != ENTRYPOINT
        || manifest.source.model != "closed-input-digest-v1"
        || !valid_hex(&manifest.source.base_commit, 40)
        || !valid_hex(&manifest.source.actual_input_digest, 64)
    {
        return Err(io::Error::other("manifest identity"));
    }
    if manifest.core.name != "@knowledge-forge-ai/theme-forge-stellar-burst"
        || manifest.core.version != "0.5.0"
        || !valid_hex(&manifest.core.tarball.sha1, 40)
        || !valid_hex(&manifest.core.tarball.sha256, 64)
        || manifest.core.tarball.size > MAX_FILE_BYTES
        || !valid_sri(&manifest.core.tarball.sri)
        || manifest.runtime.version != "22.23.2"
        || manifest.runtime.v8 != "12.4.254.21-node.56"
        || manifest.runtime.target != "aarch64-apple-darwin"
        || manifest.runtime.mode != 0o755
        || manifest.runtime.sha256
            != "18e387c90ab8a8400183e8bdd396376e1e875b91b4c874b894dcade7b35bf572"
        || manifest.runtime.size != 112_937_728
        || manifest.native.backend != "native-addon-posix-openat-v1"
        || manifest.native.abi != 1
        || manifest.native.target != "aarch64-apple-darwin"
        || manifest.native.sha256
            != "2f842ce43f62c76b04884a92980037067c8e55dfd183c86e788f1c3ac8a533c8"
        || manifest.native.size != 53_344
        || manifest.raster.name != "@knowledge-forge-ai/tfsb-raster-resvg"
        || manifest.raster.version != "0.0.0-tfsb47f"
        || manifest.raster.package_json_sha256
            != "14b741e56d9823f82318e8a9d062a02884258eccfae6266138be2a6aaf9acd12"
        || manifest.resvg.name != "@resvg/resvg-wasm"
        || manifest.resvg.version != "2.6.2"
        || manifest.resvg.wasm_sha256
            != "22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70"
        || manifest.resvg.wasm_size != 2_478_606
    {
        return Err(io::Error::other("manifest nested identity"));
    }
    if manifest.files.len() > MAX_FILES || manifest.files.len() != actual.len() {
        return Err(io::Error::other("payload file count"));
    }
    let mut by_path = BTreeMap::new();
    let mut collision = BTreeSet::new();
    let mut total = 0_u64;
    let mut previous = None;
    for expected in &manifest.files {
        if !safe_relative(&expected.path)
            || !valid_hex(&expected.sha256, 64)
            || expected.size > MAX_FILE_BYTES
            || previous.is_some_and(|value: &str| value >= expected.path.as_str())
            || !collision.insert(expected.path.to_ascii_lowercase())
        {
            return Err(io::Error::other("manifest file record"));
        }
        previous = Some(&expected.path);
        total = total
            .checked_add(expected.size)
            .filter(|value| *value <= MAX_AGGREGATE_BYTES)
            .ok_or_else(|| io::Error::other("payload aggregate size"))?;
        by_path.insert(expected.path.as_str(), expected);
    }
    for retained in actual {
        let relative = retained
            .path
            .strip_prefix(root)
            .map_err(|_| io::Error::other("payload path escape"))?
            .to_string_lossy()
            .replace('\\', "/");
        let expected = required(&by_path, &relative)?;
        if retained.sha256 != expected.sha256
            || retained.identity.length != expected.size
            || retained.identity.mode & 0o777 != expected.mode
        {
            return Err(io::Error::other("payload identity"));
        }
    }
    let inventory = serde_json::to_string(&manifest.files)
        .map_err(|_| io::Error::other("payload inventory serialization"))?;
    let actual_input = serde_json::to_string(&ActualInputIdentity {
        core_tarball: &manifest.core.tarball,
        files: &manifest.files,
    })
    .map_err(|_| io::Error::other("actual input serialization"))?;
    if manifest.totals.file_count != manifest.files.len()
        || manifest.totals.bytes != total
        || manifest.totals.inventory_digest != format!("{:x}", Sha256::digest(inventory.as_bytes()))
        || manifest.source.actual_input_digest
            != format!("{:x}", Sha256::digest(actual_input.as_bytes()))
    {
        return Err(io::Error::other("payload totals"));
    }
    let native = required(&by_path, NATIVE_PATH)?;
    let raster = required(&by_path, RASTER_PACKAGE_PATH)?;
    let wasm = required(&by_path, WASM_PATH)?;
    required(&by_path, ENTRYPOINT)?;
    if native.sha256 != manifest.native.sha256
        || native.size != manifest.native.size
        || raster.sha256 != manifest.raster.package_json_sha256
        || wasm.sha256 != manifest.resvg.wasm_sha256
        || wasm.size != manifest.resvg.wasm_size
    {
        return Err(io::Error::other("manifest consequence identity"));
    }
    if manifest.protocol.len() != 3 {
        return Err(io::Error::other("protocol inventory"));
    }
    let expected_protocol = [
        (
            "1.0",
            "96fdbcf0c56c1890d44363c34c80d8dacfccb37196de8050ab2d1afc7a3e0f70",
            "5fa687ed6434b4f0ec6288bf4285f4109ab63afe55e2235d52f04f8ed77a8827",
            "5b8f0f057d0dbcabf1b5d83765e476baececd5e7cdb5696bfcb1ac1826f84ff1",
        ),
        (
            "1.1",
            "9d58e954e62169e87648814372a381653e9e69df5a0ce722251e6e46951dfe8a",
            "b5a10078862c8e03e951a67a8e7cd125c5d4d23619c3d32a9fb41a762629d54f",
            "dee9513c61ed767e260d6dd16a13420c26f745850c7a6055cf6213e52571be60",
        ),
        (
            "1.2",
            "b620544ad644a7293313212a9585cd9e07af93608f2beac4e36b4bc99d812638",
            "e63252413eaebc2f5a73ad0973d48a51908f8d0604b09440774948bd935daf89",
            "d6259a45a4da2185761098ebf6f8d0f5ff80f08f41d3e34a4a3d69f792760fd1",
        ),
    ];
    for (version, inventory_digest, requests_digest, results_digest) in expected_protocol {
        let identity = manifest
            .protocol
            .get(version)
            .ok_or_else(|| io::Error::other("protocol version"))?;
        if identity.inventory_sha256 != inventory_digest
            || identity.requests_sha256 != requests_digest
            || identity.results_sha256 != results_digest
        {
            return Err(io::Error::other("protocol fixed identity"));
        }
        for (kind, digest) in [
            ("inventory", &identity.inventory_sha256),
            ("requests", &identity.requests_sha256),
            ("results", &identity.results_sha256),
        ] {
            if required(&by_path, &protocol_file(version, kind))?.sha256 != *digest {
                return Err(io::Error::other("protocol schema identity"));
            }
        }
    }
    Ok(())
}

fn verify_no_symlink_ancestors(path: &Path) -> io::Result<()> {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if fs::symlink_metadata(&current).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(io::Error::other("symlink in distribution ancestry"));
        }
    }
    Ok(())
}

impl VerifiedDistribution {
    /// Revalidates every named object immediately before process creation. Safe Rust cannot
    /// execute the retained Mach-O descriptor, so signing/notarization remains the final
    /// authority for the pathname-to-exec interval after this check.
    pub(crate) fn revalidate_for_spawn(&self) -> io::Result<()> {
        if self.payload_root_identity != named_identity(&self.payload, false, u64::MAX)? {
            return Err(io::Error::other("payload root changed after verification"));
        }
        self.runtime.revalidate_named(MAX_FILE_BYTES)?;
        self.manifest.revalidate_named(MAX_MANIFEST_BYTES)?;
        for directory in &self.directories {
            directory.revalidate_named()?;
        }
        let current = snapshot_tree(&self.payload)?;
        if current.files.len() != self.files.len()
            || current.directories.len() != self.directories.len()
            || self
                .files
                .iter()
                .zip(&current.files)
                .any(|(expected, actual)| {
                    expected.path != actual.path
                        || expected.identity != actual.identity
                        || expected.sha256 != actual.sha256
                })
            || self
                .directories
                .iter()
                .zip(&current.directories)
                .any(|(expected, actual)| {
                    expected.path != actual.path || expected.identity != actual.identity
                })
        {
            return Err(io::Error::other(
                "distribution tree changed after verification",
            ));
        }
        let opened_root = FileIdentity::from(&self.payload_root.metadata()?);
        if opened_root != self.payload_root_identity {
            return Err(io::Error::other("retained payload root changed"));
        }
        Ok(())
    }
}

pub(crate) fn verify_distribution(
    binary: &Path,
    payload: &Path,
) -> io::Result<VerifiedDistribution> {
    verify_no_symlink_ancestors(binary)?;
    verify_no_symlink_ancestors(payload)?;
    let runtime = open_retained(binary, MAX_FILE_BYTES)?;
    let (payload_root, payload_root_identity) = open_directory(payload)?;
    let manifest_path = payload.join("manifest.json");
    let manifest_file = open_retained(&manifest_path, MAX_MANIFEST_BYTES)?;
    let mut raw_with_newline = String::new();
    let mut manifest_reader = &manifest_file.file;
    manifest_reader.read_to_string(&mut raw_with_newline)?;
    let raw = raw_with_newline
        .strip_suffix('\n')
        .filter(|value| !value.contains('\n') && !value.contains('\r'))
        .ok_or_else(|| io::Error::other("manifest newline"))?;
    validate_strict_object(raw).map_err(|_| io::Error::other("manifest JSON"))?;
    let manifest: Manifest =
        serde_json::from_str(raw).map_err(|_| io::Error::other("manifest shape"))?;
    if runtime.sha256 != manifest.runtime.sha256
        || runtime.identity.length != manifest.runtime.size
        || runtime.identity.mode & 0o777 != manifest.runtime.mode
    {
        return Err(io::Error::other("runtime identity"));
    }
    let tree = enumerate(payload)?;
    verify_manifest(&manifest, raw, &tree.files, payload)?;
    if payload_root_identity != named_identity(payload, false, u64::MAX)? {
        return Err(io::Error::other("payload root changed during verification"));
    }
    let verified = VerifiedDistribution {
        binary: binary.to_path_buf(),
        payload: payload.to_path_buf(),
        manifest_digest: manifest.manifest_digest,
        runtime,
        payload_root,
        payload_root_identity,
        files: tree.files,
        directories: tree.directories,
        manifest: manifest_file,
    };
    verified.revalidate_for_spawn()?;
    Ok(verified)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io;
    use std::os::unix::net::UnixListener;
    use std::path::{Path, PathBuf};

    use serde::Deserialize;
    use sha2::{Digest, Sha256};

    use super::{ActualInputIdentity, Manifest};
    use super::{safe_relative, valid_hex, verify_distribution, verify_self_digest};

    fn hard_link_tree(source: &Path, destination: &Path) -> io::Result<()> {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                hard_link_tree(&source_path, &destination_path)?;
            } else if kind.is_file() {
                fs::hard_link(source_path, destination_path)?;
            } else {
                return Err(io::Error::other("unexpected source fixture object"));
            }
        }
        Ok(())
    }

    fn fixture(name: &str) -> io::Result<(PathBuf, PathBuf, PathBuf)> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let source_binary = root.join("binaries/tfsb-studio-service-aarch64-apple-darwin");
        let source_payload = root.join("sidecar-payload");
        let fixture = root
            .join("target")
            .join(format!("tfsb-tree-race-{}-{name}", std::process::id()));
        if fixture.exists() {
            fs::remove_dir_all(&fixture)?;
        }
        fs::create_dir_all(&fixture)?;
        let binary = fixture.join("sidecar");
        let payload = fixture.join("payload");
        fs::hard_link(source_binary, &binary)?;
        hard_link_tree(&source_payload, &payload)?;
        Ok((fixture, binary, payload))
    }

    fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
        fs::create_dir(destination)?;
        for entry in fs::read_dir(source)? {
            let entry = entry?;
            let source_path = entry.path();
            let destination_path = destination.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_tree(&source_path, &destination_path)?;
            } else {
                fs::copy(source_path, destination_path)?;
            }
        }
        Ok(())
    }

    fn copied_fixture(name: &str) -> io::Result<(PathBuf, PathBuf, PathBuf)> {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let source_binary = root.join("binaries/tfsb-studio-service-aarch64-apple-darwin");
        let source_payload = root.join("sidecar-payload");
        let fixture = root
            .join("target")
            .join(format!("tfsb-parity-{}-{name}", std::process::id()));
        if fixture.exists() {
            fs::remove_dir_all(&fixture)?;
        }
        fs::create_dir_all(&fixture)?;
        let binary = fixture.join("sidecar");
        let payload = fixture.join("payload");
        fs::hard_link(source_binary, &binary)?;
        copy_tree(&source_payload, &payload)?;
        Ok((fixture, binary, payload))
    }

    fn write_closed_manifest(
        payload: &Path,
        manifest: &mut Manifest,
        preserve_actual_input: bool,
    ) -> io::Result<()> {
        if !preserve_actual_input {
            let actual = serde_json::to_string(&ActualInputIdentity {
                core_tarball: &manifest.core.tarball,
                files: &manifest.files,
            })
            .map_err(|_| io::Error::other("test actual input serialization"))?;
            manifest.source.actual_input_digest = format!("{:x}", Sha256::digest(actual));
        }
        manifest.manifest_digest = "0".repeat(64);
        let raw = serde_json::to_string(manifest)
            .map_err(|_| io::Error::other("test manifest serialization"))?;
        let needle = format!("\"manifestDigest\":\"{}\",", "0".repeat(64));
        let unsigned = raw.replacen(&needle, "", 1);
        manifest.manifest_digest = format!("{:x}", Sha256::digest(unsigned));
        let closed = serde_json::to_string(manifest)
            .map_err(|_| io::Error::other("test manifest serialization"))?;
        fs::write(payload.join("manifest.json"), format!("{closed}\n"))
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct VectorCorpus {
        schema_version: u8,
        vectors: Vec<Vector>,
    }

    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Vector {
        accept: bool,
        class: String,
        name: String,
    }

    #[test]
    fn manifest_helpers_reject_ambiguous_paths_and_bad_digests() {
        assert!(safe_relative("dist/server.js"));
        for path in ["", "../server.js", "a/../b", "a\\b", "café"] {
            assert!(!safe_relative(path));
        }
        assert!(valid_hex(&"a".repeat(64), 64));
        assert!(!valid_hex(&"A".repeat(64), 64));
        assert!(!verify_self_digest("{}", "bad"));
    }

    #[test]
    fn complete_tree_is_revalidated_immediately_before_spawn() -> io::Result<()> {
        let _guard = super::DISTRIBUTION_TEST_LOCK
            .lock()
            .map_err(|_| io::Error::other("distribution test lock"))?;
        for case in [
            "dist-package",
            "nested-package",
            "extra-directory",
            "recreated-directory",
            "symlink",
            "special",
            "missing-file",
            "replaced-file",
            "content-change",
            "mode-change",
            "manifest-replace",
            "runtime-replace",
            "root-replace",
        ] {
            let (root, binary, payload) = fixture(case)?;
            let verified = verify_distribution(&binary, &payload)?;
            match case {
                "dist-package" => {
                    fs::write(payload.join("dist/package.json"), b"{}\n")?;
                }
                "nested-package" => {
                    let path = payload.join("dist/node_modules/injected");
                    fs::create_dir_all(&path)?;
                    fs::write(path.join("index.js"), b"export {};\n")?;
                }
                "extra-directory" => {
                    fs::create_dir(payload.join("dist/empty-extra"))?;
                }
                "recreated-directory" => {
                    let original = payload.join("dist/service-protocol");
                    fs::rename(&original, payload.join("dist/service-protocol-old"))?;
                    fs::create_dir(&original)?;
                }
                "symlink" => {
                    std::os::unix::fs::symlink(
                        "../manifest.json",
                        payload.join("dist/injected-link"),
                    )?;
                }
                "special" => {
                    let short =
                        PathBuf::from(format!("/tmp/tfsb-r2-tree-{}.sock", std::process::id()));
                    if short.exists() {
                        fs::remove_file(&short)?;
                    }
                    let _listener = UnixListener::bind(&short)?;
                    fs::rename(&short, payload.join("dist/injected-socket"))?;
                    assert!(verified.revalidate_for_spawn().is_err());
                    drop(verified);
                    fs::remove_dir_all(root)?;
                    continue;
                }
                "missing-file" => {
                    fs::remove_file(payload.join(super::ENTRYPOINT))?;
                }
                "replaced-file" => {
                    let entrypoint = payload.join(super::ENTRYPOINT);
                    fs::remove_file(&entrypoint)?;
                    fs::write(&entrypoint, b"console.log('replaced');\n")?;
                }
                "content-change" => {
                    let entrypoint = payload.join(super::ENTRYPOINT);
                    let mut content = fs::read(&entrypoint)?;
                    content.push(b'\n');
                    fs::remove_file(&entrypoint)?;
                    fs::write(&entrypoint, content)?;
                }
                "mode-change" => {
                    let entrypoint = payload.join(super::ENTRYPOINT);
                    let content = fs::read(&entrypoint)?;
                    fs::remove_file(&entrypoint)?;
                    fs::write(&entrypoint, content)?;
                    let mut permissions = fs::metadata(&entrypoint)?.permissions();
                    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o777);
                    fs::set_permissions(&entrypoint, permissions)?;
                }
                "manifest-replace" => {
                    let manifest = payload.join("manifest.json");
                    fs::remove_file(&manifest)?;
                    fs::write(&manifest, b"{}\n")?;
                }
                "runtime-replace" => {
                    fs::remove_file(&binary)?;
                    fs::write(&binary, b"fake-runtime")?;
                }
                "root-replace" => {
                    let backup = root.join("backup-payload");
                    let _ = fs::remove_dir_all(&backup);
                    fs::rename(&payload, &backup)?;
                    fs::create_dir(&payload)?;
                }
                _ => return Err(io::Error::other("unknown tree-race fixture")),
            }
            assert!(verified.revalidate_for_spawn().is_err());
            drop(verified);
            fs::remove_dir_all(root)?;
        }
        Ok(())
    }

    #[test]
    fn shared_corpus_exercises_the_actual_rust_verifier() -> io::Result<()> {
        let _guard = super::DISTRIBUTION_TEST_LOCK
            .lock()
            .map_err(|_| io::Error::other("distribution test lock"))?;
        let corpus: VectorCorpus =
            serde_json::from_str(include_str!("../../../tests/sidecar-verifier-vectors.json"))
                .map_err(|_| io::Error::other("shared verifier corpus"))?;
        if corpus.schema_version != 1 {
            return Err(io::Error::other("shared verifier corpus version"));
        }
        for vector in corpus.vectors {
            let (root, binary, payload) = copied_fixture(&vector.name)?;
            let manifest_path = payload.join("manifest.json");
            let raw = fs::read_to_string(&manifest_path)?;
            let mut manifest: Manifest = serde_json::from_str(raw.trim_end())
                .map_err(|_| io::Error::other("fixture manifest"))?;
            let first_path = manifest
                .files
                .first()
                .map(|file| file.path.clone())
                .ok_or_else(|| io::Error::other("fixture file"))?;
            match vector.class.as_str() {
                "positive" => {}
                "unknown-fields" => {
                    fs::write(&manifest_path, raw.replacen('{', "{\"unknown\":true,", 1))?;
                }
                "missing-fields" => {
                    fs::write(
                        &manifest_path,
                        raw.replacen("\"entrypoint\":", "\"removed\":", 1),
                    )?;
                }
                "duplicate-fields" => {
                    fs::write(
                        &manifest_path,
                        raw.replacen('{', "{\"schemaVersion\":1,", 1),
                    )?;
                }
                "noncanonical-manifest" => fs::write(&manifest_path, format!(" {raw}"))?,
                "self-digest" => {
                    manifest.manifest_digest = "0".repeat(64);
                    fs::write(
                        &manifest_path,
                        format!(
                            "{}\n",
                            serde_json::to_string(&manifest)
                                .map_err(|_| io::Error::other("test manifest"))?
                        ),
                    )?;
                }
                "source-identity" => {
                    manifest.source.base_commit = "wrong".to_owned();
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "core-identity" => {
                    manifest.core.version = "wrong".to_owned();
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "runtime-identity" => {
                    manifest.runtime.version = "wrong".to_owned();
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "protocol-identity" => {
                    let identity = manifest
                        .protocol
                        .get_mut("1.1")
                        .ok_or_else(|| io::Error::other("fixture protocol"))?;
                    identity.inventory_sha256 = "0".repeat(64);
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "native-identity" => {
                    manifest.native.abi = 2;
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "raster-resvg-identity" => {
                    manifest.raster.version = "wrong".to_owned();
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "file-ordering" => {
                    manifest.files.swap(0, 1);
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "file-collision" => {
                    let collision = manifest.files[0].path.to_ascii_uppercase();
                    manifest.files[1].path = collision;
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "totals" => {
                    manifest.totals.bytes += 1;
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "inventory-digest" => {
                    manifest.totals.inventory_digest = "0".repeat(64);
                    write_closed_manifest(&payload, &mut manifest, false)?;
                }
                "actual-input-digest" => {
                    manifest.source.actual_input_digest = "0".repeat(64);
                    write_closed_manifest(&payload, &mut manifest, true)?;
                }
                "missing-file" => fs::remove_file(payload.join(&first_path))?,
                "extra-file" => fs::write(payload.join("extra"), b"extra")?,
                "tampered-file" => fs::write(payload.join(&first_path), b"tampered")?,
                "mode-and-size" => {
                    let path = payload.join(&first_path);
                    let mut permissions = fs::metadata(&path)?.permissions();
                    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o600);
                    fs::set_permissions(path, permissions)?;
                }
                "symlink-or-special" => {
                    std::os::unix::fs::symlink(&first_path, payload.join("injected-link"))?
                }
                "required-consequence-file" => {
                    fs::remove_file(payload.join(super::ENTRYPOINT))?;
                }
                _ => return Err(io::Error::other("unknown shared verifier vector")),
            }
            let accepted = verify_distribution(&binary, &payload).is_ok();
            if accepted != vector.accept {
                return Err(io::Error::other(format!(
                    "shared verifier vector disagreed: {}",
                    vector.name
                )));
            }
            fs::remove_dir_all(root)?;
        }
        Ok(())
    }
}
