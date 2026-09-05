import { invoke } from "@tauri-apps/api/core";
import type { DesignEvidencePacket, PacketKind } from "./types";
import { validateDesignEvidencePacket } from "./validate";

export const DESIGN_PACKET_COMMANDS = Object.freeze({ import: "studio_design_packet_import", export: "studio_design_packet_export" });
export type PacketImportResult = { readonly cancelled: true } | { readonly cancelled: false; readonly packet: DesignEvidencePacket; readonly kind: PacketKind; readonly digest: string; readonly byteCount: number };
export type PacketExportResult = { readonly cancelled: true; readonly kind: PacketKind; readonly digest: string } | { readonly cancelled: false; readonly kind: PacketKind; readonly digest: string; readonly byteCount: number };
export interface DesignPacketClient { importPacket(expectedKind: "any" | PacketKind): Promise<PacketImportResult>; exportPacket(packet: DesignEvidencePacket): Promise<PacketExportResult> }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("design-packet-ipc-result-invalid");
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error("design-packet-ipc-result-invalid");
}

function kindFor(packet: DesignEvidencePacket): PacketKind {
  return packet.schema === "tfsb.design-brief" ? "brief" : packet.schema === "tfsb.design-candidate" ? "candidate" : "review";
}

function digestFor(packet: DesignEvidencePacket): string {
  return packet.schema === "tfsb.design-brief" ? packet.briefDigest : packet.schema === "tfsb.design-candidate" ? packet.candidateDigest : packet.reviewDigest;
}

function validateMetadata(value: Record<string, unknown>, packet: DesignEvidencePacket): { kind: PacketKind; digest: string } {
  const kind = kindFor(packet);
  const digest = digestFor(packet);
  if (value.kind !== kind || value.digest !== digest) throw new Error("design-packet-ipc-metadata-mismatch");
  return { kind, digest };
}

export async function validatePacketImportResult(value: unknown): Promise<PacketImportResult> {
  const result = record(value);
  if (result.cancelled === true) {
    exactKeys(result, ["cancelled"]);
    return Object.freeze({ cancelled: true });
  }
  if (result.cancelled !== false) throw new Error("design-packet-ipc-result-invalid");
  exactKeys(result, ["cancelled", "packet", "kind", "digest", "byteCount"]);
  if (!Number.isSafeInteger(result.byteCount) || (result.byteCount as number) <= 0) throw new Error("design-packet-ipc-result-invalid");
  const packet = await validateDesignEvidencePacket(result.packet);
  const { kind, digest } = validateMetadata(result, packet);
  return Object.freeze({ cancelled: false, packet, kind, digest, byteCount: result.byteCount as number });
}

export function validatePacketExportResult(value: unknown, packet: DesignEvidencePacket): PacketExportResult {
  const result = record(value);
  if (result.cancelled !== true && result.cancelled !== false) throw new Error("design-packet-ipc-result-invalid");
  exactKeys(result, result.cancelled ? ["cancelled", "kind", "digest"] : ["cancelled", "kind", "digest", "byteCount"]);
  const { kind, digest } = validateMetadata(result, packet);
  if (result.cancelled) return Object.freeze({ cancelled: true, kind, digest });
  if (!Number.isSafeInteger(result.byteCount) || (result.byteCount as number) <= 0) throw new Error("design-packet-ipc-result-invalid");
  return Object.freeze({ cancelled: false, kind, digest, byteCount: result.byteCount as number });
}

export class TauriDesignPacketClient implements DesignPacketClient {
  async importPacket(expectedKind: "any" | PacketKind): Promise<PacketImportResult> { return validatePacketImportResult(await invoke<unknown>(DESIGN_PACKET_COMMANDS.import, { expectedKind })); }
  async exportPacket(packet: DesignEvidencePacket): Promise<PacketExportResult> { const validated = await validateDesignEvidencePacket(packet); return validatePacketExportResult(await invoke<unknown>(DESIGN_PACKET_COMMANDS.export, { packet: validated }), validated); }
}
