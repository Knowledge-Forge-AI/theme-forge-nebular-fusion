use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use super::protocol_dto::{SceneDiagnosticDto, SceneMetricsDto, SceneReceiptDto};
use super::types::VectorScene;
use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use sha2::{Digest, Sha256};

fn validate_response(response: &SceneSubprocessResponse) -> StudioResult<()> {
    let invalid = || StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid);
    if response.diagnostics.len() > 128
        || response.reason_codes.len() > 128
        || response.normalizations.len() > 128
        || response
            .diagnostics
            .iter()
            .any(|d| d.code.len() > 128 || d.message.len() > 512)
    {
        return Err(invalid());
    }
    if !response.valid {
        if response.svg.is_some() || response.receipt.is_some() {
            return Err(invalid());
        }
        return Ok(());
    }
    let canonical = response.canonical_json.as_ref().ok_or_else(invalid)?;
    let svg = response.svg.as_ref().ok_or_else(invalid)?;
    let receipt = response.receipt.as_ref().ok_or_else(invalid)?;
    let scene: VectorScene = serde_json::from_str(canonical).map_err(|_| invalid())?;
    let digest = |bytes: &[u8]| format!("sha256:{:x}", Sha256::digest(bytes));
    if canonical.len() > 8 * 1024 * 1024
        || svg.len() > 4 * 1024 * 1024
        || receipt.schema != "tfsb.scene-compile-receipt-v1"
        || receipt.scene_schema != "tfsb.vector-scene-v1"
        || receipt.scene_compatibility != 1
        || receipt.scene_compiler_level != 1
        || receipt.glyph_catalog_digest
            != "sha256:8ec3bc8e99cf1cda2cdc362f5a0b6e1f94a8e1c544853d9af46bd999f8a0941a"
        || receipt.source_digest != digest(canonical.as_bytes())
        || receipt.svg_digest != digest(svg.as_bytes())
        || receipt.profile != scene.profile
        || receipt.artboard != scene.artboard
        || response.status != "success"
    {
        return Err(invalid());
    }
    Ok(())
}

pub const MAX_STDIN_BYTES: usize = 16 * 1024 * 1024; // 16 MiB
pub const MAX_STDOUT_BYTES: usize = 32 * 1024 * 1024; // 32 MiB
pub const MAX_STDERR_BYTES: usize = 64 * 1024; // 64 KiB
pub const EXECUTION_TIMEOUT: Duration = Duration::from_secs(10);
pub const TERMINATION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Default)]
struct ExecutionState {
    is_active: bool,
    pending_ticket: Option<u64>,
    next_ticket: u64,
}

#[derive(Debug, Default)]
struct ExecutionController {
    epoch: AtomicU64,
    unavailable: AtomicBool,
    #[cfg(test)]
    test_timeout_ms: std::sync::atomic::AtomicU64,
    active_cancel: Mutex<Option<Arc<AtomicBool>>>,
    execution_state: Mutex<ExecutionState>,
    execution_cvar: Condvar,
}

#[derive(Debug, Clone)]
pub struct SceneRunner {
    node_binary: PathBuf,
    scene_adapter: PathBuf,
    controller: Arc<ExecutionController>,
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

impl Drop for ChildProcessGuard<'_> {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = terminate_child(self.child);
        }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SceneSubprocessRequest<'a> {
    action: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    scene: Option<&'a VectorScene>,
    #[serde(skip_serializing_if = "Option::is_none")]
    svg_text: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dry_run: Option<bool>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SceneSubprocessResponse {
    pub status: String,
    pub action: String,
    #[serde(default)]
    pub valid: bool,
    #[serde(default)]
    pub canonical_json: Option<String>,
    #[serde(default)]
    pub svg: Option<String>,
    #[serde(default)]
    pub receipt: Option<SceneReceiptDto>,
    #[serde(default)]
    pub metrics: Option<SceneMetricsDto>,
    #[serde(default)]
    pub diagnostics: Vec<SceneDiagnosticDto>,
    #[serde(default)]
    pub classification: Option<String>,
    #[serde(default)]
    pub reason_codes: Vec<String>,
    #[serde(default)]
    pub normalizations: Vec<String>,
    #[serde(default)]
    pub imported_scene: Option<VectorScene>,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

impl SceneRunner {
    pub fn new(node_binary: PathBuf, scene_adapter: PathBuf) -> Self {
        Self {
            node_binary,
            scene_adapter,
            controller: Arc::new(ExecutionController::default()),
        }
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
        if Self::is_packaged_bundle(current_exe) {
            Self::new(
                current_exe
                    .parent()
                    .map(|p| p.join("tfsb-studio-service"))
                    .unwrap_or_default(),
                resource_dir.join("scene-payload/bin/scene-batch.js"),
            )
        } else {
            // The development path points only to the same authenticated prepared
            // payload and pinned runtime, never a source checkout or PATH command.
            let root = Path::new(env!("CARGO_MANIFEST_DIR"));
            Self::new(
                root.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
                root.join("scene-payload/bin/scene-batch.js"),
            )
        }
    }

    pub fn is_available(&self) -> bool {
        !self.controller.unavailable.load(Ordering::SeqCst)
            && crate::sidecar::scene_artifact::verify(&self.node_binary, &self.scene_adapter)
                .is_ok()
    }

    pub fn close(&self) -> bool {
        self.controller.unavailable.store(true, Ordering::SeqCst);
        self.cancel_active();
        let deadline = Instant::now() + TERMINATION_TIMEOUT;
        let Ok(mut state) = self.controller.execution_state.lock() else {
            return false;
        };
        while state.is_active {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                return false;
            };
            let Ok((next, _)) = self
                .controller
                .execution_cvar
                .wait_timeout(state, remaining)
            else {
                return false;
            };
            state = next;
        }
        true
    }

    pub fn cancel_active(&self) {
        if self
            .controller
            .epoch
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_add(1))
            .is_err()
        {
            self.controller.unavailable.store(true, Ordering::SeqCst);
        }
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

    fn execute_batch(
        &self,
        request: &SceneSubprocessRequest<'_>,
    ) -> StudioResult<SceneSubprocessResponse> {
        let epoch = self.controller.epoch.load(Ordering::SeqCst);
        if !self.is_available() {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarArtifactUnavailable,
            ));
        }

        let request_bytes = serde_json::to_vec(request)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        if request_bytes.len() > MAX_STDIN_BYTES {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        let mut state = self
            .controller
            .execution_state
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let ticket = state.next_ticket;
        state.next_ticket = state
            .next_ticket
            .checked_add(1)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::ContextStale))?;
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

        if self.controller.epoch.load(Ordering::SeqCst) != epoch {
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
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
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
            *guard = Some(cancel_token.clone());
        }

        if self.controller.epoch.load(Ordering::SeqCst) != epoch {
            cancel_token.store(true, Ordering::SeqCst);
        }
        let result = self.execute_batch_inner(&request_bytes, &cancel_token);

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

        let response = result?;
        if response.action != request.action {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarProtocolInvalid,
            ));
        }
        validate_response(&response)?;
        Ok(response)
    }

    fn execute_batch_inner(
        &self,
        request_bytes: &[u8],
        cancel_token: &Arc<AtomicBool>,
    ) -> StudioResult<SceneSubprocessResponse> {
        if cancel_token.load(Ordering::SeqCst) {
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }

        let mut child =
            Command::new(&self.node_binary)
                .arg("--permission")
                .arg(format!(
                    "--allow-fs-read={}",
                    self.scene_adapter
                        .parent()
                        .and_then(Path::parent)
                        .ok_or_else(|| StudioCommandError::new(
                            StudioReasonCode::SidecarArtifactInvalid
                        ))?
                        .display()
                ))
                .arg(&self.scene_adapter)
                .current_dir(self.scene_adapter.parent().ok_or_else(|| {
                    StudioCommandError::new(StudioReasonCode::SidecarArtifactInvalid)
                })?)
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

        let mut stdin = guard
            .child
            .stdin
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let stdin_bytes = request_bytes.to_vec();
        let stdin_thread = thread::Builder::new()
            .name("scene-batch-stdin".to_owned())
            .spawn(move || stdin.write_all(&stdin_bytes));

        let mut stdout = guard
            .child
            .stdout
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let (stdout_tx, stdout_rx) = mpsc::channel();
        let stdout_thread = thread::Builder::new()
            .name("scene-batch-stdout".to_owned())
            .spawn(move || {
                let mut output_bytes = Vec::new();
                let mut buffer = [0u8; 8192];
                loop {
                    match stdout.read(&mut buffer) {
                        Ok(0) => {
                            let _ = stdout_tx.send(Ok(output_bytes));
                            break;
                        }
                        Ok(n) => {
                            output_bytes.extend_from_slice(&buffer[..n]);
                            if output_bytes.len() > MAX_STDOUT_BYTES {
                                let _ = stdout_tx.send(Err(StudioReasonCode::ResultTooLarge));
                                break;
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => {
                            let _ = stdout_tx.send(Err(StudioReasonCode::SidecarCrashed));
                            break;
                        }
                    }
                }
            });

        let mut stderr = guard
            .child
            .stderr
            .take()
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        let stderr_exceeded = Arc::new(AtomicBool::new(false));
        let stderr_flag = stderr_exceeded.clone();
        let stderr_thread = thread::Builder::new()
            .name("scene-batch-stderr".to_owned())
            .spawn(move || {
                let mut buffer = [0u8; 4096];
                let mut total = 0usize;
                loop {
                    match stderr.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(n) => {
                            total = total.saturating_add(n);
                            if total > MAX_STDERR_BYTES {
                                stderr_flag.store(true, Ordering::SeqCst);
                                break;
                            }
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
            });

        let execution_timeout = EXECUTION_TIMEOUT;
        #[cfg(test)]
        let execution_timeout = match self.controller.test_timeout_ms.load(Ordering::SeqCst) {
            0 => execution_timeout,
            millis => Duration::from_millis(millis),
        };
        let deadline = Instant::now() + execution_timeout;
        if stdin_thread.is_err() || stdout_thread.is_err() || stderr_thread.is_err() {
            guard.reaped = terminate_child(guard.child);
            self.controller.unavailable.store(true, Ordering::SeqCst);
            let _ = stdin_thread.map(|t| t.join());
            let _ = stdout_thread.map(|t| t.join());
            let _ = stderr_thread.map(|t| t.join());
            return Err(StudioCommandError::new(StudioReasonCode::SidecarCrashed));
        }
        let mut timed_out = false;
        let mut cancelled = false;

        loop {
            if cancel_token.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            if Instant::now() >= deadline {
                timed_out = true;
                break;
            }
            match guard.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => thread::sleep(Duration::from_millis(5)),
                Err(_) => break,
            }
        }

        if cancelled {
            guard.reaped = terminate_child(guard.child);
            if !guard.reaped {
                self.controller.unavailable.store(true, Ordering::SeqCst);
            }
            let _ = stdin_thread.map(|t| t.join());
            let _ = stdout_thread.map(|t| t.join());
            let _ = stderr_thread.map(|t| t.join());
            return Err(StudioCommandError::new(StudioReasonCode::Cancelled));
        }

        if timed_out {
            guard.reaped = terminate_child(guard.child);
            if !guard.reaped {
                self.controller.unavailable.store(true, Ordering::SeqCst);
            }
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

        stdin_thread
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?
            .join()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        stdout_thread
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?
            .join()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        stderr_thread
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?
            .join()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        if stderr_exceeded.load(Ordering::SeqCst) {
            return Err(StudioCommandError::new(StudioReasonCode::ResultTooLarge));
        }

        let stdout_result = match stdout_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(res) => res,
            Err(_) => Err(StudioReasonCode::SidecarCrashed),
        };

        let output_bytes = stdout_result.map_err(StudioCommandError::new)?;

        if !exit_status.success() {
            return Err(StudioCommandError::new(StudioReasonCode::SidecarCrashed));
        }

        let response: SceneSubprocessResponse = serde_json::from_slice(&output_bytes)
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarProtocolInvalid))?;

        if response.status != "success" && response.status != "error" {
            return Err(StudioCommandError::new(
                StudioReasonCode::SidecarProtocolInvalid,
            ));
        }

        Ok(response)
    }

    pub fn compile(
        &self,
        scene: &VectorScene,
        dry_run: bool,
    ) -> StudioResult<SceneSubprocessResponse> {
        self.execute_batch(&SceneSubprocessRequest {
            action: "compile",
            scene: Some(scene),
            svg_text: None,
            dry_run: Some(dry_run),
        })
    }

    pub fn canonicalize(&self, scene: &VectorScene) -> StudioResult<SceneSubprocessResponse> {
        self.execute_batch(&SceneSubprocessRequest {
            action: "canonicalize",
            scene: Some(scene),
            svg_text: None,
            dry_run: None,
        })
    }

    pub fn import_svg(&self, svg_text: &str) -> StudioResult<SceneSubprocessResponse> {
        self.execute_batch(&SceneSubprocessRequest {
            action: "import_svg",
            scene: None,
            svg_text: Some(svg_text),
            dry_run: None,
        })
    }
}

#[cfg(test)]
mod boundary_tests {
    use super::*;

    fn prepared_runner() -> SceneRunner {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        SceneRunner::new(
            root.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
            root.join("scene-payload/bin/scene-batch.js"),
        )
    }

    #[test]
    fn real_authenticated_compile_import_and_timeout_reap() -> Result<(), Box<dyn std::error::Error>>
    {
        let runner = prepared_runner();
        let output = runner.compile(&VectorScene::default(), false)?;
        assert!(output.valid, "{:?}", output);
        assert!(output.svg.is_some());
        let imported = runner.import_svg("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 100 100\"><circle cx=\"30\" cy=\"30\" r=\"10\"/></svg>")?;
        assert!(imported.valid);
        assert_eq!(imported.classification.as_deref(), Some("SUPPORTED_IMPORT"));
        runner.controller.test_timeout_ms.store(1, Ordering::SeqCst);
        let timeout = runner.compile(&VectorScene::default(), false);
        assert!(
            matches!(timeout, Err(error) if error.reason_code() == StudioReasonCode::RequestTimeout)
        );
        assert!(!runner.controller.unavailable.load(Ordering::SeqCst));
        runner.controller.test_timeout_ms.store(0, Ordering::SeqCst);
        assert!(runner.compile(&VectorScene::default(), false)?.valid);
        Ok(())
    }

    #[test]
    fn cancellation_reaps_active_child_and_queue_remains_usable()
    -> Result<(), Box<dyn std::error::Error>> {
        let runner = prepared_runner();
        let worker = runner.clone();
        let thread = thread::spawn(move || worker.compile(&VectorScene::default(), false));
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if runner
                .controller
                .active_cancel
                .lock()
                .map_err(|_| "poisoned")?
                .is_some()
            {
                break;
            }
            if Instant::now() > deadline || thread.is_finished() {
                let result = thread.join().map_err(|_| "worker panicked")?;
                return Err(format!("compiler did not remain active: {result:?}").into());
            }
            thread::sleep(Duration::from_millis(1));
        }
        runner.cancel_active();
        let result = thread.join().map_err(|_| "worker panicked")?;
        assert!(matches!(result, Err(error) if error.reason_code() == StudioReasonCode::Cancelled));
        assert!(!runner.controller.unavailable.load(Ordering::SeqCst));
        assert!(runner.compile(&VectorScene::default(), false)?.valid);
        Ok(())
    }
}
