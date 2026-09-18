// @ts-check
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureToolWithProvenance } from "./run-syft-grype.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = dirname(SCRIPT_PATH);
const REPO_ROOT = resolve(SCRIPT_DIR, "../..");

export const CARGO_AUDIT_RECEIPT_SCHEMA = "tfsb.cargo-audit-receipt-v1";
export const CARGO_AUDIT_RECEIPT_VERSION = 1;

/**
 * @param {Buffer | string} content
 */
export function sha256Hex(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Runs cargo-audit on the specified Cargo.lock file using cryptographically pinned tool.
 *
 * @param {{
 *   toolsDir?: string,
 *   lockfile?: string,
 *   output?: string,
 *   receipt?: string,
 *   offline?: boolean,
 * }} [options]
 */
export async function runCargoAudit(options = {}) {
  const toolsDir = resolve(
    options.toolsDir ||
    process.env.TFSB_TOOLS_DIR ||
    join(REPO_ROOT, ".cache/supply-chain-tools")
  );

  let lockfile = options.lockfile ? resolve(options.lockfile) : null;
  if (!lockfile) {
    const candidate1 = join(REPO_ROOT, "apps/studio/src-tauri/Cargo.lock");
    const candidate2 = join(REPO_ROOT, "src-tauri/Cargo.lock");
    if (existsSync(candidate1)) {
      lockfile = candidate1;
    } else if (existsSync(candidate2)) {
      lockfile = candidate2;
    } else {
      throw new Error("Cargo.lock not found at apps/studio/src-tauri/Cargo.lock or src-tauri/Cargo.lock");
    }
  }

  if (!existsSync(lockfile)) {
    throw new Error(`Specified lockfile does not exist: ${lockfile}`);
  }

  const lockfileBytes = await readFile(lockfile);
  const lockfileSha256 = sha256Hex(lockfileBytes);
  const relLockfile = relative(REPO_ROOT, lockfile);

  let outputPath = resolve(
    options.output ||
    join(REPO_ROOT, ".test-reports/supply-chain/cargo-audit.json")
  );
  try {
    await mkdir(dirname(outputPath), { recursive: true });
  } catch (err) {
    if (err && (err.code === "EROFS" || err.code === "EACCES")) {
      const secureTemp = await mkdtemp(join(tmpdir(), "tfsb-cargo-audit-"));
      outputPath = join(secureTemp, "cargo-audit.json");
    } else {
      throw err;
    }
  }

  const receiptPath = resolve(
    options.receipt ||
    join(REPO_ROOT, "docs/evaluations/evidence/tfsb70b/cargo-audit-receipt.json")
  );

  // Bootstrap pinned cargo-audit tool
  const provenance = await ensureToolWithProvenance("cargo-audit", toolsDir);

  // Execute cargo-audit
  const auditProc = spawnSync(provenance.path, ["audit", "--json", "--file", lockfile], {
    encoding: "utf8",
    cwd: REPO_ROOT,
  });

  let rawJson = null;
  let parsedError = null;
  try {
    rawJson = JSON.parse(auditProc.stdout);
  } catch (err) {
    parsedError = `Failed to parse cargo-audit JSON output: ${err instanceof Error ? err.message : String(err)}`;
  }

  const vulnerabilityCount = rawJson?.vulnerabilities?.count ?? 0;
  const warningCount = Object.keys(rawJson?.warnings || {}).length;
  const passed = auditProc.status === 0 && parsedError === null && vulnerabilityCount === 0;

  // Write raw JSON output
  await writeFile(
    outputPath,
    rawJson ? JSON.stringify(rawJson, null, 2) + "\n" : (auditProc.stdout || auditProc.stderr),
    "utf8"
  );

  const receipt = {
    schema: CARGO_AUDIT_RECEIPT_SCHEMA,
    schemaVersion: CARGO_AUDIT_RECEIPT_VERSION,
    status: passed ? "pass" : "fail",
    generatedAt: new Date().toISOString(),
    toolProvenance: {
      tool: provenance.tool,
      version: provenance.version,
      platform: provenance.platform,
      source: provenance.source,
      binarySha256: provenance.binarySha256,
      archive: provenance.archive,
    },
    lockfilePath: relLockfile,
    lockfileSha256,
    exitCode: auditProc.status,
    database: rawJson?.database || null,
    vulnerabilities: rawJson?.vulnerabilities || { count: 0, list: [] },
    warnings: rawJson?.warnings || {},
    error: parsedError || (auditProc.status !== 0 ? auditProc.stderr : null),
  };

  try {
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  } catch {
    // optional receipt write
  }

  // Also write receipt to test reports if different
  const testReportReceipt = join(dirname(outputPath), "cargo-audit-receipt.json");
  if (resolve(testReportReceipt) !== resolve(receiptPath)) {
    try {
      await writeFile(testReportReceipt, JSON.stringify(receipt, null, 2) + "\n", "utf8");
    } catch {
      // ignore
    }
  }

  return { passed, receipt, outputPath, receiptPath };
}

/**
 * CLI parser and runner.
 */
export async function main(args = process.argv.slice(2)) {
  let toolsDir;
  let lockfile;
  let output;
  let receipt;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tools-dir" && args[i + 1]) toolsDir = args[++i];
    else if (args[i] === "--lockfile" && args[i + 1]) lockfile = args[++i];
    else if (args[i] === "--output" && args[i + 1]) output = args[++i];
    else if (args[i] === "--receipt" && args[i + 1]) receipt = args[++i];
  }

  const result = await runCargoAudit({ toolsDir, lockfile, output, receipt });
  console.log(`[CARGO_AUDIT] Status: ${result.passed ? "PASS" : "FAIL"}`);
  console.log(`  Output:  ${result.outputPath}`);
  console.log(`  Receipt: ${result.receiptPath}`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(SCRIPT_PATH)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
