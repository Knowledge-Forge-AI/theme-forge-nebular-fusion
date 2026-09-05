use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

use super::types::{DesignEvidencePacket, ExpectedPacketKind};
use super::validate::{MAX_PACKET_BYTES, canonical_packet_bytes, parse_packet_bytes};

#[derive(Clone, Copy, PartialEq, Eq)]
enum IoFault {
    Open,
    Read,
    Stage,
    Write,
    Sync,
    Revalidate,
    #[cfg(test)]
    ReplaceParentBeforeRevalidate,
    Link,
    Cleanup,
}

#[cfg(test)]
thread_local! {
    static INJECTED_FAULT: std::cell::Cell<Option<IoFault>> = const { std::cell::Cell::new(None) };
}

#[cfg(test)]
fn injected(point: IoFault) -> bool {
    INJECTED_FAULT.with(|fault| fault.get() == Some(point))
}

#[cfg(not(test))]
fn injected(_point: IoFault) -> bool {
    false
}

#[cfg(test)]
fn replace_parent_before_revalidate(
    parent: &Path,
    canonical_parent: &Path,
    target_name: &std::ffi::OsStr,
) {
    if !injected(IoFault::ReplaceParentBeforeRevalidate) {
        return;
    }
    let displaced = parent.with_extension("displaced-by-race");
    let _ = fs::remove_dir_all(&displaced);
    if fs::rename(canonical_parent, &displaced).is_ok() && fs::create_dir(canonical_parent).is_ok()
    {
        let _ = fs::write(canonical_parent.join("unowned.txt"), b"unowned");
        let _ = fs::write(canonical_parent.join(target_name), b"concurrent");
    }
}

#[cfg(not(test))]
fn replace_parent_before_revalidate(
    _parent: &Path,
    _canonical_parent: &Path,
    _target_name: &std::ffi::OsStr,
) {
}

pub(crate) struct ImportedPacket {
    pub(crate) packet: DesignEvidencePacket,
    pub(crate) byte_count: usize,
}

fn rejected<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::SelectionRejected))
}

fn protocol_invalid<T>() -> StudioResult<T> {
    Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid))
}

fn identity(metadata: &fs::Metadata) -> (u64, u64, u64, u64) {
    (
        metadata.dev(),
        metadata.ino(),
        metadata.len(),
        metadata.mtime() as u64,
    )
}

fn directory_identity(metadata: &fs::Metadata) -> (u64, u64) {
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
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
    }
    Ok(())
}

pub(crate) fn import_packet(
    path: &Path,
    expected: ExpectedPacketKind,
) -> StudioResult<ImportedPacket> {
    let before = fs::symlink_metadata(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if before.file_type().is_symlink()
        || !before.is_file()
        || before.len() > MAX_PACKET_BYTES as u64
    {
        return rejected();
    }
    let canonical = fs::canonicalize(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    authenticate_canonical_ancestry(&canonical)?;
    let canonical_before = fs::symlink_metadata(&canonical)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if canonical_before.file_type().is_symlink()
        || !canonical_before.is_file()
        || identity(&before) != identity(&canonical_before)
    {
        return rejected();
    }
    if injected(IoFault::Open) {
        return rejected();
    }
    let mut file = File::open(&canonical)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let opened = file
        .metadata()
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !opened.is_file() || identity(&before) != identity(&opened) {
        return rejected();
    }
    let capacity = usize::try_from(opened.len())
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let mut bytes = Vec::with_capacity(capacity);
    if injected(IoFault::Read) {
        return rejected();
    }
    Read::by_ref(&mut file)
        .take((MAX_PACKET_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if bytes.len() > MAX_PACKET_BYTES {
        return rejected();
    }
    if injected(IoFault::Revalidate) {
        return rejected();
    }
    let after = fs::symlink_metadata(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let canonical_after = fs::symlink_metadata(&canonical)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let opened_after = file
        .metadata()
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if identity(&before) != identity(&after)
        || identity(&canonical_before) != identity(&canonical_after)
        || identity(&opened) != identity(&opened_after)
        || identity(&after) != identity(&canonical_after)
    {
        return rejected();
    }
    let byte_count = bytes.len();
    let packet = parse_packet_bytes(&bytes)?;
    bytes.fill(0);
    if !expected.accepts(packet.kind()) {
        return protocol_invalid();
    }
    Ok(ImportedPacket { packet, byte_count })
}

fn stage_path(parent: &Path, attempt: u8) -> PathBuf {
    parent.join(format!(
        ".tfsb-packet-stage-{}-{attempt}",
        std::process::id()
    ))
}

pub(crate) fn export_packet(path: &Path, packet: &DesignEvidencePacket) -> StudioResult<usize> {
    let parent = path
        .parent()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let parent_before = fs::metadata(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !parent_before.is_dir() {
        return rejected();
    }
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return rejected(),
    }
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    authenticate_canonical_ancestry(&canonical_parent.join("packet-leaf"))?;
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
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        _ => return rejected(),
    }
    let bytes = canonical_packet_bytes(packet)?;
    let mut stage = None;
    for attempt in 0..16 {
        if injected(IoFault::Stage) {
            return rejected();
        }
        let candidate = stage_path(&canonical_parent, attempt);
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(file) => {
                stage = Some((candidate, file));
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return rejected(),
        }
    }
    let Some((stage_path, mut stage_file)) = stage else {
        return rejected();
    };
    let result = (|| {
        if injected(IoFault::Write) {
            return rejected();
        }
        stage_file
            .write_all(&bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        if injected(IoFault::Sync) {
            return rejected();
        }
        stage_file
            .sync_all()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        replace_parent_before_revalidate(parent, &canonical_parent, file_name);
        if injected(IoFault::Revalidate) {
            return rejected();
        }
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
        if injected(IoFault::Link) {
            return rejected();
        }
        fs::hard_link(&stage_path, &canonical_target)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let published = fs::symlink_metadata(&canonical_target)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let staged = stage_file
            .metadata()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        if identity(&published) != identity(&staged) || retained_parent.sync_all().is_err() {
            let _ = fs::remove_file(&canonical_target);
            return rejected();
        }
        Ok(bytes.len())
    })();
    drop(stage_file);
    if injected(IoFault::Cleanup) || fs::remove_file(&stage_path).is_err() {
        if result.is_ok() {
            let _ = fs::remove_file(&canonical_target);
            let _ = retained_parent.sync_all();
        }
        return rejected();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("tfsb-design-packet-{}-{name}", std::process::id()))
    }

    fn with_fault<T>(fault: IoFault, operation: impl FnOnce() -> T) -> T {
        INJECTED_FAULT.with(|injected| injected.set(Some(fault)));
        let result = operation();
        INJECTED_FAULT.with(|injected| injected.set(None));
        result
    }

    #[test]
    fn import_and_absent_only_export_round_trip() {
        let directory = fixture_path("round-trip");
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());
        let source = directory.join("brief.tfsb-brief.json");
        assert!(
            fs::write(
                &source,
                include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
            )
            .is_ok()
        );
        let imported = import_packet(&source, ExpectedPacketKind::Brief);
        assert!(imported.is_ok());
        let target = directory.join("copy.tfsb-brief.json");
        if let Ok(imported) = imported {
            assert_eq!(
                imported.byte_count,
                include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
                    .len()
            );
            assert!(export_packet(&target, &imported.packet).is_ok());
            assert!(export_packet(&target, &imported.packet).is_err());
        }
        assert!(fs::remove_dir_all(directory).is_ok());
    }

    #[test]
    fn macos_temporary_aliases_and_canonical_paths_are_accepted() {
        let directory = fixture_path("aliases");
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());
        let source = directory.join("brief.tfsb-brief.json");
        assert!(
            fs::write(
                &source,
                include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
            )
            .is_ok()
        );
        let canonical = fs::canonicalize(&source);
        assert!(canonical.is_ok());
        assert!(import_packet(&source, ExpectedPacketKind::Brief).is_ok());
        if let Ok(canonical) = canonical {
            assert!(import_packet(&canonical, ExpectedPacketKind::Brief).is_ok());
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn literal_tmp_alias_and_canonical_paths_are_accepted() {
        let directory = std::path::PathBuf::from("/tmp").join(format!(
            "tfsb-design-packet-{}-literal-tmp",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());
        let source = directory.join("brief.tfsb-brief.json");
        assert!(
            fs::write(
                &source,
                include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
            )
            .is_ok()
        );
        let canonical = fs::canonicalize(&source);
        assert!(canonical.is_ok());
        assert!(import_packet(&source, ExpectedPacketKind::Brief).is_ok());
        if let Ok(canonical) = canonical {
            assert!(import_packet(&canonical, ExpectedPacketKind::Brief).is_ok());
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[cfg(unix)]
    #[test]
    fn final_leaf_symlinks_are_rejected() {
        use std::os::unix::fs::symlink;

        let directory = fixture_path("leaf-symlink");
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());
        let source = directory.join("brief.tfsb-brief.json");
        let alias = directory.join("alias.tfsb-brief.json");
        assert!(
            fs::write(
                &source,
                include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
            )
            .is_ok()
        );
        assert!(symlink(&source, &alias).is_ok());
        assert!(import_packet(&alias, ExpectedPacketKind::Brief).is_err());
        let imported = import_packet(&source, ExpectedPacketKind::Brief);
        assert!(imported.is_ok());
        if let Ok(imported) = imported {
            assert!(export_packet(&alias, &imported.packet).is_err());
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn injected_import_and_export_faults_fail_closed() {
        let directory = fixture_path("faults");
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());
        let source = directory.join("brief.tfsb-brief.json");
        assert!(
            fs::write(
                &source,
                include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
            )
            .is_ok()
        );
        for fault in [IoFault::Open, IoFault::Read, IoFault::Revalidate] {
            assert!(
                with_fault(fault, || import_packet(&source, ExpectedPacketKind::Brief)).is_err()
            );
        }
        let imported = import_packet(&source, ExpectedPacketKind::Brief);
        assert!(imported.is_ok());
        if let Ok(imported) = imported {
            for (index, fault) in [
                IoFault::Stage,
                IoFault::Write,
                IoFault::Sync,
                IoFault::Revalidate,
                IoFault::Link,
                IoFault::Cleanup,
            ]
            .into_iter()
            .enumerate()
            {
                let target = directory.join(format!("fault-{index}.tfsb-brief.json"));
                assert!(with_fault(fault, || export_packet(&target, &imported.packet)).is_err());
                assert!(!target.exists());
            }
            let concurrent = directory.join("concurrent.tfsb-brief.json");
            assert!(fs::write(&concurrent, b"owned").is_ok());
            assert!(export_packet(&concurrent, &imported.packet).is_err());
            assert_eq!(
                fs::read(&concurrent).ok().as_deref(),
                Some(b"owned".as_slice())
            );
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn actual_parent_replacement_race_preserves_replacement_and_concurrent_target() {
        let directory = fixture_path("parent-replacement");
        let displaced = directory.with_extension("displaced-by-race");
        let _ = fs::remove_dir_all(&directory);
        let _ = fs::remove_dir_all(&displaced);
        assert!(fs::create_dir(&directory).is_ok());
        let source = directory.join("brief.tfsb-brief.json");
        assert!(
            fs::write(
                &source,
                include_bytes!("../../../protocol/tfsb-design-evidence-v1/examples/brief.json")
            )
            .is_ok()
        );
        let imported = import_packet(&source, ExpectedPacketKind::Brief);
        assert!(imported.is_ok());
        if let Ok(imported) = imported {
            let target = directory.join("race.tfsb-brief.json");
            let result = with_fault(IoFault::ReplaceParentBeforeRevalidate, || {
                export_packet(&target, &imported.packet)
            });
            assert!(result.is_err());
            assert_eq!(
                fs::read(directory.join("unowned.txt")).ok().as_deref(),
                Some(b"unowned".as_slice())
            );
            assert_eq!(
                fs::read(&target).ok().as_deref(),
                Some(b"concurrent".as_slice())
            );
            assert!(fs::read_dir(&directory).is_ok_and(|entries| {
                entries.filter_map(Result::ok).all(|entry| {
                    !entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".tfsb-packet-stage-")
                })
            }));
            assert!(displaced.is_dir());
            assert!(fs::read_dir(&displaced).is_ok_and(|entries| {
                entries.filter_map(Result::ok).any(|entry| {
                    entry
                        .file_name()
                        .to_string_lossy()
                        .starts_with(".tfsb-packet-stage-")
                })
            }));
        }
        let _ = fs::remove_dir_all(&directory);
        let _ = fs::remove_dir_all(&displaced);
    }
}
