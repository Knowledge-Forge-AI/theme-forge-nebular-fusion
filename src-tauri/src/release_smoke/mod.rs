//! Release smoke mode of the release binary.
//!
//! The mode is compiled into every build and is inert by default. It activates only when the binary
//! is launched with `--nebular-release-smoke=<scenario>` **and** `TFNF_RELEASE_SMOKE_DIR` names an
//! owner-only directory inside the temporary directory; the flag without a valid directory refuses
//! to start, and the directory without the flag is ignored. When active it:
//!
//! * opens the real window with a non-persistent (incognito) webview whose data directory and the
//!   sidecar temporary directory live inside the smoke directory;
//! * answers native project selection from a compiled-in, finite list of directories that must
//!   resolve inside the smoke directory (the page cannot choose paths);
//! * routes ordinary appearance preferences to the fixed `appearance-preferences` subdirectory of
//!   the smoke root, while P-save/P-restart pass the validated sibling parent whose fixed child is
//!   shared by the two views, rather than using the production application configuration directory;
//! * drives the real packaged frontend through its DOM and the real JS-to-Rust command bridge with
//!   a compiled-in driver script, adding no command and no capability;
//! * writes one exclusively created receipt and quits through the normal exit path (or, for the
//!   signal scenario, waits for the harness to terminate the process).

mod io;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, WebviewWindow};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};

pub(crate) const FLAG: &str = "--nebular-release-smoke";
pub(crate) const DIRECTORY_ENV: &str = "TFNF_RELEASE_SMOKE_DIR";
pub(crate) const PREFERENCES_ENV: &str = "TFNF_RELEASE_SMOKE_PREFERENCES_DIR";
const RECEIPT_SCHEMA: &str = "nebular.release-smoke-receipt-v1";
const DRIVER: &str = include_str!("driver.js");
const APPEARANCE_EXPECTATIONS_JSON: &str = include_str!("appearance-role-expectations.v1.json");
const DRIVER_BUDGET: Duration = Duration::from_secs(300);
const SIGNAL_BUDGET: Duration = Duration::from_secs(120);

const APPEARANCE_EXPECTATION_ROLES: [&str; 6] = [
    "--background",
    "--primary",
    "--tf-appearance-font-ui",
    "--tf-appearance-radius-surface",
    "--tf-appearance-selection",
    "--tf-appearance-selection-text",
];
const APPEARANCE_EXPECTATION_FAMILIES: [&str; 6] = [
    "terminal-nova",
    "nebular",
    "developer",
    "graphic-designer",
    "anime",
    "gamer",
];

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppearanceExpectationSource {
    runtime_baselines_path: String,
    runtime_baselines_sha256: String,
    catalog_index_path: String,
    catalog_index_sha256: String,
    declared_source_catalog_sha256: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppearanceExpectationRoles {
    #[serde(rename = "--background")]
    background: String,
    #[serde(rename = "--primary")]
    primary: String,
    #[serde(rename = "--tf-appearance-font-ui")]
    font_ui: String,
    #[serde(rename = "--tf-appearance-radius-surface")]
    radius_surface: String,
    #[serde(rename = "--tf-appearance-selection")]
    selection: String,
    #[serde(rename = "--tf-appearance-selection-text")]
    selection_text: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppearanceExpectationRow {
    family: String,
    mode: String,
    roles: AppearanceExpectationRoles,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AppearanceExpectations {
    schema: String,
    source: AppearanceExpectationSource,
    roles: Vec<String>,
    rows: Vec<AppearanceExpectationRow>,
    canonical_rows_sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairedDriverConfig {
    scenario: &'static str,
    appearance_expectations: AppearanceExpectations,
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn expectation_role_values_are_static(roles: &AppearanceExpectationRoles) -> bool {
    [
        roles.background.as_str(),
        roles.primary.as_str(),
        roles.font_ui.as_str(),
        roles.radius_surface.as_str(),
        roles.selection.as_str(),
        roles.selection_text.as_str(),
    ]
    .iter()
    .all(|value| {
        !value.trim().is_empty()
            && !value.contains("var(")
            && !value.contains("calc(")
            && !value.contains("env(")
            && !value.contains("attr(")
    })
}

fn validate_appearance_expectations(value: &AppearanceExpectations) -> Result<(), &'static str> {
    if value.schema != "theme-forge.appearance-role-expectations.v1" {
        return Err("appearance expectations schema is invalid");
    }
    if value.roles.len() != APPEARANCE_EXPECTATION_ROLES.len()
        || value
            .roles
            .iter()
            .zip(APPEARANCE_EXPECTATION_ROLES.iter())
            .any(|(actual, expected)| actual != expected)
    {
        return Err("appearance expectations role order is invalid");
    }
    if value.source.runtime_baselines_path
        != "frontend-fixture/src/features/appearance/generated/runtime-baselines.ts"
        || value.source.catalog_index_path
            != "frontend-fixture/src/features/appearance/generated/catalog-index.json"
        || !is_sha256(&value.source.runtime_baselines_sha256)
        || !is_sha256(&value.source.catalog_index_sha256)
        || !is_sha256(&value.source.declared_source_catalog_sha256)
        || !is_sha256(&value.canonical_rows_sha256)
    {
        return Err("appearance expectations source identity is invalid");
    }
    if value.rows.len() != APPEARANCE_EXPECTATION_FAMILIES.len() * 2 {
        return Err("appearance expectations must contain twelve rows");
    }
    for (index, row) in value.rows.iter().enumerate() {
        let expected_family =
            APPEARANCE_EXPECTATION_FAMILIES[index % APPEARANCE_EXPECTATION_FAMILIES.len()];
        let expected_mode = if index < APPEARANCE_EXPECTATION_FAMILIES.len() {
            "light"
        } else {
            "dark"
        };
        if row.family != expected_family || row.mode != expected_mode {
            return Err("appearance expectations row order is invalid");
        }
        if !expectation_role_values_are_static(&row.roles) {
            return Err("appearance expectations contain an unsupported role value");
        }
    }
    Ok(())
}

fn paired_driver_config(scenario: Scenario) -> Result<String, &'static str> {
    let scenario_json = serde_json::to_string(scenario.id())
        .map_err(|_| "release smoke scenario serialization failed")?;
    if !scenario.is_paired_v2() {
        return Ok(format!(
            "window.__NEBULAR_RELEASE_SMOKE_CONFIG__ = Object.freeze({{ scenario: {scenario_json} }});\n"
        ));
    }
    let expectations = serde_json::from_str::<AppearanceExpectations>(APPEARANCE_EXPECTATIONS_JSON)
        .map_err(|_| "appearance expectations JSON is invalid")?;
    validate_appearance_expectations(&expectations)?;
    let payload = serde_json::to_string(&PairedDriverConfig {
        scenario: scenario.id(),
        appearance_expectations: expectations,
    })
    .map_err(|_| "appearance expectations serialization failed")?;
    Ok(format!(
        "window.__NEBULAR_RELEASE_SMOKE_CONFIG__ = Object.freeze({payload});\n"
    ))
}

/// The deliberately different platform scenarios. Each fixes its own selection sequence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Scenario {
    /// macOS: host and sidecar first, then project, Theme Lab and App Theme.
    HostFirst,
    /// Linux arm64: App Theme compile before the host, Unicode and case-distinct project paths.
    CompileFirst,
    /// Linux x64: restart and cancel ordering, derived output on a case-sensitive path; normal quit.
    RestartCancel,
    /// As `RestartCancel`, but the process then waits for the harness to terminate it.
    RestartCancelSignal,
    /// First half of the fixed two-process appearance-preference restart pair.
    AppearancePairSave,
    /// Second half of the fixed two-process appearance-preference restart pair.
    AppearancePairRestart,
    /// The fixed paired-v2 authoring branch with finite source-side pickers.
    PairedV2,
}

impl Scenario {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "A" => Some(Self::HostFirst),
            "B" => Some(Self::CompileFirst),
            "C" => Some(Self::RestartCancel),
            "C-signal" => Some(Self::RestartCancelSignal),
            "P-save" => Some(Self::AppearancePairSave),
            "P-restart" => Some(Self::AppearancePairRestart),
            "paired-v2" => Some(Self::PairedV2),
            _ => None,
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::HostFirst => "A",
            Self::CompileFirst => "B",
            Self::RestartCancel => "C",
            Self::RestartCancelSignal => "C-signal",
            Self::AppearancePairSave => "P-save",
            Self::AppearancePairRestart => "P-restart",
            Self::PairedV2 => "paired-v2",
        }
    }

    /// Directories answered, in order, to native project selection. They are prepared by the
    /// harness from maintained public fixtures and must resolve inside the smoke directory.
    pub(crate) fn selections(self) -> &'static [&'static str] {
        match self {
            Self::HostFirst => &["fixtures/core-minimal"],
            Self::CompileFirst => &[
                "fixtures/Nebular Smoke Ünïcode/Project Ω",
                "fixtures/Nebular Smoke Ünïcode/project Ω",
            ],
            Self::RestartCancel | Self::RestartCancelSignal => {
                &["fixtures/Derive Target/Case", "fixtures/Derive Target/case"]
            }
            Self::AppearancePairSave | Self::AppearancePairRestart | Self::PairedV2 => &[],
        }
    }

    pub(crate) fn is_appearance_pair(self) -> bool {
        matches!(self, Self::AppearancePairSave | Self::AppearancePairRestart)
    }

    pub(crate) fn is_paired_v2(self) -> bool {
        self == Self::PairedV2
    }

    pub(crate) fn appearance_pair_role(self) -> Option<&'static str> {
        match self {
            Self::AppearancePairSave => Some("view-a"),
            Self::AppearancePairRestart => Some("view-b"),
            _ => None,
        }
    }

    fn awaits_signal(self) -> bool {
        self == Self::RestartCancelSignal
    }
}

/// Compiled-in selections answered to the native picker while the smoke mode is active.
#[derive(Debug)]
pub(crate) struct ScriptedSelections {
    root: PathBuf,
    sequence: &'static [&'static str],
    next: AtomicUsize,
    scenario: Scenario,
    paired_open: AtomicUsize,
    paired_import: AtomicUsize,
    paired_review_import: AtomicUsize,
    paired_export: AtomicUsize,
    paired_review_export: AtomicUsize,
    paired_save: AtomicUsize,
}

impl ScriptedSelections {
    /// Answers one directory selection. Files, exhausted sequences and anything that does not
    /// resolve strictly inside the smoke directory are rejected.
    pub(crate) fn pick_directory(&self, directory: bool) -> StudioResult<Option<PathBuf>> {
        if !directory {
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }
        let index = self.next.fetch_add(1, Ordering::SeqCst);
        let relative = self
            .sequence
            .get(index)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))?;
        io::contained_directory(&self.root, relative)
            .map(Some)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::SelectionRejected))
    }

    pub(crate) fn is_paired_v2(&self) -> bool {
        self.scenario.is_paired_v2()
    }

    /// Returns one path from the fixed paired-v2 exchange table. This method is
    /// activation-gated and never creates, overwrites, or discovers a path.
    pub(crate) fn paired_file(&self, key: &str) -> StudioResult<PathBuf> {
        if !self.is_paired_v2() {
            return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
        }
        let (name, existing) = match key {
            "open" => {
                let index = self.paired_open.fetch_add(1, Ordering::SeqCst);
                let name = match index {
                    0 => "baseline.theme.json",
                    1 => "v2-saved.theme.json",
                    _ => {
                        return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                    }
                };
                (name, true)
            }
            "import" => {
                if self.paired_import.fetch_add(1, Ordering::SeqCst) != 0 {
                    return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                }
                ("candidate-v2.json", true)
            }
            "review-import" => {
                if self.paired_review_import.fetch_add(1, Ordering::SeqCst) != 0 {
                    return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                }
                ("review-v2.json", true)
            }
            "tf-paired-profile-v2-candidate" => {
                if self.paired_export.fetch_add(1, Ordering::SeqCst) != 0 {
                    return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                }
                ("candidate-v2.json", false)
            }
            "tf-paired-profile-v2-review" => {
                if self.paired_review_export.fetch_add(1, Ordering::SeqCst) != 0 {
                    return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                }
                ("review-v2.json", false)
            }
            "save-v2" => {
                if self.paired_save.fetch_add(1, Ordering::SeqCst) != 0 {
                    return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
                }
                ("v2-saved.theme.json", false)
            }
            _ => {
                return Err(StudioCommandError::new(StudioReasonCode::SelectionRejected));
            }
        };
        if existing {
            io::paired_exchange_source(&self.root, name)
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        } else {
            io::paired_exchange_destination(&self.root, name)
                .map_err(|_| StudioCommandError::new(StudioReasonCode::SelectionRejected))
        }
    }
}

/// An activated release smoke.
#[derive(Debug)]
pub(crate) struct ReleaseSmoke {
    scenario: Scenario,
    directory: PathBuf,
    appearance_preferences: Option<PathBuf>,
}

impl ReleaseSmoke {
    pub(crate) fn scenario(&self) -> Scenario {
        self.scenario
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn appearance_preferences(&self) -> Option<&Path> {
        self.appearance_preferences.as_deref()
    }

    pub(crate) fn selections(&self) -> ScriptedSelections {
        ScriptedSelections {
            root: self.directory.clone(),
            sequence: self.scenario.selections(),
            next: AtomicUsize::new(0),
            scenario: self.scenario,
            paired_open: AtomicUsize::new(0),
            paired_import: AtomicUsize::new(0),
            paired_review_import: AtomicUsize::new(0),
            paired_export: AtomicUsize::new(0),
            paired_review_export: AtomicUsize::new(0),
            paired_save: AtomicUsize::new(0),
        }
    }
}

/// Parses the activation from the process arguments and the smoke directory variable.
/// `Ok(None)` is the ordinary, inert launch.
pub(crate) fn activation(
    args: impl IntoIterator<Item = OsString>,
    directory: Option<OsString>,
) -> Result<Option<ReleaseSmoke>, &'static str> {
    activation_with_preferences(args, directory, std::env::var_os(PREFERENCES_ENV))
}

/// Parses activation with the optional fixed P-save/P-restart preference
/// parent. Ordinary launches ignore a stray preference variable; active
/// non-P scenarios reject it before the WebView starts.
pub(crate) fn activation_with_preferences(
    args: impl IntoIterator<Item = OsString>,
    directory: Option<OsString>,
    appearance_preferences: Option<OsString>,
) -> Result<Option<ReleaseSmoke>, &'static str> {
    let mut args = args.into_iter().skip(1);
    let mut requested = None;
    while let Some(arg) = args.next() {
        let Some(text) = arg.to_str() else { continue };
        let value = if let Some(value) = text.strip_prefix("--nebular-release-smoke=") {
            Some(value.to_owned())
        } else if text == FLAG {
            Some(
                args.next()
                    .and_then(|value| value.into_string().ok())
                    .ok_or("release smoke scenario is missing")?,
            )
        } else {
            None
        };
        if let Some(value) = value {
            if requested.is_some() {
                return Err("release smoke requested more than once");
            }
            requested = Some(value);
        }
    }
    let Some(requested) = requested else {
        return Ok(None);
    };
    let scenario = Scenario::parse(&requested).ok_or("unknown release smoke scenario")?;
    let directory = directory.ok_or("release smoke directory is not set")?;
    let directory = io::validated_directory(Path::new(&directory))?;
    let appearance_preferences = if scenario.is_appearance_pair() {
        let supplied = appearance_preferences.ok_or("appearance preference parent is not set")?;
        Some(io::validated_appearance_preferences(
            &directory,
            Path::new(&supplied),
            scenario
                .appearance_pair_role()
                .ok_or("appearance pair role is missing")?,
        )?)
    } else {
        if appearance_preferences.is_some() {
            return Err("appearance preference parent requires an appearance pair scenario");
        }
        None
    };
    Ok(Some(ReleaseSmoke {
        scenario,
        directory,
        appearance_preferences,
    }))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverStep {
    id: String,
    ok: bool,
    via: String,
    ms: u64,
    detail: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DriverResult {
    status: String,
    scenario: String,
    steps: Vec<DriverStep>,
    #[serde(default)]
    facts: Vec<(String, String)>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExecutableIdentity {
    path: String,
    dev: u64,
    ino: u64,
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    schema: &'static str,
    scenario: &'static str,
    status: &'a str,
    application_version: &'static str,
    target: &'static str,
    pid: u32,
    started_at_unix_ms: u128,
    finished_at_unix_ms: u128,
    awaiting_signal: bool,
    executable: Option<ExecutableIdentity>,
    driver: Option<&'a DriverResult>,
    failure: Option<&'a str>,
}

fn unix_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis())
}

/// Shortens to at most `max` bytes on a character boundary (`String::truncate` panics inside a character).
fn clip(value: &mut String, max: usize) {
    if value.len() > max {
        let mut end = max;
        while !value.is_char_boundary(end) {
            end -= 1;
        }
        value.truncate(end);
    }
}

fn bounded(driver: &mut DriverResult) {
    for step in &mut driver.steps {
        clip(&mut step.id, 96);
        clip(&mut step.via, 16);
        clip(&mut step.detail, 512);
    }
    driver.facts.truncate(32);
    for (key, value) in &mut driver.facts {
        clip(key, 64);
        clip(value, 1024);
    }
}

fn target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "unsupported"
    }
}

fn record(
    smoke: &ReleaseSmoke,
    started: u128,
    driver: Option<&DriverResult>,
    failure: Option<&str>,
) -> bool {
    let passed = failure.is_none()
        && driver.is_some_and(|result| {
            result.status == "pass"
                && result.scenario == smoke.scenario.id()
                && !result.steps.is_empty()
                && result.steps.iter().all(|step| step.ok)
        });
    let executable = io::executable_identity()
        .ok()
        .map(|(path, dev, ino, size, sha256)| ExecutableIdentity {
            path,
            dev,
            ino,
            size,
            sha256,
        });
    let status = if passed && executable.is_some() {
        "pass"
    } else {
        "fail"
    };
    let receipt = Receipt {
        schema: RECEIPT_SCHEMA,
        scenario: smoke.scenario.id(),
        status,
        application_version: env!("CARGO_PKG_VERSION"),
        target: target(),
        pid: std::process::id(),
        started_at_unix_ms: started,
        finished_at_unix_ms: unix_ms(),
        awaiting_signal: status == "pass" && smoke.scenario.awaits_signal(),
        executable,
        driver,
        failure: failure.or_else(|| (!passed).then_some("driver did not pass every step")),
    };
    let written = serde_json::to_vec_pretty(&receipt)
        .map_err(std::io::Error::other)
        .and_then(|bytes| io::write_receipt(&smoke.directory, &bytes));
    if written.is_err() {
        eprintln!("release smoke: receipt could not be written");
        return false;
    }
    status == "pass"
}

const POLL: &str = "JSON.stringify({ done: window.__NEBULAR_RELEASE_SMOKE__ ?? null, progress: window.__NEBULAR_RELEASE_SMOKE_PROGRESS__ ?? null })";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Poll {
    done: Option<DriverResult>,
    progress: Option<DriverResult>,
}

// The webview answers each poll through the evaluation callback; the raw answer is only forwarded to
// the orchestration thread, which alone parses it, records the receipt and decides how to exit.
fn parse_poll(raw: &str) -> Option<Poll> {
    let text = serde_json::from_str::<String>(raw).unwrap_or_else(|_| raw.to_owned());
    serde_json::from_str::<Poll>(&text).ok()
}

/// Injects the compiled-in driver into the real window and records its result. Runs on its own
/// thread; the application quits through `AppHandle::exit`, i.e. the normal exit path. If the budget
/// elapses, the receipt still carries the driver's last published progress.
pub(crate) fn start(window: &WebviewWindow, app: AppHandle, smoke: ReleaseSmoke) {
    let window = window.clone();
    thread::spawn(move || {
        let started = unix_ms();
        let config = match paired_driver_config(smoke.scenario) {
            Ok(config) => config,
            Err(reason) => {
                let _ = record(&smoke, started, None, Some(reason));
                app.exit(1);
                return;
            }
        };
        thread::sleep(Duration::from_millis(1500));
        if window.eval(format!("{config}{DRIVER}")).is_err() {
            let _ = record(&smoke, started, None, Some("driver injection failed"));
            app.exit(1);
            return;
        }
        let (sender, receiver) = mpsc::channel::<String>();
        let deadline = Instant::now() + DRIVER_BUDGET;
        let mut progress: Option<DriverResult> = None;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            let answer = sender.clone();
            let _ = window.eval_with_callback(POLL, move |raw| {
                let _ = answer.send(raw);
            });
            while let Ok(raw) = receiver.try_recv() {
                let Some(poll) = parse_poll(&raw) else {
                    continue;
                };
                if let Some(mut result) = poll
                    .done
                    .filter(|result| matches!(result.status.as_str(), "pass" | "fail"))
                {
                    bounded(&mut result);
                    let passed = record(&smoke, started, Some(&result), None);
                    if passed && smoke.scenario.awaits_signal() {
                        // The harness terminates the process; if it never does, fail rather than linger.
                        thread::sleep(SIGNAL_BUDGET);
                        app.exit(3);
                        return;
                    }
                    app.exit(if passed { 0 } else { 1 });
                    return;
                }
                if poll.progress.is_some() {
                    progress = poll.progress;
                }
            }
        }
        if let Some(result) = progress.as_mut() {
            bounded(result);
        }
        let _ = record(
            &smoke,
            started,
            progress.as_ref(),
            Some("driver budget elapsed"),
        );
        app.exit(1);
    });
}

#[cfg(test)]
mod tests {
    use super::{
        APPEARANCE_EXPECTATIONS_JSON, AppearanceExpectations, DIRECTORY_ENV, FLAG, Scenario,
        ScriptedSelections, activation, bounded, parse_poll, validate_appearance_expectations,
    };
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn generated_appearance_rows_are_accepted_in_light_then_dark_order() -> Result<(), &'static str>
    {
        let value = serde_json::from_str::<AppearanceExpectations>(APPEARANCE_EXPECTATIONS_JSON)
            .map_err(|_| "generated appearance expectations must decode")?;
        assert_eq!(validate_appearance_expectations(&value), Ok(()));
        assert_eq!(value.rows[1].family, "nebular");
        assert_eq!(value.rows[1].mode, "light");
        assert_eq!(value.rows[6].family, "terminal-nova");
        assert_eq!(value.rows[6].mode, "dark");
        Ok(())
    }

    #[test]
    fn reordered_generated_appearance_rows_are_rejected() -> Result<(), &'static str> {
        let mut value =
            serde_json::from_str::<AppearanceExpectations>(APPEARANCE_EXPECTATIONS_JSON)
                .map_err(|_| "generated appearance expectations must decode")?;
        value.rows.swap(1, 6);
        assert_eq!(
            validate_appearance_expectations(&value),
            Err("appearance expectations row order is invalid")
        );
        Ok(())
    }

    fn args(values: &[&str]) -> Vec<OsString> {
        std::iter::once("tfnf")
            .chain(values.iter().copied())
            .map(OsString::from)
            .collect()
    }

    fn smoke_dir(name: &str) -> std::io::Result<std::path::PathBuf> {
        let path =
            std::env::temp_dir().join(format!("nebular-activation-{}-{name}", std::process::id()));
        if path.exists() {
            fs::remove_dir_all(&path)?;
        }
        fs::create_dir(&path)?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700))?;
        Ok(path)
    }

    fn paired_selections(root: PathBuf) -> ScriptedSelections {
        ScriptedSelections {
            root,
            sequence: &[],
            next: AtomicUsize::new(0),
            scenario: Scenario::PairedV2,
            paired_open: AtomicUsize::new(0),
            paired_import: AtomicUsize::new(0),
            paired_review_import: AtomicUsize::new(0),
            paired_export: AtomicUsize::new(0),
            paired_review_export: AtomicUsize::new(0),
            paired_save: AtomicUsize::new(0),
        }
    }

    fn exchange(root: &std::path::Path) -> std::io::Result<PathBuf> {
        let exchange = root.join("exchange");
        fs::create_dir(&exchange)?;
        fs::set_permissions(&exchange, fs::Permissions::from_mode(0o700))?;
        Ok(exchange)
    }

    fn exchange_file(exchange: &std::path::Path, name: &str) -> std::io::Result<()> {
        let path = exchange.join(name);
        fs::write(&path, b"fixed proposal fixture")?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
    }

    #[test]
    fn polls_distinguish_progress_from_a_finished_driver() {
        let running = r#"{"done":null,"progress":{"status":"running","scenario":"B","steps":[{"id":"app-shell","ok":true,"via":"dom","ms":1,"detail":""}],"facts":[]}}"#;
        let wrapped = serde_json::to_string(running).unwrap_or_default();
        let poll = parse_poll(&wrapped);
        assert!(poll.as_ref().is_some_and(|poll| poll.done.is_none()));
        assert!(poll.is_some_and(|poll| {
            poll.progress
                .is_some_and(|progress| progress.steps.len() == 1)
        }));
        let finished = r#"{"done":{"status":"pass","scenario":"A","steps":[],"facts":[["k","v"]]},"progress":null}"#;
        assert!(
            parse_poll(finished)
                .is_some_and(|poll| poll.done.is_some_and(|done| done.status == "pass"))
        );
        assert!(parse_poll("null").is_none());
        assert!(parse_poll(r#"{"done":null,"progress":null,"extra":1}"#).is_none());
    }

    #[test]
    fn driver_text_is_bounded_on_character_boundaries() {
        // 511 ASCII bytes then a two-byte character straddling the 512-byte bound, as a step detail can.
        let detail = format!("{}·{}", "a".repeat(511), "Ω".repeat(400));
        let facts: Vec<String> = (0..40)
            .map(|index| format!(r#"["k{index}","{}"]"#, "Ü".repeat(700)))
            .collect();
        let raw = format!(
            r#"{{"done":{{"status":"fail","scenario":"C","steps":[{{"id":"x","ok":false,"via":"dom","ms":1,"detail":"{detail}"}}],"facts":[{}]}},"progress":null}}"#,
            facts.join(",")
        );
        let mut result = parse_poll(&raw).and_then(|poll| poll.done);
        assert!(result.is_some());
        if let Some(result) = result.as_mut() {
            bounded(result);
            assert_eq!(result.steps[0].detail.len(), 511);
            assert_eq!(result.facts.len(), 32);
            assert!(
                result
                    .facts
                    .iter()
                    .all(|(_, value)| value.len() <= 1024 && value.chars().all(|c| c == 'Ü'))
            );
        }
    }

    #[test]
    fn ordinary_launches_are_inert_even_with_the_directory_variable() -> std::io::Result<()> {
        let dir = smoke_dir("inert")?;
        assert!(matches!(activation(args(&[]), None), Ok(None)));
        assert!(matches!(
            activation(args(&["--other"]), Some(dir.clone().into_os_string())),
            Ok(None)
        ));
        assert_eq!(DIRECTORY_ENV, "TFNF_RELEASE_SMOKE_DIR");
        fs::remove_dir_all(dir)
    }

    #[test]
    fn the_flag_requires_a_valid_directory_and_a_known_scenario() -> std::io::Result<()> {
        let dir = smoke_dir("flag")?;
        assert_eq!(
            activation(args(&["--nebular-release-smoke=A"]), None).err(),
            Some("release smoke directory is not set")
        );
        assert_eq!(
            activation(
                args(&["--nebular-release-smoke=Z"]),
                Some(dir.clone().into_os_string())
            )
            .err(),
            Some("unknown release smoke scenario")
        );
        assert_eq!(
            activation(args(&[FLAG]), Some(dir.clone().into_os_string())).err(),
            Some("release smoke scenario is missing")
        );
        assert_eq!(
            activation(
                args(&["--nebular-release-smoke=A", "--nebular-release-smoke=B"]),
                Some(dir.clone().into_os_string())
            )
            .err(),
            Some("release smoke requested more than once")
        );
        assert!(
            activation(
                args(&["--nebular-release-smoke=A"]),
                Some(OsString::from("/"))
            )
            .is_err()
        );
        let active = activation(
            args(&[FLAG, "C-signal"]),
            Some(dir.clone().into_os_string()),
        )
        .map_err(std::io::Error::other)?
        .ok_or_else(|| std::io::Error::other("expected activation"))?;
        assert_eq!(active.scenario(), Scenario::RestartCancelSignal);
        fs::remove_dir_all(dir)
    }

    #[test]
    fn scripted_selections_are_finite_directories_inside_the_smoke_directory() -> std::io::Result<()>
    {
        let dir = smoke_dir("select")?;
        for scenario in [
            Scenario::HostFirst,
            Scenario::CompileFirst,
            Scenario::RestartCancel,
        ] {
            for relative in scenario.selections() {
                fs::create_dir_all(dir.join(relative))?;
            }
        }
        // Scenario B distinguishes case-only different names; that needs a case-sensitive filesystem.
        let case_sensitive = fs::read_dir(dir.join("fixtures/Nebular Smoke Ünïcode"))?.count() == 2;
        let scenario = if case_sensitive { "B" } else { "A" };
        let active = activation(
            args(&[&format!("--nebular-release-smoke={scenario}")]),
            Some(dir.clone().into_os_string()),
        )
        .map_err(std::io::Error::other)?
        .ok_or_else(|| std::io::Error::other("expected activation"))?;
        let selections = active.selections();
        assert!(
            selections.pick_directory(false).is_err(),
            "only directory selections are answered"
        );
        let first = selections
            .pick_directory(true)
            .map_err(|_| std::io::Error::other("first"))?;
        if case_sensitive {
            let second = selections
                .pick_directory(true)
                .map_err(|_| std::io::Error::other("second"))?;
            assert!(
                first
                    .as_ref()
                    .is_some_and(|path| path.ends_with("Nebular Smoke Ünïcode/Project Ω"))
            );
            assert!(
                second
                    .as_ref()
                    .is_some_and(|path| path.ends_with("Nebular Smoke Ünïcode/project Ω"))
            );
            assert_ne!(first, second);
        } else {
            assert!(
                first
                    .as_ref()
                    .is_some_and(|path| path.ends_with("fixtures/core-minimal"))
            );
        }
        assert!(
            selections.pick_directory(true).is_err(),
            "the sequence is finite"
        );
        fs::remove_dir_all(dir)
    }

    #[test]
    fn paired_review_selections_are_closed_finite_and_do_not_change_candidate_paths()
    -> std::io::Result<()> {
        let source_root = smoke_dir("paired-review-source")?;
        let source_exchange = exchange(&source_root)?;
        exchange_file(&source_exchange, "candidate-v2.json")?;
        exchange_file(&source_exchange, "review-v2.json")?;
        let selections = paired_selections(source_root.clone());

        let review_source = selections
            .paired_file("review-import")
            .map_err(|_| std::io::Error::other("review source was rejected"))?;
        assert!(review_source.ends_with("exchange/review-v2.json"));
        assert!(selections.paired_file("review-import").is_err());
        assert!(
            selections
                .paired_file("tf-paired-profile-v2-brief")
                .is_err()
        );
        assert!(
            selections
                .paired_file("tf-paired-profile-v1-review")
                .is_err()
        );
        assert!(selections.paired_file("../review-v2.json").is_err());

        let candidate_source = selections
            .paired_file("import")
            .map_err(|_| std::io::Error::other("candidate source changed"))?;
        assert!(candidate_source.ends_with("exchange/candidate-v2.json"));
        fs::remove_dir_all(source_root)?;

        let destination_root = smoke_dir("paired-review-destination")?;
        let destination_exchange = exchange(&destination_root)?;
        let destinations = paired_selections(destination_root.clone());
        let review_destination = destinations
            .paired_file("tf-paired-profile-v2-review")
            .map_err(|_| std::io::Error::other("review destination was rejected"))?;
        assert!(review_destination.ends_with("exchange/review-v2.json"));
        assert!(!review_destination.exists());
        assert!(
            destinations
                .paired_file("tf-paired-profile-v2-review")
                .is_err()
        );
        exchange_file(&destination_exchange, "review-v2.json")?;
        assert!(
            destinations
                .paired_file("tf-paired-profile-v2-review")
                .is_err()
        );
        fs::remove_dir_all(destination_root)
    }

    #[test]
    fn paired_review_source_rejects_missing_exchange_member() -> std::io::Result<()> {
        let root = smoke_dir("paired-review-missing")?;
        let _exchange = exchange(&root)?;
        let selections = paired_selections(root.clone());
        assert!(selections.paired_file("review-import").is_err());
        fs::remove_dir_all(root)
    }
}
