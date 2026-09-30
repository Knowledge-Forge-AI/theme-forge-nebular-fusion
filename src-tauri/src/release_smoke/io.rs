//! The only filesystem authority of the release smoke mode. It validates the harness-created smoke
//! directory, resolves compiled-in fixture selections strictly inside it, measures the running
//! executable, and creates the receipt exclusively. Nothing outside the smoke directory is written.

use std::fs::{self, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

pub(super) const RECEIPT_NAME: &str = "receipt.json";

/// The smoke directory must be an existing, owner-only (0700) real directory whose canonical path
/// lies inside the canonical temporary directory. Returns its canonical path.
pub(super) fn validated_directory(path: &Path) -> Result<PathBuf, &'static str> {
    if !path.is_absolute() {
        return Err("smoke directory must be absolute");
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| "smoke directory is missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("smoke directory must be a real directory");
    }
    if metadata.permissions().mode() & 0o077 != 0 {
        return Err("smoke directory must be owner-only");
    }
    let canonical = fs::canonicalize(path).map_err(|_| "smoke directory cannot be resolved")?;
    let temp = fs::canonicalize(std::env::temp_dir())
        .map_err(|_| "temporary directory cannot be resolved")?;
    if canonical == temp || !canonical.starts_with(&temp) {
        return Err("smoke directory must be inside the temporary directory");
    }
    if canonical.join(RECEIPT_NAME).exists()
        || fs::symlink_metadata(canonical.join(RECEIPT_NAME)).is_ok()
    {
        return Err("smoke directory already holds a receipt");
    }
    Ok(canonical)
}

/// Resolves a compiled-in relative selection to an existing directory strictly inside `root`.
pub(super) fn contained_directory(root: &Path, relative: &str) -> Option<PathBuf> {
    let candidate = fs::canonicalize(root.join(relative)).ok()?;
    let metadata = fs::symlink_metadata(&candidate).ok()?;
    (metadata.is_dir() && candidate.starts_with(root) && candidate != root).then_some(candidate)
}

/// Identity of the running executable: path, device, inode, size and SHA-256 of its bytes.
pub(super) fn executable_identity() -> io::Result<(String, u64, u64, u64, String)> {
    let path = std::env::current_exe()?;
    let mut file = OpenOptions::new().read(true).open(&path)?;
    let before = file.metadata()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let after = file.metadata()?;
    if before.ino() != after.ino()
        || before.size() != after.size()
        || before.mtime() != after.mtime()
    {
        return Err(io::Error::other("executable changed while it was measured"));
    }
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok((
        path.to_string_lossy().into_owned(),
        before.dev(),
        before.ino(),
        before.size(),
        digest,
    ))
}

/// Creates the receipt exclusively (an existing file or link fails) with owner-only permissions.
pub(super) fn write_receipt(directory: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(directory.join(RECEIPT_NAME))?;
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::{RECEIPT_NAME, contained_directory, validated_directory, write_receipt};
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    fn scratch(name: &str) -> std::io::Result<PathBuf> {
        let path = std::env::temp_dir().join(format!(
            "nebular-release-smoke-{}-{name}",
            std::process::id()
        ));
        if path.exists() {
            fs::remove_dir_all(&path)?;
        }
        fs::create_dir(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(path)
    }

    #[test]
    fn directory_must_be_owner_only_real_and_inside_temp() -> std::io::Result<()> {
        let root = scratch("validate")?;
        assert!(validated_directory(&root).is_ok());
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755))?;
        assert_eq!(
            validated_directory(&root),
            Err("smoke directory must be owner-only")
        );
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let link = root.with_extension("link");
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&root, &link)?;
        assert_eq!(
            validated_directory(&link),
            Err("smoke directory must be a real directory")
        );
        fs::remove_file(&link)?;
        assert!(validated_directory(std::path::Path::new("relative")).is_err());
        assert!(validated_directory(std::path::Path::new("/")).is_err());
        fs::write(root.join(RECEIPT_NAME), "{}")?;
        assert_eq!(
            validated_directory(&root),
            Err("smoke directory already holds a receipt")
        );
        fs::remove_dir_all(&root)
    }

    #[test]
    fn selections_resolve_only_inside_the_smoke_directory() -> std::io::Result<()> {
        let root = fs::canonicalize(scratch("contain")?)?;
        fs::create_dir_all(root.join("Nebular Smoke Ünïcode/Project Ω"))?;
        assert!(contained_directory(&root, "Nebular Smoke Ünïcode/Project Ω").is_some());
        assert!(contained_directory(&root, "../").is_none());
        assert!(contained_directory(&root, ".").is_none());
        assert!(contained_directory(&root, "missing").is_none());
        std::os::unix::fs::symlink("/", root.join("escape"))?;
        assert!(contained_directory(&root, "escape").is_none());
        fs::remove_dir_all(&root)
    }

    #[test]
    fn receipt_is_created_exclusively() -> std::io::Result<()> {
        let root = scratch("receipt")?;
        write_receipt(&root, b"{}")?;
        assert!(write_receipt(&root, b"{}").is_err());
        assert_eq!(
            fs::metadata(root.join(RECEIPT_NAME))?.permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(&root)
    }
}
