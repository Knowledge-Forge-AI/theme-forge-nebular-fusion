use std::collections::BTreeSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use sha2::{Digest as _, Sha256};

use crate::errors::{StudioCommandError, StudioReasonCode, StudioResult};
use crate::sidecar::brand_types::{BrandPlanMethod, FrozenRasterPlanDescriptor, StudioPlanSummary};
use crate::sidecar::plan_protocol::{
    DecodedPlanResult, StudioBrandPlanStartRequest, StudioBrandPlanStartResult,
};

const PLAN_TTL: Duration = Duration::from_millis(600_000);

pub(crate) trait MonotonicClock: Send + Sync {
    fn now(&self) -> Instant;
}

struct SystemClock;

impl MonotonicClock for SystemClock {
    fn now(&self) -> Instant {
        Instant::now()
    }
}

#[derive(Clone)]
pub(crate) struct PlanSessionContext {
    pub(crate) generation: u64,
    pub(crate) nonce: String,
    pub(crate) project_handle: Option<String>,
    pub(crate) source_handles: BTreeSet<String>,
    pub(crate) raster_plan: Option<FrozenRasterPlanDescriptor>,
}

pub(crate) struct OperationControl {
    pub(crate) handle: String,
    pub(crate) cancel: Arc<AtomicBool>,
}

pub(crate) enum PlanOperationAction {
    Create {
        request: StudioBrandPlanStartRequest,
        project_handle: String,
        source_handles: Vec<String>,
    },
    Apply {
        plan: RetainedPlan,
    },
    Discard {
        plan: RetainedPlan,
    },
}

pub(crate) struct BegunPlanOperation {
    pub(crate) control: OperationControl,
    pub(crate) action: PlanOperationAction,
}

struct SecretToken(String);

impl SecretToken {
    fn new(value: String) -> Self {
        Self(value)
    }

    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl Drop for SecretToken {
    fn drop(&mut self) {
        let replacement = "0".repeat(self.0.len());
        self.0.replace_range(.., &replacement);
        self.0.clear();
    }
}

pub(crate) struct RetainedPlan {
    pub(crate) local_handle: String,
    token: SecretToken,
    pub(crate) digest: String,
    pub(crate) method: BrandPlanMethod,
    pub(crate) summary: StudioPlanSummary,
    pub(crate) project_handle: String,
    pub(crate) source_handles: Vec<String>,
    pub(crate) session_generation: u64,
    pub(crate) raster_plan: Option<FrozenRasterPlanDescriptor>,
    pub(crate) created_at: Instant,
    pub(crate) expires_at: Instant,
}

impl RetainedPlan {
    pub(crate) fn token(&self) -> &str {
        self.token.expose()
    }
}

struct ActiveOperation {
    handle: String,
    cancel: Arc<AtomicBool>,
}

#[derive(Default)]
struct PlanInner {
    next_operation: u64,
    active: Option<ActiveOperation>,
    retained: Option<RetainedPlan>,
    identity_change_in_progress: bool,
    shutdown: bool,
}

struct SharedPlanState {
    inner: Mutex<PlanInner>,
    wake: Condvar,
    clock: Arc<dyn MonotonicClock>,
}

pub(crate) struct PlanCoordinator {
    shared: Arc<SharedPlanState>,
    expiry_worker: Mutex<Option<JoinHandle<()>>>,
}

pub(crate) struct IdentityChangeGuard {
    shared: Arc<SharedPlanState>,
    reserved: bool,
}

impl PlanCoordinator {
    pub(crate) fn new() -> StudioResult<Self> {
        Self::with_clock(Arc::new(SystemClock))
    }

    fn with_clock(clock: Arc<dyn MonotonicClock>) -> StudioResult<Self> {
        let shared = Arc::new(SharedPlanState {
            inner: Mutex::new(PlanInner::default()),
            wake: Condvar::new(),
            clock,
        });
        let worker_state = shared.clone();
        let worker = std::thread::Builder::new()
            .name("tfsb-studio-plan-expiry".to_owned())
            .spawn(move || expiry_loop(&worker_state))
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))?;
        Ok(Self {
            shared,
            expiry_worker: Mutex::new(Some(worker)),
        })
    }

    pub(crate) fn begin(
        &self,
        request: StudioBrandPlanStartRequest,
        context: &PlanSessionContext,
    ) -> StudioResult<BegunPlanOperation> {
        request.validate()?;
        let now = self.shared.clock.now();
        let mut inner = self.lock()?;
        expire_locked(&mut inner, now);
        if inner.identity_change_in_progress {
            return reason(StudioReasonCode::RequestBusy);
        }
        if inner.active.is_some() {
            return reason(StudioReasonCode::RequestBusy);
        }
        if request.is_create() && inner.retained.is_some() {
            return reason(StudioReasonCode::PlanActive);
        }
        if let Some(project) = request.public_project() {
            if context.project_handle.as_deref() != Some(project) {
                return reason(StudioReasonCode::ContextInvalid);
            }
            if request
                .public_sources()
                .iter()
                .any(|source| !context.source_handles.contains(source))
            {
                return reason(StudioReasonCode::ContextInvalid);
            }
        }
        let method = create_method(&request);
        if matches!(
            method,
            Some(BrandPlanMethod::QaBaseline | BrandPlanMethod::Export)
        ) && context.raster_plan.is_none()
        {
            return reason(StudioReasonCode::CapabilityUnavailable);
        }
        inner.next_operation = inner.next_operation.saturating_add(1).max(1);
        let operation_handle = opaque_handle(
            "operation_",
            &context.nonce,
            &inner.next_operation.to_string(),
            &context.generation.to_string(),
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let action = match request {
            StudioBrandPlanStartRequest::Apply {
                plan_handle,
                expected_plan_digest,
            } => {
                let plan = authenticate_plan(
                    &mut inner,
                    &plan_handle,
                    Some(&expected_plan_digest),
                    context,
                    now,
                )?;
                PlanOperationAction::Apply { plan }
            }
            StudioBrandPlanStartRequest::Discard { plan_handle } => {
                let plan = authenticate_plan(&mut inner, &plan_handle, None, context, now)?;
                PlanOperationAction::Discard { plan }
            }
            create => PlanOperationAction::Create {
                project_handle: create.public_project().unwrap_or_default().to_owned(),
                source_handles: create.public_sources().to_vec(),
                request: create,
            },
        };
        inner.active = Some(ActiveOperation {
            handle: operation_handle.clone(),
            cancel: cancel.clone(),
        });
        Ok(BegunPlanOperation {
            control: OperationControl {
                handle: operation_handle,
                cancel,
            },
            action,
        })
    }

    pub(crate) fn cancel(&self, operation_handle: &str) -> StudioResult<bool> {
        if !valid_operation_handle(operation_handle) {
            return reason(StudioReasonCode::PlanInvalid);
        }
        let inner = self.lock()?;
        let Some(active) = &inner.active else {
            return Ok(false);
        };
        if active.handle != operation_handle {
            return reason(StudioReasonCode::PlanInvalid);
        }
        Ok(!active.cancel.swap(true, Ordering::SeqCst))
    }

    pub(crate) fn finish(&self, operation_handle: &str) {
        if let Ok(mut inner) = self.shared.inner.lock()
            && inner.active.as_ref().map(|active| active.handle.as_str()) == Some(operation_handle)
        {
            inner.active = None;
        }
    }

    pub(crate) fn retain_created(
        &self,
        operation_handle: &str,
        result: DecodedPlanResult,
        context: &PlanSessionContext,
        project_handle: String,
        source_handles: Vec<String>,
    ) -> StudioResult<StudioBrandPlanStartResult> {
        let now = self.shared.clock.now();
        let mut inner = self.lock()?;
        let active = inner
            .active
            .as_ref()
            .filter(|active| active.handle == operation_handle)
            .ok_or_else(|| StudioCommandError::new(StudioReasonCode::Cancelled))?;
        if active.cancel.load(Ordering::SeqCst)
            || context.project_handle.as_deref() != Some(project_handle.as_str())
            || source_handles
                .iter()
                .any(|source| !context.source_handles.contains(source))
        {
            return reason(StudioReasonCode::Cancelled);
        }
        if inner.retained.is_some() {
            return reason(StudioReasonCode::PlanActive);
        }
        let local_handle = opaque_handle(
            "plan_",
            &context.nonce,
            &result.plan_token,
            &format!("{}:{}", result.plan_digest, context.generation),
        );
        let public = StudioBrandPlanStartResult::Ready {
            plan_handle: local_handle.clone(),
            plan_digest: result.plan_digest.clone(),
            method: result.method,
            expires_in_ms: 600_000,
            summary: Box::new(result.summary.clone()),
            project_handle: project_handle.clone(),
            source_handles: source_handles.clone(),
        };
        inner.retained = Some(RetainedPlan {
            local_handle,
            token: SecretToken::new(result.plan_token),
            digest: result.plan_digest,
            method: result.method,
            summary: result.summary,
            project_handle,
            source_handles,
            session_generation: context.generation,
            raster_plan: context.raster_plan,
            created_at: now,
            expires_at: now + PLAN_TTL,
        });
        self.shared.wake.notify_all();
        Ok(public)
    }

    pub(crate) fn restore_unwritten_apply(
        &self,
        operation_handle: &str,
        plan: RetainedPlan,
        context: &PlanSessionContext,
    ) {
        if let Ok(mut inner) = self.shared.inner.lock()
            && inner.active.as_ref().map(|entry| entry.handle.as_str()) == Some(operation_handle)
            && !inner
                .active
                .as_ref()
                .is_some_and(|entry| entry.cancel.load(Ordering::SeqCst))
            && plan.session_generation == context.generation
            && plan.raster_plan == context.raster_plan
            && context.project_handle.as_deref() == Some(plan.project_handle.as_str())
            && plan
                .source_handles
                .iter()
                .all(|source| context.source_handles.contains(source))
            && self.shared.clock.now() < plan.expires_at
            && inner.retained.is_none()
        {
            inner.retained = Some(plan);
            self.shared.wake.notify_all();
        }
    }

    pub(crate) fn invalidate_all(&self) {
        if let Ok(mut inner) = self.shared.inner.lock() {
            if let Some(active) = &inner.active {
                active.cancel.store(true, Ordering::SeqCst);
            }
            inner.retained = None;
            self.shared.wake.notify_all();
        }
    }

    pub(crate) fn begin_identity_change(&self) -> StudioResult<IdentityChangeGuard> {
        let mut inner = self.lock()?;
        expire_locked(&mut inner, self.shared.clock.now());
        if inner.identity_change_in_progress {
            return reason(StudioReasonCode::RequestBusy);
        }
        if inner.active.is_some() {
            return reason(StudioReasonCode::RequestBusy);
        }
        if inner.retained.is_some() {
            return reason(StudioReasonCode::PlanActive);
        }
        inner.identity_change_in_progress = true;
        Ok(IdentityChangeGuard {
            shared: self.shared.clone(),
            reserved: true,
        })
    }

    #[cfg(test)]
    fn has_retained(&self) -> bool {
        self.shared
            .inner
            .lock()
            .is_ok_and(|inner| inner.retained.is_some())
    }

    fn lock(&self) -> StudioResult<MutexGuard<'_, PlanInner>> {
        self.shared
            .inner
            .lock()
            .map_err(|_| StudioCommandError::new(StudioReasonCode::SidecarCrashed))
    }
}

impl Drop for IdentityChangeGuard {
    fn drop(&mut self) {
        if self.reserved
            && let Ok(mut inner) = self.shared.inner.lock()
        {
            inner.identity_change_in_progress = false;
            self.shared.wake.notify_all();
            self.reserved = false;
        }
    }
}

impl Drop for PlanCoordinator {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.shared.inner.lock() {
            inner.shutdown = true;
            if let Some(active) = &inner.active {
                active.cancel.store(true, Ordering::SeqCst);
            }
            inner.retained = None;
            self.shared.wake.notify_all();
        }
        if let Ok(mut worker) = self.expiry_worker.lock()
            && let Some(join) = worker.take()
        {
            let _ = join.join();
        }
    }
}

fn authenticate_plan(
    inner: &mut PlanInner,
    plan_handle: &str,
    expected_digest: Option<&str>,
    context: &PlanSessionContext,
    now: Instant,
) -> StudioResult<RetainedPlan> {
    let Some(plan) = inner.retained.as_ref() else {
        return reason(StudioReasonCode::PlanInvalid);
    };
    if plan.local_handle != plan_handle {
        return reason(StudioReasonCode::PlanInvalid);
    }
    let _retained_evidence = (&plan.summary, plan.created_at);
    if now >= plan.expires_at {
        inner.retained = None;
        return reason(StudioReasonCode::PlanExpired);
    }
    if plan.session_generation != context.generation
        || plan.raster_plan != context.raster_plan
        || context.project_handle.as_deref() != Some(plan.project_handle.as_str())
        || plan
            .source_handles
            .iter()
            .any(|source| !context.source_handles.contains(source))
    {
        inner.retained = None;
        return reason(StudioReasonCode::ContextStale);
    }
    if expected_digest.is_some_and(|digest| !constant_time_equal(digest, &plan.digest)) {
        return reason(StudioReasonCode::DigestMismatch);
    }
    inner
        .retained
        .take()
        .ok_or_else(|| StudioCommandError::new(StudioReasonCode::PlanInvalid))
}

fn create_method(request: &StudioBrandPlanStartRequest) -> Option<BrandPlanMethod> {
    match request {
        StudioBrandPlanStartRequest::CreateDerive { .. } => Some(BrandPlanMethod::Derive),
        StudioBrandPlanStartRequest::CreateQaBaseline { .. } => Some(BrandPlanMethod::QaBaseline),
        StudioBrandPlanStartRequest::CreateConsumerInstall { .. } => {
            Some(BrandPlanMethod::ConsumerInstall)
        }
        StudioBrandPlanStartRequest::CreateConsumerSync { .. } => {
            Some(BrandPlanMethod::ConsumerSync)
        }
        StudioBrandPlanStartRequest::CreateExport { .. } => Some(BrandPlanMethod::Export),
        StudioBrandPlanStartRequest::Apply { .. } | StudioBrandPlanStartRequest::Discard { .. } => {
            None
        }
    }
}

fn opaque_handle(prefix: &str, first: &str, second: &str, third: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"tfsb-studio-local-handle-v1\n");
    digest.update(first.as_bytes());
    digest.update([0]);
    digest.update(second.as_bytes());
    digest.update([0]);
    digest.update(third.as_bytes());
    format!("{prefix}{:x}", digest.finalize())
}

fn constant_time_equal(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    let mut difference = left.len() ^ right.len();
    let maximum = left.len().max(right.len());
    for index in 0..maximum {
        difference |= usize::from(
            left.get(index).copied().unwrap_or_default()
                ^ right.get(index).copied().unwrap_or_default(),
        );
    }
    difference == 0
}

fn valid_operation_handle(value: &str) -> bool {
    value.len() == 74
        && value.starts_with("operation_")
        && value[10..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn expire_locked(inner: &mut PlanInner, now: Instant) {
    if inner
        .retained
        .as_ref()
        .is_some_and(|plan| now >= plan.expires_at)
    {
        inner.retained = None;
    }
}

fn expiry_loop(shared: &SharedPlanState) {
    let Ok(mut inner) = shared.inner.lock() else {
        return;
    };
    loop {
        if inner.shutdown {
            break;
        }
        let now = shared.clock.now();
        expire_locked(&mut inner, now);
        let wait = inner
            .retained
            .as_ref()
            .map_or(Duration::from_secs(3_600), |plan| {
                plan.expires_at.saturating_duration_since(now)
            });
        let Ok((next, _)) = shared.wake.wait_timeout(inner, wait) else {
            break;
        };
        inner = next;
    }
}

fn reason<T>(reason: StudioReasonCode) -> StudioResult<T> {
    Err(StudioCommandError::new(reason))
}

#[cfg(test)]
#[path = "plan_coordinator_tests.rs"]
mod tests;
