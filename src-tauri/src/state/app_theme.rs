use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::app_theme::paired_v2::{
    AppThemePairedCompileV2Request, AppThemePairedCompileV2Response, AppThemePairedCompileV2Source,
    AppThemeSaveProfileV2Request, AppThemeSaveProfileV2Response, PAIRED_V2_MAX_REVISION,
    PAIRED_V2_MAX_SOURCE_BYTES, PairedV2ActiveDocumentClaim, PairedV2AdapterCompileRequest,
    PairedV2AuthoringCapability, PairedV2Error, PairedV2LatestCompileClaim, PairedV2SaveMode,
    PairedV2SavedDocument, validate_compile_request_transport,
    validate_compile_response_for_session, validate_save_request_for_session,
    validate_save_request_transport, validate_save_response_transport,
};
use crate::app_theme::paired_v2_packets::{
    PAIRED_V2_PACKET_MAX_BYTES, PairedV2PacketEnvelope, PairedV2PacketKind, parse_packet,
};
use crate::app_theme::runner::{AppThemeRunner, COMPILER_VERSION, MAX_PROFILE_DOCUMENT_BYTES};
use crate::app_theme::types::{
    AdapterBindDocumentResponse, AppThemeCompileRequest, AppThemeCompileResponse,
    AppThemeExportResponse, AppThemeOpenProfileResponse, AppThemeOpenedDocument,
    AppThemePairedCompileRequest, AppThemePairedCompileResponse, AppThemeSaveProfileRequest,
    AppThemeSaveProfileResponse, AppThemeStatus, OwnerBindingInputOrigin, OwnerBindingRecord,
    PairedProfileDto, PairedProfileV2DocumentDto, ProfileDocumentSchemaVersion, ProfileSaveMode,
    ProfileSemanticStatus, ProfileVerificationStatus, ThemeSpecificationDto,
    sanitize_untrusted_text,
};
use crate::design_evidence::publish_paired_selected_bytes;
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

static SAVE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy)]
enum FreshFileMode {
    ProcessDefault,
    Private0600,
}

fn supported_profile_formats() -> Vec<String> {
    vec![
        "tf-paired-profile-v1".to_owned(),
        "tf-paired-profile-v2".to_owned(),
    ]
}

fn open_cancelled() -> AppThemeOpenProfileResponse {
    AppThemeOpenProfileResponse {
        cancelled: true,
        ..Default::default()
    }
}

fn open_error(msg: impl Into<String>) -> AppThemeOpenProfileResponse {
    AppThemeOpenProfileResponse {
        error: Some(msg.into()),
        ..Default::default()
    }
}

fn save_cancelled() -> AppThemeSaveProfileResponse {
    AppThemeSaveProfileResponse {
        cancelled: true,
        ..Default::default()
    }
}

fn save_error(msg: impl Into<String>) -> AppThemeSaveProfileResponse {
    AppThemeSaveProfileResponse {
        error: Some(msg.into()),
        ..Default::default()
    }
}

fn save_ok(doc: AppThemeOpenedDocument) -> AppThemeSaveProfileResponse {
    AppThemeSaveProfileResponse {
        saved: true,
        document: Some(doc),
        ..Default::default()
    }
}

fn paired_v2_error(code: &str, message: &str) -> PairedV2Error {
    PairedV2Error {
        code: code.to_owned(),
        message: message.to_owned(),
        path: None,
    }
}

fn paired_v2_compile_error(
    status: &str,
    session_id: String,
    ui_revision: u64,
    error: Option<PairedV2Error>,
) -> AppThemePairedCompileV2Response {
    let error = error.or_else(|| {
        Some(paired_v2_error(
            if status == "cancelled" {
                "CANCELLED"
            } else if status == "stale" {
                "STALE_REVISION"
            } else {
                "COMPILE_FAILED"
            },
            if status == "cancelled" {
                "The paired v2 compile was cancelled."
            } else if status == "stale" {
                "The paired v2 compile revision is stale."
            } else {
                "The paired v2 compile could not be completed."
            },
        ))
    });
    match status {
        "stale" => AppThemePairedCompileV2Response::Stale {
            valid: false,
            ui_revision: ui_revision.min(PAIRED_V2_MAX_REVISION),
            session_id,
            draft: None,
            solar_sail: None,
            stellar_loom: None,
            application_appearance: None,
            application_extension: None,
            diagnostics: vec![],
            error,
        },
        "cancelled" => AppThemePairedCompileV2Response::Cancelled {
            valid: false,
            ui_revision: ui_revision.min(PAIRED_V2_MAX_REVISION),
            session_id,
            draft: None,
            solar_sail: None,
            stellar_loom: None,
            application_appearance: None,
            application_extension: None,
            diagnostics: vec![],
            error,
        },
        _ => AppThemePairedCompileV2Response::Error {
            valid: false,
            ui_revision: ui_revision.min(PAIRED_V2_MAX_REVISION),
            session_id,
            draft: None,
            solar_sail: None,
            stellar_loom: None,
            application_appearance: None,
            application_extension: None,
            diagnostics: vec![],
            error,
        },
    }
}

fn paired_v2_save_response_for_session(
    session_id: String,
    request: &AppThemeSaveProfileV2Request,
    document: Option<PairedV2SavedDocument>,
    error: Option<PairedV2Error>,
    cancelled: bool,
    saved: bool,
) -> StudioResult<AppThemeSaveProfileV2Response> {
    let response = AppThemeSaveProfileV2Response {
        cancelled,
        saved,
        session_id,
        ui_revision: request.ui_revision.min(PAIRED_V2_MAX_REVISION),
        document,
        error,
    };
    validate_save_response_transport(&response)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;
    Ok(response)
}

fn sanitize_display_name(path: &Path) -> String {
    let raw = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("profile.json");
    let cleaned = sanitize_untrusted_text(raw, 128);
    if cleaned.is_empty() {
        "profile.json".to_owned()
    } else {
        cleaned
    }
}

const PAIRED_V2_DISPLAY_NAME_MAX_BYTES: usize = 256;

fn sanitize_paired_v2_display_name(path: &Path) -> String {
    let raw = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("profile.json");
    let cleaned = sanitize_untrusted_text(raw, PAIRED_V2_DISPLAY_NAME_MAX_BYTES);
    let mut end = cleaned.len().min(PAIRED_V2_DISPLAY_NAME_MAX_BYTES);
    while end > 0 && !cleaned.is_char_boundary(end) {
        end -= 1;
    }
    let bounded = &cleaned[..end];
    if bounded.is_empty() {
        "profile.json".to_owned()
    } else {
        bounded.to_owned()
    }
}

fn default_profile_filename(name: &str) -> String {
    let mut slug = String::new();
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
        } else if (ch == '-' || ch == '_' || ch.is_whitespace()) && !slug.ends_with('-') {
            slug.push('-');
        }
        if slug.len() >= 64 {
            break;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "profile.json".to_owned()
    } else {
        format!("{trimmed}.profile.json")
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fmt_io_err(prefix: &str, err: &std::io::Error) -> String {
    format!(
        "{prefix}: {}",
        sanitize_untrusted_text(&err.to_string(), 200)
    )
}

fn open_regular_no_follow(path: &Path) -> std::io::Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(crate::platform::O_NOFOLLOW | crate::platform::O_NONBLOCK);
    }
    options.open(path)
}

fn same_file_identity(left: &fs::Metadata, right: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        left.dev() == right.dev() && left.ino() == right.ino()
    }
    #[cfg(not(unix))]
    {
        left.len() == right.len()
    }
}

fn read_bounded_profile_bytes(path: &Path) -> Result<(Vec<u8>, Option<SystemTime>), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| fmt_io_err("Failed to inspect profile metadata", &e))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("Profile path must reference a regular file".to_owned());
    }
    if meta.len() > MAX_PROFILE_DOCUMENT_BYTES as u64 {
        return Err(format!(
            "Profile document exceeds maximum size of {MAX_PROFILE_DOCUMENT_BYTES} bytes"
        ));
    }
    let file =
        open_regular_no_follow(path).map_err(|e| fmt_io_err("Failed to open profile", &e))?;
    let opened = file
        .metadata()
        .map_err(|e| fmt_io_err("Failed to inspect profile", &e))?;
    if opened.file_type().is_symlink()
        || !opened.is_file()
        || !same_file_identity(&meta, &opened)
        || opened.len() != meta.len()
    {
        return Err("Profile path changed during inspection".to_owned());
    }
    let mut bounded = file.take((MAX_PROFILE_DOCUMENT_BYTES as u64).saturating_add(1));
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    bounded
        .read_to_end(&mut bytes)
        .map_err(|e| fmt_io_err("Failed to read profile", &e))?;
    if bytes.len() > MAX_PROFILE_DOCUMENT_BYTES {
        return Err(format!(
            "Profile document exceeds maximum size of {MAX_PROFILE_DOCUMENT_BYTES} bytes"
        ));
    }
    let after = fs::symlink_metadata(path)
        .map_err(|e| fmt_io_err("Failed to inspect profile metadata", &e))?;
    if after.file_type().is_symlink()
        || !after.is_file()
        || !same_file_identity(&opened, &after)
        || after.len() != opened.len()
        || after.modified().ok() != meta.modified().ok()
    {
        return Err("Profile path changed while reading".to_owned());
    }
    Ok((bytes, meta.modified().ok()))
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<Option<SystemTime>, String> {
    atomic_write_bytes_with_mode(path, bytes, FreshFileMode::ProcessDefault)
}

fn atomic_write_bytes_with_mode(
    path: &Path,
    bytes: &[u8],
    fresh_mode: FreshFileMode,
) -> Result<Option<SystemTime>, String> {
    if bytes.len() > MAX_PROFILE_DOCUMENT_BYTES {
        return Err(format!(
            "Profile document exceeds maximum size of {MAX_PROFILE_DOCUMENT_BYTES} bytes"
        ));
    }
    let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) else {
        return Err("Invalid destination path (missing parent directory)".to_owned());
    };
    fs::create_dir_all(parent).map_err(|e| fmt_io_err("Failed to create parent directory", &e))?;

    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let seq = SAVE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(
        ".tfsb-tmp-save-{}-{nanos}-{seq}.json",
        std::process::id()
    ));

    let write_res = (|| -> std::io::Result<()> {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        if matches!(fresh_mode, FreshFileMode::Private0600) {
            options.mode(0o600);
        }
        #[cfg(not(unix))]
        let _ = fresh_mode;
        let mut file = options.open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();

    if let Err(e) = write_res {
        let _ = fs::remove_file(&temp_path);
        return Err(fmt_io_err("Failed to write temporary file", &e));
    }
    if let Err(e) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(fmt_io_err("Failed to save profile", &e));
    }
    Ok(fs::metadata(path).ok().and_then(|m| m.modified().ok()))
}

fn atomic_write_paired_v2_profile(
    path: &Path,
    bytes: &[u8],
    save_mode: PairedV2SaveMode,
) -> Result<Option<SystemTime>, String> {
    match save_mode {
        PairedV2SaveMode::NewDocument => {
            atomic_write_bytes_with_mode(path, bytes, FreshFileMode::Private0600)
        }
        PairedV2SaveMode::Edited => atomic_write_bytes(path, bytes),
    }
}

#[derive(Debug, Clone)]
struct FileSourceMeta {
    display_name: String,
    backing_path: PathBuf,
    backing_mtime: Option<SystemTime>,
    raw_bytes: Vec<u8>,
    raw_source_sha256: String,
}

impl FileSourceMeta {
    fn new(path: PathBuf, raw_bytes: Vec<u8>, backing_mtime: Option<SystemTime>) -> Self {
        Self {
            display_name: sanitize_display_name(&path),
            backing_path: path,
            backing_mtime,
            raw_source_sha256: sha256_hex(&raw_bytes),
            raw_bytes,
        }
    }
}

#[derive(Debug, Clone)]
struct ProfileDocumentCustody {
    document_id: String,
    display_name: String,
    backing_path: PathBuf,
    backing_mtime: Option<SystemTime>,
    raw_bytes: Vec<u8>,
    raw_source_sha256: String,
    owner_binding: Option<OwnerBindingRecord>,
    parent_source_sha256: Option<String>,
    normalized_sha256: Option<String>,
    canonical_digest: Option<String>,
    schema_version: ProfileDocumentSchemaVersion,
    alias_resolved: bool,
    verification_status: ProfileVerificationStatus,
    is_transformed: bool,
    semantic: ProfileSemanticStatus,
    editable: bool,
    readonly_reason: Option<String>,
    diagnostic_code: Option<String>,
    diagnostic_summary: Option<String>,
    profile: Option<Box<PairedProfileDto>>,
    v2_profile: Option<Box<PairedProfileV2DocumentDto>>,
}

impl ProfileDocumentCustody {
    fn from_source(
        src: FileSourceMeta,
        schema_version: ProfileDocumentSchemaVersion,
        verification_status: ProfileVerificationStatus,
        semantic: ProfileSemanticStatus,
        editable: bool,
    ) -> Self {
        Self {
            document_id: String::new(),
            display_name: src.display_name,
            backing_path: src.backing_path,
            backing_mtime: src.backing_mtime,
            raw_bytes: src.raw_bytes,
            raw_source_sha256: src.raw_source_sha256,
            owner_binding: None,
            parent_source_sha256: None,
            normalized_sha256: None,
            canonical_digest: None,
            schema_version,
            alias_resolved: false,
            verification_status,
            is_transformed: false,
            semantic,
            editable,
            readonly_reason: None,
            diagnostic_code: None,
            diagnostic_summary: None,
            profile: None,
            v2_profile: None,
        }
    }

    fn v1_editable(
        src: FileSourceMeta,
        semantic: ProfileSemanticStatus,
        profile: Box<PairedProfileDto>,
        normalized_sha256: Option<String>,
        alias_resolved: bool,
    ) -> Self {
        let mut doc = Self::from_source(
            src,
            ProfileDocumentSchemaVersion::PairedProfileV1,
            ProfileVerificationStatus::UnverifiedAssertion,
            semantic,
            true,
        );
        doc.profile = Some(profile);
        doc.normalized_sha256 = normalized_sha256;
        doc.alias_resolved = alias_resolved;
        doc
    }

    fn with_diag(
        mut self,
        reason: Option<&str>,
        code: Option<&str>,
        summary: Option<String>,
    ) -> Self {
        self.readonly_reason = reason.map(str::to_owned);
        self.diagnostic_code = code.map(str::to_owned);
        self.diagnostic_summary = summary;
        self
    }

    fn new_corrupt(
        src: FileSourceMeta,
        alias_resolved: bool,
        reason: &str,
        code: Option<&str>,
        summary: Option<String>,
    ) -> Self {
        let mut doc = Self::from_source(
            src,
            ProfileDocumentSchemaVersion::Corrupt,
            ProfileVerificationStatus::Corrupt,
            ProfileSemanticStatus::Rejected,
            false,
        );
        doc.alias_resolved = alias_resolved;
        doc.with_diag(Some(reason), code, summary)
    }

    fn to_opened_document(&self, v2_authoring_eligible: bool) -> AppThemeOpenedDocument {
        AppThemeOpenedDocument {
            document_id: self.document_id.clone(),
            display_name: self.display_name.clone(),
            schema_version: self.schema_version,
            alias_resolved: self.alias_resolved,
            verification_status: self.verification_status,
            is_transformed: self.is_transformed,
            semantic: self.semantic,
            raw_source_sha256: self.raw_source_sha256.clone(),
            owner_binding: self.owner_binding.clone(),
            parent_source_sha256: self.parent_source_sha256.clone(),
            normalized_sha256: self.normalized_sha256.clone(),
            canonical_digest: self.canonical_digest.clone(),
            editable: self.editable,
            readonly_reason: self.readonly_reason.clone(),
            diagnostic_code: self.diagnostic_code.clone(),
            diagnostic_summary: self.diagnostic_summary.clone(),
            v2_authoring_eligible: v2_authoring_eligible.then_some(true),
            profile: self.profile.as_deref().cloned(),
            v2_profile: self.v2_profile.as_deref().cloned(),
        }
    }

    fn v2_active_claim(&self) -> Option<PairedV2ActiveDocumentClaim> {
        (self.schema_version == ProfileDocumentSchemaVersion::PairedProfileV2
            && self.verification_status == ProfileVerificationStatus::Verified
            && self.canonical_digest.is_some())
        .then(|| PairedV2ActiveDocumentClaim {
            document_id: self.document_id.clone(),
            raw_source_sha256: self.raw_source_sha256.clone(),
        })
    }
}

fn classify_bound_document(
    runner: &AppThemeRunner,
    src: FileSourceMeta,
    bound: AdapterBindDocumentResponse,
) -> StudioResult<ProfileDocumentCustody> {
    if bound.status != "bound" {
        if bound.schema_version == ProfileDocumentSchemaVersion::PairedProfileV1
            && bound.error_code.as_deref() == Some("SCHEMA_VALIDATION")
            && let Ok((dto, alias)) = PairedProfileDto::from_slice_with_alias_flag(&src.raw_bytes)
            && dto.schema_version == "tf-paired-profile-v1"
        {
            let doc = ProfileDocumentCustody::v1_editable(
                src,
                ProfileSemanticStatus::Rejected,
                Box::new(dto),
                None,
                alias,
            );
            return Ok(doc.with_diag(None, Some("SCHEMA_VALIDATION"), bound.error));
        }
        return Ok(ProfileDocumentCustody::new_corrupt(
            src,
            bound.alias_resolved,
            "Document failed strict profile validation and is opened for read-only inspection.",
            bound.error_code.as_deref(),
            bound.error,
        ));
    }

    match bound.schema_version {
        ProfileDocumentSchemaVersion::PairedProfileV1 => {
            let lossless_dto = if let Ok((local_dto, local_alias)) =
                PairedProfileDto::from_slice_with_alias_flag(&src.raw_bytes)
                && let Ok(reserialized) = serde_json::to_vec(&local_dto)
            {
                let rebound = runner.bind_document(&reserialized, None)?;
                (rebound.status == "bound"
                    && rebound.normalized_sha256 == bound.normalized_sha256
                    && local_alias == bound.alias_resolved)
                    .then(|| Box::new(local_dto))
            } else {
                None
            };

            if let Some(dto) = lossless_dto {
                let mut doc = ProfileDocumentCustody::v1_editable(
                    src,
                    ProfileSemanticStatus::Validated,
                    dto,
                    bound.normalized_sha256,
                    bound.alias_resolved,
                );
                doc.verification_status = bound.verification_status;
                doc.owner_binding = bound.owner_binding;
                Ok(doc)
            } else {
                let mut doc = ProfileDocumentCustody::from_source(
                    src,
                    ProfileDocumentSchemaVersion::PairedProfileV1,
                    bound.verification_status,
                    ProfileSemanticStatus::Validated,
                    false,
                );
                doc.profile = bound.profile;
                doc.normalized_sha256 = bound.normalized_sha256;
                doc.alias_resolved = bound.alias_resolved;
                doc.owner_binding = bound.owner_binding;
                Ok(doc.with_diag(
                    Some("Profile cannot be round-tripped losslessly by Studio v1 editor; opened in read-only custody."),
                    Some("UNSUPPORTED_V1_EXTENSION"),
                    Some("Lossless round-trip check failed; editing is disabled to prevent silent data loss.".to_owned()),
                ))
            }
        }
        ProfileDocumentSchemaVersion::PairedProfileV2 => {
            let mut doc = ProfileDocumentCustody::from_source(
                src,
                ProfileDocumentSchemaVersion::PairedProfileV2,
                bound.verification_status,
                ProfileSemanticStatus::Validated,
                false,
            )
            .with_diag(
                Some("Paired Profile v2 documents are opened in verified read-only custody. Save Original preserves the verified source bytes."),
                None,
                None,
            );
            doc.canonical_digest = bound.canonical_digest;
            doc.owner_binding = bound.owner_binding;
            doc.v2_profile = bound.v2_profile;
            Ok(doc)
        }
        ProfileDocumentSchemaVersion::Corrupt => Err(StudioCommandError::new(
            StudioReasonCode::SidecarProtocolInvalid,
        )),
    }
}

fn v2_authoring_eligible(custody: &ProfileDocumentCustody, paired_v2_available: bool) -> bool {
    custody.schema_version == ProfileDocumentSchemaVersion::PairedProfileV2
        && custody.verification_status == ProfileVerificationStatus::Verified
        && custody.raw_bytes.len() <= PAIRED_V2_MAX_SOURCE_BYTES
        && custody.canonical_digest.is_some()
        && custody.owner_binding.as_ref().is_some_and(|binding| {
            binding.input_origin == OwnerBindingInputOrigin::SourceBytes
                && binding.raw_source_sha256 == custody.raw_source_sha256
                && binding.verification_status == ProfileVerificationStatus::Verified
                && !binding.is_transformed
                && binding.parent_source_sha256.is_none()
                && binding.byte_length == custody.raw_bytes.len() as u64
                && binding.canonical_digest == custody.canonical_digest
        })
        && paired_v2_available
}

fn same_custody_identity(left: &ProfileDocumentCustody, right: &ProfileDocumentCustody) -> bool {
    left.document_id == right.document_id
        && left.backing_path == right.backing_path
        && left.backing_mtime == right.backing_mtime
        && left.raw_source_sha256 == right.raw_source_sha256
        && left.canonical_digest == right.canonical_digest
        && left.schema_version == right.schema_version
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[derive(Debug)]
struct DestinationPathIdentity {
    parent_path: PathBuf,
    parent_identity: Option<FileIdentity>,
    leaf: OsString,
    leaf_identity: Option<FileIdentity>,
    leaf_present: bool,
}

fn metadata_identity(metadata: &fs::Metadata) -> Option<FileIdentity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Some(FileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        None
    }
}

fn destination_path_identity(path: &Path) -> StudioResult<DestinationPathIdentity> {
    let leaf = match path.file_name() {
        Some(leaf) => leaf.to_owned(),
        None => return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected)),
    };
    let parent = match path.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let parent_metadata = fs::metadata(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    if !parent_metadata.is_dir() {
        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
    }
    let parent_path = fs::canonicalize(parent)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
    let leaf_present = fs::symlink_metadata(path).is_ok();
    let leaf_identity = fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata_identity(&metadata));
    Ok(DestinationPathIdentity {
        parent_path,
        parent_identity: metadata_identity(&parent_metadata),
        leaf,
        leaf_identity,
        leaf_present,
    })
}

fn destination_aliases_custody(path: &Path, custody_path: &Path) -> StudioResult<bool> {
    let destination = destination_path_identity(path)?;
    let custody = destination_path_identity(custody_path)?;
    let same_parent = match (destination.parent_identity, custody.parent_identity) {
        (Some(left), Some(right)) => left == right,
        _ => destination.parent_path == custody.parent_path,
    };
    if !same_parent {
        return Ok(false);
    }

    // If the live custody leaf is absent or dangling, refuse every paired
    // destination in the same directory.  The missing-custody state is
    // ambiguous until reset/reopen; fail closed rather than risk selecting an
    // alias through case, normalization, a firmlink, or another filesystem
    // name equivalence that the standard library cannot expose portably.
    if !custody.leaf_present || custody.leaf_identity.is_none() {
        return Ok(true);
    }
    if !destination.leaf_present {
        return Ok(false);
    }
    if destination.leaf_identity == custody.leaf_identity {
        return Ok(true);
    }
    Ok(destination.leaf == custody.leaf)
}

fn latest_compile_custody_matches(
    document_id: Option<&str>,
    baseline_raw_source_sha256: &str,
    custody: Option<&ProfileDocumentCustody>,
) -> bool {
    match (document_id, custody) {
        (Some(document_id), Some(custody)) => {
            custody.document_id == document_id
                && custody.schema_version == ProfileDocumentSchemaVersion::PairedProfileV2
                && custody.raw_source_sha256 == baseline_raw_source_sha256
        }
        (None, _) => true,
        _ => false,
    }
}

fn preflight_paired_v2_source(
    request: &AppThemePairedCompileV2Request,
    active_document: Option<&ProfileDocumentCustody>,
    paired_v2_available: bool,
) -> Result<PairedV2SourcePreflight, PairedV2Error> {
    if !paired_v2_available {
        return Err(paired_v2_error(
            "CAPABILITY_UNAVAILABLE",
            "Paired v2 authoring is not available.",
        ));
    }
    match &request.source {
        AppThemePairedCompileV2Source {
            document_id: Some(document_id),
            raw_source_base64: None,
            expected_raw_source_sha256,
            expected_canonical_digest,
        } => {
            let Some(custody) = active_document else {
                return Err(paired_v2_error(
                    "SOURCE_NOT_ELIGIBLE",
                    "The requested document is not in eligible v2 custody.",
                ));
            };
            if !v2_authoring_eligible(custody, paired_v2_available)
                || custody.document_id != *document_id
                || sha256_hex(&custody.raw_bytes) != custody.raw_source_sha256
                || custody.raw_source_sha256 != *expected_raw_source_sha256
                || custody.canonical_digest.as_deref() != Some(expected_canonical_digest.as_str())
            {
                return Err(paired_v2_error(
                    "SOURCE_IDENTITY_MISMATCH",
                    "The requested custody source identity is not current.",
                ));
            }
            Ok(PairedV2SourcePreflight {
                raw_bytes: custody.raw_bytes.clone(),
                baseline_raw_source_sha256: expected_raw_source_sha256.clone(),
                baseline_canonical_digest: expected_canonical_digest.clone(),
                document_id: Some(custody.document_id.clone()),
                parent_source_sha256: Some(custody.raw_source_sha256.clone()),
                source_custody: Some(custody.clone()),
            })
        }
        AppThemePairedCompileV2Source {
            document_id: None,
            raw_source_base64: Some(raw_source_base64),
            expected_raw_source_sha256,
            expected_canonical_digest,
        } => {
            let raw_bytes = base64::engine::general_purpose::STANDARD
                .decode(raw_source_base64.as_bytes())
                .map_err(|_| {
                    paired_v2_error(
                        "INVALID_REQUEST",
                        "The paired v2 source encoding is invalid.",
                    )
                })?;
            if raw_bytes.len() > PAIRED_V2_MAX_SOURCE_BYTES {
                return Err(paired_v2_error(
                    "SOURCE_TOO_LARGE",
                    "The paired v2 source exceeds its bounded custody size.",
                ));
            }
            if sha256_hex(&raw_bytes) != *expected_raw_source_sha256 {
                return Err(paired_v2_error(
                    "SOURCE_IDENTITY_MISMATCH",
                    "The requested source hash does not match the supplied bytes.",
                ));
            }
            Ok(PairedV2SourcePreflight {
                raw_bytes,
                baseline_raw_source_sha256: expected_raw_source_sha256.clone(),
                baseline_canonical_digest: expected_canonical_digest.clone(),
                document_id: None,
                parent_source_sha256: None,
                source_custody: None,
            })
        }
        _ => Err(paired_v2_error(
            "INVALID_REQUEST",
            "The paired v2 source must use exactly one source form.",
        )),
    }
}

fn validate_save_request(
    active: Option<&ProfileDocumentCustody>,
    request: &AppThemeSaveProfileRequest,
) -> Result<(ProfileSaveMode, Option<PathBuf>, String), String> {
    let mode = request.save_mode.unwrap_or_else(|| {
        if request.profile.is_some() {
            if active.is_some() {
                ProfileSaveMode::Edited
            } else {
                ProfileSaveMode::NewDocument
            }
        } else {
            ProfileSaveMode::Original
        }
    });

    match mode {
        ProfileSaveMode::Original => {
            let Some(custody) = active else {
                return Err("Save Original requires an active opened profile document".to_owned());
            };
            if let Some(ref req_id) = request.document_id
                && req_id != &custody.document_id
            {
                return Err("Document handle does not match the active profile document".to_owned());
            }
            if custody.schema_version == ProfileDocumentSchemaVersion::Corrupt
                || custody.verification_status == ProfileVerificationStatus::Corrupt
            {
                return Err("Corrupt documents cannot be saved".to_owned());
            }
            Ok((
                mode,
                Some(custody.backing_path.clone()),
                custody.display_name.clone(),
            ))
        }
        ProfileSaveMode::Edited => {
            let Some(ref profile) = request.profile else {
                return Err("Edited save mode requires a profile payload".to_owned());
            };
            if profile.schema_version != "tf-paired-profile-v1" {
                return Err(
                    "Edited save mode requires schemaVersion 'tf-paired-profile-v1'".to_owned(),
                );
            }
            if let Some(custody) = active {
                if let Some(ref req_id) = request.document_id
                    && req_id != &custody.document_id
                {
                    return Err(
                        "Document handle does not match the active profile document".to_owned()
                    );
                }
                if !custody.editable
                    || custody.schema_version != ProfileDocumentSchemaVersion::PairedProfileV1
                {
                    return Err(
                        "Active profile document is read-only and cannot be saved in edited mode"
                            .to_owned(),
                    );
                }
                Ok((
                    mode,
                    Some(custody.backing_path.clone()),
                    custody.display_name.clone(),
                ))
            } else if request.document_id.is_some() {
                Err("Document handle does not match the active profile document".to_owned())
            } else {
                Ok((mode, None, default_profile_filename(&profile.name)))
            }
        }
        ProfileSaveMode::NewDocument => {
            let Some(ref profile) = request.profile else {
                return Err("New-document save mode requires a profile payload".to_owned());
            };
            if profile.schema_version != "tf-paired-profile-v1" {
                return Err(
                    "New-document save mode requires schemaVersion 'tf-paired-profile-v1'"
                        .to_owned(),
                );
            }
            if let Some(custody) = active
                && !custody.editable
            {
                return Err(
                    "Active profile document is read-only and cannot be overwritten as a new v1 document"
                        .to_owned(),
                );
            }
            Ok((mode, None, default_profile_filename(&profile.name)))
        }
    }
}

#[derive(Clone)]
pub struct AppThemeState {
    shared: Arc<AppThemeShared>,
}

impl std::fmt::Debug for AppThemeState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppThemeState").finish_non_exhaustive()
    }
}

struct AppThemeShared {
    inner: Mutex<AppThemeSession>,
}

struct AppThemeSession {
    runner: AppThemeRunner,
    session_id: String,
    v2_session_id: String,
    v2_epoch: u64,
    v2_latest_revision: u64,
    v2_operation_nonce: u64,
    v2_latest_compile: Option<PairedV2LatestCompile>,
    active_document: Option<ProfileDocumentCustody>,
    next_document_seq: u64,
    open_generation: u64,
    latest_revision: u64,
    dirty: bool,
}

#[derive(Debug, Clone)]
struct PairedV2LatestCompile {
    nonce: u64,
    session_id: String,
    ui_revision: u64,
    baseline_raw_source_sha256: String,
    baseline_canonical_digest: String,
    raw_source_sha256: String,
    canonical_digest: String,
    source_bytes: Vec<u8>,
    document_id: Option<String>,
    parent_source_sha256: Option<String>,
    profile_name: String,
}

struct PairedV2CompileClaim {
    runner: AppThemeRunner,
    operation: crate::app_theme::runner::PairedV2Operation,
    nonce: u64,
    open_generation: u64,
    session_id: String,
    ui_revision: u64,
    raw_bytes: Vec<u8>,
    baseline_raw_source_sha256: String,
    baseline_canonical_digest: String,
    document_id: Option<String>,
    parent_source_sha256: Option<String>,
    source_custody: Option<ProfileDocumentCustody>,
}

struct PairedV2SourcePreflight {
    raw_bytes: Vec<u8>,
    baseline_raw_source_sha256: String,
    baseline_canonical_digest: String,
    document_id: Option<String>,
    parent_source_sha256: Option<String>,
    source_custody: Option<ProfileDocumentCustody>,
}

pub(crate) struct PairedV2SaveTarget {
    pub existing_path: Option<PathBuf>,
    pub default_name: String,
}

impl AppThemeSession {
    fn mint_document_id(&mut self) -> String {
        self.next_document_seq = self.next_document_seq.saturating_add(1);
        let input = format!("{}:doc:{}", self.session_id, self.next_document_seq);
        let digest = sha256_hex(input.as_bytes());
        format!("tfsb-profile-doc-{}", &digest[..16])
    }

    fn rotate_v2_epoch(&mut self) {
        self.v2_epoch = self.v2_epoch.saturating_add(1);
        let seed = format!(
            "{}:paired-v2:{}:{}",
            self.session_id, self.v2_epoch, self.v2_operation_nonce
        );
        self.v2_session_id = format!("tfsb-paired-v2-session-{}", sha256_hex(seed.as_bytes()));
        self.v2_latest_revision = 0;
        self.v2_operation_nonce = self.v2_operation_nonce.saturating_add(1);
        self.v2_latest_compile = None;
    }
}

fn stale_compile_response(ui_revision: u64) -> AppThemeCompileResponse {
    AppThemeCompileResponse {
        status: "stale".to_owned(),
        valid: false,
        ui_revision,
        compiled_css: None,
        descriptor: None,
        diagnostics: vec![],
        error: Some("Stale revision rejected".to_owned()),
    }
}

impl AppThemeState {
    pub fn new(runner: AppThemeRunner) -> Self {
        let nanos = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        Self {
            shared: Arc::new(AppThemeShared {
                inner: Mutex::new(AppThemeSession {
                    runner,
                    session_id: format!("tfsb-app-theme-session-{nanos}"),
                    v2_session_id: format!("tfsb-paired-v2-session-{nanos}"),
                    v2_epoch: 0,
                    v2_latest_revision: 0,
                    v2_operation_nonce: 0,
                    v2_latest_compile: None,
                    active_document: None,
                    next_document_seq: 0,
                    open_generation: 0,
                    latest_revision: 0,
                    dirty: false,
                }),
            }),
        }
    }

    fn lock(&self) -> StudioResult<MutexGuard<'_, AppThemeSession>> {
        self.shared
            .inner
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }

    pub fn shutdown(&self) {
        if let Ok(session) = self.lock() {
            session.runner.cancel_all();
        }
    }

    pub fn cancel_active(&self) {
        if let Ok(mut session) = self.lock() {
            session.latest_revision = session.latest_revision.saturating_add(1);
            let next_seed = format!("{}:{}", session.session_id, session.latest_revision);
            session.session_id = format!(
                "tfsb-app-theme-session-{}",
                sha256_hex(next_seed.as_bytes())
            );
            session.rotate_v2_epoch();
            session.runner.cancel_active();
            session.runner.cancel_paired_v2();
        }
    }

    pub fn status(&self) -> AppThemeStatus {
        let Ok(snapshot) = self.lock().map(|session| {
            (
                session.runner.clone(),
                session.session_id.clone(),
                session.v2_session_id.clone(),
                session.latest_revision,
                session.dirty,
                session.active_document.clone(),
            )
        }) else {
            return AppThemeStatus {
                compiler_version: COMPILER_VERSION.to_owned(),
                supported_formats: supported_profile_formats(),
                session_id: "unavailable".to_owned(),
                message: Some("Application Theme session lock failed".to_owned()),
                ..Default::default()
            };
        };

        let (runner, session_id, v2_session_id, latest_revision, dirty, doc) = snapshot;
        let available = runner.is_available();
        let paired_v2_authoring =
            runner
                .is_paired_v2_available()
                .then_some(PairedV2AuthoringCapability {
                    session_id: v2_session_id,
                    supported: true,
                });
        let message = (!available).then(|| {
            "Solar Sail compiler adapter is not available. Check that solar-sail-payload is built."
                .to_owned()
        });
        let doc = doc.as_ref();

        AppThemeStatus {
            available,
            compiler_version: COMPILER_VERSION.to_owned(),
            supported_formats: supported_profile_formats(),
            session_id,
            latest_revision,
            message,
            dirty: Some(dirty),
            active_document_id: doc.as_ref().map(|d| d.document_id.clone()),
            active_display_name: doc.as_ref().map(|d| d.display_name.clone()),
            active_schema_version: doc.as_ref().map(|d| d.schema_version),
            active_verification_status: doc.as_ref().map(|d| d.verification_status),
            paired_v2_authoring,
        }
    }

    fn claim_compile_revision(
        &self,
        requested: Option<u64>,
    ) -> StudioResult<(AppThemeRunner, u64, bool)> {
        let mut session = self.lock()?;
        let req_rev = requested.unwrap_or_else(|| session.latest_revision.saturating_add(1));
        if req_rev < session.latest_revision {
            return Ok((session.runner.clone(), req_rev, true));
        }
        session.latest_revision = req_rev;
        Ok((session.runner.clone(), req_rev, false))
    }

    pub fn compile(
        &self,
        request: AppThemeCompileRequest,
    ) -> StudioResult<AppThemeCompileResponse> {
        let (runner, req_rev, stale) = self.claim_compile_revision(request.ui_revision)?;
        if stale {
            return Ok(stale_compile_response(req_rev));
        }
        runner.compile(request.specification, Some(req_rev))
    }

    pub fn paired_compile(
        &self,
        request: AppThemePairedCompileRequest,
    ) -> StudioResult<AppThemePairedCompileResponse> {
        let (runner, req_rev, stale) = self.claim_compile_revision(request.ui_revision)?;
        if stale {
            return Ok(AppThemePairedCompileResponse {
                status: "stale".to_owned(),
                valid: false,
                ui_revision: req_rev,
                solar_sail: stale_compile_response(req_rev),
                stellar_loom: None,
                shared_tokens: vec![],
                error: Some("Stale revision rejected".to_owned()),
            });
        }
        runner.paired_compile(request.profile, Some(req_rev))
    }

    fn paired_v2_current_error(
        &self,
        status: &str,
        ui_revision: u64,
        error: Option<PairedV2Error>,
    ) -> StudioResult<AppThemePairedCompileV2Response> {
        let session = self.lock()?;
        Ok(paired_v2_compile_error(
            status,
            session.v2_session_id.clone(),
            ui_revision,
            error,
        ))
    }

    fn claim_paired_v2_compile(
        &self,
        request: &AppThemePairedCompileV2Request,
    ) -> StudioResult<Result<PairedV2CompileClaim, AppThemePairedCompileV2Response>> {
        if validate_compile_request_transport(request).is_err() {
            return Ok(Err(self.paired_v2_current_error(
                "error",
                request.ui_revision,
                Some(paired_v2_error(
                    "INVALID_REQUEST",
                    "The paired v2 compile request is invalid.",
                )),
            )?));
        }

        let (runner, session_id, latest_revision, active_document) = {
            let session = self.lock()?;
            (
                session.runner.clone(),
                session.v2_session_id.clone(),
                session.v2_latest_revision,
                session.active_document.clone(),
            )
        };
        if request.session_id != session_id {
            return Ok(Err(paired_v2_compile_error(
                "cancelled",
                request.session_id.clone(),
                request.ui_revision,
                Some(paired_v2_error(
                    "SESSION_MISMATCH",
                    "The paired v2 session is no longer current.",
                )),
            )));
        }
        if request.ui_revision < latest_revision {
            return Ok(Err(paired_v2_compile_error(
                "stale",
                request.session_id.clone(),
                request.ui_revision,
                Some(paired_v2_error(
                    "STALE_REVISION",
                    "The paired v2 compile revision is stale.",
                )),
            )));
        }

        let paired_v2_available = runner.is_paired_v2_available();
        let source = match preflight_paired_v2_source(
            request,
            active_document.as_ref(),
            paired_v2_available,
        ) {
            Ok(source) => source,
            Err(error) => {
                return Ok(Err(paired_v2_compile_error(
                    "error",
                    request.session_id.clone(),
                    request.ui_revision,
                    Some(error),
                )));
            }
        };

        let mut session = self.lock()?;
        if request.session_id != session.v2_session_id {
            return Ok(Err(paired_v2_compile_error(
                "cancelled",
                request.session_id.clone(),
                request.ui_revision,
                Some(paired_v2_error(
                    "SESSION_MISMATCH",
                    "The paired v2 session is no longer current.",
                )),
            )));
        }
        if request.ui_revision < session.v2_latest_revision {
            return Ok(Err(paired_v2_compile_error(
                "stale",
                request.session_id.clone(),
                request.ui_revision,
                Some(paired_v2_error(
                    "STALE_REVISION",
                    "The paired v2 compile revision is stale.",
                )),
            )));
        }
        if let Some(snapshot) = source.source_custody.as_ref() {
            let current = session
                .active_document
                .as_ref()
                .is_some_and(|custody| same_custody_identity(snapshot, custody));
            if !current {
                return Ok(Err(paired_v2_compile_error(
                    "cancelled",
                    request.session_id.clone(),
                    request.ui_revision,
                    Some(paired_v2_error(
                        "SUPERSEDED",
                        "The paired v2 source custody changed before execution.",
                    )),
                )));
            }
        }

        let nonce = session.v2_operation_nonce.saturating_add(1);
        let operation = session.runner.reserve_paired_v2(nonce)?;
        session.v2_latest_revision = request.ui_revision;
        session.v2_operation_nonce = nonce;
        session.v2_latest_compile = None;
        let open_generation = session.open_generation;
        let session_id = session.v2_session_id.clone();

        Ok(Ok(PairedV2CompileClaim {
            runner,
            operation,
            nonce,
            open_generation,
            session_id,
            ui_revision: request.ui_revision,
            raw_bytes: source.raw_bytes,
            baseline_raw_source_sha256: source.baseline_raw_source_sha256,
            baseline_canonical_digest: source.baseline_canonical_digest,
            document_id: source.document_id,
            parent_source_sha256: source.parent_source_sha256,
            source_custody: source.source_custody,
        }))
    }

    fn paired_v2_claim_is_current(&self, claim: &PairedV2CompileClaim) -> StudioResult<bool> {
        let session = self.lock()?;
        let custody_matches = match claim.source_custody.as_ref() {
            Some(snapshot) => session
                .active_document
                .as_ref()
                .is_some_and(|custody| same_custody_identity(snapshot, custody)),
            None => true,
        };
        Ok(session.v2_session_id == claim.session_id
            && session.v2_latest_revision == claim.ui_revision
            && session.v2_operation_nonce == claim.nonce
            && session.open_generation == claim.open_generation
            && custody_matches)
    }

    fn paired_v2_claim_failure(
        &self,
        claim: &PairedV2CompileClaim,
        status: &str,
        error: Option<PairedV2Error>,
    ) -> StudioResult<AppThemePairedCompileV2Response> {
        let session = self.lock()?;
        let current = session.v2_session_id == claim.session_id
            && session.v2_latest_revision == claim.ui_revision
            && session.v2_operation_nonce == claim.nonce
            && session.open_generation == claim.open_generation;
        if current {
            Ok(paired_v2_compile_error(
                status,
                claim.session_id.clone(),
                claim.ui_revision,
                error,
            ))
        } else {
            Ok(paired_v2_compile_error(
                "cancelled",
                claim.session_id.clone(),
                claim.ui_revision,
                Some(paired_v2_error(
                    "SUPERSEDED",
                    "The paired v2 compile result is no longer current.",
                )),
            ))
        }
    }

    pub fn paired_compile_v2(
        &self,
        request: AppThemePairedCompileV2Request,
    ) -> StudioResult<AppThemePairedCompileV2Response> {
        let claim = match self.claim_paired_v2_compile(&request)? {
            Ok(claim) => claim,
            Err(response) => return Ok(response),
        };
        if !self.paired_v2_claim_is_current(&claim)? {
            claim.runner.abort_paired_v2(&claim.operation);
            return self.paired_v2_claim_failure(
                &claim,
                "cancelled",
                Some(paired_v2_error(
                    "SUPERSEDED",
                    "The paired v2 compile result is no longer current.",
                )),
            );
        }

        let adapter_request = PairedV2AdapterCompileRequest {
            raw_source_base64: base64::engine::general_purpose::STANDARD.encode(&claim.raw_bytes),
            expected_raw_source_sha256: claim.baseline_raw_source_sha256.clone(),
            expected_canonical_digest: claim.baseline_canonical_digest.clone(),
            edits: request.edits,
            ui_revision: claim.ui_revision,
            session_id: claim.session_id.clone(),
        };
        let response =
            match claim
                .runner
                .paired_compile_v2(claim.operation, &claim.raw_bytes, adapter_request)
            {
                Ok(response) => response,
                Err(err) if err.reason_code() == StudioReasonCode::Cancelled => {
                    return self.paired_v2_claim_failure(
                        &claim,
                        "cancelled",
                        Some(paired_v2_error(
                            "CANCELLED",
                            "The paired v2 compile was cancelled.",
                        )),
                    );
                }
                Err(_) => {
                    return self.paired_v2_claim_failure(
                        &claim,
                        "error",
                        Some(paired_v2_error(
                            "COMPILE_FAILED",
                            "The paired v2 compile could not be completed.",
                        )),
                    );
                }
            };
        if validate_compile_response_for_session(&response, &claim.session_id, claim.ui_revision)
            .is_err()
        {
            return self.paired_v2_claim_failure(
                &claim,
                "error",
                Some(paired_v2_error(
                    "RESPONSE_INVALID",
                    "The paired v2 compile response failed its closed contract.",
                )),
            );
        }

        let mut session = self.lock()?;
        let custody_matches = match (
            claim.source_custody.as_ref(),
            claim.parent_source_sha256.as_ref(),
            session.active_document.as_ref(),
        ) {
            (Some(snapshot), Some(parent), Some(custody)) => {
                same_custody_identity(snapshot, custody)
                    && custody.raw_source_sha256 == *parent
                    && custody.schema_version == ProfileDocumentSchemaVersion::PairedProfileV2
            }
            (None, None, _) => true,
            _ => false,
        };
        let current = session.v2_session_id == claim.session_id
            && session.v2_latest_revision == claim.ui_revision
            && session.v2_operation_nonce == claim.nonce
            && session.open_generation == claim.open_generation
            && custody_matches;
        if !current {
            return Ok(paired_v2_compile_error(
                "cancelled",
                claim.session_id.clone(),
                claim.ui_revision,
                Some(paired_v2_error(
                    "SUPERSEDED",
                    "The paired v2 compile result is no longer current.",
                )),
            ));
        }

        match &response {
            AppThemePairedCompileV2Response::Success { draft, .. }
            | AppThemePairedCompileV2Response::Partial { draft, .. } => {
                let draft_lineage_matches = draft.baseline_raw_source_sha256.as_str()
                    == claim.baseline_raw_source_sha256.as_str()
                    && draft.baseline_canonical_digest.as_str()
                        == claim.baseline_canonical_digest.as_str()
                    && draft
                        .parent_source_sha256
                        .as_deref()
                        .is_none_or(|parent| parent == claim.baseline_raw_source_sha256.as_str());
                if !draft_lineage_matches {
                    return Ok(paired_v2_compile_error(
                        "error",
                        claim.session_id.clone(),
                        claim.ui_revision,
                        Some(paired_v2_error(
                            "RESPONSE_INVALID",
                            "The paired v2 draft lineage is invalid.",
                        )),
                    ));
                }
                let source_bytes = base64::engine::general_purpose::STANDARD
                    .decode(draft.source_bytes_base64.as_bytes())
                    .map_err(|_| {
                        StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid)
                    })?;
                if source_bytes.len() > PAIRED_V2_MAX_SOURCE_BYTES
                    || sha256_hex(&source_bytes) != draft.raw_source_sha256
                {
                    return Ok(paired_v2_compile_error(
                        "error",
                        claim.session_id.clone(),
                        claim.ui_revision,
                        Some(paired_v2_error(
                            "RESPONSE_INVALID",
                            "The paired v2 draft source identity is invalid.",
                        )),
                    ));
                }
                session.v2_latest_compile = Some(PairedV2LatestCompile {
                    nonce: claim.nonce,
                    session_id: claim.session_id.clone(),
                    ui_revision: claim.ui_revision,
                    baseline_raw_source_sha256: draft.baseline_raw_source_sha256.clone(),
                    baseline_canonical_digest: draft.baseline_canonical_digest.clone(),
                    raw_source_sha256: draft.raw_source_sha256.clone(),
                    canonical_digest: draft.canonical_digest.clone(),
                    source_bytes,
                    document_id: claim.document_id.clone(),
                    parent_source_sha256: draft
                        .parent_source_sha256
                        .clone()
                        .or_else(|| claim.parent_source_sha256.clone()),
                    profile_name: draft.profile.name.clone(),
                });
            }
            AppThemePairedCompileV2Response::Stale { .. }
            | AppThemePairedCompileV2Response::Cancelled { .. }
            | AppThemePairedCompileV2Response::Error { .. } => {}
        }
        Ok(response)
    }

    fn paired_v2_save_response(
        &self,
        request: &AppThemeSaveProfileV2Request,
        document: Option<PairedV2SavedDocument>,
        error: Option<PairedV2Error>,
        cancelled: bool,
        saved: bool,
    ) -> StudioResult<AppThemeSaveProfileV2Response> {
        let session = self.lock()?;
        let session_id = if error
            .as_ref()
            .is_some_and(|value| value.code == "INVALID_REQUEST")
        {
            session.v2_session_id.clone()
        } else {
            request.session_id.clone()
        };
        paired_v2_save_response_for_session(session_id, request, document, error, cancelled, saved)
    }

    pub(crate) fn paired_v2_save_cancelled(
        &self,
        request: &AppThemeSaveProfileV2Request,
    ) -> StudioResult<AppThemeSaveProfileV2Response> {
        self.paired_v2_save_response(request, None, None, true, false)
    }

    pub(crate) fn paired_v2_save_rejected(
        &self,
        request: &AppThemeSaveProfileV2Request,
        code: &str,
        message: &str,
    ) -> StudioResult<AppThemeSaveProfileV2Response> {
        self.paired_v2_save_response(
            request,
            None,
            Some(paired_v2_error(code, message)),
            false,
            false,
        )
    }

    pub(crate) fn prepare_save_profile_v2(
        &self,
        request: &AppThemeSaveProfileV2Request,
    ) -> StudioResult<Result<PairedV2SaveTarget, PairedV2Error>> {
        if validate_save_request_transport(request).is_err() {
            return Ok(Err(paired_v2_error(
                "INVALID_REQUEST",
                "The paired v2 save request is invalid.",
            )));
        }
        let session = self.lock()?;
        let Some(latest) = session.v2_latest_compile.as_ref() else {
            return Ok(Err(paired_v2_error(
                "NO_SUCCESSFUL_COMPILE",
                "A current paired v2 compile is required before saving.",
            )));
        };
        let latest_claim = PairedV2LatestCompileClaim {
            raw_source_sha256: latest.raw_source_sha256.clone(),
            canonical_digest: latest.canonical_digest.clone(),
            ui_revision: latest.ui_revision,
        };
        let active_claim = session
            .active_document
            .as_ref()
            .and_then(ProfileDocumentCustody::v2_active_claim);
        let edited_source_matches = request.save_mode != PairedV2SaveMode::Edited
            || latest.document_id.as_ref() == active_claim.as_ref().map(|claim| &claim.document_id);
        if request.session_id != session.v2_session_id
            || !edited_source_matches
            || validate_save_request_for_session(
                request,
                &session.v2_session_id,
                &latest_claim,
                active_claim.as_ref(),
            )
            .is_err()
        {
            return Ok(Err(paired_v2_error(
                "SAVE_GUARD_REJECTED",
                "The paired v2 save request is not current.",
            )));
        }
        let target = match request.save_mode {
            PairedV2SaveMode::Edited => {
                let Some(custody) = session.active_document.as_ref() else {
                    return Ok(Err(paired_v2_error(
                        "SAVE_GUARD_REJECTED",
                        "Edited save requires an active v2 custody document.",
                    )));
                };
                PairedV2SaveTarget {
                    existing_path: Some(custody.backing_path.clone()),
                    default_name: custody.display_name.clone(),
                }
            }
            PairedV2SaveMode::NewDocument => PairedV2SaveTarget {
                existing_path: None,
                default_name: default_profile_filename(&latest.profile_name),
            },
        };
        Ok(Ok(target))
    }

    pub fn save_profile_v2_path_with_ticket(
        &self,
        request: AppThemeSaveProfileV2Request,
        path: PathBuf,
        ticket: u64,
    ) -> StudioResult<AppThemeSaveProfileV2Response> {
        if validate_save_request_transport(&request).is_err() {
            return self.paired_v2_save_rejected(
                &request,
                "INVALID_REQUEST",
                "The paired v2 save request is invalid.",
            );
        }
        let (runner, latest, active_snapshot) = {
            let session = self.lock()?;
            if session.open_generation != ticket {
                return paired_v2_save_response_for_session(
                    request.session_id.clone(),
                    &request,
                    None,
                    None,
                    true,
                    false,
                );
            }
            let Some(latest) = session.v2_latest_compile.clone() else {
                return paired_v2_save_response_for_session(
                    request.session_id.clone(),
                    &request,
                    None,
                    Some(paired_v2_error(
                        "NO_SUCCESSFUL_COMPILE",
                        "A current paired v2 compile is required before saving.",
                    )),
                    false,
                    false,
                );
            };
            let latest_claim = PairedV2LatestCompileClaim {
                raw_source_sha256: latest.raw_source_sha256.clone(),
                canonical_digest: latest.canonical_digest.clone(),
                ui_revision: latest.ui_revision,
            };
            let active_snapshot = session.active_document.clone();
            let active_claim = active_snapshot
                .as_ref()
                .and_then(ProfileDocumentCustody::v2_active_claim);
            let edited_source_matches = request.save_mode != PairedV2SaveMode::Edited
                || latest.document_id.as_ref()
                    == active_claim.as_ref().map(|claim| &claim.document_id);
            if validate_save_request_for_session(
                &request,
                &session.v2_session_id,
                &latest_claim,
                active_claim.as_ref(),
            )
            .is_err()
                || !edited_source_matches
            {
                return paired_v2_save_response_for_session(
                    request.session_id.clone(),
                    &request,
                    None,
                    Some(paired_v2_error(
                        "SAVE_GUARD_REJECTED",
                        "The paired v2 save request is not current.",
                    )),
                    false,
                    false,
                );
            }
            (session.runner.clone(), latest, active_snapshot)
        };

        let draft_bytes = base64::engine::general_purpose::STANDARD
            .decode(&request.draft_source_base64)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;
        if draft_bytes.len() > PAIRED_V2_MAX_SOURCE_BYTES
            || sha256_hex(&draft_bytes) != request.expected_draft_raw_source_sha256
        {
            return self.paired_v2_save_rejected(
                &request,
                "DRAFT_IDENTITY_MISMATCH",
                "The paired v2 draft source identity is not current.",
            );
        }

        let bound = match runner.bind_document(&draft_bytes, None) {
            Ok(bound) if bound.status == "bound" => bound,
            Err(err) if err.reason_code() == StudioReasonCode::Cancelled => {
                return self.paired_v2_save_cancelled(&request);
            }
            _ => {
                return self.paired_v2_save_rejected(
                    &request,
                    "DRAFT_BIND_FAILED",
                    "The paired v2 draft could not be verified for saving.",
                );
            }
        };
        let valid_bound = bound.schema_version == ProfileDocumentSchemaVersion::PairedProfileV2
            && bound.valid
            && bound.verification_status == ProfileVerificationStatus::Verified
            && bound.v2_profile.is_some()
            && bound.raw_source_sha256 == request.expected_draft_raw_source_sha256
            && bound.canonical_digest.as_deref()
                == Some(request.expected_canonical_digest.as_str())
            && bound.owner_binding.as_ref().is_some_and(|binding| {
                binding.input_origin == OwnerBindingInputOrigin::SourceBytes
                    && binding.raw_source_sha256 == request.expected_draft_raw_source_sha256
                    && binding.verification_status == ProfileVerificationStatus::Verified
                    && !binding.is_transformed
                    && binding.parent_source_sha256.is_none()
                    && binding.byte_length == draft_bytes.len() as u64
                    && binding.canonical_digest.as_deref()
                        == Some(request.expected_canonical_digest.as_str())
            });
        if !valid_bound {
            return self.paired_v2_save_rejected(
                &request,
                "DRAFT_IDENTITY_MISMATCH",
                "The paired v2 draft binder identity is not current.",
            );
        }
        let bound_canonical_digest = bound
            .canonical_digest
            .clone()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        // Hold the state mutex across the final live-custody fence, no-follow
        // disk check, and atomic rename. Reset/cancel can therefore either win
        // before this fence or observe the committed write.
        let mut session = self.lock()?;
        let live_custody_matches_snapshot =
            match (active_snapshot.as_ref(), session.active_document.as_ref()) {
                (Some(snapshot), Some(live)) => same_custody_identity(snapshot, live),
                (None, None) => true,
                _ => false,
            };
        let custody_identity_matches = live_custody_matches_snapshot
            && latest_compile_custody_matches(
                latest.document_id.as_deref(),
                latest.baseline_raw_source_sha256.as_str(),
                session.active_document.as_ref(),
            );
        let latest_current = session.v2_latest_compile.as_ref().is_some_and(|current| {
            current.nonce == latest.nonce
                && current.session_id == request.session_id
                && current.ui_revision == request.expected_compile_ui_revision
                && current.baseline_raw_source_sha256 == latest.baseline_raw_source_sha256
                && current.baseline_canonical_digest == latest.baseline_canonical_digest
                && current.raw_source_sha256 == request.expected_compile_raw_source_sha256
                && current.canonical_digest == request.expected_compile_canonical_digest
                && current.source_bytes == draft_bytes
                && match request.save_mode {
                    PairedV2SaveMode::Edited => {
                        request.expected_parent_source_sha256.as_deref()
                            == Some(latest.baseline_raw_source_sha256.as_str())
                            && current.parent_source_sha256.as_deref()
                                == Some(latest.baseline_raw_source_sha256.as_str())
                    }
                    PairedV2SaveMode::NewDocument => true,
                }
                && custody_identity_matches
        });
        if session.open_generation != ticket
            || session.v2_session_id != request.session_id
            || !latest_current
        {
            return paired_v2_save_response_for_session(
                request.session_id.clone(),
                &request,
                None,
                None,
                true,
                false,
            );
        }

        if request.save_mode == PairedV2SaveMode::Edited {
            let Some(custody) = session.active_document.as_ref() else {
                return paired_v2_save_response_for_session(
                    request.session_id.clone(),
                    &request,
                    None,
                    Some(paired_v2_error(
                        "SAVE_GUARD_REJECTED",
                        "Edited save requires an active v2 custody document.",
                    )),
                    false,
                    false,
                );
            };
            if custody.backing_path != path {
                return paired_v2_save_response_for_session(
                    request.session_id.clone(),
                    &request,
                    None,
                    Some(paired_v2_error(
                        "SAVE_GUARD_REJECTED",
                        "Edited save destination does not match custody.",
                    )),
                    false,
                    false,
                );
            }
        }

        // NewDocument is also guarded when the selected path aliases the live
        // custody path. A missing or dangling custody leaf conservatively
        // protects every destination in the same parent directory until a
        // reset/reopen establishes a new custody root.
        if let Some(custody) = session.active_document.as_ref() {
            let aliases_custody =
                destination_aliases_custody(&path, &custody.backing_path).unwrap_or(true);
            if aliases_custody {
                let Ok((disk_bytes, disk_mtime)) = read_bounded_profile_bytes(&path) else {
                    return paired_v2_save_response_for_session(
                        request.session_id.clone(),
                        &request,
                        None,
                        Some(paired_v2_error(
                            "EXTERNAL_MODIFICATION",
                            "The custody file changed externally; save was rejected.",
                        )),
                        false,
                        false,
                    );
                };
                let mtime_conflict = matches!(
                    (custody.backing_mtime, disk_mtime),
                    (Some(saved), Some(current)) if saved != current
                );
                if mtime_conflict || sha256_hex(&disk_bytes) != custody.raw_source_sha256 {
                    return paired_v2_save_response_for_session(
                        request.session_id.clone(),
                        &request,
                        None,
                        Some(paired_v2_error(
                            "EXTERNAL_MODIFICATION",
                            "The custody file changed externally; save was rejected.",
                        )),
                        false,
                        false,
                    );
                }
            }
        }

        let (document_id, next_document_seq) = match (request.save_mode, active_snapshot.as_ref()) {
            (PairedV2SaveMode::Edited, Some(custody)) => (custody.document_id.clone(), None),
            _ => {
                let next = session.next_document_seq.saturating_add(1);
                let input = format!("{}:doc:{next}", session.session_id);
                let digest = sha256_hex(input.as_bytes());
                (format!("tfsb-profile-doc-{}", &digest[..16]), Some(next))
            }
        };
        let display_name = sanitize_paired_v2_display_name(&path);
        let raw_source_sha256 = request.expected_draft_raw_source_sha256.clone();
        let canonical_digest = bound_canonical_digest.clone();
        let response = AppThemeSaveProfileV2Response {
            cancelled: false,
            saved: true,
            session_id: request.session_id.clone(),
            ui_revision: request.ui_revision,
            document: Some(PairedV2SavedDocument {
                document_id: document_id.clone(),
                raw_source_sha256: raw_source_sha256.clone(),
                canonical_digest: canonical_digest.clone(),
                display_name: display_name.clone(),
            }),
            error: None,
        };
        // Validate every response field before rename. No fallible response
        // validation or panic path is permitted after a committed write.
        validate_save_response_transport(&response)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        let backing_mtime =
            match atomic_write_paired_v2_profile(&path, &draft_bytes, request.save_mode) {
                Ok(mtime) => mtime,
                Err(_) => {
                    return paired_v2_save_response_for_session(
                        request.session_id.clone(),
                        &request,
                        None,
                        Some(paired_v2_error(
                            "SAVE_FAILED",
                            "The paired v2 profile could not be saved.",
                        )),
                        false,
                        false,
                    );
                }
            };

        let mut new_custody = ProfileDocumentCustody::from_source(
            FileSourceMeta::new(path, draft_bytes, backing_mtime),
            ProfileDocumentSchemaVersion::PairedProfileV2,
            ProfileVerificationStatus::Verified,
            ProfileSemanticStatus::Validated,
            false,
        );
        new_custody.document_id = document_id.clone();
        new_custody.display_name = display_name.clone();
        new_custody.canonical_digest = Some(bound_canonical_digest);
        new_custody.owner_binding = bound.owner_binding;
        new_custody.v2_profile = bound.v2_profile;
        new_custody.readonly_reason = Some(
            "Paired Profile v2 documents remain read-only in the legacy document API.".to_owned(),
        );
        if let Some(next) = next_document_seq {
            session.next_document_seq = next;
        }
        session.active_document = Some(new_custody);
        session.v2_latest_compile = None;
        session.dirty = false;
        Ok(response)
    }

    pub fn begin_open(&self) -> StudioResult<u64> {
        let mut session = self.lock()?;
        session.runner.cancel_paired_v2();
        session.open_generation = session.open_generation.saturating_add(1);
        session.rotate_v2_epoch();
        Ok(session.open_generation)
    }

    pub fn current_custody_ticket(&self) -> StudioResult<u64> {
        Ok(self.lock()?.open_generation)
    }

    pub(crate) fn publish_paired_packet_to_path(
        &self,
        path: &Path,
        expected_kind: PairedV2PacketKind,
        envelope: &PairedV2PacketEnvelope,
    ) -> StudioResult<usize> {
        let parsed = parse_packet(
            envelope.canonical_json.as_bytes(),
            Some(expected_kind.schema()),
        )?;
        if !envelope.packet_digest_verified
            || envelope.kind != expected_kind.schema()
            || envelope.kind != envelope.packet.kind().schema()
            || envelope.digest != envelope.packet.digest()
            || parsed.packet != envelope.packet
            || parsed.kind != envelope.kind
            || parsed.digest != envelope.digest
            || parsed.canonical_json != envelope.canonical_json
            || envelope.canonical_json.len() > PAIRED_V2_PACKET_MAX_BYTES
        {
            return Err(StudioCommandError::new(StudioReasonCode::ProtocolInvalid));
        }

        // Keep the custody alias check and the absent-only publisher in one
        // session-lock interval. The snapshot canonicalizes the parent, records
        // its identity where available, and follows an existing leaf only to
        // compare its identity. Missing or dangling custody protects every
        // destination in that parent. A missing custody parent fails closed and
        // remains refused until reset/reopen establishes a new custody root.
        // The mutex is not an inter-process compare-and-swap; external renames
        // can still race after this local snapshot.
        let session = self.lock()?;
        if let Some(custody) = session.active_document.as_ref()
            && destination_aliases_custody(path, &custody.backing_path)?
        {
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }
        publish_paired_selected_bytes(path, envelope.canonical_json.as_bytes())
    }

    pub fn document_ticket_counts(&self) -> (u64, u64) {
        self.lock()
            .map_or((0, 0), |s| s.runner.document_ticket_counts())
    }

    pub fn open_profile_path(&self, path: PathBuf) -> StudioResult<AppThemeOpenProfileResponse> {
        let ticket = self.begin_open()?;
        self.open_profile_path_with_ticket(path, ticket)
    }

    pub fn open_profile_path_with_ticket(
        &self,
        path: PathBuf,
        ticket: u64,
    ) -> StudioResult<AppThemeOpenProfileResponse> {
        let runner = {
            let session = self.lock()?;
            if session.open_generation != ticket {
                return Ok(open_cancelled());
            }
            session.runner.clone()
        };

        let (raw_bytes, backing_mtime) = match read_bounded_profile_bytes(&path) {
            Ok(pair) => pair,
            Err(err_msg) => {
                return Ok(if self.lock()?.open_generation != ticket {
                    open_cancelled()
                } else {
                    open_error(err_msg)
                });
            }
        };

        let src = FileSourceMeta::new(path, raw_bytes, backing_mtime);

        let mut pending_custody = match runner.bind_document(&src.raw_bytes, None) {
            Ok(bound) => match classify_bound_document(&runner, src, bound) {
                Ok(doc) => doc,
                Err(err)
                    if err.reason_code() == StudioReasonCode::Cancelled
                        || self.lock()?.open_generation != ticket =>
                {
                    return Ok(open_cancelled());
                }
                Err(err) => return Ok(open_error(sanitize_untrusted_text(&err.to_string(), 512))),
            },
            Err(err) if err.reason_code() == StudioReasonCode::SidecarArtifactUnavailable => {
                match PairedProfileDto::from_slice_with_alias_flag(&src.raw_bytes) {
                    Ok((dto, alias)) => {
                        if dto.schema_version != "tf-paired-profile-v1" {
                            return Ok(if self.lock()?.open_generation != ticket {
                                open_cancelled()
                            } else {
                                open_error(format!(
                                    "Invalid profile schema: expected 'tf-paired-profile-v1', got '{}'",
                                    sanitize_untrusted_text(&dto.schema_version, 128)
                                ))
                            });
                        }
                        ProfileDocumentCustody::v1_editable(
                            src,
                            ProfileSemanticStatus::Unavailable,
                            Box::new(dto),
                            None,
                            alias,
                        )
                        .with_diag(
                            None,
                            Some("ADAPTER_UNAVAILABLE"),
                            Some("Solar Sail adapter is unavailable; opened via local closed v1 DTO fallback.".to_owned()),
                        )
                    }
                    Err(parse_err) => ProfileDocumentCustody::new_corrupt(
                        src,
                        false,
                        "Document failed strict local v1 DTO parsing while adapter is unavailable.",
                        Some("LOCAL_DTO_REJECTED"),
                        Some(sanitize_untrusted_text(&parse_err, 512)),
                    ),
                }
            }
            Err(err)
                if err.reason_code() == StudioReasonCode::Cancelled
                    || self.lock()?.open_generation != ticket =>
            {
                return Ok(open_cancelled());
            }
            Err(err) => return Ok(open_error(sanitize_untrusted_text(&err.to_string(), 512))),
        };

        let paired_v2_available = runner.is_paired_v2_available();
        let mut session = self.lock()?;
        if session.open_generation != ticket {
            return Ok(open_cancelled());
        }

        pending_custody.document_id = session.mint_document_id();
        let v2_eligible = v2_authoring_eligible(&pending_custody, paired_v2_available);
        let opened_doc = pending_custody.to_opened_document(v2_eligible);
        session.active_document = Some(pending_custody);
        session.dirty = false;

        Ok(AppThemeOpenProfileResponse {
            cancelled: false,
            document: Some(opened_doc),
            error: None,
        })
    }

    pub fn prepare_save_target(
        &self,
        request: &AppThemeSaveProfileRequest,
    ) -> StudioResult<Result<(Option<PathBuf>, String), String>> {
        let session = self.lock()?;
        Ok(
            validate_save_request(session.active_document.as_ref(), request)
                .map(|(_, path, default_name)| (path, default_name)),
        )
    }

    pub fn save_profile_path(
        &self,
        request: AppThemeSaveProfileRequest,
        path: PathBuf,
    ) -> StudioResult<AppThemeSaveProfileResponse> {
        self.save_profile_path_with_ticket(request, path, None)
    }

    pub fn save_profile_path_with_ticket(
        &self,
        request: AppThemeSaveProfileRequest,
        path: PathBuf,
        ticket: Option<u64>,
    ) -> StudioResult<AppThemeSaveProfileResponse> {
        let (runner, effective_mode, active_snapshot, effective_ticket) = {
            let session = self.lock()?;
            let eff_ticket = ticket.unwrap_or(session.open_generation);
            if session.open_generation != eff_ticket {
                return Ok(save_cancelled());
            }
            let (mode, _, _) =
                match validate_save_request(session.active_document.as_ref(), &request) {
                    Ok(triple) => triple,
                    Err(err_msg) => return Ok(save_error(err_msg)),
                };
            (
                session.runner.clone(),
                mode,
                session.active_document.clone(),
                eff_ticket,
            )
        };

        if let Some(ref custody) = active_snapshot
            && custody.backing_path == path
            && path.exists()
        {
            let Ok((disk_bytes, disk_mtime)) = read_bounded_profile_bytes(&path) else {
                return Ok(save_error(
                    "File was modified externally; save rejected to prevent overwriting changes",
                ));
            };
            let mtime_conflict = matches!(
                (custody.backing_mtime, disk_mtime),
                (Some(saved), Some(current)) if saved != current
            );
            if mtime_conflict || sha256_hex(&disk_bytes) != custody.raw_source_sha256 {
                return Ok(save_error(
                    "File was modified externally; save rejected to prevent overwriting changes",
                ));
            }
        }

        match effective_mode {
            ProfileSaveMode::Original => {
                self.save_original_profile(&runner, active_snapshot, path, effective_ticket)
            }
            ProfileSaveMode::Edited | ProfileSaveMode::NewDocument => self.save_serialized_profile(
                &runner,
                effective_mode,
                active_snapshot,
                request.profile,
                path,
                effective_ticket,
            ),
        }
    }

    fn save_original_profile(
        &self,
        runner: &AppThemeRunner,
        active_snapshot: Option<ProfileDocumentCustody>,
        path: PathBuf,
        effective_ticket: u64,
    ) -> StudioResult<AppThemeSaveProfileResponse> {
        let Some(mut updated) = active_snapshot else {
            return Ok(save_error(
                "Save Original requires an active opened profile document",
            ));
        };
        if sha256_hex(&updated.raw_bytes) != updated.raw_source_sha256 {
            return Ok(save_error("Custodial source digest mismatch; save aborted"));
        }
        if self.lock()?.open_generation != effective_ticket {
            return Ok(save_cancelled());
        }
        let mtime = match atomic_write_bytes(&path, &updated.raw_bytes) {
            Ok(m) => m,
            Err(e) => return Ok(save_error(e)),
        };
        updated.backing_path = path.clone();
        updated.backing_mtime = mtime;
        updated.display_name = sanitize_display_name(&path);
        let paired_v2_available = runner.is_paired_v2_available();

        let mut session = self.lock()?;
        if session.open_generation != effective_ticket {
            return Ok(save_cancelled());
        }
        let opened_doc =
            updated.to_opened_document(v2_authoring_eligible(&updated, paired_v2_available));
        session.active_document = Some(updated);
        session.dirty = false;
        Ok(save_ok(opened_doc))
    }

    fn save_serialized_profile(
        &self,
        runner: &AppThemeRunner,
        effective_mode: ProfileSaveMode,
        active_snapshot: Option<ProfileDocumentCustody>,
        profile_opt: Option<PairedProfileDto>,
        path: PathBuf,
        effective_ticket: u64,
    ) -> StudioResult<AppThemeSaveProfileResponse> {
        let Some(profile) = profile_opt else {
            return Ok(save_error("Save requires a profile payload"));
        };
        let parent_sha = match (effective_mode, active_snapshot.as_ref()) {
            (ProfileSaveMode::Edited, Some(custody)) => {
                if sha256_hex(&custody.raw_bytes) != custody.raw_source_sha256 {
                    return Ok(save_error("Custodial source digest mismatch; save aborted"));
                }
                Some(custody.raw_source_sha256.clone())
            }
            _ => None,
        };

        let mut serialized = match serde_json::to_string_pretty(&profile) {
            Ok(s) => s,
            Err(e) => {
                return Ok(save_error(format!(
                    "Serialization failed: {}",
                    sanitize_untrusted_text(&e.to_string(), 200)
                )));
            }
        };
        serialized.push('\n');
        let raw_bytes = serialized.into_bytes();
        let expected_saved_sha = sha256_hex(&raw_bytes);

        let (semantic, ver_status, is_transformed, normalized_sha256, owner_binding, bound_profile) =
            match runner.bind_document(&raw_bytes, None) {
                Ok(bound) if bound.status == "bound" => {
                    let valid_owner = bound.owner_binding.as_ref().is_some_and(|ob| {
                        ob.input_origin == OwnerBindingInputOrigin::SourceBytes
                            && ob.raw_source_sha256 == expected_saved_sha
                            && ob.byte_length == raw_bytes.len() as u64
                            && ob.verification_status == ProfileVerificationStatus::Verified
                            && !ob.is_transformed
                            && ob.parent_source_sha256.is_none()
                            && ob.canonical_digest.is_none()
                            && ob.normalized_sha256.is_some()
                            && ob.normalized_sha256 == bound.normalized_sha256
                    });
                    if !bound.valid
                        || bound.schema_version != ProfileDocumentSchemaVersion::PairedProfileV1
                        || bound.alias_resolved
                        || bound.raw_source_sha256 != expected_saved_sha
                        || !valid_owner
                    {
                        return Ok(save_error("Save validation returned invalid owner binding"));
                    }
                    let ver = if parent_sha.is_some() {
                        ProfileVerificationStatus::Transformed
                    } else {
                        ProfileVerificationStatus::Verified
                    };
                    (
                        ProfileSemanticStatus::Validated,
                        ver,
                        parent_sha.is_some(),
                        bound.normalized_sha256,
                        bound.owner_binding,
                        bound.profile.unwrap_or_else(|| Box::new(profile.clone())),
                    )
                }
                Ok(bound) => {
                    return Ok(save_error(bound.error.unwrap_or_else(|| {
                        "Edited profile failed owner validation".to_owned()
                    })));
                }
                Err(err) if err.reason_code() == StudioReasonCode::SidecarArtifactUnavailable => {
                    let ver = if parent_sha.is_some() {
                        ProfileVerificationStatus::Transformed
                    } else {
                        ProfileVerificationStatus::UnverifiedAssertion
                    };
                    (
                        ProfileSemanticStatus::Unavailable,
                        ver,
                        parent_sha.is_some(),
                        None,
                        None,
                        Box::new(profile.clone()),
                    )
                }
                Err(err)
                    if err.reason_code() == StudioReasonCode::Cancelled
                        || self.lock()?.open_generation != effective_ticket =>
                {
                    return Ok(save_cancelled());
                }
                Err(err) => return Ok(save_error(sanitize_untrusted_text(&err.to_string(), 512))),
            };

        if self.lock()?.open_generation != effective_ticket {
            return Ok(save_cancelled());
        }
        let backing_mtime = match atomic_write_bytes(&path, &raw_bytes) {
            Ok(m) => m,
            Err(e) => return Ok(save_error(e)),
        };
        let mut session = self.lock()?;
        if session.open_generation != effective_ticket {
            return Ok(save_cancelled());
        }
        let document_id = match active_snapshot.as_ref() {
            Some(prev) if effective_mode == ProfileSaveMode::Edited => prev.document_id.clone(),
            _ => session.mint_document_id(),
        };
        let src = FileSourceMeta::new(path, raw_bytes, backing_mtime);
        let mut new_custody = ProfileDocumentCustody::v1_editable(
            src,
            semantic,
            bound_profile,
            normalized_sha256,
            false,
        );
        new_custody.verification_status = ver_status;
        new_custody.is_transformed = is_transformed;
        new_custody.owner_binding = owner_binding;
        new_custody.parent_source_sha256 = parent_sha;
        new_custody.document_id = document_id;
        let opened_doc = new_custody.to_opened_document(false);
        session.active_document = Some(new_custody);
        session.dirty = false;
        Ok(save_ok(opened_doc))
    }

    pub fn export_package_to_path(
        &self,
        specification: ThemeSpecificationDto,
        destination: String,
        language: Option<String>,
    ) -> StudioResult<AppThemeExportResponse> {
        let runner = self.lock()?.runner.clone();
        runner.export_package(specification, destination, language)
    }

    pub fn reset(&self) -> StudioResult<AppThemeStatus> {
        {
            let mut session = self.lock()?;
            session.runner.cancel_all();
            session.open_generation = session.open_generation.saturating_add(1);
            session.latest_revision = session.latest_revision.saturating_add(1);
            session.rotate_v2_epoch();
            session.active_document = None;
            session.dirty = false;
        }
        Ok(self.status())
    }
}

#[cfg(test)]
#[path = "paired_v2_state_tests.rs"]
mod paired_v2_state_tests;

#[cfg(all(test, unix))]
mod writer_mode_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn paired_v2_new_document_writer_round_trips_private_mode() {
        let suffix = SAVE_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let directory = std::env::temp_dir().join(format!(
            "tfsb-paired-v2-mode-{}-{suffix}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&directory);
        assert!(fs::create_dir(&directory).is_ok());
        let target = directory.join("profile.json");
        let bytes = br#"{"schema":"tf-paired-profile-v2"}
"#;

        assert!(
            atomic_write_paired_v2_profile(&target, bytes, PairedV2SaveMode::NewDocument,).is_ok()
        );
        assert_eq!(fs::read(&target).ok().as_deref(), Some(bytes.as_slice()));
        let mode = fs::metadata(&target).map(|metadata| metadata.permissions().mode() & 0o777);
        assert_eq!(mode.ok(), Some(0o600));
        assert!(fs::read_dir(&directory).is_ok_and(|entries| {
            entries.filter_map(Result::ok).all(|entry| {
                !entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".tfsb-tmp-save-")
            })
        }));
        assert!(fs::remove_dir_all(directory).is_ok());
    }
}
