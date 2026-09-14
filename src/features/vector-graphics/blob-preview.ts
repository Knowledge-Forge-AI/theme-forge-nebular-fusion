// Blob preview management with explicit Blob lifetime and image replacement decoding.
// Adheres to TFSB63A: decode replacement before revoke last-good, inert <img> Blob engine SVG only.

export interface BlobPreviewUpdateResult {
  readonly url: string;
  readonly revokedUrl: string | null;
  readonly revision: number;
}

export class BlobPreviewManager {
  private lastGoodUrl: string | null = null;
  private lastGoodRevision: number | null = null;
  private activeCandidateUrl: string | null = null;

  /**
   * Return the current last-good Blob URL, if any.
   */
  getLastGoodUrl(): string | null {
    return this.lastGoodUrl;
  }

  /**
   * Return the revision associated with the current last-good preview.
   */
  getLastGoodRevision(): number | null {
    return this.lastGoodRevision;
  }

  /**
   * Check whether the current preview is stale with respect to the latest revision.
   */
  isStale(currentRevision: number): boolean {
    if (this.lastGoodRevision === null) return false;
    return this.lastGoodRevision !== currentRevision;
  }

  /**
   * Attempt to decode a candidate image URL via HTML Image element.
   * Tests replace the browser Image boundary, not this production decode path.
   */
  async decodeCandidateImage(url: string): Promise<void> {
    const img = new Image();
    if (typeof img.decode === "function") {
      img.src = url;
      await img.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("Failed to decode candidate SVG image blob"));
        img.src = url;
      });
    }
  }

  /**
   * Compile replacement SVG into a new Blob URL, decode it, and replace last-good.
   *
   * Invariants:
   * 1. Candidate URL is created.
   * 2. Candidate is decoded BEFORE revoking last-good.
   * 3. If decoding fails, candidate URL is revoked immediately; last-good is preserved.
   * 4. If request is no longer current (superseded/stale), candidate is revoked; last-good is preserved.
   * 5. When accepted, previous last-good is revoked and replaced by candidate.
   */
  async updatePreview(
    svg: string,
    revision: number,
    isStillCurrent: () => boolean,
  ): Promise<BlobPreviewUpdateResult | null> {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const candidateUrl = URL.createObjectURL(blob);
    this.activeCandidateUrl = candidateUrl;

    try {
      // Decode replacement BEFORE revoking last-good URL
      await this.decodeCandidateImage(candidateUrl);

      // Verify request is still current before mutating state
      if (!isStillCurrent()) {
        URL.revokeObjectURL(candidateUrl);
        if (this.activeCandidateUrl === candidateUrl) {
          this.activeCandidateUrl = null;
        }
        return null;
      }

      const revokedUrl = this.lastGoodUrl;
      if (this.lastGoodUrl && this.lastGoodUrl !== candidateUrl) {
        URL.revokeObjectURL(this.lastGoodUrl);
      }

      this.lastGoodUrl = candidateUrl;
      this.lastGoodRevision = revision;
      this.activeCandidateUrl = null;

      return {
        url: candidateUrl,
        revokedUrl,
        revision,
      };
    } catch (error) {
      // Decode failed: clean up candidate URL immediately, retain last-good URL intact!
      URL.revokeObjectURL(candidateUrl);
      if (this.activeCandidateUrl === candidateUrl) {
        this.activeCandidateUrl = null;
      }
      throw error;
    }
  }

  /**
   * Revoke the last-good URL and clean up all allocated blob references.
   */
  dispose(): void {
    if (this.activeCandidateUrl) {
      URL.revokeObjectURL(this.activeCandidateUrl);
      this.activeCandidateUrl = null;
    }
    if (this.lastGoodUrl) {
      URL.revokeObjectURL(this.lastGoodUrl);
      this.lastGoodUrl = null;
      this.lastGoodRevision = null;
    }
  }
}
