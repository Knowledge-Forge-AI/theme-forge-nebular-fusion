import type { VisualArtifact } from "./StudioBrandReadClient";
import { StudioBrandReadValidationError } from "./validators";

function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

export class VisualBlobUrlSet {
  readonly #urls = new Set<string>();

  async create(artifact: VisualArtifact): Promise<string> {
    let binary: string; try { binary = atob(artifact.bytesBase64); } catch { throw new StudioBrandReadValidationError(); }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let canonical = ""; for (let offset = 0; offset < binary.length; offset += 32_766) canonical += btoa(binary.slice(offset, offset + 32_766));
    if (canonical !== artifact.bytesBase64 || bytes.byteLength < 24 || bytes.byteLength !== artifact.byteLength || ![137,80,78,71,13,10,26,10].every((byte, index) => bytes[index] === byte) || `sha256:${hex(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer))}` !== artifact.pngDigest) throw new StudioBrandReadValidationError();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); if (view.getUint32(16) !== artifact.width || view.getUint32(20) !== artifact.height) throw new StudioBrandReadValidationError();
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" })); this.#urls.add(url); return url;
  }

  revoke(url: string): void { if (this.#urls.delete(url)) URL.revokeObjectURL(url); }
  revokeAll(): void { for (const url of this.#urls) URL.revokeObjectURL(url); this.#urls.clear(); }
}
