// Serialized edit queue for TFSB63A Vector Graphics workbench.
// Guarantees monotonic revision progression, single in-flight edit serialization,
// and flush-before-action synchronization.

import type {
  SceneDraftResponse,
  SceneEditOperation,
  SceneExpected,
  VectorGraphicsBridge,
} from "./types";

export interface PendingEditTask {
  readonly operations: readonly SceneEditOperation[];
  readonly resolve: (draft: SceneDraftResponse) => void;
  readonly reject: (error: unknown) => void;
}

export class SerializedEditQueue {
  private bridge: VectorGraphicsBridge;
  private sessionId: string;
  private revision: number;
  private draftInputDigest: string;
  private sourceId?: string | undefined;
  private tokenSnapshotId?: string | undefined;
  private engineIdentity?: string | undefined;

  private queue: PendingEditTask[] = [];
  private inFlight = false;
  private flushListeners: Array<() => void> = [];
  private onAcknowledge?: ((draft: SceneDraftResponse) => void) | undefined;

  constructor(
    bridge: VectorGraphicsBridge,
    initialDraft: SceneDraftResponse,
    onAcknowledge?: (draft: SceneDraftResponse) => void,
  ) {
    this.bridge = bridge;
    this.sessionId = initialDraft.sessionId;
    this.revision = initialDraft.revision;
    this.draftInputDigest = initialDraft.draftInputDigest;
    this.sourceId = initialDraft.sourceId;
    this.tokenSnapshotId = initialDraft.tokenSnapshotId;
    this.onAcknowledge = onAcknowledge;
  }

  updateSourceId(newSourceId: string | undefined): void {
    this.sourceId = newSourceId;
  }

  getExpected(): SceneExpected {
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      draftInputDigest: this.draftInputDigest,
      sourceId: this.sourceId,
      tokenSnapshotId: this.tokenSnapshotId,
      engineIdentity: this.engineIdentity,
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getRevision(): number {
    return this.revision;
  }

  getDraftInputDigest(): string {
    return this.draftInputDigest;
  }

  getSourceId(): string | undefined {
    return this.sourceId;
  }

  isStale(revision: number, sessionId?: string): boolean {
    if (sessionId && sessionId !== this.sessionId) return true;
    return revision < this.revision;
  }

  rebind(draft: SceneDraftResponse): void {
    this.sessionId = draft.sessionId;
    this.revision = draft.revision;
    this.draftInputDigest = draft.draftInputDigest;
    this.sourceId = draft.sourceId;
    this.tokenSnapshotId = draft.tokenSnapshotId;
  }

  /**
   * Enqueue one or more edit operations.
   * Operations will be sent sequentially, awaiting bridge acknowledgement.
   */
  enqueue(operations: readonly SceneEditOperation[]): Promise<SceneDraftResponse> {
    return new Promise<SceneDraftResponse>((resolve, reject) => {
      this.queue.push({ operations, resolve, reject });
      this.pump();
    });
  }

  /**
   * Await complete flush of all queued edits and in-flight requests.
   * Actions (Save Plan, Export Plan, Brief Create, Candidate Verify) must await flush().
   */
  async flush(): Promise<void> {
    if (this.queue.length === 0 && !this.inFlight) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.flushListeners.push(resolve);
    });
  }

  private async pump(): Promise<void> {
    if (this.inFlight || this.queue.length === 0) {
      if (!this.inFlight && this.queue.length === 0 && this.flushListeners.length > 0) {
        const listeners = [...this.flushListeners];
        this.flushListeners = [];
        listeners.forEach((listener) => listener());
      }
      return;
    }

    const nextTask = this.queue.shift();
    if (!nextTask) return;

    this.inFlight = true;
    try {
      const expected = this.getExpected();
      const draft = await this.bridge.editScene({
        expected,
        operations: nextTask.operations,
      });

      // Update state monotonically
      this.rebind(draft);
      this.onAcknowledge?.(draft);
      nextTask.resolve(draft);
    } catch (error) {
      nextTask.reject(error);
    } finally {
      this.inFlight = false;
      this.pump();
    }
  }
}
