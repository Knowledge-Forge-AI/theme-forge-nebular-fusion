import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { useState } from "react";
import { ThemeV2Exchange } from "../features/theme-lab/ThemeV2Exchange";
import {
  CANDIDATE_VERIFICATION_SCHEMA,
  CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE,
  REVIEW_CONTEXT_SCHEMA,
  createReviewContextV1,
  executeCandidateAdoption,
  executeCandidateVerification,
  parseCandidatePacketV2,
  validateReviewContextV1,
} from "../features/theme-lab/v2-exchange";
import {
  COMPONENT_CATALOG_DIGEST,
  COMPONENT_CATALOG_IDENTITY,
  COMPONENT_COMPILER_SEMANTIC,
  CORE_CATALOG_DIGEST,
  CORE_CATALOG_IDENTITY,
  CORE_COMPILER_SEMANTIC,
  type ThemeDescriptorCatalogV2,
  type ThemeDescriptorCoreV2,
  type ThemeSpecificationV2,
  type ThemeV2StyleFile,
} from "../features/theme-lab/v2-bridge";
import { SAMPLE_THEME_V2 } from "../features/theme-lab/v2-model";
import type {
  ThemeCandidateAdoptRequestV2,
  ThemeCandidateAdoptResponseV2,
  ThemeCandidateVerificationResultV2,
  ThemeCandidateVerifyRequestV2,
  ThemeCandidateVerifyResponseV2,
  ThemeLabBridge,
  ThemePacketExportRequest,
  ThemePacketExportResponse,
  ThemePacketImportResponse,
} from "../features/theme-lab/types";

// ---------------------------------------------------------------------------
// Cryptographically verified test fixtures
// ---------------------------------------------------------------------------

const CORE_STYLES: ThemeV2StyleFile[] = [
  { path: "styles/layers.css", css: "@layer tfsl.layers;" },
  { path: "styles/tokens.css", css: ":root { --test: 1; }" },
  { path: "styles/base.css", css: "body { margin: 0; }" },
  { path: "styles/accent.css", css: ".accent { color: red; }" },
  { path: "styles/overrides.css", css: "/* overrides */" },
];
const CORE_CONCAT_CSS = "@layer tfsl.layers;\n\n:root { --test: 1; }\n\nbody { margin: 0; }\n\n.accent { color: red; }\n\n/* overrides */\n";
const CORE_OUTPUT_DIGEST = "09f914def0912ae6870d84da1048a504f65c076203eb27cdde83e855969cd74f";
const CORE_INVENTORY_DIGEST = "b1ed171c636bfcc708ed42fd0365fa7262a170db3ae62b934eb96939539a7305";
const INPUT_DIGEST_SAMPLE = "a".repeat(64);

const CORE_DESCRIPTOR_VALID: ThemeDescriptorCoreV2 = {
  schema: "tfsl.theme-descriptor-v2",
  schemaVersion: 2,
  themeSchemaVersion: "tfsl.theme-v2",
  themeName: "loom-celestia-code",
  themeVersion: "1.0.0",
  adapter: "starlight-v0.42",
  selectedAccent: "default",
  accent: "default",
  inputDigest: INPUT_DIGEST_SAMPLE,
  outputDigest: CORE_OUTPUT_DIGEST,
  inventoryDigest: CORE_INVENTORY_DIGEST,
  catalogIdentity: CORE_CATALOG_IDENTITY,
  catalogDigest: CORE_CATALOG_DIGEST,
  catalog: {
    identity: CORE_CATALOG_IDENTITY,
    digest: CORE_CATALOG_DIGEST,
  },
  compilerSemantic: CORE_COMPILER_SEMANTIC,
  provenance: {
    categories: ["user-authored-data", "generated-syntax", "first-party-expression"],
    semantic: CORE_COMPILER_SEMANTIC,
    compiler: "@knowledge-forge-ai/theme-forge-stellar-loom",
    compilerVersion: "0.2.0",
  },
};

const CANDIDATE_CORE_DIGEST = "b".repeat(64);
const CANDIDATE_CORE_PACKET = {
  schema: "tfsl.theme-candidate",
  schemaVersion: 2,
  candidateId: "core-cand-alpha",
  candidateDigest: CANDIDATE_CORE_DIGEST,
  theme: SAMPLE_THEME_V2,
  rationale: "Core candidate for testing",
};

const CANDIDATE_CATALOG_DIGEST = "c".repeat(64);
const CANDIDATE_CATALOG_PACKET = {
  schema: "tfsl.theme-catalog-candidate",
  schemaVersion: 1,
  candidateDigest: `sha256:${CANDIDATE_CATALOG_DIGEST}`,
  theme: SAMPLE_THEME_V2,
  rationale: "Catalog candidate with sha256 prefix",
};

const GENUINE_COMPILER_CATALOG_DIGEST = "5dc1adca53d6bc6fcfc1b36cc3fb332cf5ad3e36a66e16d117f2d6deadc3c457";
const GENUINE_COMPILER_CATALOG_INPUT_DIGEST = "a5615bf109d19ad975c13414499316f8e4ddf5cec84f9c776a372334be9832fa";
const GENUINE_COMPILER_CATALOG_OUTPUT_DIGEST = "ec13a5fe9907877b3cb576c368792d96140035aa495b54ea281ac89e0d5c917a";
const GENUINE_COMPILER_CATALOG_RAW = "{\"adapter\":\"starlight-v0.42\",\"candidateDigest\":\"sha256:5dc1adca53d6bc6fcfc1b36cc3fb332cf5ad3e36a66e16d117f2d6deadc3c457\",\"catalog\":\"tfsl.starlight-component-catalog-v1\",\"catalogDigest\":\"sha256:34b1b7c6359a3eb996043d5ce688e1d3740bfeafa462a1b912a08d162638fc73\",\"code\":{\"catalog\":\"tfsl.starlight-code-catalog-v1\",\"catalogDigest\":\"sha256:a56cd99c26ce6e015854338eee63fd850121cf2c86af7cbe992cf39b4b58f34b\",\"inputDigest\":\"sha256:a0e268ba01e942639f421dd46f42a304837da3534f5639f6190accd03d357f6b\",\"semantic\":\"tfsl.theme-compiler-v2-code-1\"},\"fontInventory\":[],\"inputDigest\":\"sha256:a5615bf109d19ad975c13414499316f8e4ddf5cec84f9c776a372334be9832fa\",\"metadata\":{\"license\":\"AGPL-3.0-or-later\",\"name\":\"@fixture/adapter-theme\",\"version\":\"1.0.0\"},\"outputDigest\":\"sha256:ec13a5fe9907877b3cb576c368792d96140035aa495b54ea281ac89e0d5c917a\",\"outputInventory\":[{\"digest\":\"sha256:a81bcda7ec57a5c09f1cc6d05de420db7a0053b9496f1762065e083a60e5ede2\",\"id\":\"COMMERCIAL-LICENSE.md\"},{\"digest\":\"sha256:62eef07fc3ad238dd889ff98cf9ed87b3ef0f421579b6945f87ec37c608afb62\",\"id\":\"LICENSE\"},{\"digest\":\"sha256:e711709e69f5f8fc65c55ff3b3e47c390ed8f60890eb38cf999d95c2494b5d17\",\"id\":\"NOTICE\"},{\"digest\":\"sha256:81a07a95ed8b955cbc9f766c0a13082d1f484a5014927d293b58fb5523376479\",\"id\":\"README.md\"},{\"digest\":\"sha256:51bf5ac232ff025a2d173ec2093b1e2446c686ddb4cb57b06269d259edb6cd66\",\"id\":\"assets/loom-orbit.svg\"},{\"digest\":\"sha256:7ed14a4e9ebb5fe1b01bfd6e7c6ba5ebd79974927e239b1cb59e7dd927c6008e\",\"id\":\"catalog-data.json\"},{\"digest\":\"sha256:75a5751333b28f5e36a838230b26f5dae1ff771e4d36e31bf69e8cc26cacb821\",\"id\":\"components/Hero.astro\"},{\"digest\":\"sha256:0f00897bcc05c271c20d0077a470008f865190af260079a1cd890f2d374a0894\",\"id\":\"components/PageTitle.astro\"},{\"digest\":\"sha256:ec6728e2cb2fc222140348152b7cc6d70bb403683aa493e119118d50229e5745\",\"id\":\"components/PageTitleFrame.astro\"},{\"digest\":\"sha256:7af7f7a2ce4ad3267bba7e5ba6298b28385080bdd431f1ffd49fc3fcad323313\",\"id\":\"components/Pagination.astro\"},{\"digest\":\"sha256:0c38cae7d4d3e82935008e5e5c7f6190a6b6448d33593f3902607346d8c8429e\",\"id\":\"components/Sidebar.astro\"},{\"digest\":\"sha256:42c1f0826eb6a7b3813e990cff8ec5aad5d22c7fc73bceded069235e79aefc90\",\"id\":\"components/SidebarTree.astro\"},{\"digest\":\"sha256:409f548874fd2a900b8a617079aed19687965af168c10bfcab1f0dfdcb576e4d\",\"id\":\"index.d.ts\"},{\"digest\":\"sha256:23d4a127843384e90f29f6966c27c0b63099ea45d78431810e43899a61f4ac70\",\"id\":\"index.js\"},{\"digest\":\"sha256:9462f9be616655e1560bcafed8f6cfdbf39c0368a5e56758e7558ceb0fb4ebd9\",\"id\":\"middleware.js\"},{\"digest\":\"sha256:efb148424f8625016dcaaa5dd964ade8172f56f90e7e07fb9310d1a110a0f1d0\",\"id\":\"navigation.js\"},{\"digest\":\"sha256:68b97a8d4ed42aaaf3036d6222808ad6e65cac9fc9ed2f1f6f93e575e5bf6b08\",\"id\":\"package.json\"},{\"digest\":\"sha256:aea7c8852832e98471ec9b6cebdc4db2bc3e36fdb2ad68d9a3753a21eb2c669b\",\"id\":\"provenance.json\"},{\"digest\":\"sha256:dad366838981255782a706ed1b2693777f46c687a1e922a309244ce7225b897d\",\"id\":\"styles/accent.css\"},{\"digest\":\"sha256:0f252f1ec2fd6e297da5d3a14267f826843cec4dc194b99f6016de0e15769dce\",\"id\":\"styles/base.css\"},{\"digest\":\"sha256:260665acc2797b18443497987bd9e0508fdf28edb0fc8df6df059b3744d6b7ca\",\"id\":\"styles/code.css\"},{\"digest\":\"sha256:c4835f9a9cf5a0d9731888346913ebe2ef84447889418fddc868167c3f655b9e\",\"id\":\"styles/compat.css\"},{\"digest\":\"sha256:de5d41c727f757b231bbd7bc463e157f4f75bb04363c99faa8feeb0474a61290\",\"id\":\"styles/layers.css\"},{\"digest\":\"sha256:87a8e2ea1ac8ba344246405fa9588dccbbaf6824113bfce17f3a5ab695f195d2\",\"id\":\"styles/overrides.css\"},{\"digest\":\"sha256:5b0f058a3707033d4a339b4941382165fc00b13333c3a7c23980de50733e2ef5\",\"id\":\"styles/tokens.css\"},{\"digest\":\"sha256:c077e6a897d2bde1097559567bb02fb212c89d05d34fcf1a59d572c9157adbcb\",\"id\":\"theme.descriptor.json\"},{\"digest\":\"sha256:a5615bf109d19ad975c13414499316f8e4ddf5cec84f9c776a372334be9832fa\",\"id\":\"theme.json\"}],\"producer\":{\"executableDigest\":\"sha256:c4d576f290b4670ecbb1a12e7fe9fa54237d558121d4d5a4170342188b12ac17\",\"package\":\"@knowledge-forge-ai/theme-forge-stellar-loom\",\"packageMetadataDigest\":\"sha256:be20f862a4a6b72000ecfa3e0f89b5798c5d3ffd44feaa7231046ae653f84838\",\"version\":\"0.1.1\"},\"schema\":\"tfsl.theme-catalog-candidate\",\"schemaVersion\":1,\"selectedAccent\":\"default\",\"semanticCompiler\":\"tfsl.theme-compiler-v2-catalog-1\",\"state\":\"candidate\",\"theme\":{\"accentVariants\":{\"default\":{\"dark\":{\"accent-base\":\"accent-base-dark\",\"accent-high\":\"accent-high-dark\",\"accent-low\":\"accent-low-dark\",\"body\":\"text-body-dark\",\"border\":\"border-dark\",\"card\":\"bg-card-dark\",\"code\":\"bg-code-dark\",\"focus\":\"focus-ring-dark\",\"hairline\":\"hairline-dark\",\"header\":\"bg-nav-dark\",\"inline-code\":\"bg-inline-code-dark\",\"inverted\":\"text-invert-dark\",\"link\":\"text-link-dark\",\"muted\":\"text-muted-dark\",\"navigation\":\"bg-nav-dark\",\"page\":\"bg-page-dark\",\"panel\":\"bg-panel-dark\",\"raised\":\"bg-raised-dark\",\"secondary\":\"text-secondary-dark\",\"selection-background\":\"select-bg-dark\",\"selection-text\":\"select-text-dark\",\"sidebar\":\"bg-sidebar-dark\"},\"light\":{\"accent-base\":\"accent-base-light\",\"accent-high\":\"accent-high-light\",\"accent-low\":\"accent-low-light\",\"body\":\"text-body-light\",\"border\":\"border-light\",\"card\":\"bg-card-light\",\"code\":\"bg-code-light\",\"focus\":\"focus-ring-light\",\"hairline\":\"hairline-light\",\"header\":\"bg-nav-light\",\"inline-code\":\"bg-inline-code-light\",\"inverted\":\"text-invert-light\",\"link\":\"text-link-light\",\"muted\":\"text-muted-light\",\"navigation\":\"bg-nav-light\",\"page\":\"bg-page-light\",\"panel\":\"bg-panel-light\",\"raised\":\"bg-raised-light\",\"secondary\":\"text-secondary-light\",\"selection-background\":\"select-bg-light\",\"selection-text\":\"select-text-light\",\"sidebar\":\"bg-sidebar-light\"},\"tokenSet\":\"black-tokens\"}},\"adapter\":\"starlight-v0.42\",\"catalog\":{\"fontLicenses\":[],\"hero\":{\"routes\":[{\"actions\":[{\"href\":\"/catalog\",\"label\":\"Get Started\"}],\"announcement\":\"Announcing Stellar Loom Catalog\",\"layout\":\"centered\",\"media\":\"loom-orbit\",\"route\":\"/catalog/hero-centered\",\"subtitle\":\"Centered layout with actions\",\"summary\":\"Full overview of centered hero layout\",\"title\":\"Black Centered Hero\"},{\"actions\":[{\"href\":\"/catalog\",\"label\":\"Explore\"}],\"layout\":\"media-top\",\"media\":\"loom-orbit\",\"route\":\"/catalog/hero-media-top\",\"subtitle\":\"Media positioned at top\",\"title\":\"Black Media Top Hero\"},{\"actions\":[{\"href\":\"/catalog\",\"label\":\"Explore\"}],\"layout\":\"media-left\",\"media\":\"loom-orbit\",\"route\":\"/catalog/hero-media-left\",\"subtitle\":\"Media positioned at left\",\"title\":\"Black Media Left Hero\"},{\"actions\":[{\"href\":\"/catalog\",\"label\":\"Explore\"}],\"layout\":\"media-right\",\"media\":\"loom-orbit\",\"route\":\"/catalog/hero-media-right\",\"subtitle\":\"Media positioned at right\",\"title\":\"Black Media Right Hero\"},{\"actions\":[{\"href\":\"/catalog\",\"label\":\"View Banner\"}],\"layout\":\"banner\",\"route\":\"/catalog/hero-banner\",\"title\":\"Black Banner Hero\"},{\"actions\":[{\"href\":\"/catalog\",\"label\":\"Get Started\"}],\"announcement\":\"Announcing Stellar Loom Catalog\",\"layout\":\"centered\",\"media\":\"loom-orbit\",\"route\":\"/catalog/consumer-hero\",\"subtitle\":\"Centered layout with actions\",\"summary\":\"Full overview of centered hero layout\",\"title\":\"Catalog default must lose\"}]},\"layout\":\"standard\",\"pageTitle\":{\"copy\":\"url\"},\"pagination\":{\"variant\":\"card\"},\"sidebar\":{\"groupIds\":[\"catalog-core\",\"catalog-heroes\",\"catalog-width\"],\"mode\":\"nested\"}},\"codePresentation\":{\"copy\":\"standard\",\"frame\":\"terminal\",\"marks\":{\"deleted\":\"#ef4444\",\"inserted\":\"#22c55e\",\"marked\":\"#f97316\"},\"mode\":\"expressive-code\",\"syntaxTheme\":{\"dark\":{\"rules\":[{\"foreground\":\"#eda2cf\",\"scopes\":[\"keyword\"]},{\"foreground\":\"#8bd0e8\",\"scopes\":[\"string\"]},{\"foreground\":\"#a4b9ac\",\"scopes\":[\"comment\"]},{\"foreground\":\"#efb18a\",\"scopes\":[\"entity.name.function\"]},{\"foreground\":\"#bdb1eb\",\"scopes\":[\"variable\"]},{\"foreground\":\"#d5d28b\",\"scopes\":[\"constant\"]}]},\"light\":{\"rules\":[{\"foreground\":\"#782765\",\"scopes\":[\"keyword\"]},{\"foreground\":\"#27546a\",\"scopes\":[\"string\"]},{\"foreground\":\"#50645c\",\"scopes\":[\"comment\"]},{\"foreground\":\"#924019\",\"scopes\":[\"entity.name.function\"]},{\"foreground\":\"#473d76\",\"scopes\":[\"variable\"]},{\"foreground\":\"#5b5426\",\"scopes\":[\"constant\"]}]}},\"tabs\":\"deferred\"},\"components\":{\"pageTitle\":\"page-title-frame\"},\"defaultAccent\":\"default\",\"fonts\":[],\"layoutPreset\":\"standard\",\"name\":\"loom-black-catalog\",\"schemaVersion\":\"tfsl.theme-v2\",\"surfaces\":{\"border\":1,\"borderStyle\":\"solid\",\"content\":1152,\"focus\":2,\"focusOffset\":2,\"radii\":8,\"sidebar\":288,\"spacing\":4},\"tokenSets\":{\"black-tokens\":{\"accent-base-dark\":\"#f97316\",\"accent-base-light\":\"#ea580c\",\"accent-high-dark\":\"#fdba74\",\"accent-high-light\":\"#9a3412\",\"accent-low-dark\":\"#431407\",\"accent-low-light\":\"#ffedd5\",\"bg-card-dark\":\"#131620\",\"bg-card-light\":\"#ffffff\",\"bg-code-dark\":\"#090a0d\",\"bg-code-light\":\"#f1f5f9\",\"bg-inline-code-dark\":\"#1e2330\",\"bg-inline-code-light\":\"#e2e8f0\",\"bg-nav-dark\":\"#12141a\",\"bg-nav-light\":\"#ffffff\",\"bg-page-dark\":\"#0c0d10\",\"bg-page-light\":\"#f8fafc\",\"bg-panel-dark\":\"#1a1e29\",\"bg-panel-light\":\"#f8fafc\",\"bg-raised-dark\":\"#161922\",\"bg-raised-light\":\"#ffffff\",\"bg-sidebar-dark\":\"#0f1015\",\"bg-sidebar-light\":\"#f1f5f9\",\"border-dark\":\"#2e354a\",\"border-light\":\"#cbd5e1\",\"focus-ring-dark\":\"#3b82f6\",\"focus-ring-light\":\"#2563eb\",\"hairline-dark\":\"#232838\",\"hairline-light\":\"#e2e8f0\",\"select-bg-dark\":\"#3b82f6\",\"select-bg-light\":\"#2563eb\",\"select-text-dark\":\"#ffffff\",\"select-text-light\":\"#ffffff\",\"text-body-dark\":\"#f0f2f5\",\"text-body-light\":\"#0f172a\",\"text-invert-dark\":{\"alias\":\"bg-page-dark\"},\"text-invert-light\":{\"alias\":\"bg-nav-light\"},\"text-link-dark\":\"#60a5fa\",\"text-link-light\":\"#2563eb\",\"text-muted-dark\":\"#8a92a6\",\"text-muted-light\":\"#64748b\",\"text-secondary-dark\":\"#e1e4ea\",\"text-secondary-light\":\"#334155\"}},\"typography\":{\"body\":{\"font\":\"system-sans\",\"lineHeight\":1.6,\"size\":16},\"code\":{\"font\":\"system-mono\",\"lineHeight\":1.5,\"size\":14},\"heading\":{\"font\":\"system-sans\",\"lineHeight\":1.25,\"size\":28},\"ui\":{\"font\":\"system-sans\",\"lineHeight\":1.5,\"size\":14}},\"version\":\"1.0.0\"},\"visualEvidence\":[]}\n";
const GENUINE_COMPILER_CATALOG_PACKET = JSON.parse(GENUINE_COMPILER_CATALOG_RAW);

const GENUINE_CATALOG_DESCRIPTOR: ThemeDescriptorCatalogV2 = {
  schema: "tfsl.theme-descriptor-v2",
  schemaVersion: 2,
  themeSchemaVersion: "tfsl.theme-v2",
  themeName: "loom-black-catalog",
  themeVersion: "1.0.0",
  adapter: "starlight-v0.42",
  selectedAccent: "default",
  accent: "default",
  inputDigest: GENUINE_COMPILER_CATALOG_INPUT_DIGEST,
  outputDigest: GENUINE_COMPILER_CATALOG_OUTPUT_DIGEST,
  inventoryDigest: "0".repeat(64),
  catalogIdentity: COMPONENT_CATALOG_IDENTITY,
  catalogDigest: COMPONENT_CATALOG_DIGEST,
  catalog: {
    identity: COMPONENT_CATALOG_IDENTITY,
    digest: COMPONENT_CATALOG_DIGEST,
  },
  compilerSemantic: COMPONENT_COMPILER_SEMANTIC,
  provenance: {
    categories: ["user-authored-data", "generated-syntax", "first-party-expression"],
    semantic: COMPONENT_COMPILER_SEMANTIC,
    compiler: "@knowledge-forge-ai/theme-forge-stellar-loom",
    compilerVersion: "0.2.0",
  },
};

const CANDIDATE_V1_PACKET = {
  schema: "tfsl.theme-candidate",
  schemaVersion: 1,
  candidateId: "legacy-v1-cand",
  candidateDigest: "d".repeat(64),
  theme: SAMPLE_THEME_V2,
};

const CANDIDATE_UNKNOWN_PACKET = {
  schema: "tfsl.unknown-candidate",
  schemaVersion: 99,
  candidateId: "unknown-cand",
  candidateDigest: "e".repeat(64),
  theme: SAMPLE_THEME_V2,
};

// ---------------------------------------------------------------------------
// Mock Bridge Implementation for V2 Exchange Tests
// ---------------------------------------------------------------------------

class MockV2ExchangeBridge implements ThemeLabBridge {
  queuedImports: ThemePacketImportResponse[] = [];
  exportedPackets: ThemePacketExportRequest[] = [];

  verifyCalls: ThemeCandidateVerifyRequestV2[] = [];
  adoptCalls: ThemeCandidateAdoptRequestV2[] = [];

  verifyCandidateV2Impl?: (req: ThemeCandidateVerifyRequestV2) => Promise<ThemeCandidateVerifyResponseV2>;
  adoptCandidateV2Impl?: (req: ThemeCandidateAdoptRequestV2) => Promise<ThemeCandidateAdoptResponseV2>;
  exportPacketImpl?: (req: ThemePacketExportRequest) => Promise<ThemePacketExportResponse>;

  queueImportPacket(packet: Record<string, unknown>, canonicalJson?: string): void {
    this.queuedImports.push({
      cancelled: false,
      packet,
      canonicalJson: canonicalJson ?? JSON.stringify(packet),
      displayName: "candidate.json",
      kind: "candidate",
    });
  }

  async getStatus() {
    return { available: true, compilerVersion: "0.2.0" };
  }
  async compile() {
    return { uiRevision: 1, valid: true, diagnostics: [] };
  }
  async loadExample() {
    return { uiRevision: 1, valid: true, exampleName: "test", diagnostics: [] };
  }
  async openTheme() {
    return { cancelled: true, diagnostics: [] };
  }
  async saveTheme() {
    return { cancelled: true };
  }

  async importPacket(): Promise<ThemePacketImportResponse> {
    if (this.queuedImports.length > 0) {
      return this.queuedImports.shift()!;
    }
    return { cancelled: true };
  }

  async exportPacket(req: ThemePacketExportRequest): Promise<ThemePacketExportResponse> {
    this.exportedPackets.push(req);
    if (this.exportPacketImpl) {
      return this.exportPacketImpl(req);
    }
    return { cancelled: false, saved: true, displayName: req.defaultName ?? "exported.json" };
  }

  async verifyCandidateV2(req: ThemeCandidateVerifyRequestV2): Promise<ThemeCandidateVerifyResponseV2> {
    this.verifyCalls.push(req);
    if (this.verifyCandidateV2Impl) {
      return this.verifyCandidateV2Impl(req);
    }
    let reqCandidateDigest = CANDIDATE_CORE_DIGEST;
    let reqCandidateId = "core-cand-alpha";
    try {
      const parsed = JSON.parse(req.candidate);
      if (typeof parsed.candidateDigest === "string") {
        reqCandidateDigest = parsed.candidateDigest.replace(/^sha256:/, "").toLowerCase();
      }
      if (typeof parsed.candidateId === "string") {
        reqCandidateId = parsed.candidateId;
      } else {
        reqCandidateId = reqCandidateDigest;
      }
    } catch { throw new Error("Test bridge requires valid packet JSON"); }

    return {
      valid: true,
      compiledCss: CORE_CONCAT_CSS,
      descriptor: CORE_DESCRIPTOR_VALID,
      styles: CORE_STYLES,
      diagnostics: [],
      candidateVerification: {
        schema: "tfsb.theme-candidate-verification-v2",
        schemaVersion: 2,
        valid: true,
        candidateId: reqCandidateId,
        candidateDigest: reqCandidateDigest,
        inputDigest: INPUT_DIGEST_SAMPLE,
        outputDigest: CORE_OUTPUT_DIGEST,
        descriptor: CORE_DESCRIPTOR_VALID,
        styles: CORE_STYLES,
        compiledCss: CORE_CONCAT_CSS,
        diagnostics: [],
        errors: [],
        warnings: [],
      },
    };
  }

  async adoptCandidateV2(req: ThemeCandidateAdoptRequestV2): Promise<ThemeCandidateAdoptResponseV2> {
    this.adoptCalls.push(req);
    if (this.adoptCandidateV2Impl) {
      return this.adoptCandidateV2Impl(req);
    }
    return {
      adopted: true,
      specification: SAMPLE_THEME_V2,
      specificationV2: SAMPLE_THEME_V2,
      descriptor: CORE_DESCRIPTOR_VALID,
      styles: CORE_STYLES,
      compiledCss: CORE_CONCAT_CSS,
      diagnostics: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Harness Component
// ---------------------------------------------------------------------------

function TestHarness(props: {
  bridge: ThemeLabBridge;
  initialRevision?: number;
  initialDirty?: boolean;
  onAdoptSpy?: (spec: ThemeSpecificationV2, compiled?: ThemeCandidateVerificationResultV2) => void;
}) {
  const [revision, setRevision] = useState(props.initialRevision ?? 1);
  const [dirty, setDirty] = useState(props.initialDirty ?? false);

  return (
    <div>
      <div data-testid="harness-controls">
        <button type="button" onClick={() => setRevision((r) => r + 1)} data-testid="harness-bump-revision">
          Bump Revision ({revision})
        </button>
        <button type="button" onClick={() => setDirty((d) => !d)} data-testid="harness-toggle-dirty">
          Toggle Dirty ({dirty ? "dirty" : "clean"})
        </button>
      </div>
      <ThemeV2Exchange
        bridge={props.bridge}
        sessionId="sess-test-v2"
        draftRevision={revision}
        draftDirty={dirty}
        onAdopt={(spec, compiled) => {
          props.onAdoptSpy?.(spec, compiled);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("ThemeV2Exchange Component Integration", () => {
  let bridge: MockV2ExchangeBridge;
  let adoptSpy: ReturnType<typeof vi.fn<(spec: ThemeSpecificationV2, compiled?: ThemeCandidateVerificationResultV2) => void>>;

  beforeEach(() => {
    bridge = new MockV2ExchangeBridge();
    adoptSpy = vi.fn();
  });

  describe("Initial Render and Visual Digest Inspector", () => {
    it("renders controlled brief textareas, review controls, badge, and empty candidate notice", () => {
      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      expect(screen.getByTestId("protocol-badge").textContent).toContain("tfsb.theme-review-context-v1 / v2");
      expect((screen.getByTestId("brief-title-input") as HTMLInputElement).value).toBe("Theme Enhancement Brief");
      expect((screen.getByTestId("brief-goal-textarea") as HTMLTextAreaElement).value).toContain("Refine theme aesthetics");
      expect((screen.getByTestId("review-disposition-select") as HTMLSelectElement).value).toBe("approve");
      expect((screen.getByTestId("review-summary-textarea") as HTMLTextAreaElement).value).toContain("Candidate reviewed");

      // Buttons initial states
      expect((screen.getByTestId("import-candidate-btn") as HTMLButtonElement).disabled).toBe(false);
      expect((screen.getByTestId("verify-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);

      // Inspector empty notice
      expect(screen.getByTestId("no-candidate-notice").textContent).toContain("No design candidate imported yet");
    });
  });

  describe("Candidate Import & Family Verification (No Auto-Adoption)", () => {
    it("imports valid v2 core/code candidate without auto adoption and preserves canonical bytes", async () => {
      const canonical = JSON.stringify(CANDIDATE_CORE_PACKET);
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET, canonical);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("inspector-candidate-id").textContent).toBe("core-cand-alpha");
      });

      expect(screen.getByTestId("inspector-family").textContent).toContain("core-code (tfsl.theme-candidate v2)");
      expect(screen.getByTestId("inspector-candidate-digest").textContent).toBe(CANDIDATE_CORE_DIGEST);
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");

      // Critical check: NO AUTO ADOPTION occurred
      expect(adoptSpy).not.toHaveBeenCalled();
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("verify-candidate-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    it("imports valid v2 catalog candidate with sha256 prefix normalized and bare-hex candidateId", async () => {
      bridge.queueImportPacket(CANDIDATE_CATALOG_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("inspector-candidate-id").textContent).toBe(CANDIDATE_CATALOG_DIGEST);
      });

      expect(screen.getByTestId("inspector-candidate-id").textContent).not.toContain(":");
      expect(screen.getByTestId("inspector-family").textContent).toContain("catalog (tfsl.theme-catalog-candidate v1)");
      // Digest is normalized to unprefixed 64 hex
      expect(screen.getByTestId("inspector-candidate-digest").textContent).toBe(CANDIDATE_CATALOG_DIGEST);
      expect(adoptSpy).not.toHaveBeenCalled();
    });

    it("fails closed and rejects legacy v1 candidates (never convert v1)", async () => {
      bridge.queueImportPacket(CANDIDATE_V1_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("exchange-error").textContent).toContain(
          "Legacy v1 candidates (tfsl.theme-candidate v1) cannot be converted to v2"
        );
      });

      expect(screen.getByTestId("no-candidate-notice")).toBeTruthy();
      expect(adoptSpy).not.toHaveBeenCalled();
    });

    it("fails closed and rejects unknown or mixed candidate schemas", async () => {
      bridge.queueImportPacket(CANDIDATE_UNKNOWN_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("exchange-error").textContent).toContain(
          "Unsupported candidate packet schema 'tfsl.unknown-candidate'"
        );
      });

      expect(screen.getByTestId("no-candidate-notice")).toBeTruthy();
      expect(adoptSpy).not.toHaveBeenCalled();
    });
  });

  describe("Candidate Verification Workflow", () => {
    it("successfully verifies candidate and populates digest identity inspector", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(
        <ThemeV2Exchange
          bridge={bridge}
          sessionId="sess-test-v2"
          draftRevision={1}
          onAdopt={adoptSpy}
        />
      );

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)");
      });

      // Verify native call parameters
      expect(bridge.verifyCalls).toHaveLength(1);
      const call = bridge.verifyCalls[0]!;
      expect(call.uiRevision).toBe(1);
      expect(call.sessionId).toBe("sess-test-v2");

      // Verify brief context passed to native matches exact tfsb.theme-review-context-v1
      const contextObj = JSON.parse(call.brief!);
      expect(contextObj.schema).toBe(REVIEW_CONTEXT_SCHEMA);
      expect(contextObj.schemaVersion).toBe(1);
      expect(contextObj.candidateDigest).toBe(CANDIDATE_CORE_DIGEST);
      expect(contextObj.disposition).toBe("approve");

      // Inspector displays verified digests
      expect(screen.getByTestId("inspector-input-digest").textContent).toBe(INPUT_DIGEST_SAMPLE);
      expect(screen.getByTestId("inspector-output-digest").textContent).toBe(CORE_OUTPUT_DIGEST);
      expect(screen.getByTestId("inspector-inventory-digest").textContent).toBe(CORE_INVENTORY_DIGEST);
      expect(screen.getByTestId("inspector-catalog-identity").textContent).toBe(CORE_CATALOG_IDENTITY);
      expect(screen.getByTestId("inspector-compiler-semantic").textContent).toBe(CORE_COMPILER_SEMANTIC);

      // Adopt button is now enabled
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    it("displays error and remains unadoptable when native verification fails", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);
      bridge.verifyCandidateV2Impl = async () => ({
        valid: false,
        diagnostics: [],
        error: { code: "FAIL", message: "Color contrast violation on role 'page'" },
        candidateVerification: {
          schema: "tfsb.theme-candidate-verification-v2",
          schemaVersion: 2,
          valid: false,
          candidateId: "core-cand-alpha",
          candidateDigest: CANDIDATE_CORE_DIGEST,
          inputDigest: "",
          outputDigest: "",
          diagnostics: [],
          errors: ["Color contrast violation on role 'page'"],
          warnings: [],
        },
      });

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("inspector-status").textContent).toBe("Verification Failed");
        expect(screen.getByTestId("exchange-error").textContent).toContain("Color contrast violation");
      });

      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
    });

    it("fails closed if native verify returns mismatched candidateDigest", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);
      bridge.verifyCandidateV2Impl = async () => ({
        valid: true,
        compiledCss: CORE_CONCAT_CSS,
        descriptor: CORE_DESCRIPTOR_VALID,
        styles: CORE_STYLES,
        diagnostics: [],
        candidateVerification: {
          schema: "tfsb.theme-candidate-verification-v2",
          schemaVersion: 2,
          valid: true,
          candidateId: "core-cand-alpha",
          candidateDigest: "f".repeat(64), // Mismatched digest
          inputDigest: INPUT_DIGEST_SAMPLE,
          outputDigest: CORE_OUTPUT_DIGEST,
          descriptor: CORE_DESCRIPTOR_VALID,
          styles: CORE_STYLES,
          compiledCss: CORE_CONCAT_CSS,
          diagnostics: [],
          errors: [],
          warnings: [],
        },
      });

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("exchange-error").textContent).toContain("does not match candidate");
      });

      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("Stale Verify Invalidation (Draft, Context, and Candidate Mutations)", () => {
    it("revokes verification when parent draft revision changes", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(<TestHarness bridge={bridge} initialRevision={1} onAdoptSpy={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(false);

      // Parent draft mutation occurs
      fireEvent.click(screen.getByTestId("harness-bump-revision"));

      // Verification must be IMMEDIATELY revoked
      await waitFor(() => {
        expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      });
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
    });

    it("revokes verification when user edits brief title or goal", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Edit brief title
      fireEvent.change(screen.getByTestId("brief-title-input"), { target: { value: "Updated Title" } });
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);

      // Re-verify
      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Edit brief goal
      fireEvent.change(screen.getByTestId("brief-goal-textarea"), { target: { value: "Updated Goal" } });
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
    });

    it("revokes verification when user edits review disposition or summary", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Change disposition
      fireEvent.change(screen.getByTestId("review-disposition-select"), { target: { value: "revise" } });
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);

      // Re-verify
      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Edit summary
      fireEvent.change(screen.getByTestId("review-summary-textarea"), { target: { value: "Updated Summary" } });
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
    });

    it("revokes verification when a new candidate is imported", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);
      bridge.queueImportPacket(CANDIDATE_CATALOG_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      // Import Candidate A & verify
      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id").textContent).toBe("core-cand-alpha"));

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Import Candidate B
      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id").textContent).toBe(CANDIDATE_CATALOG_DIGEST));

      // Verification must be revoked
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
    });

    it("drops stale asynchronous verify results when draft revision advances mid-flight", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      let resolveVerify: (val: any) => void;
      bridge.verifyCandidateV2Impl = () =>
        new Promise((resolve) => {
          resolveVerify = resolve;
        });

      render(<TestHarness bridge={bridge} initialRevision={1} onAdoptSpy={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      // Start verify in flight
      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      expect(screen.getByTestId("verify-candidate-btn").textContent).toContain("Verifying");

      // While in flight, revision advances
      fireEvent.click(screen.getByTestId("harness-bump-revision"));

      // Now resolve the promise
      resolveVerify!({
        valid: true,
        compiledCss: CORE_CONCAT_CSS,
        descriptor: CORE_DESCRIPTOR_VALID,
        styles: CORE_STYLES,
        diagnostics: [],
        candidateVerification: {
          schema: "tfsb.theme-candidate-verification-v2",
          schemaVersion: 2,
          valid: true,
          candidateId: "core-cand-alpha",
          candidateDigest: CANDIDATE_CORE_DIGEST,
          inputDigest: INPUT_DIGEST_SAMPLE,
          outputDigest: CORE_OUTPUT_DIGEST,
          descriptor: CORE_DESCRIPTOR_VALID,
          styles: CORE_STYLES,
          compiledCss: CORE_CONCAT_CSS,
          diagnostics: [],
          errors: [],
          warnings: [],
        },
      });

      // Verification should remain unverified
      await waitFor(() => {
        expect(screen.getByTestId("verify-candidate-btn").textContent).toBe("Verify Candidate");
      });
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("Adoption, Dirty Confirmation, Replay & Consume-Once", () => {
    it("adopts clean draft immediately without dialog, calling onAdopt and consuming candidate", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} draftDirty={false} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Click Adopt
      fireEvent.click(screen.getByTestId("adopt-candidate-btn"));

      await waitFor(() => {
        expect(adoptSpy).toHaveBeenCalledTimes(1);
      });

      expect(adoptSpy).toHaveBeenCalledWith(
        SAMPLE_THEME_V2,
        expect.objectContaining({
          schema: CANDIDATE_VERIFICATION_SCHEMA,
          candidateId: "core-cand-alpha",
        })
      );

      // CONSUME ONCE: candidate and verification are cleared from component
      expect(screen.getByTestId("no-candidate-notice")).toBeTruthy();
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByTestId("verify-candidate-btn") as HTMLButtonElement).disabled).toBe(true);

      // Replay is impossible because candidate is consumed
      expect(screen.queryByTestId("inspector-candidate-id")).toBeNull();
    });

    it("triggers dirty confirmation dialog when draftDirty is true and respects cancel", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} draftDirty={true} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Click Adopt with dirty draft
      fireEvent.click(screen.getByTestId("adopt-candidate-btn"));

      // Modal dialog must appear
      expect(await screen.findByTestId("dirty-adopt-dialog")).toBeTruthy();
      expect(screen.getByText("Discard Unsaved Changes?")).toBeTruthy();

      // Click Cancel
      fireEvent.click(screen.getByTestId("dirty-cancel-btn"));

      await waitFor(() => {
        expect(screen.queryByTestId("dirty-adopt-dialog")).toBeNull();
      });

      // Nothing adopted, candidate remains verified
      expect(adoptSpy).not.toHaveBeenCalled();
      expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)");
      expect((screen.getByTestId("adopt-candidate-btn") as HTMLButtonElement).disabled).toBe(false);
    });

    it("adopts candidate upon confirming dirty dialog", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} draftDirty={true} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)"));

      // Click Adopt
      fireEvent.click(screen.getByTestId("adopt-candidate-btn"));
      expect(await screen.findByTestId("dirty-adopt-dialog")).toBeTruthy();

      // Click Discard & Adopt
      fireEvent.click(screen.getByTestId("dirty-confirm-btn"));

      await waitFor(() => {
        expect(screen.queryByTestId("dirty-adopt-dialog")).toBeNull();
        expect(adoptSpy).toHaveBeenCalledTimes(1);
      });

      expect(bridge.adoptCalls[0]?.force).toBe(true);
      expect(screen.getByTestId("no-candidate-notice")).toBeTruthy();
    });
  });

  describe("Local Review Context Export", () => {
    it("exports exact tfsb.theme-review-context-v1 JSON via bridge.exportPacket", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("export-context-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("export-notice").textContent).toContain("Exported review context");
      });

      expect(bridge.exportedPackets).toHaveLength(1);
      const exported = JSON.parse(bridge.exportedPackets[0]!.packetJson);
      expect(exported.schema).toBe(REVIEW_CONTEXT_SCHEMA);
      expect(exported.schemaVersion).toBe(1);
      expect(exported.candidateDigest).toBe(CANDIDATE_CORE_DIGEST);
      expect(exported.disposition).toBe("approve");
      expect(exported.brief.title).toBe("Theme Enhancement Brief");
    });

    it("exports review context with filename-safe bare-hex candidate id avoiding colon for catalog candidates", async () => {
      bridge.queueImportPacket(CANDIDATE_CATALOG_PACKET);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id").textContent).toBe(CANDIDATE_CATALOG_DIGEST));

      fireEvent.click(screen.getByTestId("export-context-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("export-notice").textContent).toContain("Exported review context");
      });

      expect(bridge.exportedPackets).toHaveLength(1);
      const exportCall = bridge.exportedPackets[0]!;
      expect(exportCall.defaultName).toBe(`review-context-${CANDIDATE_CATALOG_DIGEST}.json`);
      expect(exportCall.defaultName).not.toContain(":");
      const exported = JSON.parse(exportCall.packetJson);
      expect(exported.schema).toBe(REVIEW_CONTEXT_SCHEMA);
      expect(exported.candidateDigest).toBe(CANDIDATE_CATALOG_DIGEST);
    });

    it("labels context as local when export is unsupported or fails", async () => {
      bridge.queueImportPacket(CANDIDATE_CORE_PACKET);
      bridge.exportPacketImpl = async () => {
        throw new Error("Local only");
      };

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id")).toBeTruthy());

      fireEvent.click(screen.getByTestId("export-context-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("export-notice").textContent).toContain(
          "Local review context cannot be exported to portable packets: local Nebular context only"
        );
      });
    });
  });

  describe("Unit validation of local review context and candidate parser", () => {
    it("creates and validates exact local review context shape", () => {
      const ctx = createReviewContextV1({
        title: "Starlight Theme Refresh",
        goal: "Improve dark mode contrast",
        candidateDigest: `sha256:${CANDIDATE_CORE_DIGEST}`,
        disposition: "approve",
        summary: "WCAG AAA compliant colors",
      });

      expect(ctx.schema).toBe(REVIEW_CONTEXT_SCHEMA);
      expect(ctx.schemaVersion).toBe(1);
      expect(ctx.candidateDigest).toBe(CANDIDATE_CORE_DIGEST);
      expect(validateReviewContextV1(ctx)).toEqual(ctx);
    });

    it("rejects review context with oversized title or goal", () => {
      expect(() =>
        createReviewContextV1({
          title: "x".repeat(161),
          goal: "goal",
          candidateDigest: CANDIDATE_CORE_DIGEST,
          disposition: "approve",
          summary: "summary",
        })
      ).toThrow(/exceeds maximum allowed of 160/);

      expect(() =>
        createReviewContextV1({
          title: "title",
          goal: "x".repeat(4097),
          candidateDigest: CANDIDATE_CORE_DIGEST,
          disposition: "approve",
          summary: "summary",
        })
      ).toThrow(/exceeds maximum allowed of 4096/);
    });

    it("parses valid candidate packet and discriminates family", () => {
      const core = parseCandidatePacketV2(CANDIDATE_CORE_PACKET);
      expect(core.family).toBe("core-code");
      expect(core.candidateId).toBe("core-cand-alpha");

      const catalog = parseCandidatePacketV2(CANDIDATE_CATALOG_PACKET);
      expect(catalog.family).toBe("catalog");
      expect(catalog.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
      expect(catalog.candidateId).not.toContain(":");
    });

    it("parses catalog candidate with explicit candidateId or sha256 prefix safely", () => {
      const explicit = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "catalog-cand-beta",
      });
      expect(explicit.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
      expect(explicit.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);

      const withSha256 = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: `sha256:${CANDIDATE_CATALOG_DIGEST}`,
      });
      expect(withSha256.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
      expect(withSha256.candidateId).not.toContain(":");
      expect(withSha256.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);

      const withColon = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "custom:colon:id",
      });
      expect(withColon.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
      expect(withColon.candidateId).not.toContain(":");
      expect(withColon.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
    });
  });
  describe("Genuine Compiler-Generated Catalog Packet Regression (TFSB64 Defect Repair)", () => {
    it("parses genuine compiler-generated catalog packet without candidateId and assigns filename-safe bare-hex display identity while preserving closed packet bytes", () => {
      const parsed = parseCandidatePacketV2(GENUINE_COMPILER_CATALOG_RAW);

      expect(parsed.family).toBe("catalog");
      expect(parsed.schema).toBe("tfsl.theme-catalog-candidate");
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.candidateId).toBe(GENUINE_COMPILER_CATALOG_DIGEST);
      expect(parsed.candidateId).not.toContain(":");
      expect(parsed.candidateDigest).toBe(GENUINE_COMPILER_CATALOG_DIGEST);

      // Strict preservation of original closed packet bytes
      expect(parsed.canonicalJson).toBe(GENUINE_COMPILER_CATALOG_RAW);
      const decoded = JSON.parse(parsed.canonicalJson);
      expect("candidateId" in decoded).toBe(false);
      expect(decoded.schema).toBe("tfsl.theme-catalog-candidate");
      expect(decoded.schemaVersion).toBe(1);
      expect(decoded.theme.name).toBe("loom-black-catalog");
    });

    it("imports genuine compiler catalog packet in component and exports colon-free review-context filename", async () => {
      bridge.queueImportPacket(GENUINE_COMPILER_CATALOG_PACKET, GENUINE_COMPILER_CATALOG_RAW);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("inspector-candidate-id").textContent).toBe(GENUINE_COMPILER_CATALOG_DIGEST);
      });

      expect(screen.getByTestId("inspector-candidate-id").textContent).not.toContain(":");
      expect(screen.getByTestId("inspector-family").textContent).toContain("catalog (tfsl.theme-catalog-candidate v1)");
      expect(screen.getByTestId("inspector-candidate-digest").textContent).toBe(GENUINE_COMPILER_CATALOG_DIGEST);
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");

      // No auto-adoption
      expect(adoptSpy).not.toHaveBeenCalled();

      // Export review context with genuine catalog candidate
      fireEvent.click(screen.getByTestId("export-context-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("export-notice").textContent).toContain("Exported review context");
      });

      expect(bridge.exportedPackets).toHaveLength(1);
      const exportedCall = bridge.exportedPackets[0]!;
      expect(exportedCall.defaultName).toBe(`review-context-${GENUINE_COMPILER_CATALOG_DIGEST}.json`);
      expect(exportedCall.defaultName).not.toContain(":");

      const exportedContext = JSON.parse(exportedCall.packetJson);
      expect(exportedContext.schema).toBe(REVIEW_CONTEXT_SCHEMA);
      expect(exportedContext.schemaVersion).toBe(1);
      expect(exportedContext.candidateDigest).toBe(GENUINE_COMPILER_CATALOG_DIGEST);
    });

    it("verifies and adopts genuine catalog candidate while preserving the adapter identity", async () => {
      bridge.queueImportPacket(GENUINE_COMPILER_CATALOG_PACKET, GENUINE_COMPILER_CATALOG_RAW);

      // Adapter returns candidateVerification where candidateId is packet.candidateId ?? packet.candidateDigest ("sha256:5dc...")
      bridge.verifyCandidateV2Impl = async () => {
        return {
          valid: true,
          compiledCss: "/* compiled */",
          descriptor: GENUINE_CATALOG_DESCRIPTOR,
          styles: [{ path: "styles/accent.css", css: "/* genuine */" }],
          diagnostics: [],
          candidateVerification: {
            schema: "tfsb.theme-candidate-verification-v2",
            schemaVersion: 2,
            valid: true,
            candidateId: `sha256:${GENUINE_COMPILER_CATALOG_DIGEST}`, // Adapter uses packet.candidateId ?? packet.candidateDigest
            candidateDigest: GENUINE_COMPILER_CATALOG_DIGEST, // The bridge validates and normalizes the digest.
            inputDigest: GENUINE_COMPILER_CATALOG_INPUT_DIGEST,
            outputDigest: GENUINE_COMPILER_CATALOG_OUTPUT_DIGEST,
            descriptor: GENUINE_CATALOG_DESCRIPTOR,
            styles: [{ path: "styles/accent.css", css: "/* genuine */" }],
            compiledCss: "/* compiled */",
            diagnostics: [],
            errors: [],
            warnings: [],
          },
        };
      };

      bridge.adoptCandidateV2Impl = async () => {
        return {
          adopted: true,
          specification: GENUINE_COMPILER_CATALOG_PACKET.theme,
          descriptor: GENUINE_CATALOG_DESCRIPTOR,
          styles: [{ path: "styles/accent.css", css: "/* genuine */" }],
          compiledCss: "/* compiled */",
          diagnostics: [],
        };
      };

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => expect(screen.getByTestId("inspector-candidate-id").textContent).toBe(GENUINE_COMPILER_CATALOG_DIGEST));

      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)");
      });

      // Verification passed raw closed packet bytes without modification
      expect(bridge.verifyCalls[0]!.candidate).toBe(GENUINE_COMPILER_CATALOG_RAW);

      // Adopt candidate
      fireEvent.click(screen.getByTestId("adopt-candidate-btn"));
      await waitFor(() => {
        expect(adoptSpy).toHaveBeenCalledTimes(1);
      });

      expect(adoptSpy).toHaveBeenCalledWith(
        GENUINE_COMPILER_CATALOG_PACKET.theme,
        expect.objectContaining({
          schema: CANDIDATE_VERIFICATION_SCHEMA,
          candidateId: `sha256:${GENUINE_COMPILER_CATALOG_DIGEST}`, // Adapter identity is preserved.
          candidateDigest: GENUINE_COMPILER_CATALOG_DIGEST,
        })
      );

      // Consume-once: candidate cleared after adoption
      expect(screen.getByTestId("no-candidate-notice")).toBeTruthy();
    });

    it("retains failure closed on verification candidateDigest mismatch", async () => {
      const parsed = parseCandidatePacketV2(GENUINE_COMPILER_CATALOG_RAW);
      const context = createReviewContextV1({
        title: "Test Review",
        goal: "Test Verification",
        candidateDigest: GENUINE_COMPILER_CATALOG_DIGEST,
        disposition: "approve",
        summary: "Ready",
      });

      bridge.verifyCandidateV2Impl = async () => ({
        valid: true,
        candidateVerification: {
          schema: "tfsb.theme-candidate-verification-v2",
          schemaVersion: 2,
          valid: true,
          candidateId: GENUINE_COMPILER_CATALOG_DIGEST,
          candidateDigest: "0".repeat(64), // Mismatched digest
          inputDigest: GENUINE_COMPILER_CATALOG_INPUT_DIGEST,
          outputDigest: GENUINE_COMPILER_CATALOG_OUTPUT_DIGEST,
          descriptor: GENUINE_CATALOG_DESCRIPTOR,
          styles: [{ path: "styles/accent.css", css: "/* genuine */" }],
          compiledCss: "/* compiled */",
          diagnostics: [],
          errors: [],
          warnings: [],
        },
      });

      await expect(
        executeCandidateVerification(bridge, {
          rawCandidateBytes: GENUINE_COMPILER_CATALOG_RAW,
          candidate: parsed,
          context,
          draftRevision: 1,
        })
      ).rejects.toThrow(/does not match candidate/);
    });

    it("retains adoption rejection for stale revision, unverified candidate, and digest mismatch", async () => {
      const parsed = parseCandidatePacketV2(GENUINE_COMPILER_CATALOG_RAW);
      const context = createReviewContextV1({
        title: "Test Review",
        goal: "Test Adoption Rejection",
        candidateDigest: GENUINE_COMPILER_CATALOG_DIGEST,
        disposition: "approve",
        summary: "Ready",
      });

      const validVerification: ThemeCandidateVerificationResultV2 = {
        schema: CANDIDATE_VERIFICATION_SCHEMA,
        schemaVersion: 2,
        valid: true,
        candidateId: GENUINE_COMPILER_CATALOG_DIGEST,
        candidateDigest: GENUINE_COMPILER_CATALOG_DIGEST,
        inputDigest: GENUINE_COMPILER_CATALOG_INPUT_DIGEST,
        outputDigest: GENUINE_COMPILER_CATALOG_OUTPUT_DIGEST,
        descriptor: GENUINE_CATALOG_DESCRIPTOR,
        styles: [{ path: "styles/accent.css", css: "/* genuine */" }],
        compiledCss: "/* compiled */",
        diagnostics: [],
        errors: [],
        warnings: [],
      };

      // 1. Stale revision rejection
      await expect(
        executeCandidateAdoption(bridge, {
          rawCandidateBytes: GENUINE_COMPILER_CATALOG_RAW,
          candidate: parsed,
          context,
          verifiedResult: validVerification,
          draftRevision: 5,
          adoptionRevision: 5,
        })
      ).rejects.toThrow("Adoption must advance the draft revision");

      await expect(
        executeCandidateAdoption(bridge, {
          rawCandidateBytes: GENUINE_COMPILER_CATALOG_RAW,
          candidate: parsed,
          context,
          verifiedResult: validVerification,
          draftRevision: 5,
          adoptionRevision: 4,
        })
      ).rejects.toThrow("Adoption must advance the draft revision");

      // 2. Unverified candidate rejection
      const unverifiedResult: ThemeCandidateVerificationResultV2 = {
        ...validVerification,
        valid: false,
      };
      await expect(
        executeCandidateAdoption(bridge, {
          rawCandidateBytes: GENUINE_COMPILER_CATALOG_RAW,
          candidate: parsed,
          context,
          verifiedResult: unverifiedResult,
          draftRevision: 1,
          adoptionRevision: 2,
        })
      ).rejects.toThrow("Cannot adopt unverified or invalid candidate");

      // 3. Digest mismatch rejection between verifiedResult and candidate
      const mismatchedVerification: ThemeCandidateVerificationResultV2 = {
        ...validVerification,
        candidateDigest: "f".repeat(64),
      };
      await expect(
        executeCandidateAdoption(bridge, {
          rawCandidateBytes: GENUINE_COMPILER_CATALOG_RAW,
          candidate: parsed,
          context,
          verifiedResult: mismatchedVerification,
          draftRevision: 1,
          adoptionRevision: 2,
        })
      ).rejects.toThrow("Verified result candidateDigest does not match active candidate");

      // 4. Digest mismatch rejection between context and candidate
      const mismatchedContext = createReviewContextV1({
        title: "Test Review",
        goal: "Test Adoption Rejection",
        candidateDigest: "1".repeat(64),
        disposition: "approve",
        summary: "Ready",
      });
      await expect(
        executeCandidateAdoption(bridge, {
          rawCandidateBytes: GENUINE_COMPILER_CATALOG_RAW,
          candidate: parsed,
          context: mismatchedContext,
          verifiedResult: validVerification,
          draftRevision: 1,
          adoptionRevision: 2,
        })
      ).rejects.toThrow("Context candidateDigest does not match active candidate");
    });
  });

  describe("TFSB64-R1 Candidate-ID Normalization Diagnostic", () => {
    it("emits no override notice when catalog candidateId is absent", () => {
      const parsed = parseCandidatePacketV2(CANDIDATE_CATALOG_PACKET);
      expect(parsed.overrideNotice).toBeUndefined();
      expect(parsed.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
    });

    it("emits no override notice when catalog candidateId is already canonical bare hex", () => {
      const parsed = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: CANDIDATE_CATALOG_DIGEST,
      });
      expect(parsed.overrideNotice).toBeUndefined();
      expect(parsed.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
    });

    it("emits bounded fixed notice for noncanonical simple or punctuation candidateId without echoing supplied ID", () => {
      const simple = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "catalog-cand-beta",
      });
      expect(simple.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
      expect(simple.overrideNotice).not.toContain("catalog-cand-beta");
      expect(simple.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);

      const punctuation = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "custom:colon:punct!id",
      });
      expect(punctuation.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
      expect(punctuation.overrideNotice).not.toContain("custom:colon:punct!id");
      expect(punctuation.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);

      const prefixed = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: `sha256:${CANDIDATE_CATALOG_DIGEST}`,
      });
      expect(prefixed.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
      expect(prefixed.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
    });

    it("displays notice in existing import status and inspector independent of verification", async () => {
      const packet = {
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "unverified-candidate-simple-id",
      };
      bridge.queueImportPacket(packet);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      fireEvent.click(screen.getByTestId("import-candidate-btn"));

      await waitFor(() => {
        expect(screen.getByTestId("inspector-candidate-id").textContent).toBe(CANDIDATE_CATALOG_DIGEST);
      });

      // Existing import status includes fixed notice without arbitrary supplied ID
      expect(screen.getByTestId("exchange-success").textContent).toContain(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
      expect(screen.getByTestId("exchange-success").textContent).not.toContain("unverified-candidate-simple-id");

      // Inspector displays notice
      expect(screen.getByTestId("inspector-candidate-id-notice").textContent).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);

      // Independent of verification: status is Unverified and no verification diagnostics exist
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect(screen.queryByTestId("inspector-input-digest")).toBeNull();
    });

    it("preserves unchanged packet identity and raw canonical bytes when notice is generated", () => {
      const rawPacket = {
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "preserve-raw-test-id",
      };
      const rawJson = JSON.stringify(rawPacket);
      const parsed = parseCandidatePacketV2(rawJson);

      expect(parsed.candidateId).toBe(CANDIDATE_CATALOG_DIGEST);
      expect(parsed.candidateDigest).toBe(CANDIDATE_CATALOG_DIGEST);
      expect(parsed.canonicalJson).toBe(rawJson);
      expect(parsed.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);

      // Raw JSON still has original supplied candidateId intact
      const roundtripped = JSON.parse(parsed.canonicalJson);
      expect(roundtripped.candidateId).toBe("preserve-raw-test-id");
      expect("candidateId" in roundtripped).toBe(true);
    });

    it("derives distinct canonical identities when different candidate digests share the same supplied candidateId", () => {
      const digestA = "1".repeat(64);
      const digestB = "2".repeat(64);
      const sharedId = "shared-custom-name";

      const parsedA = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateDigest: digestA,
        candidateId: sharedId,
      });
      const parsedB = parseCandidatePacketV2({
        ...CANDIDATE_CATALOG_PACKET,
        candidateDigest: digestB,
        candidateId: sharedId,
      });

      expect(parsedA.candidateId).toBe(digestA);
      expect(parsedB.candidateId).toBe(digestB);
      expect(parsedA.candidateId).not.toBe(parsedB.candidateId);
      expect(parsedA.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
      expect(parsedB.overrideNotice).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
      expect(parsedA.overrideNotice).not.toContain(sharedId);
      expect(parsedB.overrideNotice).not.toContain(sharedId);
    });

    it("passes supplied candidateId bytes unchanged and propagates verifier rejection", async () => {
      const packetWithCandidateId = {
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "catalog-noncanonical-id",
      };
      const rawJson = JSON.stringify(packetWithCandidateId);
      const parsed = parseCandidatePacketV2(rawJson);

      const context = createReviewContextV1({
        title: "Test Review",
        goal: "Test Loom rejection",
        candidateDigest: CANDIDATE_CATALOG_DIGEST,
        disposition: "approve",
        summary: "Testing schema rejection",
      });

      // Bridge simulates Loom exact schema checking which rejects extra fields
      bridge.verifyCandidateV2Impl = async (req) => {
        const parsedBody = JSON.parse(req.candidate);
        // Loom exact schema: catalog packet does not allow candidateId
        if ("candidateId" in parsedBody) {
          return {
            valid: false,
            diagnostics: [],
            error: { code: "SCHEMA_ERROR", message: "CATALOG_PACKET_SCHEMA_ERROR" },
            candidateVerification: {
              schema: CANDIDATE_VERIFICATION_SCHEMA,
              schemaVersion: 2,
              valid: false,
              candidateId: parsed.candidateId,
              candidateDigest: parsed.candidateDigest,
              inputDigest: "",
              outputDigest: "",
              diagnostics: [],
              errors: ["CATALOG_PACKET_SCHEMA_ERROR"],
              warnings: [],
            },
          };
        }
        return {
          valid: true,
          diagnostics: [],
        };
      };

      const result = await executeCandidateVerification(bridge, {
        rawCandidateBytes: rawJson,
        candidate: parsed,
        context,
        draftRevision: 1,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("CATALOG_PACKET_SCHEMA_ERROR");
      // Raw bytes were NOT stripped or sanitized
      expect(bridge.verifyCalls[0]!.candidate).toBe(rawJson);
      expect(bridge.verifyCalls[0]!.candidate).toContain("catalog-noncanonical-id");
    });

    it("handles replacement of candidate with notice and clears verification and notice appropriately", async () => {
      const noncanonicalPacket = {
        ...CANDIDATE_CATALOG_PACKET,
        candidateId: "first-noncanonical-id",
      };
      const canonicalPacket = {
        ...CANDIDATE_CORE_PACKET,
      };

      bridge.queueImportPacket(noncanonicalPacket);
      bridge.queueImportPacket(canonicalPacket);

      render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={adoptSpy} />);

      // Import candidate 1 (noncanonical)
      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("inspector-candidate-id-notice")).toBeTruthy();
      });
      expect(screen.getByTestId("inspector-candidate-id-notice").textContent).toBe(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);

      // Verify candidate 1
      fireEvent.click(screen.getByTestId("verify-candidate-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("inspector-status").textContent).toBe("Verified (Valid)");
      });

      // Import candidate 2 (canonical core packet)
      fireEvent.click(screen.getByTestId("import-candidate-btn"));
      await waitFor(() => {
        expect(screen.getByTestId("inspector-candidate-id").textContent).toBe("core-cand-alpha");
      });

      // Verification is revoked, notice is cleared
      expect(screen.getByTestId("inspector-status").textContent).toBe("Unverified");
      expect(screen.queryByTestId("inspector-candidate-id-notice")).toBeNull();
      expect(screen.getByTestId("exchange-success").textContent).not.toContain(CATALOG_CANDIDATE_ID_OVERRIDE_NOTICE);
    });
  });
});

it("ignores an import that completes after the current draft changes", async () => {
  const bridge = new MockV2ExchangeBridge();
  let finish: (value: ThemePacketImportResponse) => void = () => { throw new Error("import not started"); };
  vi.spyOn(bridge, "importPacket").mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const onAdopt = vi.fn();
  const view = render(<ThemeV2Exchange bridge={bridge} draftRevision={1} onAdopt={onAdopt} />);
  fireEvent.click(screen.getByTestId("import-candidate-btn"));
  view.rerender(<ThemeV2Exchange bridge={bridge} draftRevision={2} onAdopt={onAdopt} />);
  await act(async () => { finish({ cancelled: false, canonicalJson: JSON.stringify(CANDIDATE_CORE_PACKET) }); });
  expect(screen.queryByTestId("inspector-candidate-id")).toBeNull();
  expect(onAdopt).not.toHaveBeenCalled();
});
