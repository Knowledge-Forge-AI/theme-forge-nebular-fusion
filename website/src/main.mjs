import {
  createDemoState,
  isInstallChannelAvailable,
  selectFamily,
  setInstallChannel,
  setInstallPlatform,
  setMockRadius,
  setMockRole,
  setMockRoleValue,
  setPreviewMode,
  setSiteTheme,
  setWorkflowStep,
} from "./state.mjs";

const CANDIDATE_VERSION = "0.8.0";
const PUBLISHED_CHANNEL_VERSIONS = Object.freeze({
  npm: "0.8.0",
  pip: "0.8.0",
  homebrew: "0.8.0",
  nix: "0.8.0",
  apt: "0.8.0",
  dnf: "0.8.0",
  pacman: "0.8.0",
  native: "0.8.0",
});
const githubReleaseUrl = (version) => `https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/tag/v${version}`;
const githubReleaseDownloadUrl = (version) => `https://github.com/Knowledge-Forge-AI/theme-forge-nebular-fusion/releases/download/v${version}`;
const pypiProjectUrl = (version) => `https://pypi.org/project/theme-forge-nebular-fusion/${version}/`;
const LINUX_REPOSITORY = "https://tf.rs9.knowledge-forge.ai";
const SIGNING_KEY = `${LINUX_REPOSITORY}/keys/knowledge-forge-ai-packages.asc`;
const PACKAGE_RELEASE_URL = "https://github.com/Knowledge-Forge-AI/theme-forge-packages/releases/tag/packages-current-202611-nebular080";
const SIGNING_FINGERPRINT = "7D03EE84F8C7025FD2F3D772BF89DF6643C2F1AF";

const publicationStatus = (channel, noun) => {
  const version = PUBLISHED_CHANNEL_VERSIONS[channel];
  return version === CANDIDATE_VERSION
    ? `${version} is published for this channel; consult the matching release and channel receipt.`
    : `${CANDIDATE_VERSION} publication hold: no ${CANDIDATE_VERSION} ${noun} is published.`;
};

const nativePublicationStatus = () => {
  const version = PUBLISHED_CHANNEL_VERSIONS.native;
  return version === CANDIDATE_VERSION
    ? `${version} native archive is published for this channel; consult matching release and channel receipts.`
    : `${CANDIDATE_VERSION} automated native checks passed on all three supported targets; the macOS build targets 13.3 or later. No ${CANDIDATE_VERSION} native archive is publicly published.`;
};

const FAMILY_LABELS = Object.freeze({
  "terminal-nova": "Terminal Nova",
  nebular: "Nebular",
  developer: "Developer",
  "graphic-designer": "Graphic Designer",
  anime: "Anime",
  gamer: "Gamer",
});

const FAMILY_ROLE_VALUES = Object.freeze({
  "terminal-nova": { accent: "#49c6c2", surface: "#20313a", text: "#f5eee2" },
  nebular: { accent: "#e9b75f", surface: "#27203e", text: "#f7f1e4" },
  developer: { accent: "#78b4e9", surface: "#192b3b", text: "#f2f5f2" },
  "graphic-designer": { accent: "#b98c5e", surface: "#332c28", text: "#fbf2e9" },
  anime: { accent: "#d899d4", surface: "#382c47", text: "#fff5fb" },
  gamer: { accent: "#ffb649", surface: "#30213e", text: "#fff2dc" },
});

const PLATFORM_LABELS = Object.freeze({
  "darwin-arm64": "macOS Apple Silicon",
  "linux-arm64": "Linux ARM64",
  "linux-x64": "Linux AMD64",
});

const INSTALL_CHANNELS = Object.freeze({
  npm: {
    label: "npm · global wrapper",
    title: "Install the published 0.8.0 platform wrapper.",
    available: ["darwin-arm64", "linux-arm64", "linux-x64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.npm,
    command: () => `npm install --global @knowledge-forge-ai/theme-forge-nebular-fusion@${PUBLISHED_CHANNEL_VERSIONS.npm}\ntfnf --version`,
    description: `npm selects exactly one optional ${PUBLISHED_CHANNEL_VERSIONS.npm} native package for the selected host: Darwin ARM64, Linux ARM64, or Linux x64. Use tfnf --path to print the authenticated executable path without launching.`,
    availability: "Available for this platform from the published 0.8.0 registry set. Native package selection is host-specific.",
    publicationStatus: publicationStatus("npm", "npm package"),
    source: githubReleaseUrl(PUBLISHED_CHANNEL_VERSIONS.npm),
  },
  pip: {
    label: "PyPI · universal wheel",
    title: "Install, verify, and launch the Python wrapper.",
    available: ["darwin-arm64", "linux-arm64", "linux-x64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.pip,
    command: (platform) => `${platform.startsWith("linux") ? "# Debian/Ubuntu Linux prerequisite\nsudo apt install libwebkit2gtk-4.1-0\n\n" : ""}python3 -m pip install --upgrade theme-forge-nebular-fusion==${PUBLISHED_CHANNEL_VERSIONS.pip}\ntfnf install-runtime\ntfnf --path\ntfnf`,
    description: `Requires Python 3.11 or later. The universal ${PUBLISHED_CHANNEL_VERSIONS.pip} launcher selects the current host's pinned native archive only after explicit runtime setup. tfnf --path verifies the installed runtime without launching; the final tfnf command launches the GUI. Linux also requires the system WebKitGTK 4.1 package.`,
    availability: "Available for this platform; use the release record for the current wheel metadata.",
    publicationStatus: publicationStatus("pip", "PyPI wheel"),
    source: pypiProjectUrl(PUBLISHED_CHANNEL_VERSIONS.pip),
  },
  homebrew: {
    label: "Homebrew · Apple Silicon formula",
    title: "Install the published 0.8.0 Apple Silicon formula.",
    available: ["darwin-arm64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.homebrew,
    command: () => "brew tap Knowledge-Forge-AI/tap\nbrew install Knowledge-Forge-AI/tap/theme-forge-nebular-fusion",
    description: `The ${PUBLISHED_CHANNEL_VERSIONS.homebrew} formula exposes the tfnf launcher on macOS Apple Silicon. The Homebrew Cask remains withheld, and Linux Homebrew availability is not claimed; this is a formula installation, not a notarization or Gatekeeper claim.`,
    availability: "Available only on macOS Apple Silicon in the merged tap formula record.",
    publicationStatus: publicationStatus("homebrew", "Homebrew formula"),
    source: "https://github.com/Knowledge-Forge-AI/homebrew-tap",
  },
  nix: {
    label: "Nix · pinned release ref",
    title: "Use the published Nix release, not moving main.",
    available: ["darwin-arm64", "linux-arm64", "linux-x64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.nix,
    command: () => "nix profile install github:Knowledge-Forge-AI/theme-forge-packages/nix-current-202611#theme-forge-nebular-fusion",
    description: "The published Nix channel is pinned to the nix-current-202611 ref (source 35266dbd6449432a540f3a1cc630d501c0d67911) and covers the three recorded hosts. Keep the ref visible when reproducing an install.",
    availability: "Available for the three recorded Nix hosts: Darwin ARM64, Linux ARM64, and Linux x64.",
    publicationStatus: publicationStatus("nix", "Nix release ref"),
    source: "https://github.com/Knowledge-Forge-AI/theme-forge-packages/releases/tag/nix-current-202611",
  },
  apt: {
    label: "APT · Ubuntu 26.04",
    title: "Add the signed resolute repository.",
    available: ["linux-arm64", "linux-x64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.apt,
    command: () => `sudo install -d -m 0755 /etc/apt/keyrings\ncurl -fsSL ${SIGNING_KEY} -o /tmp/theme-forge-packages.asc\ntest "$(gpg --show-keys --with-colons /tmp/theme-forge-packages.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = "${SIGNING_FINGERPRINT}"\ngpg --dearmor < /tmp/theme-forge-packages.asc | sudo tee /etc/apt/keyrings/theme-forge-packages.gpg >/dev/null\necho "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/theme-forge-packages.gpg] ${LINUX_REPOSITORY}/apt/ resolute main" | sudo tee /etc/apt/sources.list.d/theme-forge.list\nsudo apt update\nsudo apt install theme-forge-nebular-fusion`,
    description: "The signed repository publishes amd64 and arm64 packages for Ubuntu 26.04 resolute. The example verifies the primary certificate fingerprint before creating a trusted keyring and keeps apt signature checks enabled.",
    availability: "Available for Linux ARM64 and Linux AMD64 on Ubuntu 26.04 resolute.",
    publicationStatus: publicationStatus("apt", "APT package"),
    source: PACKAGE_RELEASE_URL,
  },
  dnf: {
    label: "DNF · RPM repository",
    title: "Add the signed RPM repository.",
    available: ["linux-arm64", "linux-x64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.dnf,
    command: () => `curl -fsSL ${SIGNING_KEY} -o /tmp/theme-forge-packages.asc\ntest "$(gpg --show-keys --with-colons /tmp/theme-forge-packages.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = "${SIGNING_FINGERPRINT}"\nsudo install -D -m 0644 /tmp/theme-forge-packages.asc /etc/pki/rpm-gpg/RPM-GPG-KEY-theme-forge\nprintf '[theme-forge]\\nname=Theme Forge\\nbaseurl=${LINUX_REPOSITORY}/rpm/$basearch/\\nenabled=1\\ngpgcheck=1\\nrepo_gpgcheck=1\\ngpgkey=file:///etc/pki/rpm-gpg/RPM-GPG-KEY-theme-forge\\n' | sudo tee /etc/yum.repos.d/theme-forge.repo\nsudo dnf install theme-forge-nebular-fusion`,
    description: "The published RPM paths cover x86_64 and aarch64. The example verifies the primary certificate before installing the local repo key, then preserves gpgcheck and repo_gpgcheck; current-distribution preservation exceptions do not imply Fedora promotion.",
    availability: "Available for Linux ARM64 and Linux AMD64 through the signed RPM repository.",
    publicationStatus: publicationStatus("dnf", "RPM package"),
    source: PACKAGE_RELEASE_URL,
  },
  pacman: {
    label: "pacman · Arch repository",
    title: "Add the signed Arch repository.",
    available: ["linux-arm64", "linux-x64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.pacman,
    command: () => `curl -fsSL ${SIGNING_KEY} -o /tmp/theme-forge-packages.asc\ntest "$(gpg --show-keys --with-colons /tmp/theme-forge-packages.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = "${SIGNING_FINGERPRINT}"\nsudo pacman-key --add /tmp/theme-forge-packages.asc\nsudo pacman-key --lsign-key ${SIGNING_FINGERPRINT}\nprintf '\\n[theme-forge]\\nServer = ${LINUX_REPOSITORY}/arch/$arch\\nSigLevel = Required\\n' | sudo tee -a /etc/pacman.conf\nsudo pacman -Syu theme-forge-nebular-fusion`,
    description: "The signed Arch repository includes x86_64 and aarch64 packages. The example verifies the primary certificate before local trust, requires signed package and database metadata, and uses a full -Syu transaction to avoid partial upgrades; AUR publication is not part of this channel.",
    availability: "Available for Linux ARM64 and Linux AMD64 through the signed Arch repository.",
    publicationStatus: publicationStatus("pacman", "Arch package"),
    source: PACKAGE_RELEASE_URL,
  },
  native: {
    label: "Native archive · checksummed",
    title: "Download the exact host archive.",
    available: ["darwin-arm64", "linux-arm64", "linux-x64"],
    publishedVersion: PUBLISHED_CHANNEL_VERSIONS.native,
    command: (platform) => {
      const version = PUBLISHED_CHANNEL_VERSIONS.native;
      const suffixes = {
        "darwin-arm64": "aarch64-apple-darwin",
        "linux-arm64": "aarch64-unknown-linux-gnu",
        "linux-x64": "x86_64-unknown-linux-gnu",
      };
      const archiveSuffix = platform === "darwin-arm64" ? ".app.tar.gz" : ".tar.gz";
      const archive = `theme-forge-nebular-fusion-v${version}-${suffixes[platform]}${archiveSuffix}`;
      const releaseDownloadUrl = githubReleaseDownloadUrl(version);
      const check = platform === "darwin-arm64" ? `grep -F "  ${archive}" SHA256SUMS | shasum -a 256 -c -` : `grep -F "  ${archive}" SHA256SUMS | sha256sum -c -`;
      return `curl -fLO ${releaseDownloadUrl}/SHA256SUMS\ncurl -fLO ${releaseDownloadUrl}/${archive}\n${check}\ntar -xzf ${archive}`;
    },
    description: `The v${PUBLISHED_CHANNEL_VERSIONS.native} release record lists one archive for each recorded host. Verify SHA256SUMS before unpacking; the Darwin developer app archive is ad-hoc-signed and is not a notarization or Gatekeeper claim.`,
    availability: "Available as a release archive for Darwin ARM64, Linux ARM64, and Linux AMD64.",
    publicationStatus: nativePublicationStatus(),
    source: githubReleaseUrl(PUBLISHED_CHANNEL_VERSIONS.native),
  },
});

const WORKFLOW_TITLES = Object.freeze({
  brief: "Review the brief",
  compare: "Compare the pair",
  revise: "Revise one role",
  export: "Prepare the export",
});

const MOCK_VIEW_TITLES = Object.freeze({
  studio: "Review the brief",
  catalog: "Browse the catalog",
  tokens: "Inspect the roles",
  export: "Prepare the export",
});

let state = createDemoState();
let mockView = "studio";
const root = document.documentElement;
const mockWindow = document.querySelector(".mock-window");

function queryAll(selector, scope = document) {
  return [...scope.querySelectorAll(selector)];
}

function installChannelAvailable(channel, platform) {
  return isInstallChannelAvailable(channel, platform);
}

function renderThemeControls() {
  queryAll("input[name='site-theme']").forEach((input) => {
    input.checked = input.value === state.siteTheme;
  });
  root.dataset.siteTheme = state.siteTheme;
}

function renderMock() {
  if (!mockWindow) return;
  const roleValues = state.roleValues;
  mockWindow.dataset.family = state.activeFamily;
  mockWindow.dataset.previewMode = state.previewMode;
  mockWindow.style.setProperty("--mock-accent", roleValues.accent);
  mockWindow.style.setProperty("--mock-surface", roleValues.surface);
  mockWindow.style.setProperty("--mock-text", roleValues.text);
  mockWindow.style.setProperty("--mock-radius", `${state.mockRadius}px`);
  const familyLabel = FAMILY_LABELS[state.activeFamily];
  queryAll("[data-mock-family-label]").forEach((node) => { node.textContent = familyLabel; });
  const mockTitle = mockView === "studio" ? WORKFLOW_TITLES[state.workflowStep] : MOCK_VIEW_TITLES[mockView];
  queryAll("[data-mock-view-title]").forEach((node) => { node.textContent = mockTitle; });
  queryAll("[data-mock-view]").forEach((button) => {
    const active = button.dataset.mockView === mockView;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  queryAll("[data-demo-step]").forEach((button) => {
    button.setAttribute("aria-selected", button.dataset.demoStep === state.workflowStep ? "true" : "false");
  });
  queryAll(".mock-mode-toggle [data-preview-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.previewMode === state.previewMode ? "true" : "false");
  });
  queryAll("[data-mock-role]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mockRole === state.mockRole);
  });
  const color = document.querySelector("#mock-color");
  if (color) color.value = state.roleValues[state.mockRole];
  const radius = document.querySelector("#mock-radius");
  if (radius) radius.value = String(state.mockRadius);
  const radiusValue = document.querySelector("#mock-radius-value");
  if (radiusValue) radiusValue.value = `${state.mockRadius}px`;
  if (radiusValue) radiusValue.textContent = `${state.mockRadius}px`;
  const feedback = document.querySelector("[data-demo-feedback]");
  if (feedback) feedback.textContent = `${state.mockRole} role · ${state.roleValues[state.mockRole]}`;
}

function renderFamilyCards() {
  queryAll("[data-family-card]").forEach((card) => {
    const selected = card.dataset.familyCard === state.activeFamily;
    card.classList.toggle("is-selected", selected);
    const button = card.querySelector("[data-family-select]");
    if (button) button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
}

function renderWorkflow() {
  queryAll("[data-workflow-step]").forEach((button) => {
    button.setAttribute("aria-current", button.dataset.workflowStep === state.workflowStep ? "step" : "false");
  });
  queryAll("[data-workflow-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.workflowPanel !== state.workflowStep;
  });
}

function renderInstall() {
  const channel = installChannelAvailable(state.installChannel, state.installPlatform)
    ? state.installChannel
    : "npm";
  queryAll("[data-install-platform]").forEach((button) => {
    button.setAttribute("aria-selected", button.dataset.installPlatform === state.installPlatform ? "true" : "false");
  });
  queryAll("[data-install-channel]").forEach((button) => {
    const available = installChannelAvailable(button.dataset.installChannel, state.installPlatform);
    button.disabled = !available;
    button.setAttribute("aria-selected", button.dataset.installChannel === channel ? "true" : "false");
    button.title = available ? "" : `Unavailable for ${PLATFORM_LABELS[state.installPlatform]}`;
  });
  const installPanel = document.querySelector("#installation-panel");
  const selectedPlatformTab = queryAll("[data-install-platform]").find((button) => button.dataset.installPlatform === state.installPlatform);
  const selectedChannelTab = queryAll("[data-install-channel]").find((button) => button.dataset.installChannel === channel);
  if (installPanel) {
    installPanel.setAttribute("aria-labelledby", [selectedPlatformTab?.id, selectedChannelTab?.id].filter(Boolean).join(" "));
  }
  const info = INSTALL_CHANNELS[channel];
  const label = document.querySelector("[data-install-label]");
  const title = document.querySelector("[data-install-title]");
  const command = document.querySelector("[data-install-command]");
  const description = document.querySelector("[data-install-description]");
  const availability = document.querySelector("[data-install-availability]");
  const version = document.querySelector("[data-install-version]");
  const source = document.querySelector("[data-install-source]");
  if (label) label.textContent = info.label;
  if (title) title.textContent = info.title;
  if (command) command.textContent = info.command(state.installPlatform);
  if (description) description.textContent = info.description;
  if (availability) availability.textContent = `${info.availability} ${info.publicationStatus}`;
  if (version) version.textContent = info.publishedVersion;
  if (source) {
    source.href = info.source;
    source.textContent = channel === "native" ? "Open the checksummed release record ↗" : "Open the channel source ↗";
  }
}

function tabIsVisible(tab) {
  if (tab.hidden || tab.getAttribute("aria-hidden") === "true") return false;
  if (typeof window.getComputedStyle !== "function") return true;
  const style = window.getComputedStyle(tab);
  return style.display !== "none" && style.visibility !== "hidden";
}

function enabledVisibleTabs(tablist) {
  return queryAll('[role="tab"]', tablist).filter((tab) => !tab.disabled && tabIsVisible(tab));
}

function syncTabList(tablist) {
  const tabs = queryAll('[role="tab"]', tablist);
  const enabledTabs = enabledVisibleTabs(tablist);
  if (enabledTabs.length === 0) {
    tabs.forEach((tab) => { tab.tabIndex = -1; });
    return;
  }
  const selected = enabledTabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? enabledTabs[0];
  const focused = document.activeElement;
  const rovingTab = enabledTabs.includes(focused) ? focused : selected;
  tabs.forEach((tab) => { tab.tabIndex = tab === rovingTab ? 0 : -1; });
}

function syncTabLists() {
  queryAll('[role="tablist"]').forEach(syncTabList);
}

function setupTabList(selector, activation, onSelect) {
  const tablist = document.querySelector(selector);
  if (!tablist) return;

  const activate = (tab) => {
    if (tab.disabled || !tabIsVisible(tab)) return;
    onSelect(tab);
    syncTabLists();
  };

  tablist.addEventListener("click", (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (tab && tablist.contains(tab)) activate(tab);
  });

  tablist.addEventListener("keydown", (event) => {
    const tab = event.target.closest?.('[role="tab"]');
    if (!tab || !tablist.contains(tab)) return;
    const tabs = enabledVisibleTabs(tablist);
    const currentIndex = tabs.indexOf(tab);
    if (currentIndex < 0) return;

    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activate(tab);
      return;
    } else {
      return;
    }

    event.preventDefault();
    const nextTab = tabs[nextIndex];
    tabs.forEach((candidate) => { candidate.tabIndex = candidate === nextTab ? 0 : -1; });
    if (activation === "automatic") activate(nextTab);
    nextTab.focus();
  });

  syncTabList(tablist);
}

function render() {
  renderThemeControls();
  renderMock();
  renderFamilyCards();
  renderWorkflow();
  renderInstall();
  syncTabLists();
}

queryAll("input[name='site-theme']").forEach((input) => {
  input.addEventListener("change", () => {
    state = setSiteTheme(state, input.value);
    renderThemeControls();
  });
});

queryAll("[data-family-select]").forEach((button) => {
  button.addEventListener("click", () => {
    const family = button.dataset.familySelect;
    state = selectFamily(state, family);
    state = { ...state, roleValues: { ...FAMILY_ROLE_VALUES[family] } };
    render();
  });
});

queryAll("[data-mock-view]").forEach((button) => {
  button.addEventListener("click", () => {
    mockView = button.dataset.mockView;
    renderMock();
  });
});

setupTabList(".mock-step-tabs", "automatic", (tab) => {
  state = setWorkflowStep(state, tab.dataset.demoStep);
  renderWorkflow();
  renderMock();
});

queryAll("[data-workflow-step]").forEach((button) => {
  button.addEventListener("click", () => {
    state = setWorkflowStep(state, button.dataset.workflowStep);
    renderWorkflow();
    renderMock();
  });
});

queryAll(".mock-mode-toggle [data-preview-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state = setPreviewMode(state, button.dataset.previewMode);
    renderMock();
  });
});

queryAll("[data-mock-role]").forEach((button) => {
  button.addEventListener("click", () => {
    state = setMockRole(state, button.dataset.mockRole);
    renderMock();
  });
});

document.querySelector("#mock-color")?.addEventListener("input", (event) => {
  state = setMockRoleValue(state, state.mockRole, event.currentTarget.value);
  renderMock();
});

document.querySelector("#mock-radius")?.addEventListener("input", (event) => {
  state = setMockRadius(state, event.currentTarget.value);
  renderMock();
});

setupTabList(".platform-tabs", "automatic", (tab) => {
  state = setInstallPlatform(state, tab.dataset.installPlatform);
  renderInstall();
});

setupTabList(".install-channel-row", "manual", (tab) => {
  state = setInstallChannel(state, tab.dataset.installChannel);
  renderInstall();
});

if (typeof window.matchMedia === "function") {
  const media = window.matchMedia("(prefers-color-scheme: light)");
  const onSystemChange = () => {
    if (state.siteTheme === "system") renderThemeControls();
  };
  media.addEventListener?.("change", onSystemChange);
  media.addListener?.(onSystemChange);
}

render();
