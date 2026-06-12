const refreshBtn = document.getElementById("refresh-btn");
const episodeCountEl = document.getElementById("episode-count");
const episodeInfoEl = document.getElementById("episode-info");
const enableSwitch = document.getElementById("enable-switch");
const statusMsg = document.getElementById("status-msg");
const overlay = document.getElementById("overlay");
const bootOverlay = document.getElementById("boot-overlay");
const panel = document.querySelector(".panel");

let suppressSwitchEvent = false;
let popupClosing = false;
let loadUiPromise = null;
let currentTabId = null;

function showOverlay() {
  panel.classList.add("busy");
  overlay.classList.remove("hidden");
}

function hideOverlay() {
  panel.classList.remove("busy");
  overlay.classList.add("hidden");
}

function finishBootOverlay() {
  if (bootOverlay) {
    bootOverlay.classList.add("hidden");
  }
}

const MIN_OVERLAY_MS = 600;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getActiveTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function readStorage() {
  const tab = await getActiveTab();
  currentTabId = tab?.id ?? null;

  if (currentTabId == null) {
    return defaultTabState();
  }

  return getTabState(currentTabId);
}

async function renderFromRefreshResponse(response) {
  if (response?.ok && !response.error) {
    render({
      enabled: Boolean(response.enabled ?? enableSwitch.checked),
      episodes: response.episodes || [],
      episodeCount: Number(response.episodeCount ?? response.episodes?.length ?? 0),
    });
    return;
  }
  render(await readStorage());
}

function isPluginEnabled(state) {
  return Boolean(state.enabled);
}

function render(state) {
  const count = Number(state.episodeCount ?? state.episodes?.length ?? 0);
  const active = isPluginEnabled(state);

  suppressSwitchEvent = true;
  enableSwitch.checked = Boolean(state.enabled);
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

  loadUiPromise = (async () => {
    try {
      render(await readStorage());
    } catch (error) {
      vapLogError("popup", error, { action: "loadUi" });
      console.error("[Videos Auto Play] failed to load popup state", error);
    } finally {
      finishBootOverlay();
      loadUiPromise = null;
    }
  })();

  return loadUiPromise;
}

async function persistSettings(enabled) {
  const tab = await getActiveTab();
  if (tab?.id == null) {
    return defaultTabState();
  }

  currentTabId = tab.id;
  const prev = await getTabState(tab.id);

  if (!enabled) {
    await setTabState(tab.id, {
      enabled: false,
      episodes: [],
      episodeCount: 0,
    });
    await browser.runtime.sendMessage({
      type: "TAB_DISABLED",
      tabId: tab.id,
    });
    vapLog.info("plugin", "disabled from popup", null, { tabId: tab.id });
    return getTabState(tab.id);
  }

  const patch = {
    enabled: true,
  };

  if (!prev.enabled) {
    patch.episodes = [];
    patch.episodeCount = 0;
  }

  await setTabState(tab.id, patch);
  vapLog.info("plugin", "enabled from popup", null, { tabId: tab.id });
  return getTabState(tab.id);
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
  const state = await persistSettings(enabled);
  render(state);

  if (enabled) {
    await runScan(async () => {
      const tab = await getActiveTab();
      currentTabId = tab?.id ?? currentTabId;
      const response = await browser.runtime.sendMessage({
        type: "REFRESH_EPISODES",
        tabId: currentTabId,
      });
      if (response?.error) {
        vapLog.warn("scan", "refresh response error", response, { tabId: currentTabId });
      }
      await renderFromRefreshResponse(response);
    }).catch((error) => {
      vapLogError("scan", error, { action: "enable-switch" }, { tabId: currentTabId });
    });
  }
});

refreshBtn.addEventListener("click", async () => {
  await runScan(async () => {
    const tab = await getActiveTab();
    currentTabId = tab?.id ?? currentTabId;
    const response = await browser.runtime.sendMessage({
      type: "REFRESH_EPISODES",
      tabId: currentTabId,
    });
    if (response?.error) {
      vapLog.warn("scan", "refresh response error", response, { tabId: currentTabId });
    }
    await renderFromRefreshResponse(response);
  }).catch((error) => {
    vapLogError("scan", error, { action: "refresh-button" }, { tabId: currentTabId });
  });
});

function storageChangeAffectsCurrentTab(changes) {
  if (currentTabId == null) return false;
  const key = tabStateKey(currentTabId);
  return Object.prototype.hasOwnProperty.call(changes, key);
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (storageChangeAffectsCurrentTab(changes)) {
    loadUi();
  }
});

browser.runtime.onMessage.addListener((message) => {
  if (message.type !== "EPISODES_SCANNED") return;
  if (message.tabId == null || currentTabId == null) return;
  if (message.tabId !== currentTabId) return;
  loadUi();
});

setTimeout(finishBootOverlay, 3000);
loadUi();
