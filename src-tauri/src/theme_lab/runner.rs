use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use super::validation::validate_descriptor_and_digest;

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::theme_lab::types::{
    BatchSubprocessRequest, BatchSubprocessResponse, ThemeDocument, ThemeLabCompileRequest,
    ThemeLabCompileResponse, ThemeLabExampleResponse,
};

const MAX_INPUT_BYTES: usize = 32 * 1024 * 1024; // 32MB max batch transport envelope
const MAX_STDOUT_BYTES: usize = 32 * 1024 * 1024; // 32MB
const MAX_STDERR_BYTES: usize = 64 * 1024; // 64KB
const MAX_COMPILE_INPUT_BYTES: usize = 2 * 1024 * 1024; // 2MB for compile/validate
const MAX_COMPILE_OUTPUT_BYTES: usize = 2 * 1024 * 1024 + 1024; // 2MB for compile/example/validate output
const MAX_PACKET_BYTES: usize = 16 * 1024 * 1024; // 16MB for exchange packets
const EXECUTION_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINATION_TIMEOUT: Duration = Duration::from_millis(2000);
pub const COMPILER_VERSION: &str = "0.2.0";

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
pub struct ThemeLabRunner {
    node_binary: PathBuf,
    batch_adapter: PathBuf,
    v2_adapter: Option<PathBuf>,
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

#[derive(serde::Deserialize)]
struct CandidateProbe {
    schema: Option<String>,
    #[serde(rename = "schemaVersion")]
    schema_version: Option<u32>,
    #[serde(rename = "semanticCompiler")]
    semantic_compiler: Option<String>,
}

fn is_candidate_v2(raw: &str) -> bool {
    let Ok(probe) = serde_json::from_str::<CandidateProbe>(raw) else {
        return false;
    };
    match (probe.schema.as_deref(), probe.schema_version) {
        (Some("tfsl.theme-catalog-candidate"), Some(1)) => true,
        (Some("tfsl.theme-candidate"), Some(2)) => matches!(
            probe.semantic_compiler.as_deref(),
            Some("tfsl.theme-compiler-v2-core-1") | Some("tfsl.theme-compiler-v2-code-1")
        ),
        _ => false,
    }
}

impl ThemeLabRunner {
    pub fn new(node_binary: PathBuf, batch_adapter: PathBuf) -> Self {
        let v2_adapter =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("loom-adapter/theme-adapter.mjs");
        let v2_adapter = if v2_adapter.is_file() {
            Some(v2_adapter)
        } else {
            None
        };
        Self {
            node_binary,
            batch_adapter,
            v2_adapter,
            controller: Arc::new(ExecutionController::default()),
            authenticate_payload: false,
        }
    }

    pub fn v2_adapter_path(&self) -> Option<&Path> {
        self.v2_adapter.as_deref()
    }

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

    pub fn discover(resource_dir: &Path, current_exe: &Path) -> Self {
        Self::discover_with_mode(
            resource_dir,
            current_exe,
            Self::is_packaged_bundle(current_exe),
        )
    }

    pub fn discover_with_mode(resource_dir: &Path, current_exe: &Path, packaged: bool) -> Self {
        if packaged || !cfg!(debug_assertions) {
            let bundled_node = current_exe
                .parent()
                .map(|parent| parent.join("tfsb-studio-service"))
                .unwrap_or_else(|| PathBuf::from("/nonexistent/tfsb-studio-service"));
            let bundled_adapter = if resource_dir.join("bin").join("tfsl-batch.js").is_file() {
                resource_dir.join("bin").join("tfsl-batch.js")
            } else {
                resource_dir
                    .join("loom-payload")
                    .join("bin")
                    .join("tfsl-batch.js")
            };
            let bundled_v2 = resource_dir.join("loom-adapter").join("theme-adapter.mjs");
            Self {
                node_binary: bundled_node,
                batch_adapter: bundled_adapter,
                v2_adapter: Some(bundled_v2),
                controller: Arc::new(ExecutionController::default()),
                authenticate_payload: true,
            }
        } else {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"));
            let node_binary = if let Ok(path) = std::env::var("TFSB_STUDIO_NODE_BINARY") {
                PathBuf::from(path)
            } else if let Some(parent) = current_exe.parent()
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

            let bundled_adapter = if resource_dir.join("bin").join("tfsl-batch.js").is_file() {
                resource_dir.join("bin").join("tfsl-batch.js")
            } else if resource_dir
                .join("loom-payload")
                .join("bin")
                .join("tfsl-batch.js")
                .is_file()
            {
                resource_dir
                    .join("loom-payload")
                    .join("bin")
                    .join("tfsl-batch.js")
            } else {
                root.join("loom-payload/bin/tfsl-batch.js")
            };

            let v2_adapter = root.join("loom-adapter/theme-adapter.mjs");

            Self {
                node_binary,
                batch_adapter: bundled_adapter,
                v2_adapter: Some(v2_adapter),
                controller: Arc::new(ExecutionController::default()),
                authenticate_payload: true,
            }
        }
    }

    pub fn is_available(&self) -> bool {
        let node_ok = self.node_binary.is_file() || self.node_binary == Path::new("node");
        let batch_ok = self.batch_adapter.is_file();
        let v2_ok = self
            .v2_adapter
            .as_ref()
            .is_some_and(|p| crate::sidecar::scene_artifact::authenticate_theme_adapter(p).is_ok());
        node_ok && batch_ok && v2_ok
    }

    pub fn node_binary_path(&self) -> &Path {
        &self.node_binary
    }

    pub fn batch_adapter_path(&self) -> &Path {
        &self.batch_adapter
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

    pub fn execute_batch(
        &self,
        request: &BatchSubprocessRequest,
    ) -> StudioResult<BatchSubprocessResponse> {
        self.execute_process(request, &self.batch_adapter)
    }

    pub fn execute_v2(
        &self,
        request: &BatchSubprocessRequest,
    ) -> StudioResult<BatchSubprocessResponse> {
        let v2_adapter = self
            .v2_adapter
            .as_ref()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarArtifactUnavailable))?;
        crate::sidecar::scene_artifact::authenticate_theme_adapter(v2_adapter)?;
        self.execute_process(request, v2_adapter)
    }

    fn execute_process(
        &self,
        request: &BatchSubprocessRequest,
        script_path: &Path,
    ) -> StudioResult<BatchSubprocessResponse> {
        if !self.is_available() {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarArtifactUnavailable,
            ));
        }

        let mut request = request.clone();
        request.opaque_packets = true;
        let request_bytes = serde_json::to_vec(&request)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        if request_bytes.len() > MAX_INPUT_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        if (request.action == "compile" || request.action == "validate")
            && request_bytes.len() > MAX_COMPILE_INPUT_BYTES
        {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        for packet in [
            &request.packet_json,
            &request.candidate,
            &request.brief,
            &request.review,
        ] {
            if packet
                .as_ref()
                .is_some_and(|text| text.len() > MAX_PACKET_BYTES)
            {
                return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
            }
        }
        if request.candidates.as_ref().is_some_and(|packets| {
            packets.len() > 8 || packets.iter().any(|packet| packet.len() > MAX_PACKET_BYTES)
        }) {
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

        let result = self.execute_batch_inner(&request, &request_bytes, &cancel_token, script_path);

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

    fn execute_batch_inner(
        &self,
        request: &BatchSubprocessRequest,
        request_bytes: &[u8],
        cancel_token: &Arc<AtomicBool>,
        script_path: &Path,
    ) -> StudioResult<BatchSubprocessResponse> {
        if cancel_token.load(Ordering::SeqCst) {
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }

        if self.authenticate_payload {
            crate::sidecar::scene_artifact::authenticate_theme_payload(
                &self.node_binary,
                &self.batch_adapter,
            )?;
        }
        if cancel_token.load(Ordering::SeqCst) {
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }

        let mut child = Command::new(&self.node_binary)
            .arg(script_path)
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
        let stdout_limit = match request.action.as_str() {
            "compile" | "example" | "validate" => MAX_COMPILE_OUTPUT_BYTES,
            _ => MAX_STDOUT_BYTES,
        };
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
                        if buffer.len() > stdout_limit {
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
                        buffer.extend_from_slice(&chunk[..n]);
                        if buffer.len() > MAX_STDERR_BYTES {
                            let _ = stderr_tx.send(buffer);
                            break;
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

        let response: BatchSubprocessResponse = serde_json::from_slice(&output_bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        // 1. Status must be "success" or "error"
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

        // 2. If request supplied ui_revision, response must echo exact revision
        if let Some(req_rev) = request.ui_revision
            && response.ui_revision != Some(req_rev)
        {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarProtocolInvalid,
            ));
        }

        // 3. Error branch validation
        if response.status == "error" {
            if response.valid
                || response.error.is_none()
                || response.compiled_css.is_some()
                || response.descriptor.is_some()
            {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }
            return Ok(response);
        }

        // 4. Success branch validation
        if !response.valid || response.error.is_some() {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarProtocolInvalid,
            ));
        }

        match request.action.as_str() {
            "compile" => {
                let Some(ref css) = response.compiled_css else {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                };
                if css.is_empty() {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                }
                let Some(ref desc) = response.descriptor else {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                };
                validate_descriptor_and_digest(css, desc, response.styles.as_deref())?;
            }
            "example" => {
                if response.specification.is_none() {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                }
                if let Some(ref req_name) = request.example_name
                    && response.example_name.as_ref() != Some(req_name)
                {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                }
                let Some(ref css) = response.compiled_css else {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                };
                if css.is_empty() {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                }
                let Some(ref desc) = response.descriptor else {
                    return Err(StudioCommandError::new(
                        StudioReasonCode::SidecarProtocolInvalid,
                    ));
                };
                validate_descriptor_and_digest(css, desc, response.styles.as_deref())?;
            }
            "validate" => {
                // valid is true, error is none
            }
            "exchange-brief-create"
            | "exchange-packet-parse"
            | "exchange-packet-parse-v2"
            | "exchange-candidate-verify"
            | "exchange-candidate-verify-v2"
            | "exchange-review-create"
            | "exchange-review-validate" => {
                // exchange actions
            }
            _ => {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }
        }

        Ok(response)
    }

    pub fn compile(
        &self,
        request: ThemeLabCompileRequest,
    ) -> StudioResult<ThemeLabCompileResponse> {
        let ui_revision = request.ui_revision.unwrap_or(0);

        if request.specification.is_v2()
            && request.options.as_ref().and_then(|o| o.strict_contrast) == Some(true)
        {
            return Ok(ThemeLabCompileResponse {
                ui_revision,
                valid: false,
                compiled_css: None,
                descriptor: None,
                styles: None,
                diagnostics: vec![],
                error: Some(crate::theme_lab::types::ThemeLabError {
                    code: "STRICT_CONTRAST_UNSUPPORTED".to_owned(),
                    message: "V2 strict contrast is unsupported in core".to_owned(),
                    field_path: None,
                }),
            });
        }

        let batch_req = BatchSubprocessRequest {
            action: "compile".to_owned(),
            specification: Some(request.specification),
            options: request.options,
            ui_revision: Some(ui_revision),
            ..Default::default()
        };

        let batch_res = self.execute_batch(&batch_req)?;
        Ok(ThemeLabCompileResponse {
            ui_revision: batch_res.ui_revision.unwrap_or(ui_revision),
            valid: batch_res.valid,
            compiled_css: batch_res.compiled_css,
            descriptor: batch_res.descriptor,
            styles: batch_res.styles,
            diagnostics: batch_res.diagnostics,
            error: batch_res.error,
        })
    }

    pub fn example(
        &self,
        example_name: String,
        ui_revision: Option<u64>,
    ) -> StudioResult<ThemeLabExampleResponse> {
        let rev = ui_revision.unwrap_or(0);
        let batch_req = BatchSubprocessRequest {
            action: "example".to_owned(),
            example_name: Some(example_name.clone()),
            ui_revision: Some(rev),
            ..Default::default()
        };

        let batch_res = self.execute_batch(&batch_req)?;
        let spec = batch_res
            .specification
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        Ok(ThemeLabExampleResponse {
            ui_revision: batch_res.ui_revision.unwrap_or(rev),
            valid: batch_res.valid,
            example_name,
            specification: Some(spec),
            compiled_css: batch_res.compiled_css,
            descriptor: batch_res.descriptor,
            styles: batch_res.styles,
            diagnostics: batch_res.diagnostics,
            error: batch_res.error,
        })
    }

    pub fn validate_spec(&self, doc: ThemeDocument) -> StudioResult<ThemeDocument> {
        let batch_req = BatchSubprocessRequest {
            action: "validate".to_owned(),
            specification: Some(doc.clone()),
            ..Default::default()
        };

        let batch_res = self.execute_batch(&batch_req)?;
        if !batch_res.valid {
            return Err(StudioCommandError::new(StudioReasonCode::PlanInvalid));
        }

        Ok(doc)
    }

    pub fn compile_spec(&self, doc: ThemeDocument) -> StudioResult<BatchSubprocessResponse> {
        let batch_req = BatchSubprocessRequest {
            action: "compile".to_owned(),
            specification: Some(doc),
            ..Default::default()
        };

        self.execute_batch(&batch_req)
    }

    pub fn create_brief(&self, brief_input: String) -> StudioResult<BatchSubprocessResponse> {
        let batch_req = BatchSubprocessRequest {
            action: "exchange-brief-create".to_owned(),
            brief_input: Some(brief_input),
            ..Default::default()
        };

        self.execute_batch(&batch_req)
    }

    pub fn parse_packet(
        &self,
        packet_json: String,
        expected_kind: Option<String>,
    ) -> StudioResult<BatchSubprocessResponse> {
        if packet_json.len() > MAX_PACKET_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        if is_candidate_v2(&packet_json) && self.v2_adapter.is_some() {
            let batch_req = BatchSubprocessRequest {
                action: "exchange-packet-parse-v2".to_owned(),
                packet_json: Some(packet_json),
                expected_kind,
                ..Default::default()
            };
            return self.execute_v2(&batch_req);
        }

        let batch_req = BatchSubprocessRequest {
            action: "exchange-packet-parse".to_owned(),
            packet_json: Some(packet_json),
            expected_kind,
            ..Default::default()
        };

        self.execute_batch(&batch_req)
    }

    pub fn verify_candidate(
        &self,
        candidate: String,
        brief: String,
        options: Option<crate::theme_lab::types::ThemeCompileOptions>,
    ) -> StudioResult<BatchSubprocessResponse> {
        let is_v2 = is_candidate_v2(&candidate);

        if is_v2 {
            // Reject mixed tuple: V1 brief with V2 candidate
            if !brief.trim().is_empty()
                && (brief.contains("\"tfsl.theme-brief\"")
                    && (brief.contains("\"schemaVersion\": 1")
                        || brief.contains("\"schemaVersion\":1")))
            {
                return Err(StudioCommandError::new(
                    StudioReasonCode::SidecarProtocolInvalid,
                ));
            }

            let batch_req = BatchSubprocessRequest {
                action: "exchange-candidate-verify-v2".to_owned(),
                candidate: Some(candidate),
                brief: if brief.trim().is_empty() {
                    None
                } else {
                    Some(brief)
                },
                options,
                ..Default::default()
            };

            let result = self.execute_v2(&batch_req)?;
            if result.valid {
                let invalid = || StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid);
                let css = result.compiled_css.as_ref().ok_or_else(invalid)?;
                let descriptor = result.descriptor.as_ref().ok_or_else(invalid)?;
                let verification = result.candidate_verification.as_ref().ok_or_else(invalid)?;

                let (v2_desc, v2_verif, v2_spec) =
                    match (descriptor, verification, result.specification.as_ref()) {
                        (
                            crate::theme_lab::types::ThemeDescriptor::V2(d),
                            crate::theme_lab::types::ThemeCandidateVerificationResult::V2(v),
                            Some(crate::theme_lab::types::ThemeDocument::V2(s)),
                        ) => (d, v, s),
                        _ => return Err(invalid()),
                    };

                validate_descriptor_and_digest(css, descriptor, result.styles.as_deref())?;

                if !v2_verif.valid
                    || v2_verif.schema != "tfsb.theme-candidate-verification-v2"
                    || v2_verif.schema_version != 2
                    || v2_verif.input_digest != v2_desc.input_digest
                    || v2_verif.output_digest != v2_desc.output_digest
                    || v2_desc.theme_name != v2_spec.name
                {
                    return Err(invalid());
                }
            }
            Ok(result)
        } else {
            let batch_req = BatchSubprocessRequest {
                action: "exchange-candidate-verify".to_owned(),
                candidate: Some(candidate),
                brief: Some(brief),
                options,
                ..Default::default()
            };

            let result = self.execute_batch(&batch_req)?;
            if result.valid {
                let invalid = || StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid);
                let css = result.compiled_css.as_ref().ok_or_else(invalid)?;
                let descriptor = result.descriptor.as_ref().ok_or_else(invalid)?;
                let verification = result.candidate_verification.as_ref().ok_or_else(invalid)?;

                let (v1_desc, v1_verif, v1_spec) =
                    match (descriptor, verification, result.specification.as_ref()) {
                        (
                            crate::theme_lab::types::ThemeDescriptor::V1(d),
                            crate::theme_lab::types::ThemeCandidateVerificationResult::V1(v),
                            Some(crate::theme_lab::types::ThemeDocument::V1(s)),
                        ) => (d, v, s),
                        _ => return Err(invalid()),
                    };

                validate_descriptor_and_digest(css, descriptor, None)?;
                if !v1_verif.valid
                    || v1_verif.theme_digest != format!("sha256:{}", v1_desc.input_digest)
                    || v1_desc.theme_name != v1_spec.name
                {
                    return Err(invalid());
                }
            }
            Ok(result)
        }
    }

    pub fn create_review(&self, review_input: String) -> StudioResult<BatchSubprocessResponse> {
        let batch_req = BatchSubprocessRequest {
            action: "exchange-review-create".to_owned(),
            review_input: Some(review_input),
            ..Default::default()
        };

        self.execute_batch(&batch_req)
    }

    pub fn validate_review(
        &self,
        request: crate::theme_lab::types::ThemeReviewValidateRequest,
    ) -> StudioResult<BatchSubprocessResponse> {
        if request.candidates.len() > 8 {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }
        self.execute_batch(&BatchSubprocessRequest {
            action: "exchange-review-validate".to_owned(),
            review: Some(request.review),
            brief: Some(request.brief),
            candidates: Some(request.candidates),
            ..Default::default()
        })
    }
}
