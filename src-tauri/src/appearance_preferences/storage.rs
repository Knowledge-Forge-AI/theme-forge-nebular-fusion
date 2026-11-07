use std::fmt;
use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::platform::{O_NOFOLLOW, O_NONBLOCK};

pub(crate) const MAX_BYTES: usize = 4 * 1024;
pub(crate) const FILE_NAME: &str = "appearance.json";
pub(crate) const TEMP_FILE_PREFIX: &str = ".nebular-appearance-tmp-";

const TEMP_CREATE_ATTEMPTS: u64 = 64;
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StorageError {
    RootUnavailable,
    RootUnsafe,
    DestinationUnavailable,
    DestinationUnsafe,
    Oversize,
    ReadFailed,
    TemporaryCreateFailed,
    TemporaryWriteFailed,
    TemporarySyncFailed,
    CommitFailed,
}

impl StorageError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::RootUnavailable => "root-unavailable",
            Self::RootUnsafe => "root-rejected",
            Self::DestinationUnavailable => "destination-unavailable",
            Self::DestinationUnsafe => "destination-rejected",
            Self::Oversize => "oversize",
            Self::ReadFailed => "read-failed",
            Self::TemporaryCreateFailed => "temporary-create-failed",
            Self::TemporaryWriteFailed => "temporary-write-failed",
            Self::TemporarySyncFailed => "temporary-sync-failed",
            Self::CommitFailed => "commit-failed",
        }
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for StorageError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DestinationState {
    Missing,
    Regular,
}

struct OwnedTemporary {
    path: PathBuf,
    file: File,
    identity: Option<FileIdentity>,
}

fn validate_root(root: &Path) -> Result<(), StorageError> {
    let metadata = fs::symlink_metadata(root).map_err(|_| StorageError::RootUnavailable)?;
    let file_type = metadata.file_type();
    if file_type.is_symlink() || !file_type.is_dir() {
        return Err(StorageError::RootUnsafe);
    }
    Ok(())
}

pub(crate) fn ensure_root(root: &Path) -> Result<(), StorageError> {
    match fs::symlink_metadata(root) {
        Ok(_) => validate_root(root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(root).map_err(|_| StorageError::RootUnavailable)?;
            validate_root(root)
        }
        Err(_) => Err(StorageError::RootUnavailable),
    }
}

fn destination_path(root: &Path) -> PathBuf {
    root.join(FILE_NAME)
}

fn inspect_destination(path: &Path) -> Result<DestinationState, StorageError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            if file_type.is_symlink() || !file_type.is_file() {
                return Err(StorageError::DestinationUnsafe);
            }
            Ok(DestinationState::Regular)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(DestinationState::Missing),
        Err(_) => Err(StorageError::DestinationUnavailable),
    }
}

fn open_destination_for_read(path: &Path) -> Result<File, StorageError> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        options.custom_flags(O_NOFOLLOW | O_NONBLOCK);
    }
    options.open(path).map_err(|_| StorageError::ReadFailed)
}

pub(crate) fn read_bytes(root: &Path) -> Result<Option<Vec<u8>>, StorageError> {
    validate_root(root)?;
    let path = destination_path(root);
    if inspect_destination(&path)? == DestinationState::Missing {
        return Ok(None);
    }

    let file = open_destination_for_read(&path)?;
    let metadata = file.metadata().map_err(|_| StorageError::ReadFailed)?;
    if !metadata.file_type().is_file() {
        return Err(StorageError::DestinationUnsafe);
    }
    if metadata.len() > MAX_BYTES as u64 {
        return Err(StorageError::Oversize);
    }

    let mut bounded = file.take(MAX_BYTES as u64 + 1);
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    bounded
        .read_to_end(&mut bytes)
        .map_err(|_| StorageError::ReadFailed)?;
    if bytes.len() > MAX_BYTES {
        return Err(StorageError::Oversize);
    }
    Ok(Some(bytes))
}

#[cfg(unix)]
fn identity_from_metadata(metadata: &Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;

    FileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    }
}

#[cfg(not(unix))]
fn identity_from_metadata(_: &Metadata) -> FileIdentity {
    FileIdentity {
        device: 0,
        inode: 0,
    }
}

fn identity_from_file(file: &File) -> Option<FileIdentity> {
    file.metadata()
        .ok()
        .map(|metadata| identity_from_metadata(&metadata))
}

fn remove_owned_temporary(path: &Path, identity: Option<FileIdentity>) {
    let Some(identity) = identity else {
        return;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return;
    };
    if metadata.file_type().is_file() && identity_from_metadata(&metadata) == identity {
        let _ = fs::remove_file(path);
    }
}

fn temporary_matches_identity(path: &Path, identity: Option<FileIdentity>) -> bool {
    let Some(identity) = identity else {
        return false;
    };
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    metadata.file_type().is_file() && identity_from_metadata(&metadata) == identity
}

fn cleanup_temporary(temporary: OwnedTemporary) {
    let OwnedTemporary {
        path,
        file,
        identity,
    } = temporary;
    drop(file);
    remove_owned_temporary(&path, identity);
}

fn create_temporary(root: &Path) -> Result<OwnedTemporary, StorageError> {
    for _ in 0..TEMP_CREATE_ATTEMPTS {
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = root.join(format!(
            "{TEMP_FILE_PREFIX}{}-{sequence}.tmp",
            std::process::id()
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;

            options.custom_flags(O_NOFOLLOW).mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                let identity = identity_from_file(&file);
                return Ok(OwnedTemporary {
                    path,
                    file,
                    identity,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(StorageError::TemporaryCreateFailed),
        }
    }
    Err(StorageError::TemporaryCreateFailed)
}

pub(crate) fn save_bytes(root: &Path, bytes: &[u8]) -> Result<(), StorageError> {
    save_bytes_impl(root, bytes, |_| {})
}

fn save_bytes_impl<F>(root: &Path, bytes: &[u8], before_rename: F) -> Result<(), StorageError>
where
    F: FnOnce(&Path),
{
    if bytes.len() > MAX_BYTES {
        return Err(StorageError::Oversize);
    }
    validate_root(root)?;
    let path = destination_path(root);
    inspect_destination(&path)?;

    let mut temporary = create_temporary(root)?;
    if temporary.file.write_all(bytes).is_err() {
        cleanup_temporary(temporary);
        return Err(StorageError::TemporaryWriteFailed);
    }
    if temporary.file.sync_all().is_err() {
        cleanup_temporary(temporary);
        return Err(StorageError::TemporarySyncFailed);
    }

    let OwnedTemporary {
        path: temporary_path,
        file,
        identity,
    } = temporary;
    drop(file);

    before_rename(&temporary_path);
    if !temporary_matches_identity(&temporary_path, identity) {
        remove_owned_temporary(&temporary_path, identity);
        return Err(StorageError::CommitFailed);
    }
    if let Err(error) = inspect_destination(&path) {
        remove_owned_temporary(&temporary_path, identity);
        return Err(error);
    }
    if fs::rename(&temporary_path, &path).is_err() {
        remove_owned_temporary(&temporary_path, identity);
        return Err(StorageError::CommitFailed);
    }
    Ok(())
}

#[cfg(test)]
pub(crate) fn save_bytes_with_before_rename_hook<F>(
    root: &Path,
    bytes: &[u8],
    before_rename: F,
) -> Result<(), StorageError>
where
    F: FnOnce(&Path),
{
    save_bytes_impl(root, bytes, before_rename)
}

#[cfg(test)]
mod tests {
    use super::{TEMP_SEQUENCE, save_bytes_with_before_rename_hook};
    use std::fs;

    #[test]
    fn before_rename_hook_is_used_by_the_product_commit_path()
    -> Result<(), Box<dyn std::error::Error>> {
        let root = std::env::temp_dir().join(format!(
            "nebular-storage-hook-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        fs::create_dir(&root)?;
        let mut called = false;
        save_bytes_with_before_rename_hook(&root, br#"{}"#, |_| {
            called = true;
        })?;
        assert!(called);
        fs::remove_dir_all(root)?;
        Ok(())
    }
}
