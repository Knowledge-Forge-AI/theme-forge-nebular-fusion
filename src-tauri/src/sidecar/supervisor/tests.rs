use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::ipc::Channel;

use super::SidecarSupervisor;
use crate::errors::StudioReasonCode;
use crate::sidecar::artifact::{DISTRIBUTION_TEST_LOCK, verify_distribution};
use crate::sidecar::brand_protocol::{StudioBrandReadRequest, StudioBrandReadResponse};
use crate::sidecar::error_registry::REMOTE_ERROR_REGISTRY;
use crate::sidecar::plan_protocol::{
    DeriveSelection, StudioBrandPlanStartRequest, StudioBrandPlanStartResult,
};
use crate::sidecar::process::{
    SessionInitFault, TerminationFault, TerminationOutcome, spawn_test_process,
    spawn_test_process_with_init_fault, terminate_process,
};
use crate::sidecar::protocol::{
    BrandCapabilities, EmptyParams, HostLifecycleState, InitializeResult, RasterCapability,
    RasterUnavailable, RpcError, RpcErrorData, ServerCapabilities, ServerIdentity,
    VisualEvidenceCapability, VisualEvidenceUnavailable,
};
use crate::state::host::HostState;

fn copy_tree(source: &std::path::Path, destination: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target).map_err(|error| error.to_string())?;
        } else {
            return Err("scratch fixture contains an unsupported entry".to_owned());
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct FakeResult {
    ok: bool,
}

fn fake_binary() -> Result<PathBuf, String> {
    let current = std::env::current_exe().map_err(|error| error.to_string())?;
    let debug = current
        .parent()
        .and_then(|directory| directory.parent())
        .ok_or_else(|| "test executable has no target/debug ancestor".to_owned())?;
    let binary = debug.join("tfsb-studio-fake-sidecar");
    if !binary.is_file() {
        return Err(format!("fake sidecar is unavailable: {}", binary.display()));
    }
    Ok(binary)
}

fn fake_request(
    mode: &str,
    id: u64,
    timeout: Duration,
) -> Result<
    (
        Result<FakeResult, StudioReasonCode>,
        crate::sidecar::process::ProcessSession,
    ),
    String,
> {
    let mut process =
        spawn_test_process(&fake_binary()?, mode).map_err(|error| error.to_string())?;
    let result =
        SidecarSupervisor::request(&mut process, id, "test.method", EmptyParams {}, timeout);
    Ok((result, process))
}

fn lifecycle_supervisor(mode: &'static str) -> Result<SidecarSupervisor, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let binary = root.join("binaries/tfsb-studio-service-aarch64-apple-darwin");
    let payload = root.join("sidecar-payload");
    verify_distribution(&binary, &payload)
        .map_err(|error| format!("artifact verification failed: {error}"))?;
    let temp = root
        .join("target")
        .join(format!("tfsb-lifecycle-{}-{mode}", std::process::id()));
    let mut supervisor = SidecarSupervisor::new(binary, payload, temp);
    supervisor.configure_test_sidecar(fake_binary()?, mode, Duration::from_millis(80));
    Ok(supervisor)
}

fn reap_test_supervisor(supervisor: &mut SidecarSupervisor) {
    supervisor.test_termination_fault = None;
    if let Some(process) = supervisor.process.as_mut() {
        process.termination_fault = None;
    }
    let _ = supervisor.force_reap();
}

fn valid_initialize() -> InitializeResult {
    let methods = [
        "assetDiff",
        "assetGet",
        "assetList",
        "assetValidate",
        "cancellation",
        "mutationPlans",
        "planApply",
        "previewStatus",
        "progress",
        "projectList",
        "projectOpen",
        "sourceAnalyze",
        "sourceOpen",
        "workspaceOpen",
        "workspaceStatus",
    ]
    .into_iter()
    .map(|name| (name.to_owned(), true))
    .collect();
    let limits = [
        ("assetPageSizeDefault", 64),
        ("assetPageSizeMax", 128),
        ("assetPageSizeMin", 1),
        ("maxActivePlans", 4),
        ("maxConcurrentApplies", 1),
        ("maxConcurrentReads", 4),
        ("maxFrameBytes", 16_777_216),
        ("maxQueuedReads", 4),
        ("maxRetainedNativeSnapshotPlans", 1),
        ("maxRetainedPlanBytes", 201_326_592),
        ("planTtlMs", 600_000),
        ("sourceDetailPageSizeDefault", 64),
        ("sourceDetailPageSizeMax", 128),
        ("sourceDetailPageSizeMin", 1),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value))
    .collect();
    let brand_methods = [
        ("consumerLockStatus", true),
        ("consumerProfileList", true),
        ("diff", true),
        ("exportCapability", true),
        ("exportStatus", true),
        ("familyList", true),
        ("qaProfileGet", true),
        ("qaProfileList", true),
        ("qaResultGet", true),
        ("recipeGraph", true),
        ("status", true),
        ("tokenList", true),
        ("visualEvidenceGet", false),
        ("derivePlan", true),
        ("qaBaselinePlan", false),
        ("consumerInstallPlan", true),
        ("consumerSyncPlan", true),
        ("exportPlan", false),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value))
    .collect();
    let brand_limits = [
        ("maxDiffResultBytes", 16_777_216),
        ("maxExportOutputs", 128),
        ("maxQaResultBytes", 16_777_216),
        ("maxSelectedProfiles", 8),
        ("maxSourcePackages", 8),
        ("pageSizeDefault", 64),
        ("pageSizeMax", 128),
        ("pageSizeMin", 1),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value))
    .collect();
    InitializeResult {
        protocol: "tfsb.studio".to_owned(),
        selected_version: "1.2".to_owned(),
        server: ServerIdentity {
            name: "tfsb-studio-service".to_owned(),
            version: "0.1.0".to_owned(),
        },
        session_nonce: "a".repeat(43),
        capabilities: ServerCapabilities {
            methods,
            limits,
            brand: BrandCapabilities {
                schema_version: 1,
                methods: brand_methods,
                source_purposes: BTreeMap::from([
                    ("brandBundle".to_owned(), true),
                    ("npmInstalledPackage".to_owned(), true),
                ]),
                raster: RasterCapability::Unavailable(RasterUnavailable { available: false }),
                limits: brand_limits,
                visual_evidence: VisualEvidenceCapability::Unavailable(VisualEvidenceUnavailable {
                    available: false,
                }),
            },
        },
    }
}

#[test]
fn initialization_identity_capabilities_and_unavailable_raster_are_exact() {
    let valid = valid_initialize();
    assert!(SidecarSupervisor::validate_initialize(&valid).is_ok());

    let mut wrong_version = valid_initialize();
    wrong_version.selected_version = "1.0".to_owned();
    assert!(SidecarSupervisor::validate_initialize(&wrong_version).is_err());

    let mut wrong_server = valid_initialize();
    wrong_server.server.version = "0.2.0".to_owned();
    assert!(SidecarSupervisor::validate_initialize(&wrong_server).is_err());

    let mut wrong_capability = valid_initialize();
    wrong_capability
        .capabilities
        .methods
        .insert("privatePathRead".to_owned(), true);
    assert!(SidecarSupervisor::validate_initialize(&wrong_capability).is_err());

    let mut inconsistent_raster = valid_initialize();
    inconsistent_raster.capabilities.brand.raster =
        RasterCapability::Unavailable(RasterUnavailable { available: true });
    assert!(SidecarSupervisor::validate_initialize(&inconsistent_raster).is_err());
}

#[test]
fn missing_and_corrupt_artifacts_never_reach_spawn() -> Result<(), String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let binary = root.join("binaries/tfsb-studio-service-aarch64-apple-darwin");
    let source_manifest = root.join("sidecar-payload/manifest.json");
    let fixture = root
        .join("target")
        .join(format!("tfsb-invalid-artifact-{}", std::process::id()));
    let missing_payload = fixture.join("missing");
    let corrupt_payload = fixture.join("corrupt");
    std::fs::create_dir_all(&corrupt_payload).map_err(|error| error.to_string())?;
    std::fs::copy(&source_manifest, corrupt_payload.join("manifest.json"))
        .map_err(|error| error.to_string())?;

    for (payload, expected) in [
        (missing_payload, "sidecar-artifact-unavailable"),
        (corrupt_payload, "sidecar-artifact-invalid"),
    ] {
        let mut supervisor = SidecarSupervisor::new(binary.clone(), payload, fixture.join("tmp"));
        if supervisor.start(Channel::new(|_| Ok(()))).is_ok()
            || supervisor.process.is_some()
            || supervisor.status().last_reason_code != Some(expected)
        {
            let _ = std::fs::remove_dir_all(&fixture);
            return Err(format!("{expected} did not fail before spawn"));
        }
    }
    std::fs::remove_dir_all(fixture).map_err(|error| error.to_string())
}

#[test]
fn real_packaged_sidecar_negotiates_1_1_and_reaps() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let binary = root.join("binaries/tfsb-studio-service-aarch64-apple-darwin");
    let payload = root.join("sidecar-payload");
    verify_distribution(&binary, &payload)
        .map_err(|error| format!("artifact verification failed: {error}"))?;
    let temp = std::env::temp_dir().join(format!("tfsb-sidecar-test-{}", std::process::id()));
    let mut supervisor = SidecarSupervisor::new(binary, payload, temp.clone());
    let channel = Channel::new(|_| Ok(()));
    let status = match supervisor.start(channel) {
        Ok(status) => status,
        Err(_) => {
            return Err(format!(
                "sidecar start failed: {:?}",
                supervisor.status().last_reason_code
            ));
        }
    };
    if status.selected_protocol_version.as_deref() != Some("1.2")
        || status.server_version.as_deref() != Some("0.1.0")
    {
        return Err("sidecar selected an invalid protocol identity".to_owned());
    }
    let child = supervisor
        .process
        .as_mut()
        .ok_or_else(|| "started supervisor has no child".to_owned())?;
    child.child.kill().map_err(|error| error.to_string())?;
    child.child.wait().map_err(|error| error.to_string())?;
    if !matches!(supervisor.status().state, HostLifecycleState::Crashed) {
        return Err("idle crash was not observed".to_owned());
    }
    let restarted = supervisor
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "explicit restart failed".to_owned())?;
    if !matches!(restarted.state, HostLifecycleState::Ready) {
        return Err("explicit restart did not reach ready".to_owned());
    }
    supervisor
        .shutdown()
        .map_err(|_| "graceful shutdown failed".to_owned())?;
    let _ = std::fs::remove_dir_all(temp);
    Ok(())
}

#[test]
fn real_host_command_lane_creates_reviews_discards_applies_and_reads_after_apply()
-> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let scratch = std::env::temp_dir().join(format!("tfsb-plan-host-test-{}", std::process::id()));
    let project = scratch.join("project");
    copy_tree(
        &manifest.join("../docs/examples/v0.4/brand-system/core-minimal"),
        &project,
    )?;
    let tfsb = project.join(".tfsb");
    let _ = std::fs::remove_file(tfsb.join("brand-package.toml"));
    let brand = "schema = \"tfsb.brand\"\nschema_version = 1\nenabled_domains = { tokens = true, recipes = true, qa = false, consumer_profiles = false, package = false, exports = false }\n\n[[families]]\nid = \"fixture-fam\"\nname = \"Fixture Family\"\nrequired_roles = []\noptional_roles = [\"mark\"]\n\n[[variants]]\nfamily = \"fixture-fam\"\nid = \"light\"\nbackgrounds = [\"light\"]\ncolor_mode = \"full-color\"\nscale = \"standard\"\nstatus = \"primary\"\n\n[[variants]]\nfamily = \"fixture-fam\"\nid = \"derived-dark\"\nbackgrounds = [\"dark\"]\ncolor_mode = \"reversed\"\nscale = \"standard\"\nstatus = \"primary\"\n\n[[bindings]]\nfamily = \"fixture-fam\"\nrole = \"mark\"\nvariant = \"light\"\nasset = \"fixture-mark-on-light\"\nauthority = \"source\"\n\n[[bindings]]\nfamily = \"fixture-fam\"\nrole = \"mark\"\nvariant = \"derived-dark\"\nasset = \"fixture-mark-derived-dark\"\nauthority = \"derived\"\n";
    let tokens = "schema = \"tfsb.brand-tokens\"\nschema_version = 1\n\n[[colors]]\nid = \"brand-blue\"\nvalue = \"#0066CCFF\"\n";
    let recipes = "schema = \"tfsb.brand-recipes\"\nschema_version = 1\n\n[[recipes]]\nid = \"recipe-derived-dark\"\ntarget_asset = \"fixture-mark-derived-dark\"\nsource_asset = \"fixture-mark-on-light\"\n\n[[recipes.operations]]\noperation = \"replace-paint\"\nchannel = \"fill\"\nsource_color = \"#000000FF\"\nreplacement_token = \"brand-blue\"\nexpected_occurrences = 1\n\n[[recipes.operations]]\noperation = \"copy-accessibility\"\npolicy = \"preserve\"\n";
    std::fs::write(tfsb.join("brand.toml"), brand).map_err(|error| error.to_string())?;
    std::fs::write(tfsb.join("brand-tokens.toml"), tokens).map_err(|error| error.to_string())?;
    std::fs::write(tfsb.join("brand-recipes.toml"), recipes).map_err(|error| error.to_string())?;
    let canonical = std::fs::canonicalize(&project).map_err(|error| error.to_string())?;
    let host = HostState::new(SidecarSupervisor::new(
        manifest.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
        manifest.join("sidecar-payload"),
        scratch.join("sidecar-temp"),
    ))
    .map_err(|_| "host state failed".to_owned())?;
    host.start_host(Channel::new(|_| Ok(())))
        .map_err(|_| "sidecar start failed".to_owned())?;
    let opened = host
        .lock()
        .and_then(|mut supervisor| {
            supervisor.open_project(canonical.to_str().unwrap_or_default(), "existing")
        })
        .map_err(|_| "project open failed".to_owned())?;
    let snapshot = crate::state::scene_tokens::read(&host, &opened.project_handle)
        .map_err(|_| "scene token snapshot failed".to_owned())?;
    if snapshot.bindings.len() != 1
        || !snapshot
            .bindings
            .get("brand-blue")
            .is_some_and(|v| v.eq_ignore_ascii_case("#0066cc"))
    {
        return Err("scene token snapshot did not preserve opaque color".to_owned());
    }
    let scene_state = crate::state::scene::SceneState::new(crate::scene::runner::SceneRunner::new(
        manifest.join("binaries/tfsb-studio-service-aarch64-apple-darwin"),
        manifest.join("scene-payload/bin/scene-batch.js"),
    ));
    let draft = scene_state
        .new_draft(crate::scene::protocol_dto::SceneNewRequest {
            expected: None,
            replacement_intent_id: None,
            profile: None,
            preset: None,
            artboard: None,
            title: None,
        })
        .map_err(|_| "scene new failed".to_owned())?;
    let bound = scene_state
        .bind_tokens(
            crate::scene::protocol_dto::SceneTokenBindRequest {
                expected: crate::scene::protocol_dto::SceneExpected {
                    session_id: draft.session_id,
                    revision: draft.revision,
                    draft_input_digest: Some(draft.draft_input_digest),
                    source_id: None,
                    token_snapshot_id: None,
                    engine_identity: None,
                },
                project_handle: opened.project_handle.clone(),
            },
            &host,
        )
        .map_err(|_| "scene bind failed".to_owned())?;
    if bound.scene.token_bindings.as_ref() != Some(&snapshot.bindings)
        || bound.token_snapshot_id.is_none()
    {
        return Err("scene token binding mismatch".to_owned());
    }
    let create = || StudioBrandPlanStartRequest::CreateDerive {
        project_handle: opened.project_handle.clone(),
        selection: DeriveSelection::All,
    };
    let first = host
        .start_plan(create(), Channel::new(|_| Ok(())))
        .map_err(|error| {
            format!(
                "derive plan failed: {}",
                serde_json::to_string(&error).unwrap_or_default()
            )
        })?;
    let StudioBrandPlanStartResult::Ready {
        plan_handle,
        plan_digest,
        ..
    } = first
    else {
        return Err("derive plan did not return ready".to_owned());
    };
    let discarded = host
        .start_plan(
            StudioBrandPlanStartRequest::Discard { plan_handle },
            Channel::new(|_| Ok(())),
        )
        .map_err(|_| "discard failed".to_owned())?;
    if !matches!(discarded, StudioBrandPlanStartResult::Discarded) {
        return Err("discard result was not exact".to_owned());
    }
    let second = host
        .start_plan(create(), Channel::new(|_| Ok(())))
        .map_err(|_| "second derive plan failed".to_owned())?;
    let StudioBrandPlanStartResult::Ready {
        plan_handle,
        plan_digest: second_digest,
        ..
    } = second
    else {
        return Err("second derive plan did not return ready".to_owned());
    };
    if second_digest != plan_digest {
        return Err("deterministic derive digest changed".to_owned());
    }
    let applied = host
        .start_plan(
            StudioBrandPlanStartRequest::Apply {
                plan_handle,
                expected_plan_digest: second_digest,
            },
            Channel::new(|_| Ok(())),
        )
        .map_err(|_| "apply failed".to_owned())?;
    if !matches!(applied, StudioBrandPlanStartResult::Applied { .. }) {
        return Err("apply result was not exact".to_owned());
    }
    let scene_status = scene_state
        .status_with_host(
            crate::scene::protocol_dto::SceneStatusRequest { expected: None },
            host.scene_generation(),
        )
        .map_err(|_| "scene status failed".to_owned())?;
    if !scene_status
        .diagnostics
        .iter()
        .any(|d| d.code == "TOKEN_SOURCE_CHANGED")
        || scene_status
            .scene
            .as_ref()
            .and_then(|s| s.token_bindings.as_ref())
            != Some(&snapshot.bindings)
    {
        return Err(
            "host change silently altered scene snapshot or omitted freshness diagnostic"
                .to_owned(),
        );
    }
    scene_state.shutdown();
    let read = host
        .lock()
        .and_then(|mut supervisor| {
            supervisor.brand_read(StudioBrandReadRequest::Status {
                project_handle: opened.project_handle,
            })
        })
        .map_err(|error| {
            format!(
                "read-after-apply failed: {}",
                serde_json::to_string(&error).unwrap_or_default()
            )
        })?;
    if !matches!(read, StudioBrandReadResponse::Status(_)) {
        return Err("read-after-apply result was not typed status".to_owned());
    }
    host.shutdown_host()
        .map_err(|_| "shutdown failed".to_owned())?;
    std::fs::remove_dir_all(scratch).map_err(|error| error.to_string())
}

#[test]
fn fake_sidecar_success_partial_progress_flood_and_stderr_are_joined() -> Result<(), String> {
    for mode in ["success", "partial", "progress", "flood", "stderr-flood"] {
        let (result, mut process) = fake_request(mode, 1, Duration::from_secs(2))?;
        match result {
            Ok(value) if value.ok => {}
            other => return Err(format!("fake {mode} result was invalid: {other:?}")),
        }
        if !terminate_process(&mut process).is_success()
            || process.reader.is_some()
            || process.stderr.is_some()
            || process.child.try_wait().ok().flatten().is_none()
        {
            return Err(format!(
                "fake {mode} process was not killed, reaped, and joined"
            ));
        }
    }
    Ok(())
}

#[test]
fn fake_sidecar_protocol_eof_writer_and_error_matrix_fails_closed() -> Result<(), String> {
    for mode in [
        "malformed",
        "unknown-id",
        "conflict",
        "malformed-error",
        "bad-progress",
        "crash",
        "eof",
    ] {
        let (result, mut process) = fake_request(mode, 1, Duration::from_secs(2))?;
        if result != Err(StudioReasonCode::SidecarProtocolInvalid) {
            return Err(format!(
                "fake {mode} did not fail as protocol-invalid: {result:?}"
            ));
        }
        let _ = terminate_process(&mut process);
    }
    let (busy, mut busy_process) = fake_request("remote-busy", 1, Duration::from_secs(2))?;
    if busy != Err(StudioReasonCode::RequestBusy) {
        return Err(format!("remote error was not classified: {busy:?}"));
    }
    let _ = terminate_process(&mut busy_process);

    let mut writer =
        spawn_test_process(&fake_binary()?, "exit-immediate").map_err(|error| error.to_string())?;
    std::thread::sleep(Duration::from_millis(30));
    let failed_write: Result<FakeResult, StudioReasonCode> = SidecarSupervisor::request(
        &mut writer,
        1,
        "test.method",
        EmptyParams {},
        Duration::from_millis(100),
    );
    if !matches!(
        failed_write,
        Err(StudioReasonCode::SidecarCrashed | StudioReasonCode::SidecarProtocolInvalid)
    ) {
        return Err(format!("writer failure was not closed: {failed_write:?}"));
    }
    let _ = terminate_process(&mut writer);
    Ok(())
}

#[test]
fn fake_sidecar_timeout_late_duplicate_hang_and_kill_reap_are_bounded() -> Result<(), String> {
    let mut late =
        spawn_test_process(&fake_binary()?, "late").map_err(|error| error.to_string())?;
    let first: Result<FakeResult, StudioReasonCode> = SidecarSupervisor::request(
        &mut late,
        1,
        "test.method",
        EmptyParams {},
        Duration::from_millis(20),
    );
    if first != Err(StudioReasonCode::SidecarRequestTimeout) || !late.coordinator.is_bounded() {
        return Err(format!("timeout retirement was invalid: {first:?}"));
    }
    let second: Result<FakeResult, StudioReasonCode> = SidecarSupervisor::request(
        &mut late,
        2,
        "test.method",
        EmptyParams {},
        Duration::from_secs(2),
    );
    if !matches!(second, Ok(FakeResult { ok: true })) {
        return Err(format!(
            "late retired traffic poisoned the next request: {second:?}"
        ));
    }
    let _ = terminate_process(&mut late);

    let mut duplicate =
        spawn_test_process(&fake_binary()?, "duplicate").map_err(|error| error.to_string())?;
    let first_duplicate: Result<FakeResult, StudioReasonCode> = SidecarSupervisor::request(
        &mut duplicate,
        1,
        "test.method",
        EmptyParams {},
        Duration::from_secs(2),
    );
    if !matches!(first_duplicate, Ok(FakeResult { ok: true })) {
        return Err("first duplicate-mode response failed".to_owned());
    }
    let second_duplicate: Result<FakeResult, StudioReasonCode> = SidecarSupervisor::request(
        &mut duplicate,
        2,
        "test.method",
        EmptyParams {},
        Duration::from_millis(500),
    );
    if second_duplicate != Err(StudioReasonCode::SidecarProtocolInvalid) {
        return Err(format!(
            "duplicate terminal response was not rejected: {second_duplicate:?}"
        ));
    }
    let _ = terminate_process(&mut duplicate);

    let (hung, mut hung_process) = fake_request("hang", 1, Duration::from_millis(20))?;
    if hung != Err(StudioReasonCode::SidecarRequestTimeout)
        || !terminate_process(&mut hung_process).is_success()
        || hung_process.child.try_wait().ok().flatten().is_none()
    {
        return Err(format!(
            "hung child was not timed out, killed, and reaped: {hung:?}"
        ));
    }

    let mut startup_hang =
        spawn_test_process(&fake_binary()?, "hang").map_err(|error| error.to_string())?;
    let startup: Result<FakeResult, StudioReasonCode> = SidecarSupervisor::request(
        &mut startup_hang,
        1,
        "initialize",
        EmptyParams {},
        Duration::from_millis(20),
    );
    if startup != Err(StudioReasonCode::SidecarStartupTimeout)
        || !terminate_process(&mut startup_hang).is_success()
    {
        return Err(format!(
            "startup hang was not timed out and reaped: {startup:?}"
        ));
    }

    for mode in ["remote-busy", "hang"] {
        let mut shutdown_process =
            spawn_test_process(&fake_binary()?, mode).map_err(|error| error.to_string())?;
        let shutdown: Result<(), StudioReasonCode> = SidecarSupervisor::request(
            &mut shutdown_process,
            1,
            "shutdown",
            EmptyParams {},
            Duration::from_millis(20),
        );
        if shutdown.is_ok() || !terminate_process(&mut shutdown_process).is_success() {
            return Err(format!("shutdown {mode} did not fail closed and reap"));
        }
    }
    Ok(())
}

#[test]
fn continuous_progress_cannot_extend_the_absolute_deadline() -> Result<(), String> {
    let mut process = spawn_test_process(&fake_binary()?, "continuous-progress")
        .map_err(|error| error.to_string())?;
    let started = Instant::now();
    let result: Result<FakeResult, StudioReasonCode> = SidecarSupervisor::request(
        &mut process,
        1,
        "test.method",
        EmptyParams {},
        Duration::from_millis(40),
    );
    let elapsed = started.elapsed();
    if result != Err(StudioReasonCode::SidecarRequestTimeout)
        || elapsed < Duration::from_millis(35)
        || elapsed > Duration::from_millis(500)
        || !process.coordinator.is_bounded()
        || !terminate_process(&mut process).is_success()
        || process.reader.is_some()
        || process.stderr.is_some()
        || process.child.try_wait().ok().flatten().is_none()
    {
        return Err(format!(
            "continuous progress escaped deadline or cleanup: {result:?} after {elapsed:?}"
        ));
    }
    Ok(())
}

#[test]
fn queue_saturation_is_terminal_and_never_blocks_cleanup() -> Result<(), String> {
    let (active, mut active_process) = fake_request("saturation", 1, Duration::from_secs(2))?;
    if active != Err(StudioReasonCode::SidecarProtocolInvalid)
        || !active_process.transport_overflowed()
        || !terminate_process(&mut active_process).is_success()
    {
        return Err(format!(
            "active queue saturation was not terminal: {active:?}"
        ));
    }

    let (idle, mut idle_process) = fake_request("idle-flood", 1, Duration::from_secs(2))?;
    if !matches!(idle, Ok(FakeResult { ok: true })) {
        return Err(format!(
            "idle flood did not first complete its request: {idle:?}"
        ));
    }
    std::thread::sleep(Duration::from_millis(80));
    let started = Instant::now();
    if !idle_process.transport_overflowed()
        || !terminate_process(&mut idle_process).is_success()
        || started.elapsed() > Duration::from_secs(2)
        || idle_process.reader.is_some()
        || idle_process.stderr.is_some()
        || idle_process.child.try_wait().ok().flatten().is_none()
    {
        return Err("idle saturated producer was not bounded and joined".to_owned());
    }
    Ok(())
}

#[test]
fn remote_error_registry_is_closed_and_exact() {
    assert_eq!(REMOTE_ERROR_REGISTRY.len(), 21);
    for spec in REMOTE_ERROR_REGISTRY {
        let error = RpcError {
            code: spec.numeric,
            message: "bounded".to_owned(),
            data: RpcErrorData {
                code: spec.symbolic.to_owned(),
                message: "bounded".to_owned(),
                retryable: spec.retryable,
                location: None,
            },
        };
        assert_eq!(SidecarSupervisor::remote_reason(&error), Ok(spec.public));
        let wrong_numeric = RpcError {
            code: spec.numeric + 1,
            message: "bounded".to_owned(),
            data: RpcErrorData {
                code: spec.symbolic.to_owned(),
                message: "bounded".to_owned(),
                retryable: spec.retryable,
                location: None,
            },
        };
        assert_eq!(
            SidecarSupervisor::remote_reason(&wrong_numeric),
            Err(StudioReasonCode::SidecarProtocolInvalid)
        );
        let wrong_retryability = RpcError {
            code: spec.numeric,
            message: "bounded".to_owned(),
            data: RpcErrorData {
                code: spec.symbolic.to_owned(),
                message: "bounded".to_owned(),
                retryable: !spec.retryable,
                location: None,
            },
        };
        assert_eq!(
            SidecarSupervisor::remote_reason(&wrong_retryability),
            Err(StudioReasonCode::SidecarProtocolInvalid)
        );
    }
}

#[test]
fn partial_session_construction_and_worker_failures_cleanup_transactionally() -> Result<(), String>
{
    for fault in [
        SessionInitFault::MissingStdin,
        SessionInitFault::MissingStdout,
        SessionInitFault::MissingStderr,
        SessionInitFault::StdoutWorkerSpawn,
        SessionInitFault::StderrWorkerSpawn,
    ] {
        let started = Instant::now();
        if spawn_test_process_with_init_fault(&fake_binary()?, "hang", fault).is_ok()
            || started.elapsed() > Duration::from_millis(500)
        {
            return Err(format!(
                "session initialization fault leaked ownership: {fault:?}"
            ));
        }
    }

    let mut panicked =
        spawn_test_process(&fake_binary()?, "exit-immediate").map_err(|error| error.to_string())?;
    if let Some(reader) = panicked.reader.take() {
        let _ = reader.join();
    }
    panicked.reader = Some(std::thread::spawn(|| {
        std::panic::resume_unwind(Box::new("injected worker join failure"));
    }));
    if !matches!(
        terminate_process(&mut panicked),
        TerminationOutcome::ReapedWorkerJoinFailure
    ) || panicked.reader.is_some()
        || panicked.stderr.is_some()
        || panicked.child.try_wait().ok().flatten().is_none()
    {
        return Err("worker join failure was not observed after cleanup".to_owned());
    }

    let mut wait_failure =
        spawn_test_process(&fake_binary()?, "hang").map_err(|error| error.to_string())?;
    wait_failure.termination_fault = Some(TerminationFault::ReportWaitFailure);
    if !matches!(
        terminate_process(&mut wait_failure),
        TerminationOutcome::ReapedWorkerJoinFailure
    ) || wait_failure.child.try_wait().ok().flatten().is_none()
        || wait_failure.reader.is_some()
        || wait_failure.stderr.is_some()
    {
        return Err("injected wait failure was not observable after cleanup".to_owned());
    }

    let mut kill_failure =
        spawn_test_process(&fake_binary()?, "hang").map_err(|error| error.to_string())?;
    kill_failure.termination_fault = Some(TerminationFault::UnreapedKillFailure);
    if !matches!(
        terminate_process(&mut kill_failure),
        TerminationOutcome::Unreaped
    ) || kill_failure.child.try_wait().ok().flatten().is_some()
        || kill_failure.reader.is_none()
        || kill_failure.stderr.is_none()
    {
        return Err("injected kill failure did not preserve unreaped ownership".to_owned());
    }
    kill_failure.termination_fault = None;
    if !terminate_process(&mut kill_failure).is_success() {
        return Err("cleanup retry did not reap injected kill failure".to_owned());
    }
    Ok(())
}

#[test]
fn restart_is_refused_until_the_old_process_reap_is_proven() -> Result<(), String> {
    let old = spawn_test_process(&fake_binary()?, "hang").map_err(|error| error.to_string())?;
    let old_id = old.child.id();
    let mut supervisor = SidecarSupervisor::new(
        PathBuf::from("missing-binary"),
        PathBuf::from("missing-payload"),
        PathBuf::from("missing-temp"),
    );
    supervisor.process = Some(old);
    if let Some(process) = supervisor.process.as_mut() {
        process.termination_fault = Some(TerminationFault::UnreapedKillFailure);
    }
    if supervisor.start(Channel::new(|_| Ok(()))).is_ok()
        || supervisor
            .process
            .as_ref()
            .map(|process| process.child.id())
            != Some(old_id)
    {
        return Err("restart created a replacement before the old reap was proven".to_owned());
    }
    if let Some(process) = supervisor.process.as_mut() {
        process.termination_fault = None;
    }
    if !supervisor.force_reap().is_success() || supervisor.process.is_some() {
        return Err(
            "old process could not be reaped after the injected failure cleared".to_owned(),
        );
    }
    Ok(())
}

#[test]
fn supervisor_termination_failures_are_observed_across_start_and_request() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;

    let mut startup = lifecycle_supervisor("lifecycle-malformed-initialize")?;
    startup.test_termination_fault = Some(TerminationFault::UnreapedKillFailure);
    let startup_error = match startup.start(Channel::new(|_| Ok(()))) {
        Ok(_) => {
            reap_test_supervisor(&mut startup);
            return Err("startup unexpectedly succeeded".to_owned());
        }
        Err(error) => error,
    };
    let Some(startup_id) = startup.process.as_ref().map(|process| process.child.id()) else {
        reap_test_supervisor(&mut startup);
        return Err("startup termination failure discarded the unreaped process".to_owned());
    };
    let startup_status = startup.status();
    if startup_error.reason_code() != StudioReasonCode::SidecarShutdownFailed
        || startup_status.last_reason_code != Some("sidecar-shutdown-failed")
        || !matches!(startup_status.state, HostLifecycleState::Failed)
    {
        reap_test_supervisor(&mut startup);
        return Err("startup termination failure was not published as shutdown-failed".to_owned());
    }
    let blocked = startup.start(Channel::new(|_| Ok(())));
    if !blocked
        .as_ref()
        .is_err_and(|error| error.reason_code() == StudioReasonCode::SidecarShutdownFailed)
        || startup.process.as_ref().map(|process| process.child.id()) != Some(startup_id)
    {
        reap_test_supervisor(&mut startup);
        return Err("restart was admitted before the old process reap was proven".to_owned());
    }
    startup.test_termination_fault = None;
    if let Some(process) = startup.process.as_mut() {
        process.termination_fault = None;
    } else {
        reap_test_supervisor(&mut startup);
        return Err("blocked restart lost the old process owner".to_owned());
    }
    let fake = fake_binary()?;
    startup.configure_test_sidecar(fake, "lifecycle-success", Duration::from_millis(80));
    if startup.start(Channel::new(|_| Ok(()))).is_err() {
        reap_test_supervisor(&mut startup);
        return Err("restart after the bounded reap did not start".to_owned());
    }
    if startup.shutdown().is_err() {
        reap_test_supervisor(&mut startup);
        return Err("restarted startup session did not shut down".to_owned());
    }

    let mut request = lifecycle_supervisor("lifecycle-request-timeout")?;
    request
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "request sidecar did not start".to_owned())?;
    let Some(request_id) = request.process.as_ref().map(|process| process.child.id()) else {
        reap_test_supervisor(&mut request);
        return Err("request setup did not retain its process".to_owned());
    };
    if let Some(process) = request.process.as_mut() {
        process.termination_fault = Some(TerminationFault::UnreapedKillFailure);
    }
    let request_error = match request.open_project("/bounded/test", "existing") {
        Ok(_) => {
            reap_test_supervisor(&mut request);
            return Err("request unexpectedly succeeded".to_owned());
        }
        Err(error) => error,
    };
    if request_error.reason_code() != StudioReasonCode::SidecarShutdownFailed
        || request.process.as_ref().map(|process| process.child.id()) != Some(request_id)
        || request.status().last_reason_code != Some("sidecar-shutdown-failed")
    {
        reap_test_supervisor(&mut request);
        return Err("request termination failure was not retained and published".to_owned());
    }
    let blocked = request.start(Channel::new(|_| Ok(())));
    if !blocked
        .as_ref()
        .is_err_and(|error| error.reason_code() == StudioReasonCode::SidecarShutdownFailed)
        || request.process.as_ref().map(|process| process.child.id()) != Some(request_id)
    {
        reap_test_supervisor(&mut request);
        return Err("request restart was admitted before bounded reap".to_owned());
    }
    request.test_termination_fault = None;
    if let Some(process) = request.process.as_mut() {
        process.termination_fault = None;
    } else {
        reap_test_supervisor(&mut request);
        return Err("request restart lost the old process owner".to_owned());
    }
    request.configure_test_sidecar(
        fake_binary()?,
        "lifecycle-success",
        Duration::from_millis(80),
    );
    if request.start(Channel::new(|_| Ok(()))).is_err() {
        reap_test_supervisor(&mut request);
        return Err("request restart after the bounded reap did not start".to_owned());
    }
    if request.shutdown().is_err() {
        reap_test_supervisor(&mut request);
        return Err("restarted request session did not shut down".to_owned());
    }
    Ok(())
}

#[test]
fn supervisor_reaped_worker_join_failures_are_observed_at_admitted_session_seams()
-> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;

    let mut startup = lifecycle_supervisor("lifecycle-malformed-initialize")?;
    startup.test_termination_fault = Some(TerminationFault::ReportWaitFailure);
    let startup_error = match startup.start(Channel::new(|_| Ok(()))) {
        Ok(_) => {
            reap_test_supervisor(&mut startup);
            return Err("worker-join startup unexpectedly succeeded".to_owned());
        }
        Err(error) => error,
    };
    let startup_status = startup.status();
    if startup_error.reason_code() != StudioReasonCode::SidecarShutdownFailed
        || startup.process.is_some()
        || !matches!(startup_status.state, HostLifecycleState::Failed)
        || startup_status.last_reason_code != Some("sidecar-shutdown-failed")
    {
        reap_test_supervisor(&mut startup);
        return Err(
            "reaped worker-join startup failure was not surfaced with a removed process".to_owned(),
        );
    }
    startup.test_termination_fault = None;
    startup.configure_test_sidecar(
        fake_binary()?,
        "lifecycle-success",
        Duration::from_millis(80),
    );
    if startup.start(Channel::new(|_| Ok(()))).is_err() {
        reap_test_supervisor(&mut startup);
        return Err("restart after reaped worker-join startup failure failed".to_owned());
    }
    if startup.shutdown().is_err() {
        reap_test_supervisor(&mut startup);
        return Err("restarted worker-join startup session did not shut down".to_owned());
    }

    let mut request = lifecycle_supervisor("lifecycle-request-timeout")?;
    request
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "worker-join request sidecar did not start".to_owned())?;
    if let Some(process) = request.process.as_mut() {
        process.termination_fault = Some(TerminationFault::ReportWaitFailure);
    } else {
        reap_test_supervisor(&mut request);
        return Err("worker-join request setup did not retain its process".to_owned());
    }
    let request_error = match request.open_project("/bounded/test", "existing") {
        Ok(_) => {
            reap_test_supervisor(&mut request);
            return Err("worker-join request unexpectedly succeeded".to_owned());
        }
        Err(error) => error,
    };
    let request_status = request.status();
    if request_error.reason_code() != StudioReasonCode::SidecarShutdownFailed
        || request.process.is_some()
        || !matches!(request_status.state, HostLifecycleState::Failed)
        || request_status.last_reason_code != Some("sidecar-shutdown-failed")
    {
        reap_test_supervisor(&mut request);
        return Err(
            "reaped worker-join request failure was not surfaced with a removed process".to_owned(),
        );
    }
    request.configure_test_sidecar(
        fake_binary()?,
        "lifecycle-success",
        Duration::from_millis(80),
    );
    if request.start(Channel::new(|_| Ok(()))).is_err() {
        reap_test_supervisor(&mut request);
        return Err("restart after reaped worker-join request failure failed".to_owned());
    }
    if request.shutdown().is_err() {
        reap_test_supervisor(&mut request);
        return Err("restarted worker-join request session did not shut down".to_owned());
    }

    let mut shutdown = lifecycle_supervisor("lifecycle-success")?;
    shutdown
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "worker-join shutdown sidecar did not start".to_owned())?;
    if let Some(process) = shutdown.process.as_mut() {
        process.termination_fault = Some(TerminationFault::ReportWaitFailure);
    } else {
        reap_test_supervisor(&mut shutdown);
        return Err("worker-join shutdown setup did not retain its process".to_owned());
    }
    let shutdown_error = match shutdown.shutdown() {
        Ok(()) => {
            reap_test_supervisor(&mut shutdown);
            return Err("worker-join shutdown unexpectedly succeeded".to_owned());
        }
        Err(error) => error,
    };
    let shutdown_status = shutdown.status();
    if shutdown_error.reason_code() != StudioReasonCode::SidecarShutdownFailed
        || shutdown.process.is_some()
        || !matches!(shutdown_status.state, HostLifecycleState::Failed)
        || shutdown_status.last_reason_code != Some("sidecar-shutdown-failed")
    {
        reap_test_supervisor(&mut shutdown);
        return Err(
            "reaped worker-join shutdown failure was not surfaced with a removed process"
                .to_owned(),
        );
    }
    shutdown.test_termination_fault = None;
    shutdown.configure_test_sidecar(
        fake_binary()?,
        "lifecycle-success",
        Duration::from_millis(80),
    );
    if shutdown.start(Channel::new(|_| Ok(()))).is_err() {
        reap_test_supervisor(&mut shutdown);
        return Err("restart after reaped worker-join shutdown failure failed".to_owned());
    }
    if shutdown.shutdown().is_err() {
        reap_test_supervisor(&mut shutdown);
        return Err("restarted worker-join shutdown session did not shut down".to_owned());
    }
    Ok(())
}

#[test]
fn start_exercises_crash_malformed_identity_capability_and_deadline_states() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    for (mode, expected_reason, expected_public) in [
        (
            "lifecycle-crash-before-initialize",
            StudioReasonCode::SidecarProtocolInvalid,
            "sidecar-protocol-invalid",
        ),
        (
            "lifecycle-malformed-initialize",
            StudioReasonCode::SidecarProtocolInvalid,
            "sidecar-protocol-invalid",
        ),
        (
            "lifecycle-wrong-version",
            StudioReasonCode::SidecarProtocolInvalid,
            "sidecar-protocol-invalid",
        ),
        (
            "lifecycle-wrong-server",
            StudioReasonCode::SidecarProtocolInvalid,
            "sidecar-protocol-invalid",
        ),
        (
            "lifecycle-wrong-capability",
            StudioReasonCode::SidecarProtocolInvalid,
            "sidecar-protocol-invalid",
        ),
        (
            "lifecycle-startup-timeout",
            StudioReasonCode::SidecarStartupTimeout,
            "sidecar-startup-timeout",
        ),
    ] {
        let mut supervisor = lifecycle_supervisor(mode)?;
        let started = Instant::now();
        let error = match supervisor.start(Channel::new(|_| Ok(()))) {
            Ok(_) => return Err(format!("{mode} unexpectedly started")),
            Err(error) => error,
        };
        // This call includes artifact verification before the initialize deadline.
        // Focused transport tests enforce timeout and kill/reap timing directly.
        if error.reason_code() != expected_reason
            || supervisor.process.is_some()
            || !matches!(supervisor.status().state, HostLifecycleState::Failed)
            || supervisor.status().last_reason_code != Some(expected_public)
        {
            return Err(format!(
                "{mode} did not fail closed through start: reason={:?}, process_present={}, state={:?}, public_reason={:?}, elapsed={:?}",
                error.reason_code(),
                supervisor.process.is_some(),
                supervisor.status().state,
                supervisor.status().last_reason_code,
                started.elapsed()
            ));
        }
    }
    Ok(())
}

#[test]
fn request_and_shutdown_failures_run_through_real_supervisor_entrypoints() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    let mut project = lifecycle_supervisor("lifecycle-request-timeout")?;
    project
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "request-timeout sidecar did not start".to_owned())?;
    if project.open_project("/bounded/test", "existing").is_ok()
        || project.process.is_some()
        || project.status().last_reason_code != Some("sidecar-request-timeout")
    {
        return Err("project.open timeout did not close the real supervisor".to_owned());
    }

    let mut source = lifecycle_supervisor("lifecycle-request-timeout")?;
    source
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "source timeout sidecar did not start".to_owned())?;
    if source.open_source("/bounded/test", "content").is_ok()
        || source.process.is_some()
        || source.status().last_reason_code != Some("sidecar-request-timeout")
    {
        return Err("source.open timeout did not close the real supervisor".to_owned());
    }

    for mode in [
        "lifecycle-shutdown-error",
        "lifecycle-shutdown-hang",
        "lifecycle-terminal-data",
    ] {
        let mut supervisor = lifecycle_supervisor(mode)?;
        supervisor
            .start(Channel::new(|_| Ok(())))
            .map_err(|_| format!("{mode} did not start"))?;
        if supervisor.shutdown().is_ok()
            || supervisor.process.is_some()
            || supervisor.status().last_reason_code != Some("sidecar-shutdown-failed")
        {
            return Err(format!("{mode} did not fail, kill, reap, and join"));
        }
    }
    Ok(())
}

#[test]
fn idle_crash_saturation_restart_shutdown_and_drop_are_bounded() -> Result<(), String> {
    let _distribution = DISTRIBUTION_TEST_LOCK
        .lock()
        .map_err(|_| "distribution test lock".to_owned())?;
    let mut crashed = lifecycle_supervisor("lifecycle-idle-crash")?;
    crashed
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "idle-crash sidecar did not initialize".to_owned())?;
    std::thread::sleep(Duration::from_millis(50));
    if !matches!(crashed.status().state, HostLifecycleState::Crashed) || crashed.process.is_some() {
        return Err("idle crash was not detected and reaped".to_owned());
    }

    let mut saturated = lifecycle_supervisor("lifecycle-idle-flood")?;
    saturated
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "idle-flood sidecar did not initialize".to_owned())?;
    std::thread::sleep(Duration::from_millis(80));
    if !matches!(saturated.status().state, HostLifecycleState::Failed)
        || saturated.status().last_reason_code != Some("sidecar-protocol-invalid")
        || saturated.process.is_some()
    {
        return Err("idle unsolicited saturation did not fail and reap".to_owned());
    }
    saturated.configure_test_sidecar(
        fake_binary()?,
        "lifecycle-success",
        Duration::from_millis(80),
    );
    if !matches!(
        saturated
            .start(Channel::new(|_| Ok(())))
            .map_err(|_| "restart after saturation failed".to_owned())?
            .state,
        HostLifecycleState::Ready
    ) {
        return Err("restart after saturated process reap did not reach ready".to_owned());
    }
    saturated
        .shutdown()
        .map_err(|_| "restart after saturation did not shut down".to_owned())?;

    let mut saturated_shutdown = lifecycle_supervisor("lifecycle-idle-flood")?;
    saturated_shutdown
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "shutdown saturation sidecar did not initialize".to_owned())?;
    std::thread::sleep(Duration::from_millis(80));
    if saturated_shutdown.shutdown().is_ok() || saturated_shutdown.process.is_some() {
        return Err("shutdown after saturation did not fail closed and reap".to_owned());
    }

    let mut saturated_drop = lifecycle_supervisor("lifecycle-idle-flood")?;
    saturated_drop
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "drop saturation sidecar did not initialize".to_owned())?;
    std::thread::sleep(Duration::from_millis(80));
    drop(saturated_drop);

    let mut graceful = lifecycle_supervisor("lifecycle-success")?;
    graceful
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "graceful sidecar did not start".to_owned())?;
    graceful
        .shutdown()
        .map_err(|_| "graceful sidecar did not stop".to_owned())?;
    if graceful.process.is_some() || !matches!(graceful.status().state, HostLifecycleState::Stopped)
    {
        return Err("graceful shutdown retained a process or worker".to_owned());
    }

    let mut dropped = lifecycle_supervisor("lifecycle-success")?;
    dropped
        .start(Channel::new(|_| Ok(())))
        .map_err(|_| "drop sidecar did not start".to_owned())?;
    drop(dropped);
    Ok(())
}
