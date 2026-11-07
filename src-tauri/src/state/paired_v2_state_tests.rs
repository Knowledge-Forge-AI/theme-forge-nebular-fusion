use super::{
    FileSourceMeta, ProfileDocumentCustody, ProfileSemanticStatus, destination_aliases_custody,
    latest_compile_custody_matches, read_bounded_profile_bytes, same_custody_identity,
    sanitize_paired_v2_display_name, sha256_hex,
};
use crate::app_theme::paired_v2::validate_save_response_transport;
use crate::app_theme::paired_v2::{AppThemeSaveProfileV2Response, PairedV2SavedDocument};
use crate::app_theme::paired_v2_packets::{
    PairedV2BriefCreateInput, PairedV2PacketCreateRequest, PairedV2PacketKind, create_packet,
};
use crate::app_theme::runner::AppThemeRunner;
use crate::app_theme::types::{
    OwnerBindingInputOrigin, OwnerBindingRecord, ProfileDocumentSchemaVersion,
    ProfileVerificationStatus,
};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn digest(ch: char) -> String {
    std::iter::repeat_n(ch, 64).collect()
}

fn owned_directory(tag: &str) -> Option<PathBuf> {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_nanos());
    let directory = std::env::temp_dir().join(format!(
        "tfsb-paired-v2-{tag}-{}-{nanos}",
        std::process::id()
    ));
    std::fs::create_dir(&directory).ok().map(|_| directory)
}

fn v2_custody(path: PathBuf, bytes: Vec<u8>, document_id: &str) -> ProfileDocumentCustody {
    let raw_source_sha256 = sha256_hex(&bytes);
    let canonical_digest = digest('b');
    let mut custody = ProfileDocumentCustody::from_source(
        FileSourceMeta::new(path, bytes, None),
        ProfileDocumentSchemaVersion::PairedProfileV2,
        ProfileVerificationStatus::Verified,
        ProfileSemanticStatus::Validated,
        false,
    );
    custody.document_id = document_id.to_owned();
    custody.canonical_digest = Some(canonical_digest.clone());
    custody.owner_binding = Some(OwnerBindingRecord {
        input_origin: OwnerBindingInputOrigin::SourceBytes,
        raw_source_sha256,
        verification_status: ProfileVerificationStatus::Verified,
        is_transformed: false,
        byte_length: custody.raw_bytes.len() as u64,
        normalized_sha256: None,
        canonical_digest: Some(canonical_digest),
        parent_source_sha256: None,
    });
    custody
}

#[test]
fn saved_response_unicode_is_validated_before_commit() {
    let response = AppThemeSaveProfileV2Response {
        cancelled: false,
        saved: true,
        session_id: "v2-session".to_owned(),
        ui_revision: 7,
        document: Some(PairedV2SavedDocument {
            document_id: "doc-7".to_owned(),
            raw_source_sha256: digest('a'),
            canonical_digest: digest('b'),
            display_name: "thème-🚀.json".to_owned(),
        }),
        error: None,
    };
    assert!(validate_save_response_transport(&response).is_ok());

    // The same validator is the pre-rename gate in the v2 save path.
    let mut invalid = response;
    invalid.document = None;
    assert!(validate_save_response_transport(&invalid).is_err());
}

#[test]
fn paired_v2_display_name_is_bounded_at_utf8_boundary() {
    let name = format!("{}-profile.json", "界".repeat(200));
    let path = PathBuf::from(name);
    let display_name = sanitize_paired_v2_display_name(&path);
    assert_eq!(display_name.len(), 255);
    assert!(display_name.chars().all(|character| character == '界'));
}

#[test]
fn deleted_custody_path_is_rejected_by_regular_nofollow_read() -> Result<(), &'static str> {
    let Some(directory) = owned_directory("deleted") else {
        return Err("could not create exclusive test directory");
    };
    let path = directory.join("custody.json");
    assert!(read_bounded_profile_bytes(&path).is_err());
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}

#[cfg(unix)]
#[test]
fn dangling_custody_symlink_is_rejected_by_regular_nofollow_read() -> Result<(), &'static str> {
    use std::os::unix::fs::symlink;

    let Some(directory) = owned_directory("dangling") else {
        return Err("could not create exclusive test directory");
    };
    let target = directory.join("missing-target.json");
    let link = directory.join("dangling-link.json");
    assert!(symlink(&target, &link).is_ok());
    assert!(read_bounded_profile_bytes(&link).is_err());
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}

#[test]
fn live_custody_snapshot_change_is_rejected_by_identity_fence() -> Result<(), &'static str> {
    let Some(directory) = owned_directory("snapshot") else {
        return Err("could not create exclusive test directory");
    };
    let path = directory.join("custody.json");
    let original = v2_custody(path, b"original".to_vec(), "doc-snapshot");
    let mut changed = original.clone();
    changed.raw_bytes = b"replacement".to_vec();
    changed.raw_source_sha256 = sha256_hex(&changed.raw_bytes);
    assert!(!same_custody_identity(&original, &changed));
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}

#[test]
fn detached_latest_compile_does_not_require_custody_lineage() -> Result<(), &'static str> {
    let Some(directory) = owned_directory("detached-lineage") else {
        return Err("could not create exclusive test directory");
    };
    let custody = v2_custody(
        directory.join("current.json"),
        b"current-source".to_vec(),
        "doc-current",
    );
    assert!(latest_compile_custody_matches(
        None,
        &digest('c'),
        Some(&custody)
    ));
    assert!(!latest_compile_custody_matches(
        Some("other-document"),
        custody.raw_source_sha256.as_str(),
        Some(&custody)
    ));
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}

#[cfg(unix)]
#[test]
fn custody_alias_uses_parent_identity_and_existing_leaf_inode() -> Result<(), &'static str> {
    use std::os::unix::fs::symlink;

    let Some(directory) = owned_directory("alias-inode") else {
        return Err("could not create exclusive test directory");
    };
    let custody_path = directory.join("current.json");
    let alias_path = directory.join("alias.json");
    assert!(std::fs::write(&custody_path, b"current-source").is_ok());
    assert!(std::fs::hard_link(&custody_path, &alias_path).is_ok());
    assert!(destination_aliases_custody(&alias_path, &custody_path).is_ok_and(|same| same));

    let linked_parent = directory.join("linked-parent");
    assert!(symlink(&directory, &linked_parent).is_ok());
    let firmlink_alias = linked_parent.join("current.json");
    assert!(destination_aliases_custody(&firmlink_alias, &custody_path).is_ok_and(|same| same));
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}

fn brief_envelope(source_hash: &str) -> Option<super::PairedV2PacketEnvelope> {
    create_packet(PairedV2PacketCreateRequest::Brief(
        PairedV2BriefCreateInput {
            schema: PairedV2PacketKind::Brief.schema().to_owned(),
            schema_version: 1,
            brief_id: "brief-1".to_owned(),
            title: "Packet brief".to_owned(),
            goal: "Guard custody destinations".to_owned(),
            profile_name: "Profile".to_owned(),
            profile_version: "1.0.0".to_owned(),
            source_profile_sha256: source_hash.to_owned(),
            source_canonical_digest: digest('b'),
            editable_paths: vec!["color.*".to_owned()],
            allowed_modes: vec!["light".to_owned()],
            acceptance_criteria: vec!["No overwrite".to_owned()],
            prohibited_changes: vec!["No fallback".to_owned()],
        },
    ))
    .ok()
}

#[test]
fn paired_packet_guard_protects_missing_current_custody_destination() -> Result<(), &'static str> {
    let Some(directory) = owned_directory("packet-custody") else {
        return Err("could not create exclusive test directory");
    };
    let custody_path = directory.join("current.json");
    let raw = b"current-source".to_vec();
    let raw_hash = sha256_hex(&raw);
    let Some(envelope) = brief_envelope(&raw_hash) else {
        return Err("could not construct packet envelope");
    };
    let state = super::AppThemeState::new(AppThemeRunner::new(
        PathBuf::from("/nonexistent/node"),
        PathBuf::from("/nonexistent/adapter"),
    ));
    let Ok(mut session) = state.lock() else {
        return Err("could not lock app theme state");
    };
    session.active_document = Some(v2_custody(custody_path.clone(), raw, "doc-custody"));
    drop(session);

    let result =
        state.publish_paired_packet_to_path(&custody_path, PairedV2PacketKind::Brief, &envelope);
    assert!(matches!(
        result,
        Err(error) if error.reason_code() == crate::errors::StudioReasonCode::SelectionRejected
    ));
    assert!(!custody_path.exists());
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}

#[test]
fn paired_packet_guard_refuses_any_same_parent_when_custody_is_missing() -> Result<(), &'static str>
{
    let Some(directory) = owned_directory("packet-missing-parent") else {
        return Err("could not create exclusive test directory");
    };
    let custody_path = directory.join("current.json");
    let destination = directory.join("different-name.json");
    let raw = b"current-source".to_vec();
    let raw_hash = sha256_hex(&raw);
    let Some(envelope) = brief_envelope(&raw_hash) else {
        return Err("could not construct packet envelope");
    };
    let state = super::AppThemeState::new(AppThemeRunner::new(
        PathBuf::from("/nonexistent/node"),
        PathBuf::from("/nonexistent/adapter"),
    ));
    let Ok(mut session) = state.lock() else {
        return Err("could not lock app theme state");
    };
    session.active_document = Some(v2_custody(custody_path, raw, "doc-custody"));
    drop(session);

    let result =
        state.publish_paired_packet_to_path(&destination, PairedV2PacketKind::Brief, &envelope);
    assert!(matches!(
        result,
        Err(error) if error.reason_code() == crate::errors::StudioReasonCode::SelectionRejected
    ));
    assert!(!destination.exists());
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}

#[test]
fn paired_packet_guard_preserves_foreign_existing_destination_and_allows_new_sibling()
-> Result<(), &'static str> {
    let Some(directory) = owned_directory("packet-foreign") else {
        return Err("could not create exclusive test directory");
    };
    let custody_path = directory.join("current.json");
    let foreign_path = directory.join("foreign.json");
    let raw = b"current-source".to_vec();
    let raw_hash = sha256_hex(&raw);
    let Some(envelope) = brief_envelope(&raw_hash) else {
        return Err("could not construct packet envelope");
    };
    assert!(std::fs::write(&custody_path, &raw).is_ok());
    assert!(std::fs::write(&foreign_path, b"owned").is_ok());
    let state = super::AppThemeState::new(AppThemeRunner::new(
        PathBuf::from("/nonexistent/node"),
        PathBuf::from("/nonexistent/adapter"),
    ));
    let Ok(mut session) = state.lock() else {
        return Err("could not lock app theme state");
    };
    session.active_document = Some(v2_custody(custody_path, raw, "doc-custody"));
    drop(session);

    let result =
        state.publish_paired_packet_to_path(&foreign_path, PairedV2PacketKind::Brief, &envelope);
    assert!(matches!(
        result,
        Err(error) if error.reason_code() == crate::errors::StudioReasonCode::SelectionRejected
    ));
    assert_eq!(
        std::fs::read(&foreign_path).ok().as_deref(),
        Some(b"owned".as_slice())
    );

    let sibling_path = directory.join("sibling.json");
    let sibling_result =
        state.publish_paired_packet_to_path(&sibling_path, PairedV2PacketKind::Brief, &envelope);
    assert!(sibling_result.is_ok_and(|bytes| bytes == envelope.canonical_json.len()));
    assert_eq!(
        std::fs::read(&sibling_path).ok().as_deref(),
        Some(envelope.canonical_json.as_bytes())
    );
    assert!(std::fs::remove_dir_all(directory).is_ok());
    Ok(())
}
