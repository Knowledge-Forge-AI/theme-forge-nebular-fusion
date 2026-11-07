/**
 * Small, renderer-local lifecycle contract for bounded preview consumers.
 *
 * The callback intentionally has no error field. A preview frame may report
 * failure, but details from a child document must not cross the UI boundary.
 */
export type PreviewApplicationLifecycle = "pending" | "applied" | "failed";

export interface PreviewApplicationState {
  readonly state: PreviewApplicationLifecycle;
  readonly revision: number;
  readonly mode: "light" | "dark";
  /** Opaque token identifying the current local iframe load. */
  readonly frameId: string;
  readonly contextId?: string;
  /** Present only for a path that opted into per-application v2 correlation. */
  readonly applicationId?: string;
  /** Bounded computed token returned by a confirmed preview, when available. */
  readonly computedToken?: string;
}

export type PreviewApplicationStateCallback = (state: PreviewApplicationState) => void;

export interface PreviewFrameIdentity {
  readonly generation: number;
  readonly frameId: string;
}

const COMPUTED_TOKEN_CEILING = 128;
let localFrameSequence = 0;

/** Keep computed diagnostics small, printable, and non-empty before accepting them. */
export function normalizeComputedPreviewToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > COMPUTED_TOKEN_CEILING) return null;
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

/**
 * Generate a local opaque token. The monotonic fallback keeps tests and
 * restricted webviews deterministic when randomUUID is not exposed.
 */
export function createPreviewFrameIdentity(generation: number): PreviewFrameIdentity {
  localFrameSequence += 1;
  let suffix = String(localFrameSequence);
  try {
    const randomUUID = globalThis.crypto?.randomUUID;
    if (typeof randomUUID === "function") suffix = randomUUID.call(globalThis.crypto);
  } catch {
    // The sequence fallback is sufficient for local identity binding.
  }
  return { generation, frameId: `frame-${suffix}` };
}

export function previewState(
  state: PreviewApplicationLifecycle,
  revision: number,
  mode: "light" | "dark",
  frameId: string,
  details: Pick<PreviewApplicationState, "contextId" | "applicationId" | "computedToken"> = {},
): PreviewApplicationState {
  return { state, revision, mode, frameId, ...details };
}

