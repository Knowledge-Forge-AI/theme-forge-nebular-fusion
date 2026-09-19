use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};

use crate::app_theme::types::{
    AdapterSubprocessRequest, AdapterSubprocessResponse, AppThemeCompileResponse,
    AppThemeExportResponse, AppThemePairedCompileResponse, PairedProfileDto, ThemeSpecificationDto,
};
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

const MAX_COMPILE_INPUT_BYTES: usize = 2 * 1024 * 1024;
const MAX_COMPILE_OUTPUT_BYTES: usize = 2 * 1024 * 1024 + 1024;
const MAX_STDERR_BYTES: usize = 64 * 1024;
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINATION_TIMEOUT: Duration = Duration::from_millis(2000);
pub const COMPILER_VERSION: &str = "0.1.0";

pub(crate) const SOLAR_SAIL_ADAPTER_BYTES: &[u8] =
    include_bytes!("../../solar-sail-adapter/solar-sail-adapter.mjs");

pub(crate) fn authenticate_solar_sail_adapter(path: &Path) -> StudioResult<()> {
    for ancestor in path.ancestors().skip(1) {
        let meta = std::fs::symlink_metadata(ancestor)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable))?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarArtifactUnavailable,
            ));
        }
    }
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable))?;
    if meta.file_type().is_symlink() || meta.len() != SOLAR_SAIL_ADAPTER_BYTES.len() as u64 {
        return Err(StudioCommandError::new(
            StudioReasonCode::SidecarArtifactUnavailable,
        ));
    }
    let content = std::fs::read(path)
        .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable))?;
    let expected_digest = format!("{:x}", Sha256::digest(SOLAR_SAIL_ADAPTER_BYTES));
    let actual_digest = format!("{:x}", Sha256::digest(&content));
    if expected_digest != actual_digest {
        return Err(StudioCommandError::new(
            StudioReasonCode::SidecarArtifactUnavailable,
        ));
    }
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

#[derive(Debug, Clone)]
pub struct AppThemeRunner {
    node_binary: PathBuf,
    adapter_path: PathBuf,
    controller: Arc<ExecutionController>,
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
        if !tauri::is_dev() {
            return true;
        }
        current_exe
            .parent()
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .is_some_and(|name| name == "Contents")
    }

    pub fn discover(resource: &Path, executable: &Path) -> Self {
        Self::discover_with_mode(resource, executable, Self::is_packaged_bundle(executable))
    }

    pub fn new(node_binary: PathBuf, adapter_path: PathBuf) -> Self {
        Self {
            node_binary,
            adapter_path,
            controller: Arc::new(ExecutionController::default()),
            authenticate_payload: false,
        }
    }

    pub fn discover_with_mode(resource: &Path, executable: &Path, packaged: bool) -> Self {
        if packaged || !cfg!(debug_assertions) {
            let node_binary = executable
                .parent()
                .map(|p| p.join("tfsb-studio-service"))
                .unwrap_or_else(|| PathBuf::from("/nonexistent/tfsb-studio-service"));
            let adapter_path = resource.join("solar-sail-adapter/solar-sail-adapter.mjs");
            Self {
                node_binary,
                adapter_path,
                controller: Arc::new(ExecutionController::default()),
                authenticate_payload: true,
            }
        } else {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"));
            let node_binary = if let Ok(custom) = std::env::var("TFSB_STUDIO_NODE_BINARY")
                .or_else(|_| std::env::var("TFSB_NODE_BINARY"))
            {
                PathBuf::from(custom)
            } else if let Some(parent) = executable.parent()
                && let candidate = parent.join("tfsb-studio-service")
                && candidate.is_file()
            {
                candidate
            } else if root
                .join("binaries/tfsb-studio-service-aarch64-apple-darwin")
                .is_file()
            {
                root.join("binaries/tfsb-studio-service-aarch64-apple-darwin")
            } else {
                PathBuf::from("node")
            };

            let adapter_path = if resource
                .join("solar-sail-adapter/solar-sail-adapter.mjs")
                .is_file()
            {
                resource.join("solar-sail-adapter/solar-sail-adapter.mjs")
            } else {
                root.join("solar-sail-adapter/solar-sail-adapter.mjs")
            };

            Self {
                node_binary,
                adapter_path,
                controller: Arc::new(ExecutionController::default()),
                authenticate_payload: true,
            }
        }
    }

    pub fn is_available(&self) -> bool {
        let node_ok = if self.node_binary == Path::new("node") {
            Command::new("node")
                .arg("--version")
                .output()
                .map(|o| o.status.success())
                .unwrap_or(false)
        } else {
            self.node_binary.is_file()
        };
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

    fn execute_process(
        &self,
        request: &AdapterSubprocessRequest,
    ) -> StudioResult<AdapterSubprocessResponse> {
        if !self.is_available() {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarArtifactUnavailable,
            ));
        }

        let request_bytes = serde_json::to_vec(request)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;
        if request_bytes.len() > MAX_COMPILE_INPUT_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        // 1. Signal cancellation to any active execution
        self.cancel_active();

        // 2. Register as pending and wait for execution slot (at most 1 active + 1 replaceable pending)
        let mut state = self
            .controller
            .execution_state
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
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
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        }

        // We become active
        state.is_active = true;
        state.pending_ticket = None;
        drop(state);

        // 3. Register fresh cancel token for this request
        let cancel_token = Arc::new(AtomicBool::new(false));
        {
            let mut guard = self
                .controller
                .active_cancel
                .lock()
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
            *guard = Some(cancel_token.clone());
        }

        let result = self.execute_process_inner(request, &request_bytes, &cancel_token);

        // 4. Clear cancel token if still ours
        if let Ok(mut guard) = self.controller.active_cancel.lock()
            && let Some(ref current) = *guard
            && Arc::ptr_eq(current, &cancel_token)
        {
            *guard = None;
        }

        // 5. Release active state and notify waiting pending request
        if let Ok(mut state) = self.controller.execution_state.lock() {
            state.is_active = false;
            self.controller.execution_cvar.notify_all();
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

        // Worker thread for writing stdin
        let mut stdin = guard
            .child
            .stdin
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let bytes_to_write = request_bytes.to_vec();
        let stdin_thread = Some(thread::spawn(move || {
            let _ = stdin.write_all(&bytes_to_write);
            let _ = stdin.flush();
            drop(stdin);
        }));

        // Worker thread for reading stdout with hard byte cap
        let mut stdout = guard
            .child
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

        // Worker thread for reading stderr
        let mut stderr = guard
            .child
            .stderr
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let (stderr_tx, _stderr_rx) = mpsc::channel();
        let stderr_thread = Some(thread::spawn(move || {
            let mut buffer = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) => {
                        let _ = stderr_tx.send(buffer);
                        break;
                    }
                    Ok(n) => {
                        if buffer.len() < MAX_STDERR_BYTES {
                            let take = (MAX_STDERR_BYTES - buffer.len()).min(n);
                            buffer.extend_from_slice(&chunk[..take]);
                        }
                    }
                    Err(_) => {
                        let _ = stderr_tx.send(buffer);
                        break;
                    }
                }
            }
        }));

        // Polling loop checking timeout and cancellation
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
                Ok(Some(_)) => {
                    break;
                }
                Ok(None) => {
                    thread::sleep(Duration::from_millis(5));
                }
                Err(_) => {
                    break;
                }
            }
        }

        if cancelled {
            guard.reaped = terminate_child(guard.child);
            let _ = stdin_thread.map(|t| t.join());
            let _ = stdout_thread.map(|t| t.join());
            let _ = stderr_thread.map(|t| t.join());
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }

        if timed_out {
            guard.reaped = terminate_child(guard.child);
            let _ = stdin_thread.map(|t| t.join());
            let _ = stdout_thread.map(|t| t.join());
            let _ = stderr_thread.map(|t| t.join());
            return Err(StudioCommandError::new(StudioReasonCode::RequestTimeout));
        }

        let exit_status = guard
            .child
            .wait()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        guard.reaped = true;

        let _ = stdin_thread.map(|t| t.join());
        let _ = stdout_thread.map(|t| t.join());
        let _ = stderr_thread.map(|t| t.join());

        let stdout_result = match stdout_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(res) => res,
            Err(_) => Err(StudioReasonCode::SidecarCrashed),
        };

        let output_bytes = stdout_result.map_err(StudioCommandError::new)?;

        if !exit_status.success() && (exit_status.code() != Some(1) || output_bytes.is_empty()) {
            return Err(StudioCommandError::new(StudioReasonCode::SidecarCrashed));
        }

        let response: AdapterSubprocessResponse = serde_json::from_slice(&output_bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        if response.status != "success" && response.status != "error" {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarProtocolInvalid,
            ));
        }
        if !exit_status.success() && response.status != "error" {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarProtocolInvalid,
            ));
        }

        if let Some(req_rev) = request.ui_revision
            && response.ui_revision != Some(req_rev)
        {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarProtocolInvalid,
            ));
        }

        Ok(response)
    }

    pub fn compile(
        &self,
        specification: ThemeSpecificationDto,
        ui_revision: Option<u64>,
    ) -> StudioResult<AppThemeCompileResponse> {
        let rev = ui_revision.unwrap_or(0);
        let req = AdapterSubprocessRequest {
            action: "compile".to_owned(),
            specification: Some(specification),
            profile: None,
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
            destination: None,
            language: None,
            ui_revision: Some(rev),
        };

        let res = self.execute_process(&req)?;
        let solar_sail = res.solar_sail.unwrap_or_else(|| AppThemeCompileResponse {
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
            stellar_loom: res.stellar_loom,
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
