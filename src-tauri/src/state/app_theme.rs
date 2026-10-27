use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

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
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

static SAVE_TEMP_COUNTER: AtomicU64 = AtomicU64::new(1);

fn supported_profile_formats() -> Vec<String> {
    vec!["tf-paired-profile-v1".to_owned(), "tf-paired-profile-v2".to_owned()]
}

fn open_cancelled() -> AppThemeOpenProfileResponse {
    AppThemeOpenProfileResponse { cancelled: true, ..Default::default() }
}

fn open_error(msg: impl Into<String>) -> AppThemeOpenProfileResponse {
    AppThemeOpenProfileResponse { error: Some(msg.into()), ..Default::default() }
}

fn save_cancelled() -> AppThemeSaveProfileResponse {
    AppThemeSaveProfileResponse { cancelled: true, ..Default::default() }
}

fn save_error(msg: impl Into<String>) -> AppThemeSaveProfileResponse {
    AppThemeSaveProfileResponse { error: Some(msg.into()), ..Default::default() }
}

fn save_ok(doc: AppThemeOpenedDocument) -> AppThemeSaveProfileResponse {
    AppThemeSaveProfileResponse { saved: true, document: Some(doc), ..Default::default() }
}

fn sanitize_display_name(path: &Path) -> String {
    let raw = path.file_name().and_then(|n| n.to_str()).unwrap_or("profile.json");
    let cleaned = sanitize_untrusted_text(raw, 128);
    if cleaned.is_empty() { "profile.json".to_owned() } else { cleaned }
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
    if trimmed.is_empty() { "profile.json".to_owned() } else { format!("{trimmed}.profile.json") }
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fmt_io_err(prefix: &str, err: &std::io::Error) -> String {
    format!("{prefix}: {}", sanitize_untrusted_text(&err.to_string(), 200))
}

fn read_bounded_profile_bytes(path: &Path) -> Result<(Vec<u8>, Option<SystemTime>), String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|e| fmt_io_err("Failed to inspect profile metadata", &e))?;
    if !meta.file_type().is_file() {
        return Err("Profile path must reference a regular file".to_owned());
    }
    if meta.len() > MAX_PROFILE_DOCUMENT_BYTES as u64 {
        return Err(format!(
            "Profile document exceeds maximum size of {MAX_PROFILE_DOCUMENT_BYTES} bytes"
        ));
    }
    let file = fs::File::open(path).map_err(|e| fmt_io_err("Failed to open profile", &e))?;
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
    Ok((bytes, meta.modified().ok()))
}

fn atomic_write_bytes(path: &Path, bytes: &[u8]) -> Result<Option<SystemTime>, String> {
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
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
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

    fn with_diag(mut self, reason: Option<&str>, code: Option<&str>, summary: Option<String>) -> Self {
        self.readonly_reason = reason.map(str::to_owned);
        self.diagnostic_code = code.map(str::to_owned);
        self.diagnostic_summary = summary;
        self
    }

    fn new_corrupt(src: FileSourceMeta, alias_resolved: bool, reason: &str, code: Option<&str>, summary: Option<String>) -> Self {
        let mut doc = Self::from_source(src, ProfileDocumentSchemaVersion::Corrupt, ProfileVerificationStatus::Corrupt, ProfileSemanticStatus::Rejected, false);
        doc.alias_resolved = alias_resolved;
        doc.with_diag(Some(reason), code, summary)
    }

    fn to_opened_document(&self) -> AppThemeOpenedDocument {
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
            profile: self.profile.as_deref().cloned(),
            v2_profile: self.v2_profile.as_deref().cloned(),
        }
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
            Ok((mode, Some(custody.backing_path.clone()), custody.display_name.clone()))
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
                        "Document handle does not match the active profile document".to_owned(),
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
                Ok((mode, Some(custody.backing_path.clone()), custody.display_name.clone()))
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
    active_document: Option<ProfileDocumentCustody>,
    next_document_seq: u64,
    open_generation: u64,
    latest_revision: u64,
    dirty: bool,
}

impl AppThemeSession {
    fn mint_document_id(&mut self) -> String {
        self.next_document_seq = self.next_document_seq.saturating_add(1);
        let input = format!("{}:doc:{}", self.session_id, self.next_document_seq);
        let digest = sha256_hex(input.as_bytes());
        format!("tfsb-profile-doc-{}", &digest[..16])
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
            session.runner.cancel_active();
        }
    }

    pub fn status(&self) -> AppThemeStatus {
        let Ok(session) = self.lock() else {
            return AppThemeStatus {
                compiler_version: COMPILER_VERSION.to_owned(),
                supported_formats: supported_profile_formats(),
                session_id: "unavailable".to_owned(),
                message: Some("Application Theme session lock failed".to_owned()),
                ..Default::default()
            };
        };

        let available = session.runner.is_available();
        let message = (!available).then(|| {
            "Solar Sail compiler adapter is not available. Check that solar-sail-payload is built."
                .to_owned()
        });
        let doc = session.active_document.as_ref();

        AppThemeStatus {
            available,
            compiler_version: COMPILER_VERSION.to_owned(),
            supported_formats: supported_profile_formats(),
            session_id: session.session_id.clone(),
            latest_revision: session.latest_revision,
            message,
            dirty: Some(session.dirty),
            active_document_id: doc.map(|d| d.document_id.clone()),
            active_display_name: doc.map(|d| d.display_name.clone()),
            active_schema_version: doc.map(|d| d.schema_version),
            active_verification_status: doc.map(|d| d.verification_status),
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

    pub fn begin_open(&self) -> StudioResult<u64> {
        let mut session = self.lock()?;
        session.open_generation = session.open_generation.saturating_add(1);
        Ok(session.open_generation)
    }

    pub fn current_custody_ticket(&self) -> StudioResult<u64> {
        Ok(self.lock()?.open_generation)
    }

    pub fn document_ticket_counts(&self) -> (u64, u64) {
        self.lock().map_or((0, 0), |s| s.runner.document_ticket_counts())
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
                Err(err) if err.reason_code() == StudioReasonCode::Cancelled
                    || self.lock()?.open_generation != ticket => return Ok(open_cancelled()),
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
            Err(err) if err.reason_code() == StudioReasonCode::Cancelled
                || self.lock()?.open_generation != ticket => return Ok(open_cancelled()),
            Err(err) => return Ok(open_error(sanitize_untrusted_text(&err.to_string(), 512))),
        };

        let mut session = self.lock()?;
        if session.open_generation != ticket {
            return Ok(open_cancelled());
        }

        pending_custody.document_id = session.mint_document_id();
        let opened_doc = pending_custody.to_opened_document();
        session.active_document = Some(pending_custody);
        session.dirty = false;

        Ok(AppThemeOpenProfileResponse { cancelled: false, document: Some(opened_doc), error: None })
    }

    pub fn prepare_save_target(
        &self,
        request: &AppThemeSaveProfileRequest,
    ) -> StudioResult<Result<(Option<PathBuf>, String), String>> {
        let session = self.lock()?;
        Ok(validate_save_request(session.active_document.as_ref(), request)
            .map(|(_, path, default_name)| (path, default_name)))
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
            let (mode, _, _) = match validate_save_request(session.active_document.as_ref(), &request) {
                Ok(triple) => triple,
                Err(err_msg) => return Ok(save_error(err_msg)),
            };
            (session.runner.clone(), mode, session.active_document.clone(), eff_ticket)
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
                self.save_original_profile(active_snapshot, path, effective_ticket)
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
        active_snapshot: Option<ProfileDocumentCustody>,
        path: PathBuf,
        effective_ticket: u64,
    ) -> StudioResult<AppThemeSaveProfileResponse> {
        let Some(mut updated) = active_snapshot else {
            return Ok(save_error("Save Original requires an active opened profile document"));
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

        let mut session = self.lock()?;
        if session.open_generation != effective_ticket {
            return Ok(save_cancelled());
        }
        let opened_doc = updated.to_opened_document();
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
                Err(err) if err.reason_code() == StudioReasonCode::Cancelled
                    || self.lock()?.open_generation != effective_ticket => return Ok(save_cancelled()),
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
        let mut new_custody =
            ProfileDocumentCustody::v1_editable(src, semantic, bound_profile, normalized_sha256, false);
        new_custody.verification_status = ver_status;
        new_custody.is_transformed = is_transformed;
        new_custody.owner_binding = owner_binding;
        new_custody.parent_source_sha256 = parent_sha;
        new_custody.document_id = document_id;
        let opened_doc = new_custody.to_opened_document();
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
            session.active_document = None;
            session.dirty = false;
        }
        Ok(self.status())
    }
}
