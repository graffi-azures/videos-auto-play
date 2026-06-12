const refreshBtn = document.getElementById("refresh-btn");
const episodeCountEl = document.getElementById("episode-count");
const episodeInfoEl = document.getElementById("episode-info");
const enableSwitch = document.getElementById("enable-switch");
const urlToggle = document.getElementById("url-toggle");
const urlPanel = document.getElementById("url-panel");
const domainInput = document.getElementById("domain-input");
const statusMsg = document.getElementById("status-msg");
const overlay = document.getElementById("overlay");
const bootOverlay = document.getElementById("boot-overlay");
const panel = document.querySelector(".panel");

let suppressSwitchEvent = false;
let popupClosing = false;
let loadUiPromise = null;
let initialBootDone = false;

function showOverlay() {
  panel.classList.add("busy");
  overlay.classList.remove("hidden");
}

function hideOverlay() {
  panel.classList.remove("busy");
  overlay.classList.add("hidden");
}

const MIN_OVERLAY_MS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readStorage() {
  return browser.storage.local.get(["enabled", "domain", "episodes", "episodeCount"]);
}

function isPluginEnabled(state) {
  return Boolean(state.enabled && state.domain);
}

function render(state) {
  const count = Number(state.episodeCount ?? state.episodes?.length ?? 0);
  const active = isPluginEnabled(state);

  suppressSwitchEvent = true;
  enableSwitch.checked = Boolean(state.enabled);
  domainInput.value = state.domain || "";
  suppressSwitchEvent = false;

  refreshBtn.disabled = !active;
  episodeInfoEl.classList.toggle("hidden", !active);

  if (!active) {
    statusMsg.classList.add("hidden");
    return;
  }

  episodeCountEl.textContent = String(count);
  statusMsg.textContent = count > 0 ? "" : "无可用列表";
  statusMsg.classList.toggle("hidden", count > 0);
}

function loadUi() {
  if (loadUiPromise) {
    return loadUiPromise;
  }

  const isInitialBoot = !initialBootDone;

  loadUiPromise = (async () => {
    try {
      render(await readStorage());
    } catch (error) {
      vapLogError("popup", error, { action: "loadUi" });
      console.error("[Videos Auto Play] failed to load popup state", error);
    } finally {
      if (isInitialBoot && bootOverlay) {
        bootOverlay.classList.add("hidden");
        initialBootDone = true;
      }
      loadUiPromise = null;
    }
  })();

  return loadUiPromise;
}

async function persistSettings(enabled, domain) {
  const prev = await readStorage();

  if (!enabled) {
    await browser.storage.local.set({ enabled: false });
    vapLog.info("plugin", "disabled from popup");
    return readStorage();
  }

  const nextDomain = normalizeDomain(domain) || prev.domain || "";
  if (!nextDomain) {
    return prev;
  }

  const patch = {
    enabled: true,
    domain: nextDomain,
  };

  if (!prev.enabled) {
    patch.episodes = [];
    patch.episodeCount = 0;
  }

  await browser.storage.local.set(patch);
  vapLog.info("plugin", "enabled from popup", { domain: nextDomain });
  return readStorage();
}

async function runScan(task) {
  const startedAt = Date.now();
  showOverlay();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    return await task();
  } catch (error) {
    vapLogError("popup", error, { action: "runScan" });
    throw error;
  } finally {
    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_OVERLAY_MS) {
      await sleep(MIN_OVERLAY_MS - elapsed);
    }
    hideOverlay();
  }
}

window.addEventListener("pagehide", () => {
  popupClosing = true;
  suppressSwitchEvent = true;
});

enableSwitch.addEventListener("change", async () => {
  if (suppressSwitchEvent || popupClosing) return;

  const enabled = enableSwitch.checked;
  const domain = normalizeDomain(domainInput.value);

  if (enabled && !domain) {
    suppressSwitchEvent = true;
    enableSwitch.checked = false;
    suppressSwitchEvent = false;
    return;
  }

  const state = await persistSettings(enabled, domain);
  render(state);

  if (enabled) {
    await runScan(async () => {
      const response = await browser.runtime.sendMessage({ type: "REFRESH_EPISODES" });
      if (response?.error) {
        vapLog.warn("scan", "refresh response error", response);
      }
      render(await readStorage());
    }).catch((error) => {
      vapLogError("scan", error, { action: "enable-switch" });
    });
  }
});

domainInput.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" || popupClosing) return;
  event.preventDefault();

  const domain = normalizeDomain(domainInput.value);
  if (!domain) return;

  const state = await persistSettings(enableSwitch.checked, domain);
  render(state);

  if (enableSwitch.checked) {
    await runScan(async () => {
      const response = await browser.runtime.sendMessage({ type: "REFRESH_EPISODES" });
      if (response?.error) {
        vapLog.warn("scan", "refresh response error", response);
      }
      render(await readStorage());
    }).catch((error) => {
      vapLogError("scan", error, { action: "domain-enter" });
    });
  }
});

refreshBtn.addEventListener("click", async () => {
  await runScan(async () => {
    const response = await browser.runtime.sendMessage({ type: "REFRESH_EPISODES" });
    if (response?.error) {
      vapLog.warn("scan", "refresh response error", response);
    }
    render(await readStorage());
  }).catch((error) => {
    vapLogError("scan", error, { action: "refresh-button" });
  });
});

urlToggle.addEventListener("click", () => {
  urlPanel.classList.toggle("hidden");
  urlToggle.classList.toggle("open");
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes.enabled || changes.domain || changes.episodes || changes.episodeCount) {
    loadUi();
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "EPISODES_SCANNED") {
    loadUi();
  }
});

loadUi();
