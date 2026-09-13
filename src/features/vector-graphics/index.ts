// Public exports for TFSB63A Vector Graphics feature package
import "./styles.css";

export { VectorGraphicsLab } from "./components/VectorGraphicsLab";
export type { VectorGraphicsLabProps } from "./types";

export {
  TauriVectorGraphicsBridge,
  VectorGraphicsValidationError,
  SCENE_COMMANDS,
  validateDraftResponse,
  validateStatusResponse,
  validateDisposeResponse,
  validateSelectionResponse,
  validateImportResponse,
  validateCompileResponse,
  validatePlanResponse,
  validatePublicationResponse,
  validatePacketResponse,
  validateVerificationResponse,
  validateScene,
  validateArtboard,
  validateReceipt,
  validateMetrics,
  validateDiagnostics,
} from "./vector-graphics-bridge";

export { MockVectorGraphicsBridge, createDefaultScene, sceneToSvg } from "./mock-bridge";
export { BlobPreviewManager } from "./blob-preview";
export type { BlobPreviewUpdateResult } from "./blob-preview";
export { SerializedEditQueue } from "./edit-queue";
export type { PendingEditTask } from "./edit-queue";
export * from "./types";
export * from "./request-builders";
