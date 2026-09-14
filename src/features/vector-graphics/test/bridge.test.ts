import { describe, expect, it, vi } from "vitest";
import {
  SCENE_COMMANDS,
  TauriVectorGraphicsBridge,
  VectorGraphicsValidationError,
  validateArtboard,
  validateCompileResponse,
  validateDiagnostics,
  validateDraftResponse,
  validateMetrics,
  validatePacketResponse,
  validatePlanResponse,
  validatePublicationResponse,
  validateReceipt,
  validateScene,
  validateStatusResponse,
  validateVerificationResponse,
} from "../vector-graphics-bridge";
import { MockVectorGraphicsBridge, createDefaultScene } from "../mock-bridge";
import type { SceneDraftResponse } from "../types";

describe("Vector Graphics Bridge & Protocol Validation", () => {
  describe("18 Fixed Native Commands Inventory", () => {
    it("has all 18 commands with exact studio_scene_* names", () => {
      expect(SCENE_COMMANDS.new).toBe("studio_scene_new");
      expect(SCENE_COMMANDS.status).toBe("studio_scene_status");
      expect(SCENE_COMMANDS.dispose).toBe("studio_scene_dispose");
      expect(SCENE_COMMANDS.open).toBe("studio_scene_open");
      expect(SCENE_COMMANDS.importSvg).toBe("studio_scene_import_svg");
      expect(SCENE_COMMANDS.edit).toBe("studio_scene_edit");
      expect(SCENE_COMMANDS.compile).toBe("studio_scene_compile");
      expect(SCENE_COMMANDS.savePlan).toBe("studio_scene_save_plan");
      expect(SCENE_COMMANDS.saveApply).toBe("studio_scene_save_apply");
      expect(SCENE_COMMANDS.exportPlan).toBe("studio_scene_export_plan");
      expect(SCENE_COMMANDS.exportApply).toBe("studio_scene_export_apply");
      expect(SCENE_COMMANDS.bindTokens).toBe("studio_scene_bind_tokens");
      expect(SCENE_COMMANDS.briefCreate).toBe("studio_scene_brief_create");
      expect(SCENE_COMMANDS.packetImport).toBe("studio_scene_packet_import");
      expect(SCENE_COMMANDS.packetExport).toBe("studio_scene_packet_export");
      expect(SCENE_COMMANDS.reviewCreate).toBe("studio_scene_review_create");
      expect(SCENE_COMMANDS.candidateVerify).toBe("studio_scene_candidate_verify");
      expect(SCENE_COMMANDS.candidateAdopt).toBe("studio_scene_candidate_adopt");
      expect(Object.keys(SCENE_COMMANDS)).toHaveLength(18);
    });
  });

  describe("Closed Response Validators", () => {
    const validScene = createDefaultScene();

    it("validates a well-formed SceneDraftResponse", () => {
      const raw = {
        sessionId: "sess-1",
        revision: 1,
        dirty: false,
        canonicalJson: JSON.stringify(validScene),
        draftInputDigest: "sha256:digest1",
        scene: validScene,
        diagnostics: [],
      };
      const res = validateDraftResponse(raw);
      expect(res.sessionId).toBe("sess-1");
      expect(res.revision).toBe(1);
      expect(res.dirty).toBe(false);
      expect(res.scene.profile).toBe("illustration");
    });

    it("rejects non-object or malformed draft responses", () => {
      expect(() => validateDraftResponse(null)).toThrow(VectorGraphicsValidationError);
      expect(() => validateDraftResponse("bad string")).toThrow(VectorGraphicsValidationError);
      expect(() => validateDraftResponse({ sessionId: "sess-1" })).toThrow(VectorGraphicsValidationError);
    });

    it("validates Artboard with exactly 4 viewBox elements", () => {
      const artboard = validateArtboard({
        width: 800,
        height: 600,
        viewBox: [0, 0, 800, 600],
        policy: "contain",
      });
      expect(artboard.width).toBe(800);
      expect(artboard.viewBox).toEqual([0, 0, 800, 600]);

      // Rejects invalid viewBox
      expect(() =>
        validateArtboard({
          width: 800,
          height: 600,
          viewBox: [0, 0, 800], // only 3
        }),
      ).toThrow(VectorGraphicsValidationError);
    });

    it("validates Metrics and Receipt DTOs", () => {
      const metrics = validateMetrics({
        expandedElementCount: 5,
        authoredElementCount: 3,
        pathSegmentCount: 10,
        glyphCount: 4,
        maxNestingDepth: 1,
        gradientStopCount: 2,
      });
      expect(metrics.pathSegmentCount).toBe(10);

      const receipt = validateReceipt({
        schema: "tfsb.scene-compile-receipt-v1",
        diagnostics: ["test-diag"],
        sourceSnapshotDigest: "sha256:snap",
        sceneSchema: "tfsb.vector-scene-v1",
        sceneCompatibility: 1,
        sceneCompilerLevel: 1,
        sourceDigest: "sha256:src",
        svgDigest: "sha256:svg",
        profile: "illustration",
        artboard: {
          width: 800,
          height: 600,
          viewBox: [0, 0, 800, 600],
        },
        glyphCatalogDigest: "sha256:glyph",
        tokenDigest: "sha256:tok",
        metrics,
      });
      expect(receipt.schema).toBe("tfsb.scene-compile-receipt-v1");
      expect(receipt.svgDigest).toBe("sha256:svg");
    });

    it("validates Status, Plan, Publication, and Verification responses", () => {
      const status = validateStatusResponse({
        sessionId: "sess-1",
        revision: 2,
        dirty: true,
        disposed: false,
        draftInputDigest: "sha256:stat",
        hasCompiledSvg: true,
        retainedSavePlan: false,
        retainedExportPlan: false,
        retainedPacketsCount: 1,
        diagnostics: [],
      });
      expect(status.dirty).toBe(true);
      expect(status.hasCompiledSvg).toBe(true);

      const plan = validatePlanResponse({
        cancelled: false,
        planId: "plan-1",
        targetDisplayName: "export.svg",
        byteCount: 1024,
      });
      expect(plan.planId).toBe("plan-1");

      const pub = validatePublicationResponse({
        published: true,
        targetDisplayName: "scene.json",
        sourceId: "file:///scene.json",
      });
      expect(pub.published).toBe(true);

      const ver = validateVerificationResponse({
        valid: true,
        candidatePacketId: "cand-1",
        candidateDigest: "sha256:cand",
        verificationHandle: "handle-1",
        diagnostics: [],
      });
      expect(ver.valid).toBe(true);
      expect(ver.verificationHandle).toBe("handle-1");
    });

    it("rejects unknown keys across native DTOs (closed schema enforcement)", () => {
      // Draft response with unknown key
      expect(() =>
        validateDraftResponse({
          sessionId: "sess-1",
          revision: 1,
          dirty: false,
          canonicalJson: JSON.stringify(validScene),
          draftInputDigest: "sha256:digest1",
          scene: validScene,
          diagnostics: [],
          unauthorized_extra_key: "malicious_payload",
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Status response with unknown key
      expect(() =>
        validateStatusResponse({
          sessionId: "sess-1",
          revision: 1,
          dirty: false,
          disposed: false,
          draftInputDigest: "sha256:stat",
          hasCompiledSvg: false,
          retainedSavePlan: false,
          retainedExportPlan: false,
          retainedPacketsCount: 0,
          diagnostics: [],
          extraField: true,
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Compile response with unknown key
      expect(() =>
        validateCompileResponse({
          sessionId: "sess-1",
          revision: 1,
          diagnostics: [],
          unrecognizedProperty: 42,
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Receipt with unknown key
      expect(() =>
        validateReceipt({
          schema: "tfsb.scene-compile-receipt-v1",
          diagnostics: [],
          sourceSnapshotDigest: "sha256:snap",
          sceneSchema: "tfsb.vector-scene-v1",
          sceneCompatibility: 1,
          sceneCompilerLevel: 1,
          sourceDigest: "sha256:src",
          svgDigest: "sha256:svg",
          profile: "illustration",
          artboard: { width: 800, height: 600, viewBox: [0, 0, 800, 600] },
          glyphCatalogDigest: "sha256:glyph",
          tokenDigest: "sha256:tok",
          metrics: {
            expandedElementCount: 0,
            authoredElementCount: 0,
            pathSegmentCount: 0,
            glyphCount: 0,
            maxNestingDepth: 0,
            gradientStopCount: 0,
          },
          rogueKey: "invalid",
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Artboard with unknown key
      expect(() =>
        validateArtboard({
          width: 800,
          height: 600,
          viewBox: [0, 0, 800, 600],
          unknownKey: 1,
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Scene with unknown key
      expect(() =>
        validateScene({
          ...validScene,
          forbiddenAttribute: "bad",
        }),
      ).toThrow(VectorGraphicsValidationError);
    });

    it("rejects non-finite numbers (Infinity, -Infinity, NaN) in geometric models", () => {
      // Artboard width Infinity
      expect(() =>
        validateArtboard({
          width: Infinity,
          height: 600,
          viewBox: [0, 0, 800, 600],
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Artboard height NaN
      expect(() =>
        validateArtboard({
          width: 800,
          height: NaN,
          viewBox: [0, 0, 800, 600],
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Artboard viewBox with -Infinity
      expect(() =>
        validateArtboard({
          width: 800,
          height: 600,
          viewBox: [0, 0, -Infinity, 600],
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Metrics with NaN
      expect(() =>
        validateMetrics({
          expandedElementCount: NaN,
          authoredElementCount: 0,
          pathSegmentCount: 0,
          glyphCount: 0,
          maxNestingDepth: 0,
          gradientStopCount: 0,
        }),
      ).toThrow(VectorGraphicsValidationError);

      // Scene element with Infinity
      expect(() =>
        validateScene({
          ...validScene,
          elements: [
            {
              type: "circle",
              id: "inf-circle",
              cx: Infinity,
              cy: 10,
              r: 5,
            },
          ],
        }),
      ).toThrow(VectorGraphicsValidationError);
    });
  });

  describe("MockVectorGraphicsBridge All 18 Operations", () => {
    it("executes all 18 commands end-to-end", async () => {
      const bridge = new MockVectorGraphicsBridge();

      // 1. newScene
      const newRes = await bridge.newScene({ preset: "diagram", profile: "diagram" });
      expect(newRes.scene.profile).toBe("diagram");
      expect(newRes.dirty).toBe(true);

      // 2. getStatus
      const statusRes = await bridge.getStatus();
      expect(statusRes.sessionId).toBe(newRes.sessionId);

      // 3. editScene
      const editRes = await bridge.editScene({
        expected: { sessionId: newRes.sessionId, revision: newRes.revision },
        operations: [
          {
            type: "insertElement",
            element: {
              type: "rect",
              id: "test-rect",
              x: 10,
              y: 10,
              width: 100,
              height: 50,
            },
          },
        ],
      });
      expect(editRes.revision).toBe(newRes.revision + 1);
      expect(editRes.scene.elements.some((el) => el.id === "test-rect")).toBe(true);

      // 4. compileScene
      const compileRes = await bridge.compileScene({
        expected: { sessionId: editRes.sessionId, revision: editRes.revision },
      });
      expect(compileRes.svg).toContain("<svg");
      expect(compileRes.receipt?.schema).toBe("tfsb.scene-compile-receipt-v1");

      // 5. openScene
      const openRes = await bridge.openScene();
      expect(openRes.cancelled).toBe(false);
      expect(openRes.draft?.sourceId).toBeTruthy();

      // 6. importSvg
      const importRes = await bridge.importSvg();
      expect(importRes.classification).toBe("SUPPORTED_IMPORT");

      // 7. savePlan & 8. saveApply
      const savePlanRes = await bridge.savePlan({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
      });
      expect(savePlanRes.planId).toBeTruthy();
      const saveApplyRes = await bridge.saveApply({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        planId: savePlanRes.planId!,
      });
      expect(saveApplyRes.published).toBe(true);
      expect(bridge.dirty).toBe(false);

      // 9. exportPlan & 10. exportApply
      const exportPlanRes = await bridge.exportPlan({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
      });
      expect(exportPlanRes.planId).toBeTruthy();
      const exportApplyRes = await bridge.exportApply({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        planId: exportPlanRes.planId!,
      });
      expect(exportApplyRes.published).toBe(true);

      // 11. bindTokens
      const tokenRes = await bridge.bindTokens({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        projectHandle: "default",
      });
      expect(tokenRes.scene.tokenBindings?.["color.primary"]).toBe("#ec4899");

      // 12. createBrief
      const briefRes = await bridge.createBrief({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        title: "Test Brief",
        objective: "Test Objective",
      });
      expect(briefRes.packetKind).toBe("brief");

      // 13. importPacket
      const packetImportRes = await bridge.importPacket();
      expect(packetImportRes.packetId).toBeTruthy();

      // 14. exportPacket
      const packetExportRes = await bridge.exportPacket({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        packetId: packetImportRes.packetId!,
      });
      expect(packetExportRes.published).toBe(true);

      // 15. createReview
      const reviewRes = await bridge.createReview({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        briefPacketId: briefRes.packetId!,
        candidatePacketIds: [packetImportRes.packetId!],
        overallDisposition: "approved",
        summary: "LGTM",
      });
      expect(reviewRes.packetKind).toBe("review");

      // 16. verifyCandidate
      const verifyRes = await bridge.verifyCandidate({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        candidatePacketId: packetImportRes.packetId!,
      });
      expect(verifyRes.valid).toBe(true);

      // 17. adoptCandidate
      const adoptRes = await bridge.adoptCandidate({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
        verificationHandle: verifyRes.verificationHandle,
      });
      expect(adoptRes.dirty).toBe(true);
      expect(adoptRes.sourceId).toBeUndefined(); // Clears source

      // 18. dispose
      const disposeRes = await bridge.dispose({
        expected: { sessionId: bridge.sessionId, revision: bridge.revision },
      });
      expect(disposeRes.disposed).toBe(true);
    });
  });
});
