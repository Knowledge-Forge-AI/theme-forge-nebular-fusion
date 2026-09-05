import type { StudioBrandPlanCancelResult, StudioBrandPlanStartRequest, StudioBrandPlanStartResult, StudioPlanOperationEvent } from "./contracts";

export interface StudioBrandPlanClient {
  startPlanOperation(request: StudioBrandPlanStartRequest, onEvent: (event: StudioPlanOperationEvent) => void): Promise<StudioBrandPlanStartResult>;
  cancelPlanOperation(operationHandle: string): Promise<StudioBrandPlanCancelResult>;
}
