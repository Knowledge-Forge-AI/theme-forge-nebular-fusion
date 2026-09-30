#!/usr/bin/env node
// Native release-candidate lane selection.
//
// pull_request: every lane runs (the workflow's path filter decides whether the workflow runs at all).
// workflow_dispatch: exactly the lanes whose boolean inputs are true; zero selected lanes is an error.
// Routine runs retain candidates for 14 days; an explicit release-candidate dispatch retains them for
// 90 days, the public-repository maximum. Diagnostics never carry candidate binaries and keep 7 days.
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LANES = Object.freeze({
  "macos-arm64": Object.freeze({ platform: "darwin-arm64", runner: "macos-15", input: "macos_arm64", scenarios: Object.freeze(["A"]), manualConfirmation: true }),
  "linux-arm64": Object.freeze({ platform: "linux-arm64", runner: "ubuntu-24.04-arm", input: "linux_arm64", scenarios: Object.freeze(["B"]), manualConfirmation: false }),
  "linux-x64": Object.freeze({ platform: "linux-x64", runner: "ubuntu-24.04", input: "linux_x64", scenarios: Object.freeze(["C", "C-signal"]), manualConfirmation: false }),
});
export const RETENTION = Object.freeze({ routine: 14, releaseCandidate: 90, diagnostics: 7, maximumPublic: 90 });

const truthy = (value) => value === true || value === "true";

function checkedIdentity({ sha, runId, runAttempt, version }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("A full source commit SHA is required");
  if (!/^[1-9]\d*$/.test(String(runId ?? "")) || !/^[1-9]\d*$/.test(String(runAttempt ?? ""))) throw new Error("Run id and attempt are required");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version ?? "")) throw new Error("A semantic package version is required");
}

export function artifactName(kind, { lane, version, sha, runId, runAttempt }) {
  const prefix = kind === "candidate" ? `nebular-rc-${version}` : "nebular-rc-diag";
  return `${prefix}-${lane}-${sha.slice(0, 12)}-r${runId}-a${runAttempt}`;
}

/**
 * @param {{ eventName: string, inputs?: Record<string, unknown>, sha: string, runId: string|number, runAttempt: string|number, version: string }} options
 */
export function planLanes(options) {
  const { eventName, inputs = {} } = options;
  checkedIdentity(options);
  let selected;
  let releaseCandidate = false;
  if (eventName === "pull_request") {
    selected = Object.keys(LANES);
  } else if (eventName === "workflow_dispatch") {
    selected = Object.entries(LANES).filter(([, lane]) => truthy(inputs[lane.input])).map(([name]) => name);
    releaseCandidate = truthy(inputs.release_candidate);
  } else {
    throw new Error(`Native release candidates are not built for ${eventName} events`);
  }
  if (selected.length === 0) throw new Error("Select at least one native release-candidate lane");
  const retentionDays = releaseCandidate ? RETENTION.releaseCandidate : RETENTION.routine;
  const lanes = Object.fromEntries(Object.entries(LANES).map(([name, lane]) => [name, {
    ...lane,
    selected: selected.includes(name),
    candidateArtifact: artifactName("candidate", { ...options, lane: name }),
    diagnosticsArtifact: artifactName("diagnostics", { ...options, lane: name }),
  }]));
  return {
    schema: "nebular.native-rc-plan-v1",
    eventName,
    releaseCandidate,
    retentionDays,
    diagnosticsRetentionDays: RETENTION.diagnostics,
    source: { sha: options.sha, runId: String(options.runId), runAttempt: String(options.runAttempt), version: options.version },
    selected,
    lanes,
  };
}

// The job outputs the workflow consumes: one boolean per lane plus the shared values.
export function workflowOutputs(plan) {
  return {
    plan: JSON.stringify(plan),
    ...Object.fromEntries(Object.entries(plan.lanes).map(([name, lane]) => [name.replace("-", "_"), String(lane.selected)])),
    ...Object.fromEntries(Object.entries(plan.lanes).map(([name, lane]) => [`${name.replace("-", "_")}_artifact`, lane.candidateArtifact])),
    ...Object.fromEntries(Object.entries(plan.lanes).map(([name, lane]) => [`${name.replace("-", "_")}_diagnostics`, lane.diagnosticsArtifact])),
    retention_days: String(plan.retentionDays),
    diagnostics_retention_days: String(plan.diagnosticsRetentionDays),
    release_candidate: String(plan.releaseCandidate),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")) : {};
    const version = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version;
    const plan = planLanes({
      eventName: process.env.GITHUB_EVENT_NAME,
      inputs: event.inputs ?? {},
      sha: process.env.NEBULAR_RC_SOURCE_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      version,
    });
    const outputs = workflowOutputs(plan);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
