use tauri::State;
use tauri::ipc::Channel;

use crate::errors::StudioResult;
use crate::sidecar::plan_protocol::{
    StudioBrandPlanCancelRequest, StudioBrandPlanCancelResult, StudioBrandPlanStartRequest,
    StudioBrandPlanStartResult, StudioPlanOperationEvent,
};
use crate::state::host::HostState;

#[tauri::command]
pub(crate) async fn studio_brand_plan_start(
    request: StudioBrandPlanStartRequest,
    progress: Channel<StudioPlanOperationEvent>,
    state: State<'_, HostState>,
) -> StudioResult<StudioBrandPlanStartResult> {
    let host = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || host.start_plan(request, progress))
        .await
        .map_err(|_| {
            crate::errors::StudioCommandError::new(crate::errors::StudioReasonCode::SidecarCrashed)
        })?
}

#[tauri::command(async)]
pub(crate) fn studio_brand_plan_cancel(
    request: StudioBrandPlanCancelRequest,
    state: State<'_, HostState>,
) -> StudioResult<StudioBrandPlanCancelResult> {
    Ok(StudioBrandPlanCancelResult {
        accepted: state.cancel_plan(&request.operation_handle)?,
    })
}
