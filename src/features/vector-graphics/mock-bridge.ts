import type {
  Artboard,
  SceneAdoptRequest,
  SceneApplyRequest,
  SceneBriefRequest,
  SceneCompileRequest,
  SceneCompileResponse,
  SceneDisposeRequest,
  SceneDisposeResponse,
  SceneDraftResponse,
  SceneEditOperation,
  SceneEditRequest,
  SceneExportPlanRequest,
  SceneImportResponse,
  SceneImportSvgRequest,
  SceneNewRequest,
  SceneOpenRequest,
  ScenePacketExportRequest,
  ScenePacketImportRequest,
  ScenePacketResponse,
  ScenePlanResponse,
  ScenePublicationResponse,
  SceneReviewRequest,
  SceneSavePlanRequest,
  SceneSelectionResponse,
  SceneStatusRequest,
  SceneStatusResponse,
  SceneTokenBindRequest,
  SceneVerificationResponse,
  SceneVerifyRequest,
  VectorGraphicsBridge,
  VectorScene,
} from "./types";

export function createDefaultScene(): VectorScene {
  return {
    schema: "tfsb.vector-scene-v1",
    compatibility: 1,
    compilerLevel: 1,
    profile: "illustration",
    artboard: {
      width: 800,
      height: 600,
      viewBox: [0, 0, 800, 600],
      policy: "contain",
    },
    accessibility: {
      mode: "labelled",
      title: "Sample Vector Scene",
      desc: "Default starter illustration scene",
    },
    elements: [
      {
        type: "rect",
        id: "bg-rect",
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        presentation: {
          fill: { type: "solid", color: "#1e1738" },
        },
      },
      {
        type: "circle",
        id: "hero-circle",
        cx: 400,
        cy: 300,
        r: 120,
        presentation: {
          fill: { type: "solid", color: "#8b5cf6" },
          stroke: { type: "solid", color: "#f6c65b" },
          strokeWidth: 4,
        },
      },
      {
        type: "label",
        id: "title-label",
        text: "Stellar Burst",
        x: 400,
        y: 305,
        align: "center",
        scale: 24,
        presentation: {
          fill: { type: "solid", color: "#ffffff" },
        },
      },
    ],
  };
}

export function sceneToSvg(scene: VectorScene): string {
  const elementsSvg = scene.elements
    .map((elem) => {
      switch (elem.type) {
        case "rect":
          return `<rect id="${elem.id ?? ""}" x="${elem.x}" y="${elem.y}" width="${elem.width}" height="${elem.height}" fill="${elem.presentation?.fill?.type === "solid" ? elem.presentation.fill.color : "#666"}" />`;
        case "circle":
          return `<circle id="${elem.id ?? ""}" cx="${elem.cx}" cy="${elem.cy}" r="${elem.r}" fill="${elem.presentation?.fill?.type === "solid" ? elem.presentation.fill.color : "#888"}" stroke="${elem.presentation?.stroke?.type === "solid" ? elem.presentation.stroke.color : "none"}" stroke-width="${elem.presentation?.strokeWidth ?? 0}" />`;
        case "ellipse":
          return `<ellipse id="${elem.id ?? ""}" cx="${elem.cx}" cy="${elem.cy}" rx="${elem.rx}" ry="${elem.ry}" />`;
        case "line":
          return `<line id="${elem.id ?? ""}" x1="${elem.x1}" y1="${elem.y1}" x2="${elem.x2}" y2="${elem.y2}" stroke="currentColor" />`;
        case "polyline":
          return `<polyline id="${elem.id ?? ""}" points="${elem.points.map((p) => p.join(",")).join(" ")}" />`;
        case "polygon":
          return `<polygon id="${elem.id ?? ""}" points="${elem.points.map((p) => p.join(",")).join(" ")}" />`;
        case "path":
          return `<path id="${elem.id ?? ""}" d="${elem.d}" />`;
        case "diagramNode":
          return `<rect id="${elem.id}" x="${elem.x}" y="${elem.y}" width="${elem.width}" height="${elem.height}" rx="${elem.rx ?? 0}" /><text x="${elem.x + 8}" y="${elem.y + 20}">${elem.label ?? ""}</text>`;
        case "label":
          return `<text id="${elem.id ?? ""}" x="${elem.x}" y="${elem.y}" text-anchor="${elem.align ?? "left"}">${elem.text}</text>`;
        case "connector":
          return `<line id="${elem.id ?? ""}" x1="0" y1="0" x2="100" y2="100" />`;
        case "use":
          return `<use id="${elem.id ?? ""}" href="${elem.href}" x="${elem.x ?? 0}" y="${elem.y ?? 0}" />`;
        case "group":
          return `<g id="${elem.id ?? ""}"></g>`;
        default:
          return "";
      }
    })
    .join("\n  ");

  const [minX, minY, vbWidth, vbHeight] = scene.artboard.viewBox;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${vbWidth} ${vbHeight}" width="${scene.artboard.width}" height="${scene.artboard.height}">
  ${elementsSvg}
</svg>`;
}

export class MockVectorGraphicsBridge implements VectorGraphicsBridge {
  public sessionId = "mock-scene-session-1";
  public revision = 1;
  public draftInputDigest = "sha256:0000000000000000000000000000000000000000000000000000000000000001";
  public scene: VectorScene = createDefaultScene();
  public dirty = false;
  public sourceId: string | undefined = undefined;
  public tokenSnapshotId: string | undefined = undefined;
  public retainedSavePlan = false;
  public retainedExportPlan = false;
  public retainedPackets = new Map<string, ScenePacketResponse>();
  public verificationResults = new Map<string, SceneVerificationResponse>();
  public calls: { command: string; args: unknown }[] = [];

  // Configurable hooks for tests
  public compileDelayMs = 0;
  public compileFailOnce = false;

  private recordCall(command: string, args: unknown): void {
    this.calls.push({ command, args });
  }

  async newScene(request: SceneNewRequest): Promise<SceneDraftResponse> {
    this.recordCall("newScene", request);
    this.sessionId = `mock-session-${Date.now()}`;
    this.revision = 1;
    this.scene = createDefaultScene();
    if (request.profile) {
      this.scene = { ...this.scene, profile: request.profile };
    }
    if (request.artboard) {
      this.scene = { ...this.scene, artboard: request.artboard };
    }
    this.dirty = true;
    this.sourceId = undefined;
    this.tokenSnapshotId = undefined;
    this.draftInputDigest = `sha256:new-${this.revision}-${Date.now()}`;

    return {
      sessionId: this.sessionId,
      revision: this.revision,
      sourceId: this.sourceId,
      dirty: this.dirty,
      scene: this.scene,
      canonicalJson: JSON.stringify(this.scene),
      draftInputDigest: this.draftInputDigest,
      tokenSnapshotId: this.tokenSnapshotId,
      compiled: {
        svg: sceneToSvg(this.scene),
        svgDigest: "sha256:preview-new",
        receipt: {
          schema: "tfsb.scene-compile-receipt-v1",
          diagnostics: [],
          sourceSnapshotDigest: this.draftInputDigest,
          sceneSchema: this.scene.schema,
          sceneCompatibility: this.scene.compatibility,
          sceneCompilerLevel: this.scene.compilerLevel,
          sourceDigest: this.draftInputDigest,
          svgDigest: "sha256:preview-new",
          profile: this.scene.profile,
          artboard: this.scene.artboard,
          glyphCatalogDigest: "sha256:empty-glyphs",
          tokenDigest: "sha256:empty-tokens",
          metrics: {
            expandedElementCount: this.scene.elements.length,
            authoredElementCount: this.scene.elements.length,
            pathSegmentCount: 12,
            glyphCount: 12,
            maxNestingDepth: 1,
            gradientStopCount: 0,
          },
        },
        metrics: {
          expandedElementCount: this.scene.elements.length,
          authoredElementCount: this.scene.elements.length,
          pathSegmentCount: 12,
          glyphCount: 12,
          maxNestingDepth: 1,
          gradientStopCount: 0,
        },
      },
      diagnostics: [],
    };
  }

  async getStatus(request?: SceneStatusRequest): Promise<SceneStatusResponse> {
    this.recordCall("getStatus", request);
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      sourceId: this.sourceId,
      dirty: this.dirty,
      disposed: false,
      draftInputDigest: this.draftInputDigest,
      tokenSnapshotId: this.tokenSnapshotId,
      hasCompiledSvg: true,
      compiledSvgDigest: "sha256:current-svg",
      retainedSavePlan: this.retainedSavePlan,
      retainedExportPlan: this.retainedExportPlan,
      retainedPacketsCount: this.retainedPackets.size,
      diagnostics: [],
    };
  }

  async dispose(request: SceneDisposeRequest): Promise<SceneDisposeResponse> {
    this.recordCall("dispose", request);
    return {
      sessionId: request.expected.sessionId,
      disposed: true,
    };
  }

  async openScene(request?: SceneOpenRequest): Promise<SceneSelectionResponse> {
    this.recordCall("openScene", request);
    this.revision++;
    this.dirty = false;
    this.sourceId = "file:///scenes/opened-sample.json";
    this.tokenSnapshotId = undefined;
    this.draftInputDigest = `sha256:opened-${this.revision}`;
    const draft: SceneDraftResponse = {
      sessionId: this.sessionId,
      revision: this.revision,
      sourceId: this.sourceId,
      dirty: this.dirty,
      scene: this.scene,
      canonicalJson: JSON.stringify(this.scene),
      draftInputDigest: this.draftInputDigest,
      tokenSnapshotId: this.tokenSnapshotId,
      diagnostics: [],
    };
    return { cancelled: false, draft };
  }

  async importSvg(request?: SceneImportSvgRequest): Promise<SceneImportResponse> {
    this.recordCall("importSvg", request);
    this.revision++;
    this.dirty = true;
    this.sourceId = "file:///scenes/imported-sample.svg";
    this.tokenSnapshotId = undefined;
    this.draftInputDigest = `sha256:imported-svg-${this.revision}`;
    const draft: SceneDraftResponse = {
      sessionId: this.sessionId,
      revision: this.revision,
      sourceId: this.sourceId,
      dirty: this.dirty,
      scene: this.scene,
      canonicalJson: JSON.stringify(this.scene),
      draftInputDigest: this.draftInputDigest,
      diagnostics: [],
    };
    return {
      cancelled: false,
      classification: "SUPPORTED_IMPORT",
      reasonCodes: ["CLEAN_IMPORT"],
      normalizations: ["viewBox viewBox standardized"],
      diagnostics: [],
      draft,
    };
  }

  async editScene(request: SceneEditRequest): Promise<SceneDraftResponse> {
    this.recordCall("editScene", request);
    let nextScene = { ...this.scene };

    for (const op of request.operations) {
      switch (op.type) {
        case "setArtboard":
          nextScene = { ...nextScene, artboard: op.artboard };
          break;
        case "setProfile":
          nextScene = { ...nextScene, profile: op.profile };
          break;
        case "setAccessibility":
          nextScene = { ...nextScene, accessibility: op.accessibility };
          break;
        case "insertElement": {
          const elements = [...nextScene.elements];
          if (typeof op.index === "number" && op.index >= 0 && op.index <= elements.length) {
            elements.splice(op.index, 0, op.element);
          } else {
            elements.push(op.element);
          }
          nextScene = { ...nextScene, elements };
          break;
        }
        case "updateElement": {
          const elements = nextScene.elements.map((el) => (el.id === op.id ? op.element : el));
          nextScene = { ...nextScene, elements };
          break;
        }
        case "removeElement": {
          const elements = nextScene.elements.filter((el) => el.id !== op.id);
          nextScene = { ...nextScene, elements };
          break;
        }
        case "moveElement": {
          const elements = [...nextScene.elements];
          const idx = elements.findIndex((el) => el.id === op.id);
          if (idx >= 0 && op.newIndex >= 0 && op.newIndex < elements.length) {
            const [item] = elements.splice(idx, 1);
            if (item) elements.splice(op.newIndex, 0, item);
          }
          nextScene = { ...nextScene, elements };
          break;
        }
        case "setDefinitions":
          nextScene = { ...nextScene, definitions: op.definitions };
          break;
        case "setTokenBindings":
          nextScene = { ...nextScene, tokenBindings: op.tokenBindings };
          break;
        case "setLayout":
          nextScene = { ...nextScene, layout: op.layout };
          break;
        case "setProvenance":
          nextScene = { ...nextScene, provenance: op.provenance };
          break;
        case "replaceScene":
          nextScene = op.scene;
          break;
      }
    }

    this.scene = nextScene;
    this.revision++;
    this.dirty = true;
    this.draftInputDigest = `sha256:edit-${this.revision}-${Date.now()}`;

    return {
      sessionId: this.sessionId,
      revision: this.revision,
      sourceId: this.sourceId,
      dirty: this.dirty,
      scene: this.scene,
      canonicalJson: JSON.stringify(this.scene),
      draftInputDigest: this.draftInputDigest,
      tokenSnapshotId: this.tokenSnapshotId,
      diagnostics: [],
    };
  }

  async compileScene(request: SceneCompileRequest): Promise<SceneCompileResponse> {
    this.recordCall("compileScene", request);
    // Mirror native Session::check_expected, including absence of optional bindings.
    const expected = request.expected;
    const reasonCode = expected.sessionId !== this.sessionId ? "context-invalid"
      : expected.revision !== this.revision ? "stale"
      : expected.draftInputDigest !== undefined && expected.draftInputDigest !== this.draftInputDigest ? "digest-mismatch"
      : expected.sourceId !== this.sourceId || expected.tokenSnapshotId !== this.tokenSnapshotId
        || (expected.engineIdentity !== undefined && expected.engineIdentity !== "tfsb.vector-scene-v1:1:1") ? "context-stale"
      : undefined;
    if (reasonCode) {
      throw { schemaVersion: 1, reasonCode, message: "The requested Studio host operation could not be completed." };
    }
    if (this.compileDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.compileDelayMs));
    }

    if (this.compileFailOnce) {
      this.compileFailOnce = false;
      throw new Error("Simulated compile failure");
    }

    const svg = sceneToSvg(this.scene);
    const metrics = {
      expandedElementCount: this.scene.elements.length,
      authoredElementCount: this.scene.elements.length,
      pathSegmentCount: 14,
      glyphCount: 12,
      maxNestingDepth: 1,
      gradientStopCount: 0,
    };
    const receipt = {
      schema: "tfsb.scene-compile-receipt-v1",
      diagnostics: [],
      sourceSnapshotDigest: this.draftInputDigest,
      sceneSchema: this.scene.schema,
      sceneCompatibility: this.scene.compatibility,
      sceneCompilerLevel: this.scene.compilerLevel,
      sourceDigest: this.draftInputDigest,
      svgDigest: `sha256:svg-${this.revision}`,
      profile: this.scene.profile,
      artboard: this.scene.artboard,
      glyphCatalogDigest: "sha256:empty-glyphs",
      tokenDigest: "sha256:empty-tokens",
      metrics,
    };

    return {
      sessionId: request.expected.sessionId,
      revision: request.expected.revision,
      draftInputDigest: request.expected.draftInputDigest ?? this.draftInputDigest,
      svg,
      receipt,
      metrics,
      diagnostics: [],
    };
  }

  async savePlan(request: SceneSavePlanRequest): Promise<ScenePlanResponse> {
    this.recordCall("savePlan", request);
    this.retainedSavePlan = true;
    return {
      cancelled: false,
      planId: `save-plan-${this.revision}`,
      targetDisplayName: "new-scene.json",
      targetKind: "json",
      byteCount: JSON.stringify(this.scene).length,
      canonicalDigest: this.draftInputDigest,
      expiresAtUnixMs: Date.now() + 300_000,
    };
  }

  async saveApply(request: SceneApplyRequest): Promise<ScenePublicationResponse> {
    this.recordCall("saveApply", request);
    this.retainedSavePlan = false;
    this.dirty = false;
    this.sourceId = "file:///scenes/new-scene.json";
    return {
      published: true,
      targetDisplayName: "new-scene.json",
      sourceId: this.sourceId,
      digest: this.draftInputDigest,
      byteCount: 1024,
    };
  }

  async exportPlan(request: SceneExportPlanRequest): Promise<ScenePlanResponse> {
    this.recordCall("exportPlan", request);
    this.retainedExportPlan = true;
    return {
      cancelled: false,
      planId: `export-plan-${this.revision}`,
      targetDisplayName: "scene-export.svg",
      targetKind: "svg",
      byteCount: 2048,
      canonicalDigest: `sha256:svg-${this.revision}`,
      expiresAtUnixMs: Date.now() + 300_000,
    };
  }

  async exportApply(request: SceneApplyRequest): Promise<ScenePublicationResponse> {
    this.recordCall("exportApply", request);
    this.retainedExportPlan = false;
    // Export does NOT reset dirty
    return {
      published: true,
      targetDisplayName: "scene-export.svg",
      digest: `sha256:svg-${this.revision}`,
      byteCount: 2048,
    };
  }

  async bindTokens(request: SceneTokenBindRequest): Promise<SceneDraftResponse> {
    this.recordCall("bindTokens", request);
    this.tokenSnapshotId = `token-snap-${this.revision + 1}`;
    this.scene = {
      ...this.scene,
      tokenBindings: {
        "color.primary": "#ec4899",
        "color.accent": "#38bdf8",
        "color.border": "#f6c65b",
        "color.bg": "#0c0917",
      },
    };
    this.revision++;
    this.dirty = true;
    this.draftInputDigest = `sha256:tokens-${this.revision}`;
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      sourceId: this.sourceId,
      dirty: this.dirty,
      scene: this.scene,
      canonicalJson: JSON.stringify(this.scene),
      draftInputDigest: this.draftInputDigest,
      tokenSnapshotId: this.tokenSnapshotId,
      diagnostics: [],
    };
  }

  async createBrief(request: SceneBriefRequest): Promise<ScenePacketResponse> {
    this.recordCall("createBrief", request);
    const packetId = `brief-${Date.now()}`;
    const res: ScenePacketResponse = {
      cancelled: false,
      packetId,
      packetKind: "brief",
      canonicalJson: JSON.stringify({
        schema: "tfsb.scene-exchange-brief-v1",
        title: request.title,
        objective: request.objective,
        acceptanceCriteria: request.acceptanceCriteria,
        scene: this.scene,
      }),
      packetDigest: `sha256:brief-${packetId}`,
      senderClaims: ["local-author"],
      diagnostics: [],
    };
    this.retainedPackets.set(packetId, res);
    return res;
  }

  async importPacket(request?: ScenePacketImportRequest): Promise<ScenePacketResponse> {
    this.recordCall("importPacket", request);
    const packetId = `imported-candidate-${Date.now()}`;
    const res: ScenePacketResponse = {
      cancelled: false,
      packetId,
      packetKind: request?.expectedKind ?? "candidate",
      canonicalJson: JSON.stringify({
        schema: "tfsb.scene-exchange-candidate-v1",
        candidateId: packetId,
        scene: this.scene,
      }),
      packetDigest: `sha256:packet-${packetId}`,
      senderClaims: ["remote-agent"],
      diagnostics: [],
    };
    this.retainedPackets.set(packetId, res);
    return res;
  }

  async exportPacket(request: ScenePacketExportRequest): Promise<ScenePublicationResponse> {
    this.recordCall("exportPacket", request);
    const packet = this.retainedPackets.get(request.packetId);
    return {
      published: true,
      targetDisplayName: `${request.packetId}.json`,
      digest: packet?.packetDigest ?? "sha256:exported-packet",
      byteCount: 512,
    };
  }

  async createReview(request: SceneReviewRequest): Promise<ScenePacketResponse> {
    this.recordCall("createReview", request);
    const packetId = `review-${Date.now()}`;
    const res: ScenePacketResponse = {
      cancelled: false,
      packetId,
      packetKind: "review",
      canonicalJson: JSON.stringify({
        schema: "tfsb.scene-exchange-review-v1",
        briefPacketId: request.briefPacketId,
        candidatePacketIds: request.candidatePacketIds,
        overallDisposition: request.overallDisposition,
        summary: request.summary,
        annotations: request.annotations,
      }),
      packetDigest: `sha256:review-${packetId}`,
      senderClaims: ["local-reviewer"],
      diagnostics: [],
    };
    this.retainedPackets.set(packetId, res);
    return res;
  }

  async verifyCandidate(request: SceneVerifyRequest): Promise<SceneVerificationResponse> {
    this.recordCall("verifyCandidate", request);
    const handle = `handle-verify-${Date.now()}`;
    const res: SceneVerificationResponse = {
      valid: true,
      candidatePacketId: request.candidatePacketId,
      candidateDigest: `sha256:candidate-${request.candidatePacketId}`,
      compiledSvgDigest: `sha256:verified-svg-${request.candidatePacketId}`,
      verificationHandle: handle,
      diagnostics: [],
      metrics: {
        expandedElementCount: 5,
        authoredElementCount: 3,
        pathSegmentCount: 8,
        glyphCount: 10,
        maxNestingDepth: 1,
        gradientStopCount: 0,
      },
    };
    this.verificationResults.set(handle, res);
    return res;
  }

  async adoptCandidate(request: SceneAdoptRequest): Promise<SceneDraftResponse> {
    this.recordCall("adoptCandidate", request);
    this.revision++;
    this.dirty = true;
    this.sourceId = undefined; // Adoption clears source id
    this.draftInputDigest = `sha256:adopted-${this.revision}`;
    return {
      sessionId: this.sessionId,
      revision: this.revision,
      sourceId: undefined,
      dirty: true,
      scene: this.scene,
      canonicalJson: JSON.stringify(this.scene),
      draftInputDigest: this.draftInputDigest,
      diagnostics: [],
    };
  }
}
