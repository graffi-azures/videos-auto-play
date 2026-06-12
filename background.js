importScripts("lib/domain.js");

const autoPlayJobs = new Map();
const endMonitors = new Map();

const END_MIN_PLAY_MS = 12000;
const END_SILENT_CHECKS = 3;
const END_POLL_MS = 2000;
const AUTO_PLAY_ATTEMPTS = 10;
const AUTO_PLAY_INTERVAL_MS = 1500;

async function getState() {
  return browser.storage.local.get(["enabled", "domain", "episodes", "episodeCount"]);
}

async function saveEpisodes(episodes, tabId) {
  await browser.storage.local.set({
    episodes,
    episodeCount: episodes.length,
    activeTabId: tabId ?? null,
  });

  browser.runtime
    .sendMessage({
      type: "EPISODES_SCANNED",
      episodes,
      episodeCount: episodes.length,
    })
    .catch(() => {});
}

async function getActiveTab(message) {
  if (message?.tabId != null) {
    try {
      return await browser.tabs.get(message.tabId);
    } catch {
      // ignore
    }
  }

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function sendToTab(tabId, message) {
  if (tabId == null) return null;
  try {
    return await browser.tabs.sendMessage(tabId, message);
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  if (tabId == null) return false;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const probe = await sendToTab(tabId, { type: "PING" });
    if (probe?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const tab = await browser.tabs.get(tabId).catch(() => null);
  if (!tab?.url || tab.url.startsWith("about:") || tab.url.startsWith("moz-extension:")) {
    return false;
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["lib/domain.js", "lib/player-play.js", "content/content.js"],
    });
  } catch {
    return false;
  }

  return Boolean((await sendToTab(tabId, { type: "PING" }))?.ok);
}

async function requestScan(tabId) {
  await ensureContentScript(tabId);
  const response = await sendToTab(tabId, { type: "SCAN_EPISODES" });
  return response?.episodes || [];
}

function autoPlayKey(tabId) {
  return `vapAutoPlay_${tabId}`;
}

function tabCaptureKey(tabId) {
  return `vapCapture_${tabId}`;
}

async function getAutoPlayState(tabId) {
  const data = await browser.storage.local.get(autoPlayKey(tabId));
  return data[autoPlayKey(tabId)] || null;
}

function cancelAutoPlayJob(tabId) {
  const job = autoPlayJobs.get(tabId);
  if (job) {
    job.cancel = true;
    if (job.timer != null) {
      clearTimeout(job.timer);
    }
  }
  autoPlayJobs.delete(tabId);
}

function stopEndMonitor(tabId) {
  const monitor = endMonitors.get(tabId);
  if (!monitor) return;
  monitor.cancel = true;
  if (monitor.timer != null) {
    clearInterval(monitor.timer);
  }
  endMonitors.delete(tabId);
}

function stopAllTabJobs(tabId) {
  cancelAutoPlayJob(tabId);
  stopEndMonitor(tabId);
}

async function clearAutoPlayState(tabId) {
  if (tabId == null) return;
  cancelAutoPlayJob(tabId);
  await browser.storage.local.remove(autoPlayKey(tabId));
  await sendToTab(tabId, { type: "AUTO_PLAY_SUCCEEDED" }).catch(() => {});
}

async function tabExists(tabId) {
  try {
    await browser.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

async function isTabAudible(tabId) {
  try {
    const tab = await browser.tabs.get(tabId);
    return Boolean(tab?.audible);
  } catch {
    return false;
  }
}

async function clickIframePlayer(tabId, capture) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      files: ["lib/player-play.js"],
      world: "MAIN",
      func: (clickPoint, iframeIndex) => {
        const play = window.__vapPlayerPlay;
        if (!play) return false;
        return play.activateIframePlayer({ clickPoint, iframeIndex });
      },
      args: [capture?.playerClick || null, capture?.iframeIndex ?? -1],
    });

    return Boolean(results?.[0]?.result);
  } catch {
    return false;
  }
}

async function triggerAutoPlayForTab(tabId) {
  const state = await getAutoPlayState(tabId);
  if (!state?.pending) return;

  if (autoPlayJobs.has(tabId)) return;

  const job = { cancel: false, timer: null };
  autoPlayJobs.set(tabId, job);

  const capture =
    (await browser.storage.local.get(tabCaptureKey(tabId)))[tabCaptureKey(tabId)] || {};

  let attempt = 0;

  const runAttempt = async () => {
    if (job.cancel) return;
    if (!(await tabExists(tabId))) {
      await clearAutoPlayState(tabId);
      cancelAutoPlayJob(tabId);
      return;
    }

    const pending = await getAutoPlayState(tabId);
    if (!pending?.pending) {
      cancelAutoPlayJob(tabId);
      return;
    }

    await clickIframePlayer(tabId, capture);

    job.timer = setTimeout(async () => {
      if (job.cancel) return;

      if (await isTabAudible(tabId)) {
        await browser.storage.local.remove(autoPlayKey(tabId));
        await sendToTab(tabId, { type: "AUTO_PLAY_SUCCEEDED" });
        cancelAutoPlayJob(tabId);
        return;
      }

      attempt += 1;
      if (attempt >= AUTO_PLAY_ATTEMPTS) {
        await browser.storage.local.remove(autoPlayKey(tabId));
        cancelAutoPlayJob(tabId);
        await sendToTab(tabId, { type: "AUTO_PLAY_FAILED" });
        return;
      }

      void runAttempt();
    }, AUTO_PLAY_INTERVAL_MS);
  };

  void runAttempt();
}

async function startEndMonitor(tabId) {
  stopEndMonitor(tabId);

  const enabledState = await getState();
  if (!enabledState.enabled) return;

  const capture =
    (await browser.storage.local.get(tabCaptureKey(tabId)))[tabCaptureKey(tabId)] || {};
  if (!capture.playerTarget && capture.iframeIndex == null && !capture.playerClick) {
    return;
  }

  const episodesState = await getState();
  if (!Array.isArray(episodesState.episodes) || episodesState.episodes.length === 0) {
    return;
  }

  const monitor = {
    cancel: false,
    timer: null,
    wasAudible: false,
    audibleSince: 0,
    silentChecks: 0,
  };
  endMonitors.set(tabId, monitor);

  const tick = async () => {
    if (monitor.cancel) return;
    if (!(await tabExists(tabId))) {
      stopEndMonitor(tabId);
      return;
    }

    const enabledNow = await getState();
    if (!enabledNow.enabled) {
      stopEndMonitor(tabId);
      return;
    }

    const pending = await getAutoPlayState(tabId);
    if (pending?.pending) return;

    const audible = await isTabAudible(tabId);
    const now = Date.now();

    if (audible) {
      monitor.wasAudible = true;
      monitor.audibleSince = now;
      monitor.silentChecks = 0;
      return;
    }

    if (!monitor.wasAudible) return;

    monitor.silentChecks += 1;
    const playedMs = now - monitor.audibleSince;
    if (playedMs >= END_MIN_PLAY_MS && monitor.silentChecks >= END_SILENT_CHECKS) {
      stopEndMonitor(tabId);
      await sendToTab(tabId, { type: "PLAY_NEXT_EPISODE" });
    }
  };

  monitor.timer = setInterval(tick, END_POLL_MS);
  void tick();
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void (async () => {
    if (changeInfo.status === "complete") {
      const state = await getAutoPlayState(tabId);
      if (state?.pending) {
        await triggerAutoPlayForTab(tabId);
      }
    }

    if (changeInfo.audible === false && endMonitors.has(tabId)) {
      const monitor = endMonitors.get(tabId);
      if (monitor?.wasAudible) {
        void (async () => {
          const pending = await getAutoPlayState(tabId);
          if (!pending?.pending) {
            const now = Date.now();
            monitor.silentChecks += 1;
            const playedMs = now - monitor.audibleSince;
            if (playedMs >= END_MIN_PLAY_MS && monitor.silentChecks >= END_SILENT_CHECKS) {
              stopEndMonitor(tabId);
              await sendToTab(tabId, { type: "PLAY_NEXT_EPISODE" });
            }
          }
        })();
      }
    }
  })();
});

browser.tabs.onRemoved.addListener((tabId) => {
  stopAllTabJobs(tabId);
  browser.storage.local.remove(autoPlayKey(tabId)).catch(() => {});
  browser.storage.local.remove(tabCaptureKey(tabId)).catch(() => {});
});

if (browser.runtime.onSuspend) {
  browser.runtime.onSuspend.addListener(() => {
    for (const tabId of [...autoPlayJobs.keys(), ...endMonitors.keys()]) {
      stopAllTabJobs(tabId);
    }
  });
}

browser.runtime.onStartup.addListener(() => {
  browser.storage.local.get(null).then((all) => {
    const keys = Object.keys(all).filter(
      (key) => key.startsWith("vapAutoPlay_") || key.startsWith("vapCapture_")
    );
    if (keys.length) {
      browser.storage.local.remove(keys).catch(() => {});
    }
  });
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.enabled) return;
  if (changes.enabled.newValue === false) {
    for (const tabId of [...endMonitors.keys()]) {
      stopEndMonitor(tabId);
    }
    for (const tabId of [...autoPlayJobs.keys()]) {
      cancelAutoPlayJob(tabId);
    }
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_STATE": {
          sendResponse(await getState());
          break;
        }

        case "REFRESH_EPISODES": {
          const tab = await getActiveTab(message);
          if (!tab?.id) {
            sendResponse({ ok: false, ...(await getState()) });
            break;
          }
          const episodes = await requestScan(tab.id);
          await saveEpisodes(episodes, tab.id);
          sendResponse({ ok: true, ...(await getState()) });
          break;
        }

        case "EPISODES_UPDATED": {
          const episodes = message.episodes || [];
          await saveEpisodes(episodes, sender.tab?.id);
          sendResponse({ ok: true });
          break;
        }

        case "IS_TAB_AUDIBLE": {
          const tabId = message.tabId ?? sender.tab?.id;
          sendResponse({ audible: await isTabAudible(tabId) });
          break;
        }

        case "MARK_AUTO_PLAY": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId != null) {
            await browser.storage.local.set({
              [autoPlayKey(tabId)]: {
                pending: true,
                url: message.url || null,
                at: Date.now(),
              },
            });
          }
          sendResponse({ ok: true });
          break;
        }

        case "CLEAR_AUTO_PLAY": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId != null) {
            cancelAutoPlayJob(tabId);
            await browser.storage.local.remove(autoPlayKey(tabId));
          }
          sendResponse({ ok: true });
          break;
        }

        case "REQUEST_AUTO_PLAY": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId != null) {
            await triggerAutoPlayForTab(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        case "START_END_MONITOR": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId != null) {
            await startEndMonitor(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        case "STOP_END_MONITOR": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId != null) {
            stopEndMonitor(tabId);
          }
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ error: "unknown_message" });
      }
    } catch (error) {
      sendResponse({ error: String(error) });
    }
  })();

  return true;
});
