import { Channel, invoke } from "@tauri-apps/api/core";
import type { StudioBrandPlanStartRequest, StudioBrandPlanStartResult, StudioPlanOperationEvent } from "../brand-plans/contracts";
import { validatePlanCancelResult, validatePlanEvent, validatePlanResult } from "../brand-plans/validators";
import type {
  ProjectOpenMode, SourceSelectKind, StudioHostBridge, StudioHostState, StudioHostStateEvent,
  StudioHostCapabilitySummary, StudioHostStatus, StudioProjectOpen, StudioProjectSelectResult, StudioSourceOpen, StudioSourceSelectResult,
} from "../protocol/contracts";

export const STUDIO_HOST_COMMANDS = {
  brandRead: "studio_brand_read",
  planStart: "studio_brand_plan_start",
  planCancel: "studio_brand_plan_cancel",
  start: "studio_host_start",
  status: "studio_host_status",
  selectProject: "studio_select_project",
  selectSource: "studio_select_source",
  shutdown: "studio_host_shutdown",
} as const;

const states: readonly StudioHostState[] = ["not-started", "verifying", "starting", "initializing", "ready", "stopping", "stopped", "crashed", "failed"];
const sourceKinds = ["directory", "archive"] as const;
const authorityKinds = ["source-map", "normalization-map", "shard-manifest", "brand-bundle", "npm-installed-package"] as const;
const digest = /^[a-f0-9]{64}$/u;
const publicDigest = /^sha256:[a-f0-9]{64}$/u;
const handle = /^(project|source)_[A-Za-z0-9_-]{1,248}$/u;
const baseMethods = ["assetDiff", "assetGet", "assetList", "assetValidate", "cancellation", "mutationPlans", "planApply", "previewStatus", "progress", "projectList", "projectOpen", "sourceAnalyze", "sourceOpen", "workspaceOpen", "workspaceStatus"] as const;
const brandReads = ["consumerLockStatus", "consumerProfileList", "diff", "exportCapability", "exportStatus", "familyList", "qaProfileGet", "qaProfileList", "qaResultGet", "recipeGraph", "status", "tokenList", "visualEvidenceGet"] as const;
const brandSourcePurposes = ["brandBundle", "npmInstalledPackage"] as const;
const failedReasons = [
  "sidecar-artifact-unavailable", "sidecar-artifact-invalid", "sidecar-startup-timeout",
  "sidecar-protocol-invalid", "sidecar-crashed", "sidecar-initialization-failed",
  "sidecar-request-timeout", "sidecar-request-failed", "sidecar-shutdown-failed",
] as const;

export class StudioHostValidationError extends Error {
  constructor() { super("Studio host returned an invalid typed response"); this.name = "StudioHostValidationError"; }
}

function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new StudioHostValidationError();
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new StudioHostValidationError();
  return result;
}

function nullableString(value: unknown, maximum: number, pattern?: RegExp): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || (pattern && !pattern.test(value))) throw new StudioHostValidationError();
  return value;
}

function count(value: unknown, maximum = 1_000_000): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) throw new StudioHostValidationError();
  return value as number;
}

export function validateHostEvent(value: unknown): StudioHostStateEvent {
  const candidate = value as Record<string, unknown>;
  const keys = candidate && "reasonCode" in candidate ? ["reasonCode", "schemaVersion", "sequence", "state"] : ["schemaVersion", "sequence", "state"];
  const item = record(value, keys);
  if (item.schemaVersion !== 1 || !Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1 || !states.includes(item.state as StudioHostState) || ("reasonCode" in item && (typeof item.reasonCode !== "string" || item.reasonCode.length > 64 || !/^[a-z0-9-]+$/u.test(item.reasonCode)))) throw new StudioHostValidationError();
  return { schemaVersion: 1, sequence: item.sequence as number, state: item.state as StudioHostState, ...(typeof item.reasonCode === "string" ? { reasonCode: item.reasonCode } : {}) };
}

export function validateHostStatus(value: unknown): StudioHostStatus {
  const item = record(value, ["capabilities", "lastReasonCode", "manifestDigest", "methods", "projectOpenCount", "raster", "schemaVersion", "selectedProtocolVersion", "serverVersion", "sourceOpenCount", "state", "studioVersion"]);
  const raster = record(item.raster, ["available", "qualificationIdentity"]);
  if (item.schemaVersion !== 1 || item.studioVersion !== "0.1.0" || !states.includes(item.state as StudioHostState) || !Array.isArray(item.methods) || item.methods.length > 64 || !item.methods.every((method) => typeof method === "string" && method.length > 0 && method.length <= 64) || typeof raster.available !== "boolean") throw new StudioHostValidationError();
  const selected = item.selectedProtocolVersion === null ? null : item.selectedProtocolVersion === "1.2" ? "1.2" : (() => { throw new StudioHostValidationError(); })();
  const qualificationIdentity = nullableString(raster.qualificationIdentity, 71, publicDigest);
  if ((raster.available && qualificationIdentity !== `sha256:${"4bb08e677b87ef1ca74c35c5c22f547cebef4c22a1f98a08a9246fd9397d0f11"}`) || (!raster.available && qualificationIdentity !== null)) throw new StudioHostValidationError();
  let capabilities: StudioHostStatus["capabilities"] = null;
  if (item.capabilities !== null) {
    const summary = record(item.capabilities, ["baseMethods", "brandReads", "brandSourcePurposes", "limits", "planCapabilities"]);
    const limits = record(summary.limits, ["assetPageSizeDefault", "assetPageSizeMax", "assetPageSizeMin", "brandPageSizeDefault", "brandPageSizeMax", "brandPageSizeMin", "maxDiffResultBytes", "maxFrameBytes", "maxQaResultBytes"]);
    const plans = record(summary.planCapabilities, ["consumerInstall", "consumerSync", "derive", "export", "qaBaseline"]);
    const exactList = (actual: unknown, expected: readonly string[]) => Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]) && new Set(actual).size === actual.length;
    if (!exactList(summary.baseMethods, baseMethods) || !exactList(summary.brandReads, brandReads) || !exactList(summary.brandSourcePurposes, brandSourcePurposes)
        || limits.assetPageSizeDefault !== 64 || limits.assetPageSizeMax !== 128 || limits.assetPageSizeMin !== 1
        || limits.brandPageSizeDefault !== 64 || limits.brandPageSizeMax !== 128 || limits.brandPageSizeMin !== 1
        || limits.maxDiffResultBytes !== 16_777_216 || limits.maxFrameBytes !== 16_777_216 || limits.maxQaResultBytes !== 16_777_216
        || plans.consumerInstall !== true || plans.consumerSync !== true || plans.derive !== true
        || plans.export !== raster.available || plans.qaBaseline !== raster.available
        || !exactList(item.methods, baseMethods)) throw new StudioHostValidationError();
    const publicLimits: StudioHostCapabilitySummary["limits"] = {
      assetPageSizeDefault: 64, assetPageSizeMax: 128, assetPageSizeMin: 1,
      brandPageSizeDefault: 64, brandPageSizeMax: 128, brandPageSizeMin: 1,
      maxDiffResultBytes: 16_777_216, maxFrameBytes: 16_777_216, maxQaResultBytes: 16_777_216,
    };
    const publicPlans: StudioHostCapabilitySummary["planCapabilities"] = {
      consumerInstall: true, consumerSync: true, derive: true,
      export: raster.available, qaBaseline: raster.available,
    };
    capabilities = {
      baseMethods: [...baseMethods], brandReads: [...brandReads], brandSourcePurposes: [...brandSourcePurposes],
      limits: publicLimits, planCapabilities: publicPlans,
    };
  }
  const serverVersion = nullableString(item.serverVersion, 64);
  const lastReasonCode = nullableString(item.lastReasonCode, 64, /^[a-z0-9-]+$/u);
  const ready = item.state === "ready";
  if (ready) {
    if (capabilities === null || selected !== "1.2" || serverVersion !== "0.1.0"
        || lastReasonCode !== null) throw new StudioHostValidationError();
  } else if (capabilities !== null || selected !== null || serverVersion !== null
      || item.methods.length !== 0 || raster.available || qualificationIdentity !== null) {
    throw new StudioHostValidationError();
  }
  if ((item.state === "crashed" && lastReasonCode !== "sidecar-crashed")
      || (item.state === "failed" && !failedReasons.includes(lastReasonCode as typeof failedReasons[number]))
      || (!(["crashed", "failed"] as const).includes(item.state as "crashed" | "failed") && lastReasonCode !== null)) {
    throw new StudioHostValidationError();
  }
  return {
    schemaVersion: 1, studioVersion: "0.1.0",
    manifestDigest: nullableString(item.manifestDigest, 64, digest), state: item.state as StudioHostState,
    selectedProtocolVersion: selected, serverVersion, methods: [...item.methods] as string[], capabilities,
    raster: { available: raster.available, qualificationIdentity },
    projectOpenCount: count(item.projectOpenCount) ?? 0, sourceOpenCount: count(item.sourceOpenCount) ?? 0,
    lastReasonCode,
  };
}

function project(value: unknown): StudioProjectOpen {
  const item = record(value, ["assetCount", "canonicalDigest", "companionCount", "name", "projectHandle", "rootKind", "schemaVersion", "state"]);
  if (typeof item.projectHandle !== "string" || !handle.test(item.projectHandle) || !item.projectHandle.startsWith("project_") || item.rootKind !== "project" || ![null, 1, 2].includes(item.schemaVersion as never) || ![null, "uninitialized"].includes(item.state as never)) throw new StudioHostValidationError();
  return { projectHandle: item.projectHandle, rootKind: "project", schemaVersion: item.schemaVersion as 1 | 2 | null, name: nullableString(item.name, 256), canonicalDigest: nullableString(item.canonicalDigest, 71, publicDigest), assetCount: count(item.assetCount, 128), companionCount: count(item.companionCount, 1024), state: item.state as "uninitialized" | null };
}

export function validateProjectResult(value: unknown): StudioProjectSelectResult {
  const candidate = value as Record<string, unknown>;
  const item = record(value, candidate?.cancelled === true ? ["cancelled"] : ["cancelled", "project"]);
  if (item.cancelled === true) return { cancelled: true };
  if (item.cancelled !== false) throw new StudioHostValidationError();
  return { cancelled: false, project: project(item.project) };
}

function source(value: unknown): StudioSourceOpen {
  const item = record(value, ["assetCount", "authorityKind", "brandSystemDigest", "brandVersion", "candidateCount", "companionCount", "digest", "packageId", "profileCount", "rootKind", "sourceHandle", "sourceKind"]);
  if (typeof item.sourceHandle !== "string" || !handle.test(item.sourceHandle) || !item.sourceHandle.startsWith("source_") || item.rootKind !== "source" || ![null, ...sourceKinds].includes(item.sourceKind as never) || ![null, ...authorityKinds].includes(item.authorityKind as never)) throw new StudioHostValidationError();
  return { sourceHandle: item.sourceHandle, rootKind: "source", sourceKind: item.sourceKind as StudioSourceOpen["sourceKind"], authorityKind: item.authorityKind as StudioSourceOpen["authorityKind"], digest: nullableString(item.digest, 71, publicDigest), packageId: nullableString(item.packageId, 256), brandVersion: nullableString(item.brandVersion, 128), brandSystemDigest: nullableString(item.brandSystemDigest, 71, publicDigest), candidateCount: count(item.candidateCount, 100_000), profileCount: count(item.profileCount), assetCount: count(item.assetCount), companionCount: count(item.companionCount) };
}

export function validateSourceResult(value: unknown): StudioSourceSelectResult {
  const candidate = value as Record<string, unknown>;
  const item = record(value, candidate?.cancelled === true ? ["cancelled"] : ["cancelled", "source"]);
  if (item.cancelled === true) return { cancelled: true };
  if (item.cancelled !== false) throw new StudioHostValidationError();
  return { cancelled: false, source: source(item.source) };
}

export class TauriStudioHostBridge implements StudioHostBridge {
  readonly source = "rust-tauri" as const;
  #channel: Channel<unknown> | undefined;
  #planChannel: Channel<unknown> | undefined;

  async startHost(onEvent: (event: StudioHostStateEvent) => void): Promise<StudioHostStatus> {
    this.close();
    const channel = new Channel<unknown>((event) => onEvent(validateHostEvent(event)));
    this.#channel = channel;
    return validateHostStatus(await invoke<unknown>(STUDIO_HOST_COMMANDS.start, { events: channel }));
  }
  async getStatus() { return validateHostStatus(await invoke<unknown>(STUDIO_HOST_COMMANDS.status)); }
  async selectProject(mode: ProjectOpenMode) { return validateProjectResult(await invoke<unknown>(STUDIO_HOST_COMMANDS.selectProject, { mode })); }
  async selectSource(kind: SourceSelectKind) { return validateSourceResult(await invoke<unknown>(STUDIO_HOST_COMMANDS.selectSource, { kind })); }
  async startPlanOperation(request: StudioBrandPlanStartRequest, onEvent: (event: StudioPlanOperationEvent) => void) {
    if (this.#planChannel) throw new StudioHostValidationError();
    const channel = new Channel<unknown>((event) => onEvent(validatePlanEvent(event)));
    this.#planChannel = channel;
    try { return validatePlanResult(await invoke<unknown>(STUDIO_HOST_COMMANDS.planStart, { request, progress: channel })); }
    finally { channel.onmessage = () => undefined; if (this.#planChannel === channel) this.#planChannel = undefined; }
  }
  async cancelPlanOperation(operationHandle: string) { return validatePlanCancelResult(await invoke<unknown>(STUDIO_HOST_COMMANDS.planCancel, { request: { operationHandle } })); }
  async shutdownHost() { await invoke<void>(STUDIO_HOST_COMMANDS.shutdown); this.close(); }
  close() { if (this.#channel) this.#channel.onmessage = () => undefined; if (this.#planChannel) this.#planChannel.onmessage = () => undefined; this.#channel = undefined; this.#planChannel = undefined; }
}

const fixtureStatus: StudioHostStatus = { schemaVersion: 1, studioVersion: "0.1.0", manifestDigest: null, state: "not-started", selectedProtocolVersion: null, serverVersion: null, methods: [], capabilities: null, raster: { available: false, qualificationIdentity: null }, projectOpenCount: 0, sourceOpenCount: 0, lastReasonCode: null };
const fixtureCapabilities: StudioHostCapabilitySummary = {
  baseMethods: [...baseMethods], brandReads: [...brandReads], brandSourcePurposes: [...brandSourcePurposes],
  limits: { assetPageSizeDefault: 64, assetPageSizeMax: 128, assetPageSizeMin: 1, brandPageSizeDefault: 64, brandPageSizeMax: 128, brandPageSizeMin: 1, maxDiffResultBytes: 16_777_216, maxFrameBytes: 16_777_216, maxQaResultBytes: 16_777_216 },
  planCapabilities: { consumerInstall: true, consumerSync: true, derive: true, export: false, qaBaseline: false },
};

export class FixtureStudioHostBridge implements StudioHostBridge {
  readonly source = "fixture-test" as const;
  async startHost(onEvent: (event: StudioHostStateEvent) => void) { const ready = { ...fixtureStatus, state: "ready" as const, selectedProtocolVersion: "1.2" as const, serverVersion: "0.1.0", methods: [...baseMethods], capabilities: fixtureCapabilities }; onEvent({ schemaVersion: 1, sequence: 1, state: "ready" }); return ready; }
  async getStatus() { return fixtureStatus; }
  async selectProject() { return { cancelled: true } as const; }
  async selectSource() { return { cancelled: true } as const; }
  async startPlanOperation(): Promise<StudioBrandPlanStartResult> { throw new StudioHostValidationError(); }
  async cancelPlanOperation() { return { accepted: false }; }
  async shutdownHost() { return undefined; }
  close() { return undefined; }
}
