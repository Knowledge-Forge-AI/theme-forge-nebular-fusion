import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const nodeRequire = createRequire(import.meta.url);
const exchangeDistCandidates = [
  resolve(import.meta.dirname, "../../src-tauri/loom-payload/dist/design-exchange/index.js"),
  resolve(process.cwd(), "src-tauri/loom-payload/dist/design-exchange/index.js"),
  resolve(import.meta.dirname, "../../../../packages/stellar-loom/dist/design-exchange/index.js"),
  resolve(process.cwd(), "packages/stellar-loom/dist/design-exchange/index.js"),
  resolve(process.cwd(), "../../packages/stellar-loom/dist/design-exchange/index.js"),
];
let exchangeDistPath: string | undefined = exchangeDistCandidates.find((p) => existsSync(p));
if (!exchangeDistPath) {
  try {
    exchangeDistPath = nodeRequire.resolve("@knowledge-forge-ai/theme-forge-stellar-loom/design-exchange");
  } catch {
    try {
      exchangeDistPath = nodeRequire.resolve("@knowledge-forge-ai/theme-forge-stellar-loom/dist/design-exchange/index.js");
    } catch {}
  }
}
if (!exchangeDistPath || !existsSync(exchangeDistPath)) {
  throw new Error(`Required stellar-loom design-exchange dist missing at ${exchangeDistCandidates[0]}. Built packages/stellar-loom or prepared loom-payload is required. Fails closed (must fail, not skip).`);
}
const tfslExchangeDist = nodeRequire(exchangeDistPath);
import type {
  ThemeBriefCreateRequest,
  ThemeBriefCreateResponse,
  ThemeCandidateAdoptRequest,
  ThemeCandidateAdoptResponse,
  ThemeCandidateVerifyRequest,
  ThemeCandidateVerifyResponse,
  ThemeLabBridge,
  ThemeLabCompileRequest,
  ThemeLabCompileResponse,
  ThemeLabExampleResponse,
  ThemeLabOpenResponse,
  ThemeLabSaveRequest,
  ThemeLabSaveResponse,
  ThemeLabStatusResponse,
  ThemePacketExportRequest,
  ThemePacketExportResponse,
  ThemePacketImportRequest,
  ThemePacketImportResponse,
  ThemeReviewCreateRequest,
  ThemeReviewCreateResponse,
  ThemeReviewValidateRequest,
  ThemeReviewValidateResponse,
  ThemeSpecification,
} from "../features/theme-lab/types";

export interface TfslBatchTestBridgeOptions {
  readonly disconnected?: boolean | undefined;
  readonly batchScriptPath?: string | undefined;
}

export class TfslBatchTestBridge implements ThemeLabBridge {
  readonly batchScript: string;
  readonly distBatch: string;
  private currentSpec: ThemeSpecification | null = null;
  private dirty = false;
  private latestRevision = 1;
  private disconnected = false;
  private readonly importQueue: unknown[] = [];
  private readonly exportedPackets: Array<{ packet: unknown; json: string; defaultName?: string | undefined; displayName?: string | undefined }> = [];

  constructor(options?: TfslBatchTestBridgeOptions) {
    this.disconnected = options?.disconnected ?? false;

    const candidates = options?.batchScriptPath
      ? [options.batchScriptPath]
      : [
          resolve(import.meta.dirname, "../../src-tauri/loom-payload/bin/tfsl-batch.js"),
          resolve(process.cwd(), "src-tauri/loom-payload/bin/tfsl-batch.js"),
          resolve(import.meta.dirname, "../../../../packages/stellar-loom/bin/tfsl-batch.js"),
          resolve(process.cwd(), "packages/stellar-loom/bin/tfsl-batch.js"),
          resolve(process.cwd(), "../../packages/stellar-loom/bin/tfsl-batch.js"),
        ];

    const found = candidates.find((p) => existsSync(p));
    if (!found && !this.disconnected) {
      throw new Error(`Required tfsl-batch.js missing in expected locations: ${candidates.join(", ")}. Fails closed (must fail, not skip).`);
    }

    this.batchScript = found || candidates[0]!;
    this.distBatch = existsSync(resolve(this.batchScript, "../../dist/batch.js"))
      ? resolve(this.batchScript, "../../dist/batch.js")
      : resolve(this.batchScript, "../dist/batch.js");

    if (!existsSync(this.distBatch) && !this.disconnected) {
      throw new Error(`Required dist/batch.js missing at ${this.distBatch}. Built packages/stellar-loom or prepared loom-payload is required. Fails closed (must fail, not skip).`);
    }
  }

  disconnect(): void {
    this.disconnected = true;
  }

  queueImport(packet: unknown): void {
    this.importQueue.push(packet);
  }

  getExportedPackets(): ReadonlyArray<{ packet: unknown; json: string; defaultName?: string | undefined; displayName?: string | undefined }> {
    return this.exportedPackets;
  }

  setDirty(dirty: boolean): void {
    this.dirty = dirty;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  getCurrentSpec(): ThemeSpecification | null {
    return this.currentSpec;
  }

  private invokeBatch(req: Record<string, unknown>): any {
    if (this.disconnected) {
      throw new Error("TFSL batch bridge is disconnected: command execution failed closed");
    }

    if (!existsSync(this.batchScript)) {
      throw new Error(`tfsl-batch.js not found at ${this.batchScript}. Fails closed.`);
    }
    if (!existsSync(this.distBatch)) {
      throw new Error(`dist/batch.js not found at ${this.distBatch}. Fails closed.`);
    }

    const result = spawnSync("node", [this.batchScript], {
      input: JSON.stringify(req),
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });

    if (result.error) {
      throw result.error;
    }

    const rawOutput = (result.stdout || "").trim();
    if (!rawOutput) {
      throw new Error(
        `tfsl-batch exited with status ${result.status} without output. Stderr: ${result.stderr}`
      );
    }

    try {
      return JSON.parse(rawOutput);
    } catch (parseErr) {
      const errMessage = parseErr instanceof Error ? parseErr.message : String(parseErr);
      throw new Error(`Failed to parse tfsl-batch stdout as JSON: ${errMessage}. Output was: ${rawOutput}`);
    }
  }

  async getStatus(): Promise<ThemeLabStatusResponse> {
    if (this.disconnected) {
      return {
        available: false,
        compilerVersion: "0.0.0-disconnected",
        message: "Stellar Loom compiler adapter is disconnected",
        dirty: this.dirty,
      };
    }

    return {
      available: true,
      compilerVersion: "0.1.0",
      sessionId: "tfsl-test-session",
      latestRevision: this.latestRevision,
      dirty: this.dirty,
    };
  }

  async compile(request: ThemeLabCompileRequest): Promise<ThemeLabCompileResponse> {
    const rev = request.uiRevision ?? (this.latestRevision + 1);
    this.latestRevision = Math.max(this.latestRevision, rev);

    const batchRes = this.invokeBatch({
      action: "compile",
      specification: request.specification,
      options: request.options,
      uiRevision: rev,
    });

    if (batchRes.valid) {
      this.currentSpec = batchRes.specification ?? request.specification;
      this.dirty = true;
    }

    return {
      uiRevision: batchRes.uiRevision ?? rev,
      valid: Boolean(batchRes.valid),
      compiledCss: batchRes.compiledCss,
      descriptor: batchRes.descriptor,
      diagnostics: batchRes.diagnostics ?? [],
      error: batchRes.error,
    };
  }

  async loadExample(name: string, uiRevision?: number): Promise<ThemeLabExampleResponse> {
    const rev = uiRevision ?? (this.latestRevision + 1);
    this.latestRevision = Math.max(this.latestRevision, rev);

    const batchRes = this.invokeBatch({
      action: "example",
      exampleName: name,
      uiRevision: rev,
    });

    if (batchRes.valid && batchRes.specification) {
      this.currentSpec = batchRes.specification;
      this.dirty = false;
    }

    return {
      uiRevision: batchRes.uiRevision ?? rev,
      valid: Boolean(batchRes.valid),
      exampleName: batchRes.exampleName ?? name,
      specification: batchRes.specification,
      compiledCss: batchRes.compiledCss,
      descriptor: batchRes.descriptor,
      diagnostics: batchRes.diagnostics ?? [],
      error: batchRes.error,
    };
  }

  async openTheme(): Promise<ThemeLabOpenResponse> {
    return {
      cancelled: true,
      diagnostics: [],
    };
  }

  async saveTheme(request: ThemeLabSaveRequest): Promise<ThemeLabSaveResponse> {
    const batchRes = this.invokeBatch({
      action: "validate",
      specification: request.specification,
    });

    if (!batchRes.valid) {
      throw new Error(`Cannot save invalid theme specification: ${JSON.stringify(batchRes.error)}`);
    }

    this.currentSpec = request.specification;
    this.dirty = false;

    return {
      cancelled: false,
      displayName: "theme.json",
    };
  }

  async createBrief(request: ThemeBriefCreateRequest): Promise<ThemeBriefCreateResponse> {
    const batchRes = this.invokeBatch({
      action: "exchange-brief-create",
      briefInput: JSON.stringify(request.briefInput),
    });

    if (!batchRes.valid || !batchRes.packet) {
      throw new Error(`Failed to create brief via tfsl-batch: ${JSON.stringify(batchRes.error)}`);
    }

    return {
      packet: batchRes.packet,
      canonicalJson: batchRes.canonicalJson,
      digest: batchRes.digest,
    };
  }

  async importPacket(request?: ThemePacketImportRequest): Promise<ThemePacketImportResponse> {
    if (this.importQueue.length === 0) {
      return {
        cancelled: true,
      };
    }

    const next = this.importQueue.shift();
    let rawContent: string;
    if (typeof next === "string") {
      rawContent = next;
    } else if (tfslExchangeDist?.serializeThemeExchangePacket) {
      rawContent = tfslExchangeDist.serializeThemeExchangePacket(next);
    } else {
      rawContent = JSON.stringify(next);
    }

    const batchRes = this.invokeBatch({
      action: "exchange-packet-parse",
      packetJson: rawContent,
      expectedKind: request?.expectedKind,
    });

    if (!batchRes.valid) {
      return {
        cancelled: false,
        displayName: "packet.json",
        error: batchRes.error,
      };
    }

    return {
      cancelled: false,
      displayName: "packet.json",
      packet: batchRes.packet,
      canonicalJson: batchRes.canonicalJson,
      kind: batchRes.kind,
      digest: batchRes.digest,
    };
  }

  async exportPacket(request: ThemePacketExportRequest): Promise<ThemePacketExportResponse> {
    const batchRes = this.invokeBatch({
      action: "exchange-packet-parse",
      packetJson: request.packetJson,
    });

    if (!batchRes.valid) {
      return {
        cancelled: false,
        saved: false,
        displayName: request.defaultName ?? "packet.json",
        error: batchRes.error,
      };
    }

    const exportRecord = {
      packet: batchRes.packet,
      json: request.packetJson,
      defaultName: request.defaultName,
      displayName: request.defaultName ?? "packet.json",
    };
    this.exportedPackets.push(exportRecord);

    return {
      cancelled: false,
      saved: true,
      displayName: request.defaultName ?? "packet.json",
      digest: batchRes.digest,
    };
  }

  async createReview(request: ThemeReviewCreateRequest): Promise<ThemeReviewCreateResponse> {
    const batchRes = this.invokeBatch({
      action: "exchange-review-create",
      reviewInput: JSON.stringify(request.reviewInput),
    });

    if (!batchRes.valid || !batchRes.packet) {
      throw new Error(`Failed to create review via tfsl-batch: ${JSON.stringify(batchRes.error)}`);
    }

    return {
      packet: batchRes.packet,
      canonicalJson: batchRes.canonicalJson,
      digest: batchRes.digest,
    };
  }

  async verifyThemeCandidate(request: ThemeCandidateVerifyRequest): Promise<ThemeCandidateVerifyResponse> {
    const batchRes = this.invokeBatch({
      action: "exchange-candidate-verify",
      candidate: request.candidate,
      brief: request.brief,
      options: request.options,
    });

    return {
      valid: Boolean(batchRes.valid),
      compiledCss: batchRes.compiledCss,
      descriptor: batchRes.descriptor,
      diagnostics: batchRes.diagnostics ?? [],
      candidateVerification: batchRes.candidateVerification,
      error: batchRes.error,
    };
  }

  async validateThemeReview(request: ThemeReviewValidateRequest): Promise<ThemeReviewValidateResponse> {
    const batchRes = this.invokeBatch({
      action: "exchange-review-validate",
      review: request.review,
      brief: request.brief,
      candidates: request.candidates ?? [],
    });

    return {
      valid: Boolean(batchRes.valid),
      reviewValidation: batchRes.reviewValidation,
      error: batchRes.error,
    };
  }

  async adoptCandidate(request: ThemeCandidateAdoptRequest): Promise<ThemeCandidateAdoptResponse> {
    const force = Boolean(request.force);

    if (this.dirty && !force) {
      return {
        adopted: false,
        requiresConfirmation: true,
        error: {
          code: "UNSAVED_CHANGES",
          message: "Current draft has unsaved changes. Confirm overwrite with force: true.",
        },
      };
    }

    let candidate: Record<string, unknown>;
    try {
      candidate = typeof request.candidate === "string" ? JSON.parse(request.candidate) : request.candidate;
    } catch {
      return {
        adopted: false,
        error: {
          code: "INVALID_CANDIDATE",
          message: "Candidate JSON parse error",
        },
      };
    }

    if (!candidate || !candidate.theme) {
      return {
        adopted: false,
        error: {
          code: "INVALID_CANDIDATE",
          message: "Candidate packet missing theme specification",
        },
      };
    }

    const themeSpec = candidate.theme as ThemeSpecification;
    const compileRes = await this.compile({
      specification: themeSpec,
      uiRevision: request.uiRevision ?? ++this.latestRevision,
    });

    if (!compileRes.valid) {
      return {
        adopted: false,
        error: compileRes.error,
      };
    }

    this.currentSpec = themeSpec;
    this.dirty = false;

    return {
      adopted: true,
      specification: themeSpec,
      compiledCss: compileRes.compiledCss,
      descriptor: compileRes.descriptor,
      diagnostics: compileRes.diagnostics,
    };
  }

  async dispose(): Promise<void> {
    this.importQueue.length = 0;
  }
}
