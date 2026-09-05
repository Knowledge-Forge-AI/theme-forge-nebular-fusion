use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::sidecar::artifact::VerifiedDistribution;
use crate::sidecar::coordinator::RequestCoordinator;
use crate::sidecar::framing::NdjsonFramer;
use crate::sidecar::protocol::{PublicCapabilitySummary, RasterStatus};

const CHANNEL_BOUND: usize = 8;
const TERMINATION_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug)]
pub(crate) enum ReaderEvent {
    Frame(String),
    Protocol,
    Eof,
}

#[derive(Debug, Default)]
pub(crate) struct TransportState {
    pub(crate) overflowed: bool,
}

type TransportLock = Mutex<TransportState>;
pub(crate) type SharedTransportState = Arc<TransportLock>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum SessionInitFault {
    MissingStdin,
    MissingStdout,
    MissingStderr,
    StdoutWorkerSpawn,
    StderrWorkerSpawn,
}

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminationFault {
    UnreapedKillFailure,
    ReportWaitFailure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerminationOutcome {
    Success,
    ReapedWorkerJoinFailure,
    Unreaped,
}

impl TerminationOutcome {
    pub(crate) const fn is_success(self) -> bool {
        matches!(self, Self::Success)
    }

    pub(crate) const fn is_unreaped(self) -> bool {
        matches!(self, Self::Unreaped)
    }
}

#[derive(Debug)]
pub(crate) struct ProcessSession {
    pub(crate) child: Child,
    pub(crate) stdin: Option<ChildStdin>,
    pub(crate) receiver: Receiver<ReaderEvent>,
    pub(crate) transport: SharedTransportState,
    pub(crate) reader: Option<JoinHandle<()>>,
    pub(crate) stderr: Option<JoinHandle<u64>>,
    pub(crate) coordinator: RequestCoordinator,
    pub(crate) nonce: String,
    pub(crate) server_version: String,
    pub(crate) methods: Vec<String>,
    pub(crate) capabilities: Option<PublicCapabilitySummary>,
    pub(crate) raster: RasterStatus,
    #[cfg(test)]
    pub(crate) termination_fault: Option<TerminationFault>,
}

impl ProcessSession {
    pub(crate) fn transport_overflowed(&self) -> bool {
        self.transport.lock().map_or(true, |state| state.overflowed)
    }
}

struct SessionInitGuard {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
    stderr: Option<JoinHandle<u64>>,
}

impl SessionInitGuard {
    fn new(child: Child) -> Self {
        Self {
            child: Some(child),
            stdin: None,
            reader: None,
            stderr: None,
        }
    }

    fn cleanup(&mut self) -> TerminationOutcome {
        self.stdin.take();
        let reaped = self.child.as_mut().is_none_or(terminate_child);
        if !reaped {
            return TerminationOutcome::Unreaped;
        }
        let reader_ok = self
            .reader
            .take()
            .is_none_or(|worker| worker.join().is_ok());
        let stderr_ok = self
            .stderr
            .take()
            .is_none_or(|worker| worker.join().is_ok());
        if reader_ok && stderr_ok {
            TerminationOutcome::Success
        } else {
            TerminationOutcome::ReapedWorkerJoinFailure
        }
    }
}

impl Drop for SessionInitGuard {
    fn drop(&mut self) {
        let _ = self.cleanup();
    }
}

fn publish(
    sender: &SyncSender<ReaderEvent>,
    transport: &SharedTransportState,
    event: ReaderEvent,
) -> bool {
    let Ok(mut state) = transport.lock() else {
        return false;
    };
    if state.overflowed {
        return false;
    }
    match sender.try_send(event) {
        Ok(()) => true,
        Err(TrySendError::Full(_)) => {
            state.overflowed = true;
            false
        }
        Err(TrySendError::Disconnected(_)) => false,
    }
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

pub(crate) fn spawn_process(
    verified: &VerifiedDistribution,
    temp: &Path,
) -> std::io::Result<ProcessSession> {
    std::fs::create_dir_all(temp)?;
    verified.revalidate_for_spawn()?;
    let entrypoint = verified.payload.join("dist/service-protocol/server-cli.js");
    let child = Command::new(&verified.binary)
        .arg(&entrypoint)
        .current_dir(&verified.payload)
        .env_clear()
        .env("LANG", "C")
        .env("LC_ALL", "C")
        .env("TZ", "UTC")
        .env("TMPDIR", temp)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    session_from_child(child)
}

#[cfg(test)]
pub(crate) fn spawn_test_process(executable: &Path, mode: &str) -> std::io::Result<ProcessSession> {
    let child = Command::new(executable)
        .env_clear()
        .env("TFSB_FAKE_MODE", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    session_from_child(child)
}

#[cfg(test)]
pub(crate) fn spawn_test_process_with_init_fault(
    executable: &Path,
    mode: &str,
    fault: SessionInitFault,
) -> std::io::Result<ProcessSession> {
    let child = Command::new(executable)
        .env_clear()
        .env("TFSB_FAKE_MODE", mode)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    session_from_child_inner(child, Some(fault))
}

fn session_from_child(child: Child) -> std::io::Result<ProcessSession> {
    session_from_child_inner(child, None)
}

fn session_from_child_inner(
    mut child: Child,
    fault: Option<SessionInitFault>,
) -> std::io::Result<ProcessSession> {
    match fault {
        Some(SessionInitFault::MissingStdin) => drop(child.stdin.take()),
        Some(SessionInitFault::MissingStdout) => drop(child.stdout.take()),
        Some(SessionInitFault::MissingStderr) => drop(child.stderr.take()),
        _ => {}
    }
    let mut guard = SessionInitGuard::new(child);
    let (stdin, stdout, stderr) = {
        let child = guard
            .child
            .as_mut()
            .ok_or_else(|| std::io::Error::other("missing child owner"))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("missing child stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("missing child stdout"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::other("missing child stderr"))?;
        (stdin, stdout, stderr)
    };
    guard.stdin = Some(stdin);
    let (sender, receiver) = mpsc::sync_channel(CHANNEL_BOUND);
    let transport = SharedTransportState::default();
    let reader_transport = Arc::clone(&transport);
    if fault == Some(SessionInitFault::StdoutWorkerSpawn) {
        return Err(std::io::Error::other(
            "injected stdout worker spawn failure",
        ));
    }
    let reader = thread::Builder::new()
        .name("tfsb-sidecar-stdout".to_owned())
        .spawn(move || {
            let mut input = BufReader::new(stdout);
            let mut framer = NdjsonFramer::default();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                match input.read(&mut buffer) {
                    Ok(0) => {
                        let _ = publish(
                            &sender,
                            &reader_transport,
                            if framer.finish().is_ok() {
                                ReaderEvent::Eof
                            } else {
                                ReaderEvent::Protocol
                            },
                        );
                        break;
                    }
                    Ok(count) => match framer.push(&buffer[..count]) {
                        Ok(frames) => {
                            for frame in frames {
                                if !publish(&sender, &reader_transport, ReaderEvent::Frame(frame)) {
                                    return;
                                }
                            }
                        }
                        Err(_) => {
                            let _ = publish(&sender, &reader_transport, ReaderEvent::Protocol);
                            break;
                        }
                    },
                    Err(_) => {
                        let _ = publish(&sender, &reader_transport, ReaderEvent::Protocol);
                        break;
                    }
                }
            }
        })?;
    guard.reader = Some(reader);
    if fault == Some(SessionInitFault::StderrWorkerSpawn) {
        return Err(std::io::Error::other(
            "injected stderr worker spawn failure",
        ));
    }
    let stderr = thread::Builder::new()
        .name("tfsb-sidecar-stderr".to_owned())
        .spawn(move || {
            let mut input = BufReader::new(stderr);
            let mut buffer = [0_u8; 4096];
            let mut observed = 0_u64;
            loop {
                match input.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(count) => observed = observed.saturating_add(count as u64).min(1_048_576),
                }
            }
            observed
        })?;
    guard.stderr = Some(stderr);
    let child = guard
        .child
        .take()
        .ok_or_else(|| std::io::Error::other("missing child owner"))?;
    let stdin = guard
        .stdin
        .take()
        .ok_or_else(|| std::io::Error::other("missing child stdin owner"))?;
    let reader = guard
        .reader
        .take()
        .ok_or_else(|| std::io::Error::other("missing stdout worker owner"))?;
    let stderr = guard
        .stderr
        .take()
        .ok_or_else(|| std::io::Error::other("missing stderr worker owner"))?;
    Ok(ProcessSession {
        child,
        stdin: Some(stdin),
        receiver,
        transport,
        reader: Some(reader),
        stderr: Some(stderr),
        coordinator: RequestCoordinator::default(),
        nonce: String::new(),
        server_version: String::new(),
        methods: Vec::new(),
        capabilities: None,
        raster: RasterStatus {
            available: false,
            qualification_identity: None,
        },
        #[cfg(test)]
        termination_fault: None,
    })
}

pub(crate) fn terminate_process(process: &mut ProcessSession) -> TerminationOutcome {
    process.stdin.take();
    #[cfg(test)]
    if process.termination_fault == Some(TerminationFault::UnreapedKillFailure) {
        return TerminationOutcome::Unreaped;
    }
    let wait_ok = terminate_child(&mut process.child);
    if !wait_ok {
        return TerminationOutcome::Unreaped;
    }
    let reader_ok = process
        .reader
        .take()
        .is_none_or(|worker| worker.join().is_ok());
    let stderr_ok = process
        .stderr
        .take()
        .is_none_or(|worker| worker.join().is_ok());
    let complete = wait_ok && reader_ok && stderr_ok;
    #[cfg(test)]
    if process.termination_fault == Some(TerminationFault::ReportWaitFailure) {
        return TerminationOutcome::ReapedWorkerJoinFailure;
    }
    if complete {
        TerminationOutcome::Success
    } else {
        TerminationOutcome::ReapedWorkerJoinFailure
    }
}
