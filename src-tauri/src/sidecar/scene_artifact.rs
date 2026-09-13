//! Independently compiled scene payload pins; no manifest self-authentication.
use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

#[derive(Deserialize)]
struct Binding {
    node: Runtime,
    files: Vec<Member>,
}
#[derive(Deserialize)]
struct Runtime {
    sha256: String,
    bytes: u64,
}
#[derive(Deserialize)]
struct Member {
    path: String,
    sha256: String,
    bytes: u64,
}

fn invalid() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable)
}

fn authenticate_file(path: &Path, bytes: u64, digest: &str) -> StudioResult<()> {
    let before = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !before.is_file() || before.file_type().is_symlink() || before.len() != bytes {
        return Err(invalid());
    }
    let mut file = fs::File::open(path).map_err(|_| invalid())?;
    let opened = file.metadata().map_err(|_| invalid())?;
    if (before.dev(), before.ino(), before.len()) != (opened.dev(), opened.ino(), opened.len()) {
        return Err(invalid());
    }
    let mut hasher = Sha256::new();
    let count =
        std::io::copy(&mut file.by_ref().take(bytes + 1), &mut hasher).map_err(|_| invalid())?;
    let after = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if (after.dev(), after.ino(), after.len()) != (opened.dev(), opened.ino(), opened.len())
        || count != bytes
        || !after.is_file()
        || after.file_type().is_symlink()
        || before.modified().ok() != after.modified().ok()
        || format!("{:x}", hasher.finalize()) != digest
    {
        return Err(invalid());
    }
    Ok(())
}

fn inventory(root: &Path, directory: &Path, files: &mut BTreeSet<String>) -> StudioResult<()> {
    inventory_bounded(root, directory, files, 256)
}

fn inventory_bounded(
    root: &Path,
    directory: &Path,
    files: &mut BTreeSet<String>,
    limit: usize,
) -> StudioResult<()> {
    if files.len() > limit {
        return Err(invalid());
    }
    for entry in fs::read_dir(directory).map_err(|_| invalid())? {
        let entry = entry.map_err(|_| invalid())?;
        let kind = entry.file_type().map_err(|_| invalid())?;
        let path = entry.path();
        if kind.is_dir() {
            inventory_bounded(root, &path, files, limit)?;
        } else if kind.is_file() {
            let name = path
                .strip_prefix(root)
                .map_err(|_| invalid())?
                .to_str()
                .ok_or_else(invalid)?
                .to_owned();
            files.insert(name);
        } else {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn verify(node: &Path, adapter: &Path) -> StudioResult<()> {
    let binding: Binding = serde_json::from_str(include_str!(
        "../../../protocol/scene-workbench-v1/payload-binding.json"
    ))
    .map_err(|_| invalid())?;
    let root = adapter
        .parent()
        .and_then(Path::parent)
        .ok_or_else(invalid)?;
    if adapter != root.join("bin/scene-batch.js") {
        return Err(invalid());
    }
    for ancestor in root.ancestors() {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| invalid())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(invalid());
        }
    }
    authenticate_file(node, binding.node.bytes, &binding.node.sha256)?;
    let mut actual = BTreeSet::new();
    inventory(root, root, &mut actual)?;
    let expected: BTreeSet<_> = binding.files.iter().map(|m| m.path.clone()).collect();
    if actual != expected || expected.len() != binding.files.len() {
        return Err(invalid());
    }
    for member in binding.files {
        if member.bytes > 8 * 1024 * 1024
            || Path::new(&member.path)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err(invalid());
        }
        authenticate_file(&root.join(member.path), member.bytes, &member.sha256)?;
    }
    Ok(())
}

pub(crate) const THEME_ADAPTER_BYTES: &[u8] =
    include_bytes!("../../loom-adapter/theme-adapter.mjs");

pub(crate) fn authenticate_theme_adapter(path: &Path) -> StudioResult<()> {
    for ancestor in path.ancestors().skip(1) {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| invalid())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(invalid());
        }
    }
    let digest = format!("{:x}", Sha256::digest(THEME_ADAPTER_BYTES));
    authenticate_file(path, THEME_ADAPTER_BYTES.len() as u64, &digest)
}

/// Authenticate the separately pinned Loom payload without requiring Burst resources.
pub(crate) fn authenticate_theme_payload(node: &Path, adapter: &Path) -> StudioResult<()> {
    let binding: Binding = serde_json::from_str(include_str!(
        "../../../protocol/theme-lab-v2/payload-binding.json"
    ))
    .map_err(|_| invalid())?;
    let root = adapter
        .parent()
        .and_then(Path::parent)
        .ok_or_else(invalid)?;
    if adapter != root.join("bin/tfsl-batch.js") {
        return Err(invalid());
    }
    for ancestor in root.ancestors() {
        let meta = fs::symlink_metadata(ancestor).map_err(|_| invalid())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(invalid());
        }
    }
    authenticate_file(node, binding.node.bytes, &binding.node.sha256)?;
    // Check the fixed package inventory, including declarations and non-executable resources.
    let mut actual = BTreeSet::new();
    inventory_bounded(root, root, &mut actual, 512)?;
    let expected: BTreeSet<_> = binding.files.iter().map(|m| m.path.clone()).collect();
    if actual != expected || expected.len() != binding.files.len() {
        return Err(invalid());
    }
    for member in binding.files {
        if member.bytes > 8 * 1024 * 1024
            || Path::new(&member.path)
                .components()
                .any(|p| !matches!(p, Component::Normal(_)))
        {
            return Err(invalid());
        }
        authenticate_file(&root.join(member.path), member.bytes, &member.sha256)?;
    }
    Ok(())
}
