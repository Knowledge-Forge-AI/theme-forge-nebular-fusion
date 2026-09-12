use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::SystemTime;

use sha2::{Digest, Sha256};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::theme_lab::runner::{COMPILER_VERSION, ThemeLabRunner};
use crate::theme_lab::types::{
    ThemeCandidateAdoptRequest, ThemeCandidateAdoptResponse, ThemeCandidateVerificationResult,
    ThemeDescriptor, ThemeDocument, ThemeDraftUpdateRequest, ThemeDraftUpdateResponse,
    ThemeLabCompileRequest, ThemeLabCompileResponse, ThemeLabError, ThemeLabExampleResponse,
    ThemeLabOpenResponse, ThemeLabStatus,
};

#[derive(Clone)]
pub struct ThemeLabState {
    shared: Arc<ThemeLabShared>,
}

impl std::fmt::Debug for ThemeLabState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThemeLabState").finish_non_exhaustive()
    }
}

struct ThemeLabShared {
    inner: Mutex<ThemeLabSession>,
}

struct ThemeLabSession {
    runner: ThemeLabRunner,
    session_id: String,
    active_file_path: Option<PathBuf>,
    active_display_name: Option<String>,
    active_file_mtime: Option<SystemTime>,
    latest_revision: u64,
    dirty: bool,
    adopted_theme_digest: Option<String>,
}

impl ThemeLabState {
    pub fn new(runner: ThemeLabRunner) -> Self {
        let nanos = match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
            Ok(d) => d.as_nanos(),
            Err(_) => 0,
        };
        let session_id = format!("tfsb-theme-session-{nanos}");
        Self {
            shared: Arc::new(ThemeLabShared {
                inner: Mutex::new(ThemeLabSession {
                    runner,
                    session_id,
                    active_file_path: None,
                    active_display_name: None,
                    active_file_mtime: None,
                    latest_revision: 0,
                    dirty: false,
                    adopted_theme_digest: None,
                }),
            }),
        }
    }

    fn lock(&self) -> StudioResult<MutexGuard<'_, ThemeLabSession>> {
        self.shared
            .inner
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }

    pub fn shutdown(&self) {
        if let Ok(session) = self.lock() {
            session.runner.cancel_active();
        }
    }

    pub fn cancel_active(&self) {
        if let Ok(mut session) = self.lock() {
            session.latest_revision = session.latest_revision.saturating_add(1);
            session.session_id = format!(
                "tfsb-theme-session-{:x}",
                Sha256::digest(format!(
                    "{}:{}",
                    session.session_id, session.latest_revision
                ))
            );
            session.runner.cancel_active();
        }
    }

    pub fn status(&self) -> ThemeLabStatus {
        let Ok(session) = self.lock() else {
            return ThemeLabStatus {
                available: false,
                compiler_version: COMPILER_VERSION.to_owned(),
                session_id: "unavailable".to_owned(),
                latest_revision: 0,
                message: Some("Theme Lab session lock failed".to_owned()),
                dirty: None,
                adopted_theme_digest: None,
            };
        };

        let available = session.runner.is_available();
        let message = if available {
            None
        } else {
            Some(
                "Stellar Loom compiler adapter is not available. Check that loom-payload is built."
                    .to_owned(),
            )
        };

        let mut version = COMPILER_VERSION.to_owned();
        let adapter_path = session.runner.batch_adapter_path();
        if let Some(parent) = adapter_path.parent() {
            let pkg_path = if let Some(grandparent) = parent.parent() {
                grandparent.join("package.json")
            } else {
                parent.join("package.json")
            };
            #[derive(serde::Deserialize)]
            struct ThemePackageManifest {
                version: Option<String>,
            }
            if pkg_path.is_file()
                && let Ok(content) = fs::read_to_string(&pkg_path)
                && let Ok(ThemePackageManifest { version: Some(ver) }) =
                    serde_json::from_str::<ThemePackageManifest>(&content)
            {
                version = ver;
            }
        }

        ThemeLabStatus {
            available,
            compiler_version: version,
            session_id: session.session_id.clone(),
            latest_revision: session.latest_revision,
            message,
            dirty: Some(session.dirty),
            adopted_theme_digest: session.adopted_theme_digest.clone(),
        }
    }

    pub fn compile(
        &self,
        request: ThemeLabCompileRequest,
    ) -> StudioResult<ThemeLabCompileResponse> {
        let (runner, start_session_id) = {
            let mut session = self.lock()?;
            if request
                .session_id
                .as_ref()
                .is_some_and(|id| id != &session.session_id)
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            let req_rev = request.ui_revision.unwrap_or(0);
            if req_rev < session.latest_revision {
                return Ok(ThemeLabCompileResponse {
                    ui_revision: req_rev,
                    valid: false,
                    compiled_css: None,
                    descriptor: None,
                    styles: None,
                    diagnostics: vec![],
                    error: Some(ThemeLabError {
                        code: "STALE_REVISION".to_owned(),
                        message: "Stale compilation revision superseded".to_owned(),
                        field_path: None,
                    }),
                });
            }
            if req_rev > session.latest_revision {
                session.latest_revision = req_rev;
            }
            (session.runner.clone(), session.session_id.clone())
        };

        let req_rev = request.ui_revision.unwrap_or(0);
        let result = runner.compile(request.clone());

        {
            let mut session = self.lock()?;
            let is_stale = session.session_id != start_session_id
                || request
                    .session_id
                    .as_ref()
                    .is_some_and(|id| id != &session.session_id)
                || req_rev < session.latest_revision;

            if is_stale {
                return Ok(ThemeLabCompileResponse {
                    ui_revision: req_rev,
                    valid: false,
                    compiled_css: None,
                    descriptor: None,
                    styles: None,
                    diagnostics: vec![],
                    error: Some(ThemeLabError {
                        code: "STALE_REVISION".to_owned(),
                        message: "Stale compilation revision superseded".to_owned(),
                        field_path: None,
                    }),
                });
            }

            let resp = result?;
            session.dirty = true;
            Ok(resp)
        }
    }

    pub fn example(
        &self,
        example_name: String,
        ui_revision: Option<u64>,
        session_id: Option<String>,
    ) -> StudioResult<ThemeLabExampleResponse> {
        let req_rev = ui_revision.unwrap_or(0);
        let (runner, start_session_id) = {
            let mut session = self.lock()?;
            if session_id
                .as_ref()
                .is_some_and(|id| id != &session.session_id)
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            if req_rev < session.latest_revision {
                return Ok(ThemeLabExampleResponse {
                    ui_revision: req_rev,
                    valid: false,
                    example_name,
                    specification: None,
                    compiled_css: None,
                    descriptor: None,
                    styles: None,
                    diagnostics: vec![],
                    error: Some(ThemeLabError {
                        code: "STALE_REVISION".to_owned(),
                        message: "Stale example revision superseded".to_owned(),
                        field_path: None,
                    }),
                });
            }
            if req_rev > session.latest_revision {
                session.latest_revision = req_rev;
            }
            (session.runner.clone(), session.session_id.clone())
        };

        let result = runner.example(example_name.clone(), ui_revision);

        {
            let mut session = self.lock()?;
            let is_stale = session.session_id != start_session_id
                || session_id
                    .as_ref()
                    .is_some_and(|id| id != &session.session_id)
                || req_rev < session.latest_revision;

            if is_stale {
                return Ok(ThemeLabExampleResponse {
                    ui_revision: req_rev,
                    valid: false,
                    example_name,
                    specification: None,
                    compiled_css: None,
                    descriptor: None,
                    styles: None,
                    diagnostics: vec![],
                    error: Some(ThemeLabError {
                        code: "STALE_REVISION".to_owned(),
                        message: "Stale example revision superseded".to_owned(),
                        field_path: None,
                    }),
                });
            }

            let resp = result?;
            if resp.valid {
                session.active_file_path = None;
                session.active_display_name = Some(format!("{example_name}.theme.json"));
                session.active_file_mtime = None;
                session.dirty = false;
                session.adopted_theme_digest = None;
            }
            Ok(resp)
        }
    }

    pub fn open_file(&self, path: PathBuf) -> StudioResult<ThemeLabOpenResponse> {
        self.open_file_with_binding(path, None, None)
    }

    pub fn open_file_with_binding(
        &self,
        path: PathBuf,
        session_id: Option<String>,
        ui_revision: Option<u64>,
    ) -> StudioResult<ThemeLabOpenResponse> {
        if !path.is_file() {
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }

        let metadata = fs::metadata(&path)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        if metadata.len() > 2 * 1024 * 1024 {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        let display_name = match path.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => "theme.json".to_owned(),
        };

        let bytes = fs::read(&path)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        let doc: ThemeDocument = match serde_json::from_slice(&bytes) {
            Ok(d) => d,
            Err(e) => {
                return Ok(ThemeLabOpenResponse {
                    cancelled: false,
                    specification: None,
                    display_name: Some(display_name),
                    compiled_css: None,
                    descriptor: None,
                    styles: None,
                    diagnostics: vec![],
                    error: Some(ThemeLabError {
                        code: "INVALID_JSON".to_owned(),
                        message: format!("Failed to parse theme JSON: {e}"),
                        field_path: None,
                    }),
                });
            }
        };

        let (runner, start_session_id) = {
            let session = self.lock()?;
            if session_id
                .as_ref()
                .is_some_and(|id| id != &session.session_id)
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            if let Some(rev) = ui_revision
                && rev < session.latest_revision
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            (session.runner.clone(), session.session_id.clone())
        };

        let batch_res = runner.compile_spec(doc.clone())?;
        if !batch_res.valid {
            return Ok(ThemeLabOpenResponse {
                cancelled: false,
                specification: None,
                display_name: Some(display_name),
                compiled_css: None,
                descriptor: None,
                styles: None,
                diagnostics: batch_res.diagnostics,
                error: batch_res.error,
            });
        }

        let mtime = metadata.modified().ok();
        {
            let mut session = self.lock()?;
            let is_stale = session.session_id != start_session_id
                || session_id
                    .as_ref()
                    .is_some_and(|id| id != &session.session_id)
                || ui_revision.is_some_and(|rev| rev < session.latest_revision);

            if is_stale {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }

            session.active_file_path = Some(path);
            session.active_display_name = Some(display_name.clone());
            session.active_file_mtime = mtime;
            session.dirty = false;
            session.adopted_theme_digest = None;
        }

        Ok(ThemeLabOpenResponse {
            cancelled: false,
            specification: batch_res.specification.or(Some(doc)),
            display_name: Some(display_name),
            compiled_css: batch_res.compiled_css,
            descriptor: batch_res.descriptor,
            styles: batch_res.styles,
            diagnostics: batch_res.diagnostics,
            error: None,
        })
    }

    pub fn active_file_path(&self) -> StudioResult<Option<PathBuf>> {
        let session = self.lock()?;
        Ok(session.active_file_path.clone())
    }

    pub fn active_display_name(&self) -> StudioResult<Option<String>> {
        let session = self.lock()?;
        Ok(session.active_display_name.clone())
    }

    pub fn save_file(
        &self,
        doc: impl Into<ThemeDocument>,
        destination: &Path,
    ) -> StudioResult<String> {
        self.save_file_with_binding(doc.into(), destination, None, None)
    }

    pub fn save_file_with_binding(
        &self,
        doc: ThemeDocument,
        destination: &Path,
        session_id: Option<String>,
        ui_revision: Option<u64>,
    ) -> StudioResult<String> {
        let parent = match destination.parent() {
            Some(p) => p,
            None => return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected)),
        };

        if !parent.is_dir() {
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }

        let (runner, start_session_id) = {
            let session = self.lock()?;
            if session_id
                .as_ref()
                .is_some_and(|id| id != &session.session_id)
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            if let Some(rev) = ui_revision
                && rev < session.latest_revision
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            (session.runner.clone(), session.session_id.clone())
        };

        let val_res = runner.validate_spec(doc.clone());
        if val_res.is_err() {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }

        if destination.is_file() {
            let session = self.lock()?;
            let is_active_file = session.active_file_path.as_deref() == Some(destination);
            let modified = is_active_file
                && match (
                    session.active_file_mtime,
                    fs::metadata(destination).and_then(|m| m.modified()),
                ) {
                    (Some(saved), Ok(current)) => current != saved,
                    _ => false,
                };
            if modified {
                return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
            }
        }

        let json_bytes = serde_json::to_vec_pretty(&doc)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::PlanInvalid))?;

        let nanos = match SystemTime::now().duration_since(SystemTime::UNIX_EPOCH) {
            Ok(d) => d.as_nanos(),
            Err(_) => 0,
        };
        let temp_path = parent.join(format!(".tfsb-tmp-save-{nanos}.json"));

        if fs::write(&temp_path, &json_bytes).is_err() {
            let _ = fs::remove_file(&temp_path);
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }

        if fs::rename(&temp_path, destination).is_err() {
            let _ = fs::remove_file(&temp_path);
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }

        let display_name = match destination.file_name() {
            Some(n) => n.to_string_lossy().into_owned(),
            None => "theme.json".to_owned(),
        };

        let new_mtime = fs::metadata(destination).and_then(|m| m.modified()).ok();
        {
            let mut session = self.lock()?;
            let is_stale = session.session_id != start_session_id
                || session_id
                    .as_ref()
                    .is_some_and(|id| id != &session.session_id)
                || ui_revision.is_some_and(|rev| rev < session.latest_revision);

            if is_stale {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }

            session.active_file_path = Some(destination.to_path_buf());
            session.active_display_name = Some(display_name.clone());
            session.active_file_mtime = new_mtime;
            session.dirty = false;
        }

        Ok(display_name)
    }

    pub fn runner(&self) -> StudioResult<ThemeLabRunner> {
        let session = self.lock()?;
        Ok(session.runner.clone())
    }

    pub fn adopt_candidate(
        &self,
        request: ThemeCandidateAdoptRequest,
    ) -> StudioResult<ThemeCandidateAdoptResponse> {
        let runner = {
            let mut session = self.lock()?;
            if request.session_id != session.session_id
                || request.ui_revision <= session.latest_revision
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            if session.dirty && !request.force {
                return Ok(ThemeCandidateAdoptResponse {
                    adopted: false,
                    requires_confirmation: true,
                    specification: None,
                    compiled_css: None,
                    descriptor: None,
                    styles: None,
                    diagnostics: vec![],
                    error: None,
                });
            }
            session.latest_revision = request.ui_revision;
            session.runner.clone()
        };

        let result = runner.verify_candidate(request.candidate, request.brief, request.options)?;
        if !result.valid {
            return Ok(ThemeCandidateAdoptResponse {
                adopted: false,
                requires_confirmation: false,
                specification: None,
                compiled_css: None,
                descriptor: None,
                styles: None,
                diagnostics: result.diagnostics,
                error: result.error,
            });
        }
        let invalid = || StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid);
        let verification = result.candidate_verification.as_ref().ok_or_else(invalid)?;
        let descriptor = result.descriptor.as_ref().ok_or_else(invalid)?;
        let css = result.compiled_css.as_ref().ok_or_else(invalid)?;
        let specification = result.specification.as_ref().ok_or_else(invalid)?;
        let css_digest = format!("{:x}", Sha256::digest(css.as_bytes()));

        let adopted_theme_digest = match (verification, descriptor, specification) {
            (
                ThemeCandidateVerificationResult::V1(v1),
                ThemeDescriptor::V1(d1),
                ThemeDocument::V1(s1),
            ) => {
                if !v1.valid
                    || v1.theme_digest != format!("sha256:{}", d1.input_digest)
                    || v1
                        .computed_css_digest
                        .as_deref()
                        .map(|digest| digest.trim_start_matches("sha256:"))
                        != Some(css_digest.as_str())
                    || d1.output_digest != css_digest
                    || d1.theme_name != s1.name
                {
                    return Err(invalid());
                }
                v1.theme_digest.clone()
            }
            (
                ThemeCandidateVerificationResult::V2(v2),
                ThemeDescriptor::V2(d2),
                ThemeDocument::V2(s2),
            ) => {
                if !v2.valid
                    || (v2.schema != "tfsb.theme-candidate-verification-v2"
                        && v2.schema != "tfsl.theme-candidate-verification-v2")
                    || v2.schema_version != 2
                    || v2.input_digest != d2.input_digest
                    || v2.output_digest != d2.output_digest
                    || d2.output_digest != css_digest
                    || d2.theme_name != s2.name
                {
                    return Err(invalid());
                }
                format!("sha256:{}", v2.input_digest)
            }
            _ => return Err(invalid()),
        };

        {
            let mut session = self.lock()?;
            if session.session_id != request.session_id
                || session.latest_revision != request.ui_revision
            {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            session.active_file_path = None;
            session.active_display_name = None;
            session.active_file_mtime = None;
            session.dirty = true;
            session.adopted_theme_digest = Some(adopted_theme_digest);
        }
        Ok(ThemeCandidateAdoptResponse {
            adopted: true,
            requires_confirmation: false,
            specification: result.specification,
            compiled_css: result.compiled_css,
            descriptor: result.descriptor,
            styles: result.styles,
            diagnostics: result.diagnostics,
            error: None,
        })
    }

    pub fn draft_update(
        &self,
        request: ThemeDraftUpdateRequest,
    ) -> StudioResult<ThemeDraftUpdateResponse> {
        let mut session = self.lock()?;
        if request.session_id != session.session_id
            || request.ui_revision <= session.latest_revision
        {
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }
        session.latest_revision = request.ui_revision;
        session.adopted_theme_digest = None;
        session.dirty = true;
        Ok(ThemeDraftUpdateResponse {
            ui_revision: request.ui_revision,
        })
    }
}
