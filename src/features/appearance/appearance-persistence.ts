import type { AppearanceController } from "./appearance-controller";
import {
  cloneAppearancePreferenceRecord,
  validateAppearancePreferenceSaveReply,
  type AppearancePreferenceSaveReply,
  type AppearanceSettingsBridge,
} from "./appearance-settings-bridge";
import type { AppearancePreferenceRecordV1 } from "./appearance-preferences";

export type AppearancePreferencePersistenceStatus = "idle" | "saving" | "saved" | "failed";

export interface AppearancePreferencePersistenceSnapshot {
  readonly status: AppearancePreferencePersistenceStatus;
  readonly savedRevision: number;
}

export interface AppearancePreferencePersistence {
  connect(): void;
  disconnect(): void;
  subscribe(notify: () => void): () => void;
  getSnapshot(): AppearancePreferencePersistenceSnapshot;
}

interface PendingSave {
  readonly revision: number;
  readonly preferences: AppearancePreferenceRecordV1;
}

interface InFlightSave {
  readonly pending: PendingSave;
}

function makeSnapshot(
  status: AppearancePreferencePersistenceStatus,
  savedRevision: number,
): AppearancePreferencePersistenceSnapshot {
  return Object.freeze({ status, savedRevision });
}

function isSavedReply(value: unknown): value is { readonly status: "saved" } {
  try { return validateAppearancePreferenceSaveReply(value).status === "saved"; }
  catch { return false; }
}

/**
 * Persist only committed explicit preference revisions. The coordinator owns
 * ordering and lifecycle; it never gives native code a controller or a raw
 * mutable record.
 */
export function createAppearancePreferencePersistence(
  controller: AppearanceController,
  bridge: AppearanceSettingsBridge,
): AppearancePreferencePersistence {
  let connected = false;
  let unsubscribeController: (() => void) | null = null;
  let pending: PendingSave | null = null;
  let inFlight: InFlightSave | null = null;
  let savedRevision = 0;
  let failedRevision: number | null = null;
  let snapshot = makeSnapshot("idle", savedRevision);
  const observers = new Set<() => void>();

  function notify(): void {
    if (!connected) return;
    for (const observer of observers) {
      try {
        observer();
      } catch {
        // Observer failures cannot alter persistence ordering or ownership.
      }
    }
  }

  function setSnapshot(status: AppearancePreferencePersistenceStatus): void {
    if (snapshot.status === status && snapshot.savedRevision === savedRevision) return;
    snapshot = makeSnapshot(status, savedRevision);
    notify();
  }

  function queueCurrentIfNeeded(): void {
    if (!connected) return;
    const current = controller.getSnapshot();
    const revision = Number.isSafeInteger(current.preferenceRevision) && current.preferenceRevision >= 0
      ? current.preferenceRevision
      : 0;
    if (revision === 0 || revision <= savedRevision || revision === failedRevision) return;
    if (inFlight?.pending.revision === revision) return;

    let preferences: AppearancePreferenceRecordV1;
    try {
      preferences = cloneAppearancePreferenceRecord(current.preferences);
    } catch {
      failedRevision = revision;
      pending = null;
      setSnapshot("failed");
      return;
    }

    if (pending === null || revision > pending.revision) {
      pending = Object.freeze({ revision, preferences });
    }
  }

  function settleFailure(attempt: PendingSave): void {
    if (inFlight?.pending !== attempt) return;
    inFlight = null;
    failedRevision = attempt.revision;
    if (!connected) {
      setSnapshot("failed");
      return;
    }

    queueCurrentIfNeeded();
    if (pending !== null && pending.revision > attempt.revision) {
      startNext();
      return;
    }
    setSnapshot("failed");
  }

  function settleSuccess(attempt: PendingSave, reply: AppearancePreferenceSaveReply): void {
    if (inFlight?.pending !== attempt) return;
    if (!isSavedReply(reply)) {
      settleFailure(attempt);
      return;
    }
    inFlight = null;

    savedRevision = Math.max(savedRevision, attempt.revision);
    if (failedRevision !== null && failedRevision <= attempt.revision) failedRevision = null;
    if (!connected) {
      setSnapshot("saved");
      return;
    }

    queueCurrentIfNeeded();
    if (pending !== null && pending.revision > attempt.revision) {
      startNext();
      return;
    }
    setSnapshot("saved");
  }

  function startNext(): void {
    if (!connected || inFlight !== null || pending === null) return;
    const attempt = pending;
    pending = null;
    if (attempt.revision <= savedRevision || attempt.revision === failedRevision) {
      const blockedByFailure = attempt.revision === failedRevision;
      queueCurrentIfNeeded();
      if (pending === null) setSnapshot(blockedByFailure ? "failed" : "saved");
      else startNext();
      return;
    }

    inFlight = Object.freeze({ pending: attempt });
    setSnapshot("saving");
    let saveResult: Promise<AppearancePreferenceSaveReply>;
    try {
      saveResult = bridge.save(attempt.preferences);
    } catch {
      settleFailure(attempt);
      return;
    }
    Promise.resolve(saveResult).then(
      (reply) => settleSuccess(attempt, reply),
      () => settleFailure(attempt),
    );
  }

  function observeController(): void {
    if (!connected) return;
    queueCurrentIfNeeded();
    startNext();
  }

  const persistence: AppearancePreferencePersistence = {
    connect(): void {
      if (connected) return;
      connected = true;
      unsubscribeController = controller.subscribe(observeController);
      observeController();
      if (inFlight === null && pending === null && snapshot.status === "saving") {
        setSnapshot(savedRevision > 0 ? "saved" : "idle");
      }
    },

    disconnect(): void {
      if (!connected) return;
      connected = false;
      unsubscribeController?.();
      unsubscribeController = null;
      pending = null;
    },

    subscribe(notifyObserver: () => void): () => void {
      observers.add(notifyObserver);
      return () => observers.delete(notifyObserver);
    },

    getSnapshot(): AppearancePreferencePersistenceSnapshot {
      return snapshot;
    },
  };

  return Object.freeze(persistence);
}
