use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use sha2::{Digest, Sha256};

use crate::app_theme::types::{
    AdapterBindDocumentResponse, AdapterSubprocessRequest, AdapterSubprocessResponse,
    AppThemeCompileResponse, AppThemeExportResponse, AppThemePairedCompileResponse,
    OwnerBindingInputOrigin, OwnerBindingRecord, PairedProfileDto, ProfileDocumentSchemaVersion,
    ProfileVerificationStatus, ThemeSpecificationDto, sanitize_error_code, sanitize_untrusted_text,
};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

const MAX_COMPILE_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMPILE_OUTPUT_BYTES: usize = 2 * 1024 * 1024 + 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
pub const MAX_PROFILE_DOCUMENT_BYTES: usize = 1024 * 1024;
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINATION_TIMEOUT: Duration = Duration::from_millis(2000);
pub const COMPILER_VERSION: &str = "0.3.0";

pub(crate) const SOLAR_SAIL_ADAPTER_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/solar-sail-adapter.mjs");

#[inline]
fn sidecar_unavail() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable)
}

#[inline]
fn protocol_invalid() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid)
}

#[inline]
fn sidecar_crashed() -> StudioCommandError {
    StudioCommandError::new(StudioReasonCode::SidecarCrashed)
}

fn is_lower_hex_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub use super::payload_authentication::authenticate_payload_closure;

pub(crate) fn authenticate_solar_sail_adapter(path: &Path) -> StudioResult<()> {
    for ancestor in path.ancestors().skip(1) {
        let meta = std::fs::symlink_metadata(ancestor).map_err(|_| sidecar_unavail())?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(sidecar_unavail());
        }
    }
    let meta = std::fs::symlink_metadata(path).map_err(|_| sidecar_unavail())?;
    if meta.file_type().is_symlink() || meta.len() != SOLAR_SAIL_ADAPTER_BYTES.len() as u64 {
        return Err(sidecar_unavail());
    }
    let content = std::fs::read(path).map_err(|_| sidecar_unavail())?;
    let expected_digest = format!("{:x}", Sha256::digest(SOLAR_SAIL_ADAPTER_BYTES));
    let actual_digest = format!("{:x}", Sha256::digest(&content));
    if expected_digest != actual_digest {
        return Err(sidecar_unavail());
    }
    authenticate_payload_closure(path)?;
    Ok(())
}

#[derive(Debug, Default)]
struct ExecutionState {
    is_active: bool,
    pending_ticket: Option<u64>,
    next_ticket: u64,
}

#[derive(Debug, Default)]
struct ExecutionController {
    active_cancel: Mutex<Option<Arc<AtomicBool>>>,
    execution_state: Mutex<ExecutionState>,
    execution_cvar: std::sync::Condvar,
}

#[derive(Debug, Default)]
struct DocumentExecutionState {
    is_active: bool,
    active_cancel: Option<Arc<AtomicBool>>,
    next_ticket: u64,
    serving_ticket: u64,
    cancelled_before_ticket: u64,
}

#[cfg(test)]
#[derive(Debug)]
struct DocumentRegistrationGate {
    entered_tx: mpsc::Sender<()>,
    release_rx: mpsc::Receiver<()>,
}

#[derive(Debug, Default)]
struct DocumentExecutionController {
    execution_state: Mutex<DocumentExecutionState>,
    execution_cvar: std::sync::Condvar,
    #[cfg(test)]
    registration_gate: Mutex<Option<DocumentRegistrationGate>>,
}

#[derive(Debug, Clone)]
pub struct AppThemeRunner {
    node_binary: PathBuf,
    adapter_path: PathBuf,
    controller: Arc<ExecutionController>,
    document_controller: Arc<DocumentExecutionController>,
    authenticate_payload: bool,
}

fn terminate_child(child: &mut Child) -> bool {
    match child.try_wait() {
        Ok(Some(_)) => return true,
        Ok(None) => {}
        Err(_) => return false,
    }
    if child.kill().is_err() {
        return false;
    }
    let deadline = Instant::now() + TERMINATION_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) if Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => return false,
        }
    }
}

struct ChildProcessGuard<'a> {
    child: &'a mut Child,
    reaped: bool,
}

impl<'a> Drop for ChildProcessGuard<'a> {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = terminate_child(self.child);
        }
    }
}

impl AppThemeRunner {
    pub fn is_packaged_bundle(current_exe: &Path) -> bool {
        crate::platform::is_packaged_bundle(current_exe)
    }

    pub fn discover(resource: &Path, executable: &Path) -> Self {
        Self::discover_with_mode(resource, executable, Self::is_packaged_bundle(executable))
    }

    pub fn new(node_binary: PathBuf, adapter_path: PathBuf) -> Self {
        Self {
            node_binary,
            adapter_path,
            controller: Arc::new(ExecutionController::default()),
            document_controller: Arc::new(DocumentExecutionController::default()),
            authenticate_payload: false,
        }
    }

    pub fn discover_with_mode(resource: &Path, executable: &Path, packaged: bool) -> Self {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let node_binary = crate::platform::select_runtime(root, executable, packaged);
        let res_adapter = resource.join("solar-sail-adapter/solar-sail-adapter.mjs");
        let adapter_path = if packaged || !cfg!(debug_assertions) || res_adapter.is_file() {
            res_adapter
        } else {
            root.join("solar-sail-adapter/solar-sail-adapter.mjs")
        };
        Self {
            node_binary,
            adapter_path,
            controller: Arc::new(ExecutionController::default()),
            document_controller: Arc::new(DocumentExecutionController::default()),
            authenticate_payload: true,
        }
    }

    pub fn is_available(&self) -> bool {
        let node_ok = self.node_binary.is_file();
        let adapter_ok = if self.authenticate_payload {
            authenticate_solar_sail_adapter(&self.adapter_path).is_ok()
        } else {
            self.adapter_path.is_file()
        };
        node_ok && adapter_ok
    }

    pub fn node_binary_path(&self) -> &Path {
        &self.node_binary
    }

    pub fn adapter_path(&self) -> &Path {
        &self.adapter_path
    }

    pub fn document_ticket_counts(&self) -> (u64, u64) {
        self.document_controller
            .execution_state
            .lock()
            .map_or((0, 0), |s| (s.serving_ticket, s.next_ticket))
    }

    pub fn cancel_active(&self) {
        if let Ok(guard) = self.controller.active_cancel.lock()
            && let Some(ref token) = *guard
        {
            token.store(true, Ordering::SeqCst);
        }
        if let Ok(mut state) = self.controller.execution_state.lock() {
            state.pending_ticket = None;
            self.controller.execution_cvar.notify_all();
        }
    }

    pub fn cancel_documents(&self) {
        if let Ok(mut state) = self.document_controller.execution_state.lock() {
            state.cancelled_before_ticket = state.next_ticket;
            if let Some(ref token) = state.active_cancel {
                token.store(true, Ordering::SeqCst);
            }
            if !state.is_active {
                state.serving_ticket = state.next_ticket;
            }
            self.document_controller.execution_cvar.notify_all();
        }
    }

    #[cfg(test)]
    pub(crate) fn install_document_registration_gate(
        &self,
    ) -> (mpsc::Receiver<()>, mpsc::Sender<()>) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        if let Ok(mut guard) = self.document_controller.registration_gate.lock() {
            *guard = Some(DocumentRegistrationGate {
                entered_tx,
                release_rx,
            });
        }
        (entered_rx, release_tx)
    }

    #[cfg(test)]
    fn pause_at_document_registration_gate(&self) {
        let gate = self
            .document_controller
            .registration_gate
            .lock()
            .ok()
            .and_then(|mut g| g.take());
        if let Some(gate) = gate {
            let _ = gate.entered_tx.send(());
            let _ = gate.release_rx.recv_timeout(Duration::from_secs(5));
        }
    }

    pub fn cancel_all(&self) {
        self.cancel_active();
        self.cancel_documents();
    }

    fn execute_process(
        &self,
        request: &AdapterSubprocessRequest,
    ) -> StudioResult<AdapterSubprocessResponse> {
        if !self.is_available() {
            return Err(sidecar_unavail());
        }
        let request_bytes = serde_json::to_vec(request).map_err(|_| protocol_invalid())?;
        if request_bytes.len() > MAX_COMPILE_INPUT_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        self.cancel_active();

        let mut state = self
            .controller
            .execution_state
            .lock()
            .map_err(|_| sidecar_crashed())?;
        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.wrapping_add(1);
        state.pending_ticket = Some(ticket);
        self.controller.execution_cvar.notify_all();

        while state.is_active || state.pending_ticket != Some(ticket) {
            if state.pending_ticket != Some(ticket) {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            state = self
                .controller
                .execution_cvar
                .wait(state)
                .map_err(|_| sidecar_crashed())?;
        }

        state.is_active = true;
        state.pending_ticket = None;
        drop(state);

        let cancel_token = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self
                .controller
                .active_cancel
                .lock()
                .map_err(|_| sidecar_crashed())?;
            *guard = Some(cancel_token.clone());
        }

        let result = self.execute_process_inner(request, &request_bytes, &cancel_token);

        if let Ok(mut guard) = self.controller.active_cancel.lock()
            && let Some(ref current) = *guard
            && Arc::ptr_eq(current, &cancel_token)
        {
            *guard = None;
        }
        if let Ok(mut state) = self.controller.execution_state.lock() {
            state.is_active = false;
            self.controller.execution_cvar.notify_all();
        }
        result
    }

    fn execute_document_process(
        &self,
        request: &AdapterSubprocessRequest,
    ) -> StudioResult<AdapterSubprocessResponse> {
        if !self.is_available() {
            return Err(sidecar_unavail());
        }
        let request_bytes = serde_json::to_vec(request).map_err(|_| protocol_invalid())?;
        if request_bytes.len() > MAX_COMPILE_INPUT_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        let mut state = self
            .document_controller
            .execution_state
            .lock()
            .map_err(|_| sidecar_crashed())?;
        let ticket = state.next_ticket;
        state.next_ticket = state.next_ticket.wrapping_add(1);

        while state.is_active || state.serving_ticket != ticket {
            if ticket < state.cancelled_before_ticket {
                return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
            }
            state = self
                .document_controller
                .execution_cvar
                .wait(state)
                .map_err(|_| sidecar_crashed())?;
        }

        if ticket < state.cancelled_before_ticket {
            state.serving_ticket = state
                .serving_ticket
                .wrapping_add(1)
                .max(state.cancelled_before_ticket);
            self.document_controller.execution_cvar.notify_all();
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }

        let cancel_token = Arc::new(AtomicBool::new(false));
        state.is_active = true;
        state.active_cancel = Some(cancel_token.clone());
        drop(state);

        #[cfg(test)]
        self.pause_at_document_registration_gate();

        let result = self.execute_process_inner(request, &request_bytes, &cancel_token);

        if let Ok(mut state) = self.document_controller.execution_state.lock() {
            if let Some(ref current) = state.active_cancel
                && Arc::ptr_eq(current, &cancel_token)
            {
                state.active_cancel = None;
            }
            state.is_active = false;
            let next_serving = state.serving_ticket.wrapping_add(1);
            state.serving_ticket = next_serving.max(state.cancelled_before_ticket);
            self.document_controller.execution_cvar.notify_all();
        }

        result
    }

    fn execute_process_inner(
        &self,
        request: &AdapterSubprocessRequest,
        request_bytes: &[u8],
        cancel_token: &Arc<AtomicBool>,
    ) -> StudioResult<AdapterSubprocessResponse> {
        if cancel_token.load(Ordering::SeqCst) {
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }

        let mut child = Command::new(&self.node_binary)
            .arg(&self.adapter_path)
            .env_clear()
            .env("NODE_ENV", "production")
            .env("LANG", "C")
            .env("LC_ALL", "C")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;

        let mut guard = ChildProcessGuard {
            child: &mut child,
            reaped: false,
        };
        let (stdin_thread, stdout_thread, stderr_thread, stdout_rx) =
            spawn_adapter_io_threads(guard.child, request_bytes)?;

        let start = Instant::now();
        let mut cancelled = false;
        let mut timed_out = false;
        loop {
            if cancel_token.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            if start.elapsed() > EXECUTION_TIMEOUT {
                timed_out = true;
                break;
            }
            match guard.child.try_wait() {
                Ok(Some(_)) | Err(_) => break,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
            }
        }

        if cancelled || timed_out {
            guard.reaped = terminate_child(guard.child);
            join_io_threads(stdin_thread, stdout_thread, stderr_thread);
            let reason = if cancelled {
                StudioReasonCode::Cancelled
            } else {
                StudioReasonCode::RequestTimeout
            };
            return Err(StudioCommandError::new(reason));
        }

        let exit_status = guard
            .child
            .wait()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        guard.reaped = true;
        join_io_threads(stdin_thread, stdout_thread, stderr_thread);

        let stdout_result = stdout_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap_or(Err(StudioReasonCode::SidecarCrashed));
        let output_bytes = stdout_result.map_err(StudioCommandError::new)?;
        if !exit_status.success() && (exit_status.code() != Some(1) || output_bytes.is_empty()) {
            return Err(sidecar_crashed());
        }

        let response: AdapterSubprocessResponse =
            serde_json::from_slice(&output_bytes).map_err(|_| protocol_invalid())?;
        if request.action == "bind_document" {
            if (response.status != "bound" && response.status != "error")
                || (!exit_status.success() && response.status != "error")
            {
                return Err(protocol_invalid());
            }
        } else if (response.status != "success" && response.status != "error")
            || (!exit_status.success() && response.status != "error")
        {
            return Err(protocol_invalid());
        }
        if let Some(req_rev) = request.ui_revision
            && response.ui_revision != Some(req_rev)
        {
            return Err(protocol_invalid());
        }
        Ok(response)
    }

    pub(crate) fn bind_document(
        &self,
        raw_bytes: &[u8],
        ui_revision: Option<u64>,
    ) -> StudioResult<AdapterBindDocumentResponse> {
        if raw_bytes.len() > MAX_PROFILE_DOCUMENT_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        let expected_raw_sha256 = format!("{:x}", Sha256::digest(raw_bytes));
        let req = AdapterSubprocessRequest {
            action: "bind_document".to_owned(),
            specification: None,
            profile: None,
            raw_bytes_base64: Some(base64::engine::general_purpose::STANDARD.encode(raw_bytes)),
            destination: None,
            language: None,
            ui_revision,
        };
        let res = self.execute_document_process(&req)?;
        let raw_source_sha256 = res.raw_source_sha256.ok_or_else(protocol_invalid)?;
        if !is_lower_hex_sha256(&raw_source_sha256) || raw_source_sha256 != expected_raw_sha256 {
            return Err(protocol_invalid());
        }
        let schema_version = res.schema_version.ok_or_else(protocol_invalid)?;
        let alias_resolved = res.alias_resolved.ok_or_else(protocol_invalid)?;
        let verification_status = res.verification_status.ok_or_else(protocol_invalid)?;

        if res.status == "bound" {
            if !res.valid
                || res.error.is_some()
                || res.error_code.is_some()
                || verification_status != ProfileVerificationStatus::Verified
            {
                return Err(protocol_invalid());
            }
            let owner_binding = res.owner_binding.ok_or_else(protocol_invalid)?;
            let raw_len = raw_bytes.len() as u64;
            match schema_version {
                ProfileDocumentSchemaVersion::PairedProfileV1 => {
                    let normalized_sha256 = res.normalized_sha256.ok_or_else(protocol_invalid)?;
                    let profile = res.profile.ok_or_else(protocol_invalid)?;
                    if !is_lower_hex_sha256(&normalized_sha256)
                        || res.v2_profile.is_some()
                        || res.canonical_digest.is_some()
                        || profile.schema_version != "tf-paired-profile-v1"
                    {
                        return Err(protocol_invalid());
                    }
                    check_owner_binding(
                        &owner_binding,
                        schema_version,
                        alias_resolved,
                        &expected_raw_sha256,
                        raw_len,
                        Some(&normalized_sha256),
                        None,
                    )?;
                    Ok(AdapterBindDocumentResponse {
                        status: res.status,
                        valid: true,
                        schema_version,
                        alias_resolved,
                        verification_status,
                        raw_source_sha256,
                        normalized_sha256: Some(normalized_sha256),
                        canonical_digest: None,
                        owner_binding: Some(owner_binding),
                        profile: Some(profile),
                        v2_profile: None,
                        error_code: None,
                        error: None,
                        details: vec![],
                    })
                }
                ProfileDocumentSchemaVersion::PairedProfileV2 => {
                    let canonical_digest = res.canonical_digest.ok_or_else(protocol_invalid)?;
                    let v2_profile = res.v2_profile.ok_or_else(protocol_invalid)?;
                    if !is_lower_hex_sha256(&canonical_digest)
                        || res.normalized_sha256.is_some()
                        || res.profile.is_some()
                        || alias_resolved
                        || v2_profile.schema_version != "tf-paired-profile-v2"
                    {
                        return Err(protocol_invalid());
                    }
                    check_owner_binding(
                        &owner_binding,
                        schema_version,
                        alias_resolved,
                        &expected_raw_sha256,
                        raw_len,
                        None,
                        Some(&canonical_digest),
                    )?;
                    Ok(AdapterBindDocumentResponse {
                        status: res.status,
                        valid: true,
                        schema_version,
                        alias_resolved: false,
                        verification_status,
                        raw_source_sha256,
                        normalized_sha256: None,
                        canonical_digest: Some(canonical_digest),
                        owner_binding: Some(owner_binding),
                        profile: None,
                        v2_profile: Some(v2_profile),
                        error_code: None,
                        error: None,
                        details: vec![],
                    })
                }
                ProfileDocumentSchemaVersion::Corrupt => Err(protocol_invalid()),
            }
        } else {
            if res.valid
                || res.owner_binding.is_some()
                || res.profile.is_some()
                || res.v2_profile.is_some()
                || res.normalized_sha256.is_some()
                || res.canonical_digest.is_some()
            {
                return Err(protocol_invalid());
            }
            let error_code = res
                .error_code
                .as_deref()
                .map(|c| sanitize_error_code(c, "BIND_ERROR"))
                .unwrap_or_else(|| "BIND_ERROR".to_owned());
            let error_msg = res
                .error
                .as_deref()
                .map(|e| sanitize_untrusted_text(e, 512))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Profile document validation failed".to_owned());
            let details = res
                .details
                .iter()
                .take(16)
                .map(|d| sanitize_untrusted_text(d, 512))
                .filter(|s| !s.is_empty())
                .collect();
            Ok(AdapterBindDocumentResponse {
                status: "error".to_owned(),
                valid: false,
                schema_version,
                alias_resolved,
                verification_status,
                raw_source_sha256,
                normalized_sha256: None,
                canonical_digest: None,
                owner_binding: None,
                profile: None,
                v2_profile: None,
                error_code: Some(error_code),
                error: Some(error_msg),
                details,
            })
        }
    }

    pub fn compile(
        &self,
        specification: ThemeSpecificationDto,
        ui_revision: Option<u64>,
    ) -> StudioResult<AppThemeCompileResponse> {
        let rev = ui_revision.unwrap_or(0);
        let mut clean_spec = specification;
        if clean_spec.schema_version == "tfss.theme-v1" {
            clean_spec.surfaces.content = None;
        }
        let req = AdapterSubprocessRequest {
            action: "compile".to_owned(),
            specification: Some(clean_spec),
            profile: None,
            raw_bytes_base64: None,
            destination: None,
            language: None,
            ui_revision: Some(rev),
        };
        let res = self.execute_process(&req)?;
        Ok(AppThemeCompileResponse {
            status: res.status,
            valid: res.valid,
            ui_revision: res.ui_revision.unwrap_or(rev),
            compiled_css: res.compiled_css,
            descriptor: res.descriptor,
            diagnostics: res.diagnostics,
            error: res.error,
        })
    }

    pub fn paired_compile(
        &self,
        profile: PairedProfileDto,
        ui_revision: Option<u64>,
    ) -> StudioResult<AppThemePairedCompileResponse> {
        let rev = ui_revision.unwrap_or(0);
        let req = AdapterSubprocessRequest {
            action: "paired_compile".to_owned(),
            specification: None,
            profile: Some(profile),
            raw_bytes_base64: None,
            destination: None,
            language: None,
            ui_revision: Some(rev),
        };
        let res = self.execute_process(&req)?;
        let solar_sail = res
            .solar_sail
            .map(|b| *b)
            .unwrap_or_else(|| AppThemeCompileResponse {
                status: res.status.clone(),
                valid: res.valid,
                ui_revision: rev,
                compiled_css: res.compiled_css,
                descriptor: res.descriptor,
                diagnostics: res.diagnostics,
                error: res.error.clone(),
            });
        Ok(AppThemePairedCompileResponse {
            status: res.status,
            valid: res.valid,
            ui_revision: rev,
            solar_sail,
            stellar_loom: res.stellar_loom.map(|b| *b),
            shared_tokens: res.shared_tokens,
            error: res.error,
        })
    }

    pub fn export_package(
        &self,
        specification: ThemeSpecificationDto,
        destination: String,
        language: Option<String>,
    ) -> StudioResult<AppThemeExportResponse> {
        let req = AdapterSubprocessRequest {
            action: "export_package".to_owned(),
            specification: Some(specification),
            profile: None,
            raw_bytes_base64: None,
            destination: Some(destination),
            language,
            ui_revision: None,
        };
        let res = self.execute_process(&req)?;
        Ok(AppThemeExportResponse {
            cancelled: false,
            destination: res.destination,
            file_count: res.file_count,
            error: res.error,
        })
    }
}

fn check_owner_binding(
    owner: &OwnerBindingRecord,
    schema_version: ProfileDocumentSchemaVersion,
    alias_resolved: bool,
    expected_raw_sha256: &str,
    raw_len: u64,
    top_normalized: Option<&str>,
    top_canonical: Option<&str>,
) -> StudioResult<()> {
    if !is_lower_hex_sha256(&owner.raw_source_sha256)
        || owner.verification_status != ProfileVerificationStatus::Verified
        || owner.is_transformed
        || owner.parent_source_sha256.is_some()
        || owner.byte_length == 0
    {
        return Err(protocol_invalid());
    }
    match owner.input_origin {
        OwnerBindingInputOrigin::SourceBytes => {
            if alias_resolved
                || owner.raw_source_sha256 != expected_raw_sha256
                || owner.byte_length != raw_len
            {
                return Err(protocol_invalid());
            }
        }
        OwnerBindingInputOrigin::ResolvedLegacyAlias => {
            if !alias_resolved || schema_version != ProfileDocumentSchemaVersion::PairedProfileV1 {
                return Err(protocol_invalid());
            }
        }
    }
    match schema_version {
        ProfileDocumentSchemaVersion::PairedProfileV1
            if owner.normalized_sha256.as_deref() == top_normalized
                && owner.canonical_digest.is_none() =>
        {
            Ok(())
        }
        ProfileDocumentSchemaVersion::PairedProfileV2
            if owner.canonical_digest.as_deref() == top_canonical
                && owner.normalized_sha256.is_none() =>
        {
            Ok(())
        }
        _ => Err(protocol_invalid()),
    }
}

type AdapterIoThreads = (
    Option<thread::JoinHandle<()>>,
    Option<thread::JoinHandle<()>>,
    Option<thread::JoinHandle<()>>,
    mpsc::Receiver<Result<Vec<u8>, StudioReasonCode>>,
);

fn spawn_adapter_io_threads(
    child: &mut Child,
    request_bytes: &[u8],
) -> StudioResult<AdapterIoThreads> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
    let bytes_to_write = request_bytes.to_vec();
    let stdin_thread = Some(thread::spawn(move || {
        let _ = stdin.write_all(&bytes_to_write);
        let _ = stdin.flush();
        drop(stdin);
    }));

    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
    let (stdout_tx, stdout_rx) = mpsc::channel();
    let stdout_thread = Some(thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) => {
                    let _ = stdout_tx.send(Ok(buffer));
                    break;
                }
                Ok(n) => {
                    buffer.extend_from_slice(&chunk[..n]);
                    if buffer.len() > MAX_COMPILE_OUTPUT_BYTES {
                        let _ = stdout_tx.send(Err(StudioReasonCode::ResultTooLarge));
                        break;
                    }
                }
                Err(_) => {
                    let _ = stdout_tx.send(Err(StudioReasonCode::SidecarCrashed));
                    break;
                }
            }
        }
    }));

    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
    let (stderr_tx, _stderr_rx) = mpsc::channel();
    let stderr_thread = Some(thread::spawn(move || {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk) {
                Ok(0) | Err(_) => {
                    let _ = stderr_tx.send(buffer);
                    break;
                }
                Ok(n) => {
                    if buffer.len() < MAX_STDERR_BYTES {
                        let take = (MAX_STDERR_BYTES - buffer.len()).min(n);
                        buffer.extend_from_slice(&chunk[..take]);
                    }
                }
            }
        }
    }));

    Ok((stdin_thread, stdout_thread, stderr_thread, stdout_rx))
}

fn join_io_threads(
    stdin_thread: Option<thread::JoinHandle<()>>,
    stdout_thread: Option<thread::JoinHandle<()>>,
    stderr_thread: Option<thread::JoinHandle<()>>,
) {
    let _ = stdin_thread.map(|t| t.join());
    let _ = stdout_thread.map(|t| t.join());
    let _ = stderr_thread.map(|t| t.join());
}

#[cfg(test)]
#[path = "document_queue_tests.rs"]
mod document_queue_tests;
