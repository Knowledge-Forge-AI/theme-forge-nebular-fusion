//! The fixture and receipt filesystem helper of release smoke mode. It validates the harness-created smoke
//! directory, resolves compiled-in fixture selections strictly inside it, measures the running
//! executable, and creates the receipt exclusively. This helper writes only inside the smoke directory.
//! The appearance-preferences module separately uses a fixed subdirectory of that same root.

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

const PAIR_MARKER: &str = ".nebular-appearance-pair-v1";
const PAIR_SHARED_DIR: &str = "shared-prefs";
const PAIR_APPEARANCE_DIR: &str = "appearance-preferences";
const PAIR_EXCHANGE_DIR: &str = "exchange";

fn fixed_exchange_source(name: &str) -> bool {
    matches!(
        name,
        "baseline.theme.json" | "v2-saved.theme.json" | "candidate-v2.json" | "review-v2.json"
    )
}

fn fixed_exchange_destination(name: &str) -> bool {
    matches!(
        name,
        "v2-saved.theme.json" | "candidate-v2.json" | "review-v2.json"
    )
}

fn owner_only_directory(path: &Path, expected_uid: u32) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "pair layout is missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("pair layout contains a non-directory");
    }
    if metadata.permissions().mode() & 0o777 != 0o700 || metadata.uid() != expected_uid {
        return Err("pair directory must be owner-only");
    }
    Ok(())
}

fn owner_only_file(
    path: &Path,
    mode: u32,
    nlink: u64,
    expected_uid: u32,
) -> Result<(), &'static str> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "pair layout is missing")?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("pair layout contains a non-file");
    }
    if metadata.permissions().mode() & 0o777 != mode
        || metadata.nlink() != nlink
        || metadata.uid() != expected_uid
    {
        return Err("pair file has unexpected mode or link count");
    }
    Ok(())
}

fn exact_children(path: &Path, expected: &[&str]) -> Result<(), &'static str> {
    let mut actual = fs::read_dir(path)
        .map_err(|_| "pair layout cannot be enumerated")?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .map_err(|_| "pair layout cannot be enumerated")
        })
        .collect::<Result<Vec<_>, _>>()?;
    actual.sort_unstable();
    let mut expected = expected
        .iter()
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    expected.sort_unstable();
    (actual == expected)
        .then_some(())
        .ok_or("pair layout has unexpected entries")
}

fn valid_pair_id(value: &str) -> bool {
    value.starts_with("appearance-pair-v1-")
        && (1..=96).contains(&(value.len().saturating_sub("appearance-pair-v1-".len())))
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn pair_root_from_smoke(smoke_dir: &Path, role: &str) -> Result<PathBuf, &'static str> {
    let smoke = fs::canonicalize(smoke_dir).map_err(|_| "smoke directory cannot be resolved")?;
    let smoke_name = smoke
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("pair smoke path is malformed")?;
    if smoke_name != "nebular-release-smoke" {
        return Err("pair smoke path is malformed");
    }
    let tmp = smoke.parent().ok_or("pair smoke path is malformed")?;
    let view = tmp.parent().ok_or("pair smoke path is malformed")?;
    let pair_root = view.parent().ok_or("pair smoke path is malformed")?;
    if view.file_name().and_then(|name| name.to_str()) != Some(role) {
        return Err("pair view role does not match smoke path");
    }
    Ok(pair_root.to_path_buf())
}

/// Validates the allocator-owned P-save/P-restart layout. This function never
/// creates, repairs, or deletes a preference directory or file.
pub(super) fn validated_appearance_preferences(
    smoke_dir: &Path,
    shared_parent: &Path,
    role: &str,
) -> Result<PathBuf, &'static str> {
    if !matches!(role, "view-a" | "view-b") {
        return Err("pair view role is invalid");
    }
    let pair_root = pair_root_from_smoke(smoke_dir, role)?;
    let expected_uid = fs::symlink_metadata(smoke_dir)
        .map_err(|_| "smoke directory cannot be inspected")?
        .uid();
    owner_only_directory(&pair_root, expected_uid)?;
    exact_children(
        &pair_root,
        &[PAIR_MARKER, PAIR_SHARED_DIR, "view-a", "view-b"],
    )?;
    let marker = pair_root.join(PAIR_MARKER);
    owner_only_file(&marker, 0o600, 1, expected_uid)?;
    let pair_id = pair_root
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("pair root name is invalid")?;
    if !valid_pair_id(pair_id) {
        return Err("pair root name is invalid");
    }
    let expected_marker = format!("nebular.appearance-pair-v1\n{pair_id}\n");
    let marker_size = fs::symlink_metadata(&marker)
        .map_err(|_| "pair marker cannot be read")?
        .len();
    if marker_size != expected_marker.len() as u64 {
        return Err("pair marker is invalid");
    }
    let marker_bytes = fs::read(&marker).map_err(|_| "pair marker cannot be read")?;
    if marker_bytes != expected_marker.as_bytes() {
        return Err("pair marker is invalid");
    }
    if !shared_parent.is_absolute() {
        return Err("shared preference parent must be absolute");
    }
    let supplied_shared =
        fs::symlink_metadata(shared_parent).map_err(|_| "shared preference parent is missing")?;
    if supplied_shared.file_type().is_symlink() || !supplied_shared.is_dir() {
        return Err("shared preference parent must be a real directory");
    }
    let shared =
        fs::canonicalize(shared_parent).map_err(|_| "shared preference parent is missing")?;
    if shared != pair_root.join(PAIR_SHARED_DIR) {
        return Err("shared preference parent is not the fixed sibling");
    }
    owner_only_directory(&shared, expected_uid)?;
    exact_children(&shared, &[PAIR_APPEARANCE_DIR])?;
    let preferences = shared.join(PAIR_APPEARANCE_DIR);
    owner_only_directory(&preferences, expected_uid)?;
    let other_view = if role == "view-a" { "view-b" } else { "view-a" };
    owner_only_directory(&pair_root.join(other_view), expected_uid)?;
    let view = pair_root.join(role);
    owner_only_directory(&view, expected_uid)?;
    exact_children(&view, &["home", "tmp", "xdg"])?;
    owner_only_directory(&view.join("tmp"), expected_uid)?;
    exact_children(&view.join("tmp"), &["nebular-release-smoke"])?;
    owner_only_directory(
        &view.join("tmp").join("nebular-release-smoke"),
        expected_uid,
    )?;
    owner_only_directory(&view.join("home"), expected_uid)?;
    owner_only_directory(&view.join("xdg"), expected_uid)?;
    exact_children(
        &view.join("xdg"),
        &["config", "cache", "data", "state", "runtime"],
    )?;
    for child in ["config", "cache", "data", "state", "runtime"] {
        owner_only_directory(&view.join("xdg").join(child), expected_uid)?;
    }
    if role == "view-a" {
        if !fs::read_dir(&preferences)
            .map_err(|_| "appearance preference leaf cannot be enumerated")?
            .next()
            .is_none()
        {
            return Err("P-save preference leaf is not empty");
        }
    } else {
        owner_only_file(&preferences.join("appearance.json"), 0o600, 1, expected_uid)?;
        if fs::read_dir(&preferences)
            .map_err(|_| "appearance preference leaf cannot be enumerated")?
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy() != "appearance.json")
        {
            return Err("P-restart preference leaf has unexpected entries");
        }
    }
    // The existing appearance initializer appends its fixed
    // `appearance-preferences` child to this returned parent.
    Ok(shared)
}

fn validated_exchange_directory(root: &Path) -> Result<PathBuf, &'static str> {
    let root = fs::canonicalize(root).map_err(|_| "smoke directory cannot be resolved")?;
    let expected_uid = fs::symlink_metadata(&root)
        .map_err(|_| "smoke directory cannot be inspected")?
        .uid();
    let exchange = root.join(PAIR_EXCHANGE_DIR);
    owner_only_directory(&exchange, expected_uid)?;
    Ok(exchange)
}

pub(super) fn paired_exchange_source(root: &Path, name: &str) -> Result<PathBuf, &'static str> {
    if !fixed_exchange_source(name) {
        return Err("paired exchange source is not in the fixed table");
    }
    let exchange = validated_exchange_directory(root)?;
    let expected_uid = fs::symlink_metadata(&exchange)
        .map_err(|_| "paired exchange cannot be inspected")?
        .uid();
    let path = exchange.join(name);
    owner_only_file(&path, 0o600, 1, expected_uid)?;
    Ok(path)
}

pub(super) fn paired_exchange_destination(
    root: &Path,
    name: &str,
) -> Result<PathBuf, &'static str> {
    if !fixed_exchange_destination(name) {
        return Err("paired exchange destination is not in the fixed table");
    }
    let exchange = validated_exchange_directory(root)?;
    let path = exchange.join(name);
    if fs::symlink_metadata(&path).is_ok() {
        return Err("paired exchange destination already exists");
    }
    Ok(path)
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
    use super::{
        RECEIPT_NAME, contained_directory, paired_exchange_destination, paired_exchange_source,
        validated_directory, write_receipt,
    };
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

    #[test]
    fn paired_exchange_names_are_closed_for_sources_and_destinations() -> std::io::Result<()> {
        let root = fs::canonicalize(scratch("exchange-closure")?)?;
        let exchange = root.join("exchange");
        fs::create_dir(&exchange)?;
        fs::set_permissions(&exchange, fs::Permissions::from_mode(0o700))?;
        let review = exchange.join("review-v2.json");
        fs::write(&review, b"review")?;
        fs::set_permissions(&review, fs::Permissions::from_mode(0o600))?;

        assert_eq!(
            paired_exchange_source(&root, "review-v2.json"),
            Ok(review.clone())
        );
        assert_eq!(
            paired_exchange_source(&root, "foreign.json"),
            Err("paired exchange source is not in the fixed table")
        );
        assert_eq!(
            paired_exchange_destination(&root, "review-v2.json"),
            Err("paired exchange destination already exists")
        );
        assert_eq!(
            paired_exchange_destination(&root, "foreign.json"),
            Err("paired exchange destination is not in the fixed table")
        );

        fs::remove_file(review)?;
        assert_eq!(
            paired_exchange_destination(&root, "review-v2.json"),
            Ok(exchange.join("review-v2.json"))
        );
        fs::remove_dir_all(root)
    }
}
