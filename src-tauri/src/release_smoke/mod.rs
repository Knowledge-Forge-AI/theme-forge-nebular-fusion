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
const RECEIPT_SCHEMA: &str = "nebular.release-smoke-receipt-v1";
const DRIVER: &str = include_str!("driver.js");
const DRIVER_BUDGET: Duration = Duration::from_secs(300);
const SIGNAL_BUDGET: Duration = Duration::from_secs(120);

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
}

impl Scenario {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "A" => Some(Self::HostFirst),
            "B" => Some(Self::CompileFirst),
            "C" => Some(Self::RestartCancel),
            "C-signal" => Some(Self::RestartCancelSignal),
            _ => None,
        }
    }

    pub(crate) fn id(self) -> &'static str {
        match self {
            Self::HostFirst => "A",
            Self::CompileFirst => "B",
            Self::RestartCancel => "C",
            Self::RestartCancelSignal => "C-signal",
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
}

/// An activated release smoke.
#[derive(Debug)]
pub(crate) struct ReleaseSmoke {
    scenario: Scenario,
    directory: PathBuf,
}

impl ReleaseSmoke {
    pub(crate) fn scenario(&self) -> Scenario {
        self.scenario
    }

    pub(crate) fn directory(&self) -> &Path {
        &self.directory
    }

    pub(crate) fn selections(&self) -> ScriptedSelections {
        ScriptedSelections {
            root: self.directory.clone(),
            sequence: self.scenario.selections(),
            next: AtomicUsize::new(0),
        }
    }
}

/// Parses the activation from the process arguments and the smoke directory variable.
/// `Ok(None)` is the ordinary, inert launch.
pub(crate) fn activation(
    args: impl IntoIterator<Item = OsString>,
    directory: Option<OsString>,
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
    Ok(Some(ReleaseSmoke {
        scenario,
        directory,
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
        let config = format!(
            "window.__NEBULAR_RELEASE_SMOKE_CONFIG__ = Object.freeze({{ scenario: {:?} }});\n",
            smoke.scenario.id()
        );
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
    use super::{DIRECTORY_ENV, FLAG, Scenario, activation, bounded, parse_poll};
    use std::ffi::OsString;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

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
}
