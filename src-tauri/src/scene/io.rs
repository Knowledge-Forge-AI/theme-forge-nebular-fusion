use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

pub const MAX_SCENE_FILE_BYTES: usize = 8 * 1024 * 1024; // 8 MiB
pub const MAX_SVG_FILE_BYTES: usize = 8 * 1024 * 1024; // 8 MiB
pub const MAX_PACKET_FILE_BYTES: usize = 16 * 1024 * 1024; // 16 MiB

fn rejected<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::SelectionRejected))
}

pub fn validate_suggested_name(name: &str) -> StudioResult<()> {
    if name.is_empty()
        || name.len() > 255
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c == '/' || c == '\\' || c == ':' || c.is_control())
    {
        return rejected();
    }
    Ok(())
}

pub fn display_name(path: &Path) -> Option<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| name.len() <= 255 && !name.chars().any(char::is_control))
        .map(str::to_owned)
}

pub fn selected_source_id(path: &Path) -> StudioResult<String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return rejected();
    }
    let identity = format!(
        "{}:{}:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime(),
        metadata.mtime_nsec()
    );
    Ok(format!(
        "scene-source-{}",
        super::session::compute_sha256(identity.as_bytes())
    ))
}

pub fn file_identity(metadata: &fs::Metadata) -> (u64, u64, u64, u64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime() as u64,
    )
}

pub fn directory_identity(metadata: &fs::Metadata) -> (u64, u64) {
    (metadata.dev(), metadata.ino())
}

fn authenticate_canonical_ancestry(path: &Path) -> StudioResult<()> {
    let mut current = path
        .parent()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    loop {
        let metadata = fs::symlink_metadata(current)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return rejected();
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent,
            _ => break,
        }
    }
    Ok(())
}

pub fn get_parent_identity(path: &Path) -> StudioResult<(u64, u64)> {
    let parent = path
        .parent()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let parent_metadata = fs::metadata(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !parent_metadata.is_dir() {
        return rejected();
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    authenticate_canonical_ancestry(&canonical_parent.join("leaf"))?;

    let canonical_parent_metadata = fs::symlink_metadata(&canonical_parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !canonical_parent_metadata.is_dir()
        || directory_identity(&parent_metadata) != directory_identity(&canonical_parent_metadata)
    {
        return rejected();
    }
    Ok(directory_identity(&canonical_parent_metadata))
}

pub fn validate_parent_identity(path: &Path, expected_identity: (u64, u64)) -> StudioResult<()> {
    let current_identity = get_parent_identity(path)?;
    if current_identity != expected_identity {
        return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
    }
    Ok(())
}

pub fn read_selected_bytes(path: &Path, max_bytes: usize) -> StudioResult<Vec<u8>> {
    let parent = path
        .parent()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let parent_metadata = fs::metadata(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !parent_metadata.is_dir() {
        return rejected();
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    authenticate_canonical_ancestry(&canonical_parent.join("leaf"))?;

    let symlink_metadata = fs::symlink_metadata(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if symlink_metadata.file_type().is_symlink() || !symlink_metadata.is_file() {
        return rejected();
    }
    let file_len = symlink_metadata.len() as usize;
    if file_len > max_bytes {
        return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
    }

    let mut file = File::open(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let opened_metadata = file
        .metadata()
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if opened_metadata.file_type().is_symlink() || !opened_metadata.is_file() {
        return rejected();
    }
    if directory_identity(&symlink_metadata) != directory_identity(&opened_metadata) {
        return rejected();
    }
    if opened_metadata.len() != symlink_metadata.len() {
        return rejected();
    }
    let opened_len = opened_metadata.len() as usize;
    if opened_len > max_bytes {
        return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
    }

    let mut buffer = Vec::with_capacity(opened_len.min(max_bytes));
    (&mut file)
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut buffer)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;

    if buffer.len() != opened_len || buffer.len() > max_bytes {
        return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
    }

    let symlink_after = fs::symlink_metadata(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let after_read = file
        .metadata()
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if (
        after_read.mtime(),
        after_read.mtime_nsec(),
        after_read.ctime(),
        after_read.ctime_nsec(),
    ) != (
        opened_metadata.mtime(),
        opened_metadata.mtime_nsec(),
        opened_metadata.ctime(),
        opened_metadata.ctime_nsec(),
    ) || directory_identity(&symlink_after) != directory_identity(&opened_metadata)
        || symlink_after.len() != opened_metadata.len()
    {
        return rejected();
    }

    Ok(buffer)
}

fn stage_candidate_path(parent: &Path, attempt: u32) -> PathBuf {
    parent.join(format!(
        ".tfsb-scene-stage-{}-{}-{}",
        std::process::id(),
        attempt,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ))
}

fn safe_remove_if_identity_matches(
    target: &Path,
    expected_identity: (u64, u64, u64, u64),
) -> StudioResult<()> {
    let meta = fs::symlink_metadata(target)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))?;
    if meta.file_type().is_symlink() || file_identity(&meta) != expected_identity {
        return Err(StudioCommandError::new(StudioReasonCode::DomainFailed));
    }
    fs::remove_file(target).map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))
}

/// Transactional, absent-only atomic publication:
/// 1. Verifies parent directory exists and ancestry is non-symlink
/// 2. Verifies destination is absent (no existing file)
/// 3. Stages bytes into an exclusive temporary file in the same parent directory
/// 4. Syncs stage file, revalidates parent identity
/// 5. Hard-links stage file to canonical destination
/// 6. Revalidates destination identity against stage file
/// 7. Syncs parent directory and cleans up stage file (ownership-checked)
pub fn publish_absent_only_bytes(path: &Path, bytes: &[u8]) -> StudioResult<usize> {
    publish_with_hook(path, bytes, &mut |_, _, _| Ok(()))
}

fn publish_with_hook(
    path: &Path,
    bytes: &[u8],
    hook: &mut dyn FnMut(&str, &Path, &Path) -> StudioResult<()>,
) -> StudioResult<usize> {
    let parent = path
        .parent()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let parent_before = fs::metadata(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !parent_before.is_dir() {
        return rejected();
    }

    // Destination must be absent
    match fs::symlink_metadata(path) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        _ => return rejected(),
    }

    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    authenticate_canonical_ancestry(&canonical_parent.join("leaf"))?;

    let canonical_parent_before = fs::symlink_metadata(&canonical_parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !canonical_parent_before.is_dir()
        || directory_identity(&parent_before) != directory_identity(&canonical_parent_before)
    {
        return rejected();
    }

    let retained_parent = File::open(&canonical_parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let retained_before = retained_parent
        .metadata()
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if directory_identity(&retained_before) != directory_identity(&canonical_parent_before) {
        return rejected();
    }

    let file_name = path
        .file_name()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let canonical_target = canonical_parent.join(file_name);

    match fs::symlink_metadata(&canonical_target) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        _ => return rejected(),
    }

    let mut stage = None;
    for attempt in 0..16 {
        let candidate = stage_candidate_path(&canonical_parent, attempt);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                stage = Some((candidate, file));
                break;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return rejected(),
        }
    }

    let Some((stage_path, mut stage_file)) = stage else {
        return rejected();
    };

    let publish_result = (|| {
        hook("stage-created", &stage_path, &canonical_target)?;
        stage_file
            .write_all(bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        hook("before-sync", &stage_path, &canonical_target)?;
        stage_file
            .sync_all()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;

        hook("before-publish", &stage_path, &canonical_target)?;
        let parent_after = fs::metadata(parent)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let canonical_parent_after = fs::symlink_metadata(&canonical_parent)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let retained_after = retained_parent
            .metadata()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;

        if directory_identity(&parent_before) != directory_identity(&parent_after)
            || directory_identity(&canonical_parent_before)
                != directory_identity(&canonical_parent_after)
            || directory_identity(&retained_before) != directory_identity(&retained_after)
            || directory_identity(&parent_after) != directory_identity(&canonical_parent_after)
        {
            return rejected();
        }

        let stage_metadata = stage_file
            .metadata()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let s_identity = file_identity(&stage_metadata);

        fs::hard_link(&stage_path, &canonical_target)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;

        let published_metadata = fs::symlink_metadata(&canonical_target)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;

        if file_identity(&published_metadata) != s_identity || retained_parent.sync_all().is_err() {
            safe_remove_if_identity_matches(&canonical_target, s_identity)?;
            return rejected();
        }

        Ok(bytes.len())
    })();

    let cleanup_identity = stage_file
        .metadata()
        .map(|m| file_identity(&m))
        .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))?;
    drop(stage_file);
    safe_remove_if_identity_matches(&stage_path, cleanup_identity)?;
    retained_parent
        .sync_all()
        .map_err(|_| StudioCommandError::new(StudioReasonCode::DomainFailed))?;
    publish_result
}

#[cfg(test)]
mod fault_tests {
    use super::*;
    #[test]
    fn publication_faults_preserve_concurrent_targets_and_owned_cleanup()
    -> Result<(), Box<dyn std::error::Error>> {
        for fault in [
            "stage-created",
            "before-sync",
            "target-appears",
            "symlink-appears",
            "parent-replaced",
        ] {
            let root = std::env::temp_dir().join(format!(
                "scene-io-fault-{}-{}",
                std::process::id(),
                fault
            ));
            fs::create_dir(&root)?;
            let parent = root.join("parent");
            fs::create_dir(&parent)?;
            let target = parent.join("scene.svg");
            let result = publish_with_hook(
                &target,
                b"safe compiled bytes",
                &mut |stage, _, destination| {
                    if stage == fault {
                        return Err(StudioCommandError::new(StudioReasonCode::DomainFailed));
                    }
                    if stage == "before-publish" {
                        match fault {
                            "target-appears" => {
                                fs::write(destination, b"concurrent").map_err(|_| {
                                    StudioCommandError::new(StudioReasonCode::DomainFailed)
                                })?
                            }
                            "symlink-appears" => {
                                std::os::unix::fs::symlink("unrelated", destination).map_err(
                                    |_| StudioCommandError::new(StudioReasonCode::DomainFailed),
                                )?
                            }
                            "parent-replaced" => {
                                fs::rename(&parent, root.join("retained-parent")).map_err(
                                    |_| StudioCommandError::new(StudioReasonCode::DomainFailed),
                                )?;
                                fs::create_dir(&parent).map_err(|_| {
                                    StudioCommandError::new(StudioReasonCode::DomainFailed)
                                })?;
                                fs::write(destination, b"concurrent").map_err(|_| {
                                    StudioCommandError::new(StudioReasonCode::DomainFailed)
                                })?;
                            }
                            _ => {}
                        }
                    }
                    Ok(())
                },
            );
            assert!(result.is_err());
            if fault == "target-appears" || fault == "parent-replaced" {
                assert_eq!(fs::read(&target)?, b"concurrent");
            } else if fault == "symlink-appears" {
                assert!(fs::symlink_metadata(&target)?.file_type().is_symlink());
            } else {
                assert!(!target.exists());
                assert_eq!(fs::read_dir(&parent)?.count(), 0);
            }
            fs::remove_dir_all(&root)?;
        }
        Ok(())
    }
}
