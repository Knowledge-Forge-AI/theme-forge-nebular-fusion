import { invoke } from "@tauri-apps/api/core";
import { STUDIO_HOST_COMMANDS } from "../host/studio-host-bridge";
import type { StudioBrandReadClient, VisualEvidenceRequest } from "./StudioBrandReadClient";
import {
  validateBrandStatus, validateConsumerLockStatus, validateConsumerProfilePage,
  validateAssetIdentity,
  validateExportCapability, validateExportStatusPage, validateFamilyPage, validateQaProfile,
  validateQaProfilePage, validateQaResult, validateRecipeGraph, validateSemanticDiff,
  validateTokenPage, validateVisualEvidence,
} from "./validators";

const page = (kind: "family-page" | "token-page" | "qa-profile-page" | "export-status-page", projectHandle: string, pageSize: number, cursor?: string) => ({ kind, projectHandle, pageSize, ...(cursor ? { cursor } : {}) });

async function call(request: object): Promise<unknown> { return invoke<unknown>(STUDIO_HOST_COMMANDS.brandRead, { request }); }

export class TauriStudioBrandReadClient implements StudioBrandReadClient {
  async getAssetIdentity(projectHandle: string, assetId: string) { return validateAssetIdentity(await call({ kind: "asset-identity", projectHandle, assetId })); }
  async getBrandStatus(projectHandle: string) { return validateBrandStatus(await call({ kind: "status", projectHandle })); }
  async listFamilies(projectHandle: string, pageSize: number, cursor?: string) { return validateFamilyPage(await call(page("family-page", projectHandle, pageSize, cursor))); }
  async listTokens(projectHandle: string, pageSize: number, cursor?: string) { return validateTokenPage(await call(page("token-page", projectHandle, pageSize, cursor))); }
  async getRecipeGraph(projectHandle: string) { return validateRecipeGraph(await call({ kind: "recipe-graph", projectHandle })); }
  async listQaProfiles(projectHandle: string, pageSize: number, cursor?: string) { return validateQaProfilePage(await call(page("qa-profile-page", projectHandle, pageSize, cursor))); }
  async getQaProfile(projectHandle: string, profileId: string) { return validateQaProfile(await call({ kind: "qa-profile", projectHandle, profileId })); }
  async getQaResult(projectHandle: string, profileId: string) { return validateQaResult(await call({ kind: "qa-result", projectHandle, profileId })); }
  async getSemanticDiff(projectHandle: string, sourceHandle: string) { return validateSemanticDiff(await call({ kind: "semantic-diff", projectHandle, sourceHandle })); }
  async listConsumerProfiles(projectHandle: string, sourceHandles: readonly string[], pageSize: number, cursor?: string) { return validateConsumerProfilePage(await call({ kind: "consumer-profile-page", projectHandle, sourceHandles, pageSize, ...(cursor ? { cursor } : {}) })); }
  async getConsumerLockStatus(projectHandle: string) { return validateConsumerLockStatus(await call({ kind: "consumer-lock-status", projectHandle })); }
  async getExportCapability(projectHandle: string) { return validateExportCapability(await call({ kind: "export-capability", projectHandle })); }
  async listExportStatus(projectHandle: string, pageSize: number, cursor?: string) { return validateExportStatusPage(await call(page("export-status-page", projectHandle, pageSize, cursor))); }
  async getVisualEvidence(request: VisualEvidenceRequest) { return validateVisualEvidence(await call({ kind: "visual-evidence", request })); }
}
