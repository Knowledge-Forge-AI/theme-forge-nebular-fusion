import { describe, expect, it, vi } from "vitest";
import { SerializedEditQueue } from "../edit-queue";
import { MockVectorGraphicsBridge, createDefaultScene } from "../mock-bridge";
import type { SceneDraftResponse, SceneEditOperation } from "../types";

describe("Serialized Edit Queue & Stale Result Discarding (TFSB63A)", () => {
  const initialDraft: SceneDraftResponse = {
    sessionId: "session-alpha",
    revision: 1,
    dirty: false,
    scene: createDefaultScene(),
    canonicalJson: "{}",
    draftInputDigest: "sha256:init",
    diagnostics: [],
  };

  it("serializes consecutive edits and updates revisions monotonically", async () => {
    const bridge = new MockVectorGraphicsBridge();
    const queue = new SerializedEditQueue(bridge, initialDraft);

    expect(queue.getRevision()).toBe(1);
    expect(queue.getSessionId()).toBe("session-alpha");

    const op1: SceneEditOperation = {
      type: "insertElement",
      element: { type: "rect", id: "r1", x: 0, y: 0, width: 10, height: 10 },
    };
    const op2: SceneEditOperation = {
      type: "insertElement",
      element: { type: "circle", id: "c1", cx: 20, cy: 20, r: 5 },
    };

    // Dispatch two edits concurrently
    const [res1, res2] = await Promise.all([
      queue.enqueue([op1]),
      queue.enqueue([op2]),
    ]);

    expect(res1.revision).toBe(2);
    expect(res2.revision).toBe(3);
    expect(queue.getRevision()).toBe(3);
    expect(queue.isStale(2)).toBe(true);
    expect(queue.isStale(3)).toBe(false);
  });

  it("flushes and blocks actions until all pending edits are acknowledged", async () => {
    const bridge = new MockVectorGraphicsBridge();
    const queue = new SerializedEditQueue(bridge, initialDraft);

    const completedOps: string[] = [];
    const origEdit = bridge.editScene.bind(bridge);

    // Add artificial delay to simulate network/IPC
    bridge.editScene = async (req) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      completedOps.push(`edit-rev-${req.expected.revision}`);
      return origEdit(req);
    };

    // Queue 3 edits
    void queue.enqueue([{ type: "setProfile", profile: "diagram" }]);
    void queue.enqueue([{ type: "setProfile", profile: "editorial" }]);
    void queue.enqueue([{ type: "setProfile", profile: "promotional" }]);

    expect(completedOps).toHaveLength(0);

    // Action arrives (e.g. Save Plan) and calls flush()
    const flushStartTime = Date.now();
    await queue.flush();
    const flushDuration = Date.now() - flushStartTime;

    // Flush waited until all 3 edits were completed
    expect(completedOps).toHaveLength(3);
    expect(queue.getRevision()).toBe(4);
    expect(flushDuration).toBeGreaterThanOrEqual(25);
  });

  it("identifies stale revisions and discarded asynchronous responses", () => {
    const bridge = new MockVectorGraphicsBridge();
    const queue = new SerializedEditQueue(bridge, initialDraft);

    // Revision is 1
    expect(queue.isStale(0)).toBe(true);
    expect(queue.isStale(1)).toBe(false);

    // Rebind to revision 5
    queue.rebind({
      ...initialDraft,
      revision: 5,
      draftInputDigest: "sha256:rev5",
    });

    // Revisions 1 through 4 are stale
    expect(queue.isStale(1)).toBe(true);
    expect(queue.isStale(4)).toBe(true);
    expect(queue.isStale(5)).toBe(false);

    // Different session is unconditionally stale
    expect(queue.isStale(5, "old-session")).toBe(true);
    expect(queue.isStale(5, "session-alpha")).toBe(false);
  });

  it("rebinds sourceId when source identity changes upon Save As", () => {
    const bridge = new MockVectorGraphicsBridge();
    const queue = new SerializedEditQueue(bridge, initialDraft);

    expect(queue.getExpected().sourceId).toBeUndefined();

    // Rebind source identity (e.g. after Save As)
    queue.updateSourceId("file:///project/saved-scene.json");
    expect(queue.getExpected().sourceId).toBe("file:///project/saved-scene.json");
  });

  it("discards asynchronous compile responses arriving after session replacement", () => {
    const bridge = new MockVectorGraphicsBridge();
    const queue = new SerializedEditQueue(bridge, initialDraft);

    const oldSessionId = queue.getSessionId();

    // Advance session via newScene/rebind
    const nextDraft: SceneDraftResponse = {
      ...initialDraft,
      sessionId: "session-beta",
      revision: 1,
      draftInputDigest: "sha256:beta-init",
    };
    queue.rebind(nextDraft);

    // Old session compilation response arriving now is detected as stale
    expect(queue.isStale(1, oldSessionId)).toBe(true);
    expect(queue.isStale(1, "session-beta")).toBe(false);
  });
});
