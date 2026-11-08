export const SITE_THEMES = Object.freeze(["system", "light", "dark"]);
export const PREVIEW_MODES = Object.freeze(["paired", "light", "dark"]);
export const FAMILY_IDS = Object.freeze([
  "terminal-nova",
  "nebular",
  "developer",
  "graphic-designer",
  "anime",
  "gamer",
]);
export const WORKFLOW_STEPS = Object.freeze(["brief", "compare", "revise", "export"]);
export const MOCK_ROLES = Object.freeze(["accent", "surface", "text"]);
const INSTALL_CHANNEL_AVAILABILITY = Object.freeze({
  npm: Object.freeze(["darwin-arm64", "linux-arm64", "linux-x64"]),
  pip: Object.freeze(["darwin-arm64", "linux-arm64", "linux-x64"]),
  homebrew: Object.freeze(["darwin-arm64"]),
  nix: Object.freeze(["darwin-arm64", "linux-arm64", "linux-x64"]),
  apt: Object.freeze(["linux-arm64", "linux-x64"]),
  dnf: Object.freeze(["linux-arm64", "linux-x64"]),
  pacman: Object.freeze(["linux-arm64", "linux-x64"]),
  native: Object.freeze(["darwin-arm64", "linux-arm64", "linux-x64"]),
});

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export function createDemoState() {
  return {
    siteTheme: "system",
    activeFamily: "nebular",
    previewMode: "paired",
    workflowStep: "brief",
    mockRole: "accent",
    mockRadius: 12,
    roleValues: {
      accent: "#e9b75f",
      surface: "#27203e",
      text: "#f7f1e4",
    },
    installPlatform: "darwin-arm64",
    installChannel: "npm",
  };
}

export function setSiteTheme(state, value) {
  return SITE_THEMES.includes(value) ? { ...state, siteTheme: value } : state;
}

export function selectFamily(state, familyId) {
  return FAMILY_IDS.includes(familyId) ? { ...state, activeFamily: familyId } : state;
}

export function setPreviewMode(state, value) {
  return PREVIEW_MODES.includes(value) ? { ...state, previewMode: value } : state;
}

export function setWorkflowStep(state, value) {
  return WORKFLOW_STEPS.includes(value) ? { ...state, workflowStep: value } : state;
}

export function setMockRole(state, value) {
  return MOCK_ROLES.includes(value) ? { ...state, mockRole: value } : state;
}

export function setMockRoleValue(state, role, value) {
  if (!MOCK_ROLES.includes(role) || !HEX_COLOR.test(value)) return state;
  return { ...state, roleValues: { ...state.roleValues, [role]: value.toLowerCase() } };
}

export function setMockRadius(state, value) {
  const radius = Number(value);
  if (!Number.isFinite(radius)) return state;
  return { ...state, mockRadius: Math.min(24, Math.max(8, Math.round(radius))) };
}

export function setInstallPlatform(state, value) {
  const platforms = ["darwin-arm64", "linux-arm64", "linux-x64"];
  if (!platforms.includes(value)) return state;
  const installChannel = isInstallChannelAvailable(state.installChannel, value)
    ? state.installChannel
    : "npm";
  return { ...state, installPlatform: value, installChannel };
}

export function setInstallChannel(state, value) {
  const channels = ["npm", "pip", "homebrew", "nix", "apt", "dnf", "pacman", "native"];
  return channels.includes(value) && isInstallChannelAvailable(value, state.installPlatform)
    ? { ...state, installChannel: value }
    : state;
}

export function isInstallChannelAvailable(channel, platform) {
  return INSTALL_CHANNEL_AVAILABILITY[channel]?.includes(platform) ?? false;
}

export function resolveSiteTheme(preference, systemTheme = "dark") {
  if (preference === "light" || preference === "dark") return preference;
  return systemTheme === "light" ? "light" : "dark";
}
