import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import {
  decodePairedV2NativePacketEnvelope,
  decodePairedV2Packet,
  PAIRED_V2_PACKET_KINDS,
  type PairedV2NativePacketEnvelope,
  type PairedV2PacketCreateRequest,
  type PairedV2PacketKind,
} from "./paired-v2-packets";
import { PairedV2ValidationError, readonlyJsonClone } from "./paired-v2-bridge-decoder";
import type {
  ThemeLabBridge,
  ThemePacketExportResponse,
  ThemePacketImportResponse,
} from "../theme-lab/types";
import { TauriThemeLabBridge } from "../theme-lab/theme-lab-bridge";

export const PAIRED_V2_PACKET_COMMAND = "studio_app_theme_paired_packet_create_v2" as const;

export type PairedV2PacketInvoke = <T>(
  command: string,
  args: { readonly request: unknown },
) => Promise<T>;

export type PairedV2PacketTransport = Required<Pick<ThemeLabBridge, "importPacket" | "exportPacket">>;

export type PairedV2PacketBridgeErrorCode =
  | "invalid-request"
  | "invalid-response"
  | "native-rejected";

export class PairedV2PacketBridgeError extends Error {
  readonly code: PairedV2PacketBridgeErrorCode;

  constructor(code: PairedV2PacketBridgeErrorCode) {
    super(
      code === "invalid-request"
        ? "Paired v2 packet request rejected before native invocation"
        : code === "invalid-response"
          ? "Paired v2 packet response rejected"
          : "Paired v2 packet operation was not completed"
    );
    this.name = "PairedV2PacketBridgeError";
    this.code = code;
  }
}

export interface PairedV2PacketImportOutcome {
  readonly cancelled: boolean;
  readonly envelope?: PairedV2NativePacketEnvelope;
}

export interface PairedV2PacketExportOutcome {
  readonly cancelled: boolean;
  readonly saved: boolean;
  readonly digest?: string;
}

type UnknownRecord = Record<string, unknown>;

const ZERO_DIGEST = "0".repeat(64);

const CREATE_FIELDS: Readonly<Record<PairedV2PacketKind, readonly string[]>> = Object.freeze({
  "tf-paired-profile-v2-brief": [
    "schema", "schemaVersion", "briefId", "title", "goal", "profileName", "profileVersion",
    "sourceProfileSha256", "sourceCanonicalDigest", "editablePaths", "allowedModes",
    "acceptanceCriteria", "prohibitedChanges",
  ],
  "tf-paired-profile-v2-candidate": [
    "schema", "schemaVersion", "candidateId", "briefDigest", "sourceBytesBase64",
    "sourceProfileSha256", "sourceCanonicalDigest", "rationale",
  ],
  "tf-paired-profile-v2-review": [
    "schema", "schemaVersion", "reviewId", "briefDigest", "candidateDigests", "dispositions",
    "overallDisposition", "summary",
  ],
});

const OWN_DIGEST_FIELD: Readonly<Record<PairedV2PacketKind, string>> = Object.freeze({
  "tf-paired-profile-v2-brief": "briefDigest",
  "tf-paired-profile-v2-candidate": "candidateDigest",
  "tf-paired-profile-v2-review": "reviewDigest",
});

function fail(code: PairedV2PacketBridgeErrorCode): never {
  throw new PairedV2PacketBridgeError(code);
}

function objectValue(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail("invalid-request");
  return value as UnknownRecord;
}

function exact(object: UnknownRecord, allowed: readonly string[], context: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(object).some((key) => !allowedSet.has(key))) return fail("invalid-request");
  if (Object.keys(object).length !== allowed.length) return fail("invalid-request");
  if (allowed.some((key) => !Object.prototype.hasOwnProperty.call(object, key))) {
    throw new PairedV2PacketBridgeError("invalid-request");
  }
  void context;
}

function packetKind(value: unknown): PairedV2PacketKind {
  if (typeof value !== "string" || !PAIRED_V2_PACKET_KINDS.includes(value as PairedV2PacketKind)) {
    return fail("invalid-request");
  }
  return value as PairedV2PacketKind;
}

function normalizeCreateRequest(value: PairedV2PacketCreateRequest): PairedV2PacketCreateRequest {
  let safeValue: unknown;
  try {
    safeValue = readonlyJsonClone(value);
  } catch {
    return fail("invalid-request");
  }
  const outer = objectValue(safeValue);
  exact(outer, ["kind", "input"], "paired v2 packet create request");
  const kind = packetKind(outer.kind);
  const input = objectValue(outer.input);
  const fields = CREATE_FIELDS[kind];
  exact(input, fields, `paired v2 ${kind} create input`);
  if (input.schema !== kind || input.schemaVersion !== 1 || Object.prototype.hasOwnProperty.call(input, OWN_DIGEST_FIELD[kind])) {
    return fail("invalid-request");
  }

  try {
    const shaped = { ...input, [OWN_DIGEST_FIELD[kind]]: ZERO_DIGEST };
    const parsed = decodePairedV2Packet(shaped);
    if (parsed.schema !== kind) return fail("invalid-request");
    const normalizedInput = Object.create(null) as UnknownRecord;
    for (const key of fields) {
      Object.defineProperty(normalizedInput, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: (parsed as unknown as UnknownRecord)[key],
      });
    }
    Object.freeze(normalizedInput);
    return Object.freeze({ kind, input: normalizedInput }) as PairedV2PacketCreateRequest;
  } catch (error) {
    if (error instanceof PairedV2PacketBridgeError) throw error;
    if (error instanceof PairedV2ValidationError) return fail("invalid-request");
    return fail("invalid-request");
  }
}

function defaultName(kind: PairedV2PacketKind): string {
  const suffix = kind.endsWith("brief") ? "brief" : kind.endsWith("candidate") ? "candidate" : "review";
  return `theme.paired-v2-${suffix}.json`;
}

function decodeResponseEnvelope(value: unknown): PairedV2NativePacketEnvelope {
  try {
    return decodePairedV2NativePacketEnvelope(value);
  } catch {
    return fail("invalid-response");
  }
}

function assertImportIdentity(response: ThemePacketImportResponse, envelope: PairedV2NativePacketEnvelope): void {
  if (
    response.canonicalJson !== envelope.canonicalJson ||
    response.kind !== envelope.kind ||
    response.digest !== envelope.digest
  ) return fail("invalid-response");
}

function assertExportEnvelope(
  response: ThemePacketExportResponse,
  envelope: PairedV2NativePacketEnvelope,
  retainedCanonicalJson: string,
): void {
  if (
    response.digest !== envelope.digest ||
    envelope.canonicalJson !== retainedCanonicalJson ||
    envelope.kind !== envelope.packet.schema
  ) return fail("invalid-response");
}

/**
 * Frontend transport for the portable paired-v2 packet seam.
 * Native invocation and the existing picker bridge are both explicit
 * dependencies; this class never discovers or invokes either implicitly.
 */
export interface PairedV2PacketBridge {
  createPacket(request: PairedV2PacketCreateRequest): Promise<PairedV2NativePacketEnvelope>;
  importPacket(kind: PairedV2PacketKind): Promise<PairedV2PacketImportOutcome>;
  exportPacket(envelope: PairedV2NativePacketEnvelope): Promise<PairedV2PacketExportOutcome>;
}

export class TauriPairedV2PacketBridge implements PairedV2PacketBridge {
  constructor(
    private readonly invoke: PairedV2PacketInvoke,
    private readonly packetTransport: PairedV2PacketTransport,
  ) {}

  async createPacket(request: PairedV2PacketCreateRequest): Promise<PairedV2NativePacketEnvelope> {
    const normalized = normalizeCreateRequest(request);
    let raw: unknown;
    try {
      raw = await this.invoke(PAIRED_V2_PACKET_COMMAND, { request: normalized });
    } catch {
      return fail("native-rejected");
    }
    return decodeResponseEnvelope(raw);
  }

  async importPacket(kind: PairedV2PacketKind): Promise<PairedV2PacketImportOutcome> {
    const expectedKind = packetKind(kind);
    let response: ThemePacketImportResponse;
    try {
      response = await this.packetTransport.importPacket({ expectedKind });
    } catch {
      return fail("native-rejected");
    }
    if (response.cancelled) {
      if (response.pairedV2 !== undefined) return fail("invalid-response");
      return { cancelled: true };
    }
    if (response.error !== undefined || response.pairedV2 === undefined) return fail("native-rejected");
    const envelope = decodeResponseEnvelope(response.pairedV2);
    if (envelope.kind !== expectedKind) return fail("invalid-response");
    assertImportIdentity(response, envelope);
    return { cancelled: false, envelope };
  }

  async exportPacket(envelope: PairedV2NativePacketEnvelope): Promise<PairedV2PacketExportOutcome> {
    const retained = decodeResponseEnvelope(envelope);
    let response: ThemePacketExportResponse;
    try {
      response = await this.packetTransport.exportPacket({
        packetJson: retained.canonicalJson,
        defaultName: defaultName(retained.kind),
        expectedKind: retained.kind,
      });
    } catch {
      return fail("native-rejected");
    }
    if (response.cancelled) {
      if (response.saved || response.pairedV2 !== undefined) return fail("invalid-response");
      return { cancelled: true, saved: false };
    }
    if (response.error !== undefined) {
      if (response.pairedV2 !== undefined) return fail("invalid-response");
      return fail("native-rejected");
    }
    if (!response.saved) {
      if (response.pairedV2 !== undefined) return fail("invalid-response");
      return { cancelled: false, saved: false, ...(response.digest === undefined ? {} : { digest: response.digest }) };
    }
    if (response.pairedV2 === undefined) return fail("invalid-response");
    const exported = decodeResponseEnvelope(response.pairedV2);
    if (exported.kind !== retained.kind) return fail("invalid-response");
    assertExportEnvelope(response, exported, retained.canonicalJson);
    return { cancelled: false, saved: true, digest: exported.digest };
  }
}

/**
 * Production wiring is explicit at the Lab boundary: this factory only
 * assembles the native invoke port with the existing picker bridge. It does
 * not invoke native commands while React renders and is not used when a
 * fixture supplies an injected packet bridge.
 */
export function createTauriPairedV2PacketBridge(): PairedV2PacketBridge {
  const invoke: PairedV2PacketInvoke = <T>(
    command: string,
    args: { readonly request: unknown },
  ) => tauriInvoke<T>(command, args);
  return new TauriPairedV2PacketBridge(invoke, new TauriThemeLabBridge());
}
