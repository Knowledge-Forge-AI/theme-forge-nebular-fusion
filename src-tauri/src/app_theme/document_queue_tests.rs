use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use super::AppThemeRunner;
use crate::app_theme::types::{
    AppThemeSaveProfileRequest, PairedProfileDto, ProfileSaveMode, ThemeSpecificationDto,
};
use crate::errors::StudioReasonCode;
use crate::state::app_theme::AppThemeState;

const SAMPLE_V1_PROFILE_JSON: &[u8] = br##"{"schemaVersion":"tf-paired-profile-v1","name":"Queue Test Profile","version":"0.1.0","palette":{"light":{"background":"#ffffff","foreground":"#09090b","card":"#ffffff","cardForeground":"#09090b","popover":"#ffffff","popoverForeground":"#09090b","primary":"#00a896","primaryForeground":"#ffffff","secondary":"#f4f4f5","secondaryForeground":"#18181b","muted":"#f4f4f5","mutedForeground":"#71717a","accent":"#f4f4f5","accentForeground":"#18181b","destructive":"#ef4444","destructiveForeground":"#fafafa","border":"#e4e4e7","input":"#e4e4e7","ring":"#00a896"},"dark":{"background":"#09090b","foreground":"#fafafa","card":"#09090b","cardForeground":"#fafafa","popover":"#09090b","popoverForeground":"#fafafa","primary":"#02c39a","primaryForeground":"#09090b","secondary":"#27272a","secondaryForeground":"#fafafa","muted":"#27272a","mutedForeground":"#a1a1aa","accent":"#27272a","accentForeground":"#fafafa","destructive":"#7f1d1d","destructiveForeground":"#fafafa","border":"#27272a","input":"#27272a","ring":"#02c39a"}},"surfaces":{"radius":"0.5rem","borderWidth":"1px","content":704},"typography":{"fontSans":"Inter, sans-serif"}}"##;

struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    fn new(prefix: &str) -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::SystemTime::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos());
        let path = std::env::temp_dir().join(format!(
            "tfsb-doc-queue-{prefix}-{}-{nanos}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&path);
        Self {
            path: path.canonicalize().unwrap_or(path),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

fn find_node() -> Result<PathBuf, Box<dyn std::error::Error>> {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let bundled = manifest_dir.join("binaries/tfsb-studio-service-aarch64-apple-darwin");
    if bundled.is_file() {
        return Ok(bundled);
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for segment in path_var.split(':') {
            let candidate = PathBuf::from(segment).join("node");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    for p in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        let path = PathBuf::from(p);
        if path.is_file() {
            return Ok(path);
        }
    }
    Err("node runtime executable not found".into())
}

fn write_mock_adapter(dir: &Path) -> Result<(PathBuf, PathBuf), Box<dyn std::error::Error>> {
    let adapter_path = dir.join("mock-adapter.mjs");
    let marker_path = dir.join("spawn-marker.txt");
    let marker_lit = serde_json::to_string(&marker_path.to_string_lossy().into_owned())?;
    let script = format!(
        r#"import {{ createHash }} from "node:crypto";
import {{ appendFileSync, readFileSync }} from "node:fs";
appendFileSync({marker_lit}, "spawned\n");
const req = JSON.parse(readFileSync(0, "utf8"));
if (req.action === "bind_document") {{
  const raw = Buffer.from(req.rawBytesBase64, "base64");
  const rawSha = createHash("sha256").update(raw).digest("hex");
  const parsed = JSON.parse(raw.toString("utf8"));
  const normSha = createHash("sha256").update(JSON.stringify(parsed)).digest("hex");
  process.stdout.write(JSON.stringify({{
    status: "bound",
    valid: true,
    uiRevision: req.uiRevision ?? null,
    schemaVersion: "tf-paired-profile-v1",
    aliasResolved: false,
    verificationStatus: "verified",
    rawSourceSha256: rawSha,
    normalizedSha256: normSha,
    ownerBinding: {{
      inputOrigin: "source-bytes",
      rawSourceSha256: rawSha,
      verificationStatus: "verified",
      isTransformed: false,
      byteLength: raw.length,
      normalizedSha256: normSha
    }},
    profile: parsed
  }}));
}} else {{
  process.stdout.write(JSON.stringify({{
    status: "success",
    valid: true,
    uiRevision: req.uiRevision ?? 0,
    compiledCss: ":root {{}}",
    diagnostics: []
  }}));
}}
"#
    );
    std::fs::write(&adapter_path, script)?;
    Ok((adapter_path, marker_path))
}

fn sample_v1_profile() -> Result<PairedProfileDto, Box<dyn std::error::Error>> {
    let (dto, _) = PairedProfileDto::from_slice_with_alias_flag(SAMPLE_V1_PROFILE_JSON)?;
    Ok(dto)
}

#[test]
fn q1_cancel_documents_during_registration_gap_prevents_child_spawn()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = ScratchDir::new("q1");
    let node = find_node()?;
    let (adapter, marker) = write_mock_adapter(tmp.path())?;
    let runner = AppThemeRunner::new(node, adapter);

    let (entered_rx, release_tx) = runner.install_document_registration_gate();
    let runner_t0 = runner.clone();
    let handle_t0 = thread::spawn(move || runner_t0.bind_document(SAMPLE_V1_PROFILE_JSON, Some(1)));

    entered_rx.recv_timeout(Duration::from_secs(3))?;
    {
        let st = runner
            .document_controller
            .execution_state
            .lock()
            .map_err(|_| "lock poisoned")?;
        assert!(
            st.is_active && st.active_cancel.is_some(),
            "is_active and active_cancel must be registered atomically before lock release"
        );
    }

    // Also enqueue a second request (Ticket 1) that waits in the pre-registration condvar loop.
    let runner_t1 = runner.clone();
    let handle_t1 = thread::spawn(move || runner_t1.bind_document(SAMPLE_V1_PROFILE_JSON, Some(2)));
    for _ in 0..100 {
        if runner.document_ticket_counts().1 >= 2 {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(runner.document_ticket_counts().1, 2);

    runner.cancel_documents();
    release_tx.send(())?;

    for handle in [handle_t0, handle_t1] {
        let res = handle.join().map_err(|_| "bind_document thread panicked")?;
        match res {
            Err(err) => assert_eq!(err.reason_code(), StudioReasonCode::Cancelled),
            Ok(_) => return Err("expected Cancelled error during registration gap".into()),
        }
    }
    assert!(
        !marker.exists(),
        "adapter child process must not spawn after registration-gap or queued cancellation"
    );
    Ok(())
}

#[test]
fn q2_save_profile_path_cancelled_during_registration_gap_performs_no_filesystem_mutation()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = ScratchDir::new("q2");
    let node = find_node()?;
    let (adapter, marker) = write_mock_adapter(tmp.path())?;
    let runner = AppThemeRunner::new(node, adapter);
    let state = AppThemeState::new(runner.clone());
    let profile = sample_v1_profile()?;

    // Positive control: uncancelled save_profile_path completes and writes destination.
    let positive_dest = tmp.path().join("positive-saved.json");
    let pos_res = state.save_profile_path(
        AppThemeSaveProfileRequest {
            profile: Some(profile.clone()),
            document_id: None,
            save_mode: Some(ProfileSaveMode::NewDocument),
        },
        positive_dest.clone(),
    )?;
    assert!(!pos_res.cancelled && pos_res.saved && positive_dest.is_file());
    assert!(marker.exists());
    let _ = std::fs::remove_file(&marker);

    // Shutdown during registration gap with existing sentinel destination file.
    let existing_dest = tmp.path().join("existing-sentinel.json");
    std::fs::write(&existing_dest, b"sentinel-original-bytes")?;
    let (entered_rx, release_tx) = runner.install_document_registration_gate();
    let state_shutdown = state.clone();
    let profile_shutdown = profile.clone();
    let dest_shutdown = existing_dest.clone();
    let h_shutdown = thread::spawn(move || {
        state_shutdown.save_profile_path(
            AppThemeSaveProfileRequest {
                profile: Some(profile_shutdown),
                document_id: None,
                save_mode: Some(ProfileSaveMode::NewDocument),
            },
            dest_shutdown,
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(3))?;
    state.shutdown();
    release_tx.send(())?;
    let shutdown_res = h_shutdown.join().map_err(|_| "shutdown save panicked")??;
    assert!(shutdown_res.cancelled && !shutdown_res.saved && shutdown_res.document.is_none());
    assert!(
        !marker.exists(),
        "shutdown during registration gap must prevent child spawn"
    );
    assert_eq!(std::fs::read(&existing_dest)?, b"sentinel-original-bytes");

    // Reset during registration gap with absent destination file.
    let absent_dest = tmp.path().join("absent-destination.json");
    let (entered_rx2, release_tx2) = runner.install_document_registration_gate();
    let state_reset = state.clone();
    let dest_reset = absent_dest.clone();
    let h_reset = thread::spawn(move || {
        state_reset.save_profile_path(
            AppThemeSaveProfileRequest {
                profile: Some(profile),
                document_id: None,
                save_mode: Some(ProfileSaveMode::NewDocument),
            },
            dest_reset,
        )
    });
    entered_rx2.recv_timeout(Duration::from_secs(3))?;
    state.reset()?;
    release_tx2.send(())?;
    let reset_res = h_reset.join().map_err(|_| "reset save panicked")??;
    assert!(reset_res.cancelled && !reset_res.saved && reset_res.document.is_none());
    assert!(
        !marker.exists(),
        "reset during registration gap must prevent child spawn"
    );
    assert!(!absent_dest.exists());
    Ok(())
}

#[test]
fn q3_stale_completion_does_not_clear_newer_active_cancel_token()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = ScratchDir::new("q3");
    let node = find_node()?;
    let (adapter, _marker) = write_mock_adapter(tmp.path())?;
    let runner = AppThemeRunner::new(node, adapter);

    // Part 1: Real two-thread queue handoff from cancelled Ticket 0 to queued Ticket 1.
    let (entered_rx0, release_tx0) = runner.install_document_registration_gate();
    let r0 = runner.clone();
    let h0 = thread::spawn(move || r0.bind_document(SAMPLE_V1_PROFILE_JSON, Some(10)));
    entered_rx0.recv_timeout(Duration::from_secs(3))?;

    // Cancel Ticket 0 before Ticket 1 is enqueued so Ticket 1 (ticket == 1 >= cancelled_before_ticket == 1)
    // waits in the condvar queue for Ticket 0 to finish and hand off execution.
    runner.cancel_documents();

    let (entered_rx1, release_tx1) = runner.install_document_registration_gate();
    let r1 = runner.clone();
    let h1 = thread::spawn(move || r1.bind_document(SAMPLE_V1_PROFILE_JSON, Some(11)));
    for _ in 0..100 {
        if runner.document_ticket_counts().1 >= 2 {
            break;
        }
        thread::sleep(Duration::from_millis(10));
    }

    // Release cancelled Ticket 0; it must exit and hand off the queue to Ticket 1.
    release_tx0.send(())?;
    let res0 = h0.join().map_err(|_| "t0 panicked")?;
    assert!(res0.is_err());

    entered_rx1.recv_timeout(Duration::from_secs(3))?;
    {
        let st = runner
            .document_controller
            .execution_state
            .lock()
            .map_err(|_| "lock poisoned")?;
        assert!(st.is_active);
        assert_eq!(st.serving_ticket, 1);
        let token1 = st
            .active_cancel
            .as_ref()
            .ok_or("expected Ticket 1 active_cancel")?;
        assert!(!token1.load(Ordering::SeqCst));
    }
    release_tx1.send(())?;
    let bound1 = h1.join().map_err(|_| "t1 panicked")??;
    assert_eq!(bound1.status, "bound");
    assert!(bound1.valid);

    // Part 2: Direct Arc::ptr_eq guard check when active_cancel is replaced before cleanup.
    let (entered_rx, release_tx) = runner.install_document_registration_gate();
    let runner_clone = runner.clone();
    let handle =
        thread::spawn(move || runner_clone.bind_document(SAMPLE_V1_PROFILE_JSON, Some(12)));

    entered_rx.recv_timeout(Duration::from_secs(3))?;
    let newer_token = Arc::new(AtomicBool::new(false));
    {
        let mut st = runner
            .document_controller
            .execution_state
            .lock()
            .map_err(|_| "lock poisoned")?;
        if let Some(ref old_token) = st.active_cancel {
            old_token.store(true, Ordering::SeqCst);
        }
        st.active_cancel = Some(newer_token.clone());
    }
    release_tx.send(())?;

    let res = handle.join().map_err(|_| "thread panicked")?;
    assert!(res.is_err());

    {
        let st = runner
            .document_controller
            .execution_state
            .lock()
            .map_err(|_| "lock poisoned")?;
        let current = st
            .active_cancel
            .as_ref()
            .ok_or("expected newer_token to remain installed")?;
        assert!(Arc::ptr_eq(current, &newer_token));
        assert!(!newer_token.load(Ordering::SeqCst));
    }
    runner.cancel_documents();
    assert!(newer_token.load(Ordering::SeqCst));
    Ok(())
}

#[test]
fn q4_repeated_cancel_reset_shutdown_leaves_consistent_ticket_state_and_subsequent_submission_succeeds()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = ScratchDir::new("q4");
    let node = find_node()?;
    let (adapter, _marker) = write_mock_adapter(tmp.path())?;
    let runner = AppThemeRunner::new(node, adapter);
    let state = AppThemeState::new(runner.clone());

    for round in 0..3 {
        let (entered_rx, release_tx) = runner.install_document_registration_gate();
        let r_clone = runner.clone();
        let h = thread::spawn(move || r_clone.bind_document(SAMPLE_V1_PROFILE_JSON, Some(round)));
        entered_rx.recv_timeout(Duration::from_secs(3))?;
        runner.cancel_documents();
        state.reset()?;
        state.shutdown();
        release_tx.send(())?;
        let res = h.join().map_err(|_| "thread panicked")?;
        assert!(res.is_err());
    }

    let (serving, next) = runner.document_ticket_counts();
    assert_eq!(serving, next);
    {
        let st = runner
            .document_controller
            .execution_state
            .lock()
            .map_err(|_| "lock poisoned")?;
        assert!(!st.is_active);
        assert!(st.active_cancel.is_none());
        assert_eq!(st.serving_ticket, st.next_ticket);
    }

    let ok_bound = runner.bind_document(SAMPLE_V1_PROFILE_JSON, Some(99))?;
    assert_eq!(ok_bound.status, "bound");
    assert!(ok_bound.valid);
    Ok(())
}

#[test]
fn q5_preview_compile_and_document_cancellation_are_independent()
-> Result<(), Box<dyn std::error::Error>> {
    let tmp = ScratchDir::new("q5");
    let node = find_node()?;
    let (adapter, _marker) = write_mock_adapter(tmp.path())?;
    let runner = AppThemeRunner::new(node, adapter);

    // 1. Preview cancel_active() must not cancel an in-flight document request.
    let (entered_rx, release_tx) = runner.install_document_registration_gate();
    let r_doc = runner.clone();
    let doc_handle = thread::spawn(move || r_doc.bind_document(SAMPLE_V1_PROFILE_JSON, Some(7)));
    entered_rx.recv_timeout(Duration::from_secs(3))?;
    runner.cancel_active();
    release_tx.send(())?;
    let bound = doc_handle.join().map_err(|_| "doc thread panicked")??;
    assert_eq!(bound.status, "bound");
    assert!(bound.valid);

    // 2. Document cancel_documents() must not cancel a preview compile.
    runner.cancel_documents();
    let spec = ThemeSpecificationDto {
        schema_version: "tfss.theme-v1".to_owned(),
        name: "Preview Theme".to_owned(),
        version: "0.1.0".to_owned(),
        ..ThemeSpecificationDto::default()
    };
    let compiled = runner.compile(spec, Some(11))?;
    assert_eq!(compiled.status, "success");
    assert!(compiled.valid);
    assert_eq!(compiled.ui_revision, 11);
    Ok(())
}
