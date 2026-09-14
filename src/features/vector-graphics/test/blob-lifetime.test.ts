import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobPreviewManager } from "../blob-preview";

describe("Blob Lifetime & Replacement Decoding (TFSB63A)", () => {
  let createdUrls: string[] = [];
  let revokedUrls: string[] = [];
  let urlCounter = 0;
  const decode = vi.fn<() => Promise<void>>();

  beforeEach(() => {
    createdUrls = [];
    revokedUrls = [];
    urlCounter = 0;
    decode.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal("Image", class {
      src = "";
      decode = decode;
    });

    // Mock URL.createObjectURL and URL.revokeObjectURL
    globalThis.URL.createObjectURL = vi.fn((blob: Blob) => {
      expect(blob.type).toBe("image/svg+xml");
      const url = `blob:test-studio/${++urlCounter}`;
      createdUrls.push(url);
      return url;
    });

    globalThis.URL.revokeObjectURL = vi.fn((url: string) => {
      revokedUrls.push(url);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for the browser decode promise before replacing the displayed URL", async () => {
    const manager = new BlobPreviewManager();
    await manager.updatePreview("<svg/>", 1, () => true);
    let finishDecode!: () => void;
    decode.mockImplementationOnce(() => new Promise<void>(resolve => { finishDecode = resolve; }));
    const replacement = manager.updatePreview("<svg/>", 2, () => true);
    expect(decode).toHaveBeenCalledTimes(2);
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/1");
    expect(revokedUrls).toEqual([]);
    finishDecode();
    await replacement;
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/2");
    expect(revokedUrls).toEqual(["blob:test-studio/1"]);
    manager.dispose();
  });

  it("decodes replacement before revoking last-good URL on successful update", async () => {
    const manager = new BlobPreviewManager();
    const decodeOrder: string[] = [];

    // Spy on decodeCandidateImage to track execution order
    const origDecode = manager.decodeCandidateImage.bind(manager);
    manager.decodeCandidateImage = async (url: string) => {
      decodeOrder.push(`decode:${url}`);
      // At decode time, previous last-good must NOT be revoked yet
      expect(revokedUrls).toHaveLength(0);
      await origDecode(url);
    };

    // First update: initial preview
    const res1 = await manager.updatePreview("<svg id='1'></svg>", 1, () => true);
    expect(res1).not.toBeNull();
    expect(res1?.url).toBe("blob:test-studio/1");
    expect(res1?.revokedUrl).toBeNull();
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/1");
    expect(manager.getLastGoodRevision()).toBe(1);
    expect(revokedUrls).toHaveLength(0);

    // Second update: replacement preview
    manager.decodeCandidateImage = async (url: string) => {
      decodeOrder.push(`decode:${url}`);
      // Crucial invariant: during decode of replacement (url 2), url 1 must NOT be revoked yet!
      expect(revokedUrls).not.toContain("blob:test-studio/1");
    };

    const res2 = await manager.updatePreview("<svg id='2'></svg>", 2, () => true);
    expect(res2).not.toBeNull();
    expect(res2?.url).toBe("blob:test-studio/2");
    expect(res2?.revokedUrl).toBe("blob:test-studio/1");

    // After successful decode and commit, previous last-good is revoked
    expect(revokedUrls).toContain("blob:test-studio/1");
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/2");
    expect(manager.getLastGoodRevision()).toBe(2);

    manager.dispose();
    expect(revokedUrls).toContain("blob:test-studio/2");
  });

  it("revokes candidate immediately and preserves last-good URL if decoding fails", async () => {
    const manager = new BlobPreviewManager();

    // Initial valid preview
    await manager.updatePreview("<svg id='valid'></svg>", 1, () => true);
    const firstUrl = manager.getLastGoodUrl();
    expect(firstUrl).toBe("blob:test-studio/1");
    expect(revokedUrls).toHaveLength(0);

    // Simulate decode failure on replacement
    decode.mockRejectedValueOnce(new Error("SVG XML parsing error during rasterization"));

    await expect(
      manager.updatePreview("<svg malformed></svg>", 2, () => true),
    ).rejects.toThrow("SVG XML parsing error during rasterization");

    // The candidate URL (blob:test-studio/2) must be revoked immediately!
    expect(revokedUrls).toContain("blob:test-studio/2");
    // The previous last-good URL must NOT be revoked!
    expect(revokedUrls).not.toContain("blob:test-studio/1");
    // State remains pointing to the first valid preview
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/1");
    expect(manager.getLastGoodRevision()).toBe(1);

    manager.dispose();
  });

  it("revokes candidate and preserves last-good URL if request becomes stale during decode", async () => {
    const manager = new BlobPreviewManager();

    await manager.updatePreview("<svg id='1'></svg>", 1, () => true);
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/1");

    // Second update that becomes stale before completing
    let isCurrent = true;
    manager.decodeCandidateImage = async () => {
      // While decoding, newer edit arrived making this candidate stale
      isCurrent = false;
    };

    const res = await manager.updatePreview("<svg id='stale'></svg>", 2, () => isCurrent);
    expect(res).toBeNull(); // Discarded

    // Candidate URL 2 was revoked
    expect(revokedUrls).toContain("blob:test-studio/2");
    // Last-good URL 1 remains intact
    expect(revokedUrls).not.toContain("blob:test-studio/1");
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/1");

    manager.dispose();
  });

  it("accurately reports staleness with respect to current revision", async () => {
    const manager = new BlobPreviewManager();
    expect(manager.isStale(1)).toBe(false);

    await manager.updatePreview("<svg></svg>", 1, () => true);
    expect(manager.isStale(1)).toBe(false);
    expect(manager.isStale(2)).toBe(true);
    expect(manager.isStale(5)).toBe(true);

    await manager.updatePreview("<svg></svg>", 5, () => true);
    expect(manager.isStale(5)).toBe(false);
    expect(manager.isStale(6)).toBe(true);

    manager.dispose();
  });

  it("cleans up last-good and candidate URLs on dispose()", async () => {
    const manager = new BlobPreviewManager();
    await manager.updatePreview("<svg></svg>", 1, () => true);
    expect(manager.getLastGoodUrl()).toBe("blob:test-studio/1");

    manager.dispose();
    expect(revokedUrls).toContain("blob:test-studio/1");
    expect(manager.getLastGoodUrl()).toBeNull();
    expect(manager.getLastGoodRevision()).toBeNull();
  });
});
