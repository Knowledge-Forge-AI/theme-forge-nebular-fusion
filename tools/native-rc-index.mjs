#!/usr/bin/env node
// Native release-candidate catalog (rc-index). Runs after every lane, whatever their outcome.
//
// A selected lane is `qualified-automated` only when its job succeeded; it exported the uploaded
// artifact's ID and SHA-256 digest; the artifact downloaded by that ID holds the sealed rc-evidence.json
// whose digest the job exported; every candidate file re-hashes to the sealed evidence; every smoke run
// passed; and the artifact's retention, read back from the Actions API, is what the plan requested.
// A failed or skipped lane is never qualified. The catalog fails unless every selected lane qualified.
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRegularSnapshot } from "./fs-snapshot.mjs";
import { LANES } from "./native-rc-plan.mjs";

const json = (path) => JSON.parse(readRegularSnapshot(path, { label: path, maxBytes: 16 * 1024 * 1024 }).bytes.toString("utf8"));
const DIGEST = /^(?:sha256:)?[a-f0-9]{64}$/;
const DAY = 24 * 60 * 60 * 1000;

/** Reads an artifact's expiry through the Actions REST API (GET only). */
export async function artifactExpiry({ repository, artifactId, token, fetchImpl = globalThis.fetch }) {
  const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/artifacts/${artifactId}`, {
    headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28" },
  });
  if (!response.ok) throw new Error(`artifact ${artifactId} metadata request failed with ${response.status}`);
  const body = await response.json();
  return { id: body.id, name: body.name, digest: body.digest ?? null, createdAt: body.created_at, expiresAt: body.expires_at, sizeInBytes: body.size_in_bytes };
}

/**
 * @param {{ plan: object, needs: object, downloadDir: string, expiry?: (lane: string, artifactId: string) => Promise<object>, now?: number }} options
 */
export async function buildIndex({ plan, needs, downloadDir, expiry, now = Date.now() }) {
  const lanes = [];
  for (const [name, definition] of Object.entries(LANES)) {
    const planned = plan.lanes?.[name];
    const job = needs?.[name];
    const entry = { lane: name, platform: definition.platform, runner: definition.runner, selected: Boolean(planned?.selected), jobResult: job?.result ?? "absent",
      manualConfirmationRequired: definition.manualConfirmation, problems: [] };
    if (!entry.selected) {
      entry.status = "not-selected";
      lanes.push(entry);
      continue;
    }
    const problems = entry.problems;
    if (job?.result !== "success") problems.push(`lane job result is ${job?.result ?? "absent"}`);
    const outputs = job?.outputs ?? {};
    entry.artifact = { name: planned.candidateArtifact, id: outputs.artifact_id ?? null, digest: outputs.artifact_digest ?? null };
    if (!/^\d+$/.test(entry.artifact.id ?? "")) problems.push("no uploaded artifact id");
    if (!DIGEST.test(entry.artifact.digest ?? "")) problems.push("no uploaded artifact digest");
    const directory = join(downloadDir, planned.candidateArtifact);
    if (problems.length === 0 && !existsSync(join(directory, "evidence/rc-evidence.json"))) problems.push("the artifact downloaded by id holds no rc-evidence.json");
    if (problems.length === 0) {
      const evidenceFile = readRegularSnapshot(join(directory, "evidence/rc-evidence.json"), { label: "rc-evidence.json", maxBytes: 16 * 1024 * 1024 });
      if (evidenceFile.sha256 !== outputs.evidence_sha256) problems.push("rc-evidence.json differs from the digest the lane exported");
      const evidence = JSON.parse(evidenceFile.bytes.toString("utf8"));
      entry.evidenceSha256 = evidenceFile.sha256;
      if (evidence.status !== "pass" || evidence.lane !== name || evidence.platform !== definition.platform) problems.push("sealed evidence is not a passing record of this lane");
      if (evidence.source?.commit !== plan.source.sha) problems.push("sealed evidence is bound to a different source commit");
      const candidateNames = readdirSync(join(directory, "candidate")).sort();
      const sealedNames = (evidence.candidate?.files ?? []).map((file) => file.name).sort();
      if (JSON.stringify(candidateNames) !== JSON.stringify(sealedNames)) problems.push("artifact candidate files differ from the sealed list");
      for (const file of evidence.candidate?.files ?? []) {
        const actual = readRegularSnapshot(join(directory, "candidate", file.name), { label: file.name, maxBytes: 2 * 1024 * 1024 * 1024 });
        if (actual.sha256 !== file.sha256) problems.push(`${file.name} does not match its sealed digest`);
      }
      if (!(evidence.smoke ?? []).length || !(evidence.smoke ?? []).every((run) => run.status === "pass")) problems.push("not every smoke run passed");
      entry.source = evidence.source;
      entry.candidate = evidence.candidate;
      entry.smoke = (evidence.smoke ?? []).map(({ label, scenario, source, status, receiptSha256 }) => ({ label, scenario, source, status, receiptSha256 }));
      if (!expiry) {
        problems.push("retention read-back unavailable");
      } else {
        try {
          const metadata = await expiry(name, entry.artifact.id);
          entry.artifact.expiresAt = metadata.expiresAt;
          entry.artifact.apiDigest = metadata.digest;
          const days = (Date.parse(metadata.expiresAt) - now) / DAY;
          entry.artifact.retentionDaysObserved = Math.round(days);
          if (!(days > plan.retentionDays - 1.5)) problems.push(`artifact expires in ${days.toFixed(1)} days, not the requested ${plan.retentionDays}`);
          if (metadata.digest && metadata.digest.replace(/^sha256:/, "") !== entry.artifact.digest.replace(/^sha256:/, "")) problems.push("API artifact digest differs from the uploaded digest");
        } catch (error) {
          problems.push(`retention read-back failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    entry.status = problems.length === 0 ? "qualified-automated" : job?.result === "skipped" ? "skipped" : "failed";
    lanes.push(entry);
  }
  const selected = lanes.filter((entry) => entry.selected);
  return {
    schema: "nebular.native-rc-index-v1",
    status: selected.length > 0 && selected.every((entry) => entry.status === "qualified-automated") ? "pass" : "fail",
    eventName: plan.eventName,
    releaseCandidate: plan.releaseCandidate,
    retentionDays: plan.retentionDays,
    source: plan.source,
    selected: plan.selected,
    passed: lanes.filter((entry) => entry.status === "qualified-automated").map((entry) => entry.lane),
    failed: lanes.filter((entry) => entry.status === "failed").map((entry) => entry.lane),
    skipped: lanes.filter((entry) => entry.status === "skipped" || entry.status === "not-selected").map((entry) => entry.lane),
    appleManualConfirmationRequired: lanes.some((entry) => entry.lane === "macos-arm64" && entry.status === "qualified-automated"),
    lanes,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (flag) => { const index = args.indexOf(flag); return index === -1 ? undefined : args[index + 1]; };
  try {
    const plan = JSON.parse(process.env.NEBULAR_RC_PLAN ?? "{}");
    const needs = JSON.parse(process.env.NEBULAR_RC_NEEDS ?? "{}");
    const token = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const index = await buildIndex({ plan, needs, downloadDir: resolve(value("--download-dir")),
      expiry: token && repository ? (_lane, artifactId) => artifactExpiry({ repository, artifactId, token }) : undefined });
    writeFileSync(resolve(value("--output")), `${JSON.stringify(index, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ status: index.status, passed: index.passed, failed: index.failed, skipped: index.skipped })}\n`);
    if (index.status !== "pass") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
