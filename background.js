importScripts("lib/tab-state.js", "lib/logger.js");

const autoPlayJobs = new Map();
const endMonitors = new Map();

const END_MIN_PLAY_MS = 12000;
const END_SILENT_CHECKS = 3;
const END_POLL_MS = 4000;
const AUTO_PLAY_ATTEMPTS = 10;
const AUTO_PLAY_INTERVAL_MS = 1500;

async function saveEpisodes(episodes, tabId) {
  if (tabId == null) return;

  await setTabState(tabId, {
    episodes,
    episodeCount: episodes.length,
  });

  browser.runtime
    .sendMessage({
      type: "EPISODES_SCANNED",
      tabId,
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
    void vapLog.warn("content-script", "cannot inject on restricted page", { url: tab?.url }, { tabId });
    return false;
  }

  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["lib/tab-state.js", "lib/player-play.js", "lib/log-client.js", "content/content.js"],
    });
  } catch (error) {
    void vapLogError("content-script", error, { action: "inject" }, { tabId, url: tab.url });
    return false;
  }

  const ok = Boolean((await sendToTab(tabId, { type: "PING" }))?.ok);
  if (!ok) {
    void vapLog.warn("content-script", "injected but PING failed", null, { tabId, url: tab.url });
  }
  return ok;
}

async function requestScan(tabId, rediscover = false) {
  try {
    await ensureContentScript(tabId);
    const response = await sendToTab(tabId, { type: "SCAN_EPISODES", rediscover, tabId });
    if (!response) {
      void vapLog.warn("scan", "no response from content script", { rediscover }, { tabId });
      return [];
    }
    const episodes = response.episodes || [];
    void vapLog.info(
      "scan",
      rediscover ? "manual scan finished" : "scan finished",
      { count: episodes.length, rediscover },
      { tabId }
    );
    return episodes;
  } catch (error) {
    void vapLogError("scan", error, { rediscover }, { tabId });
    return [];
  }
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

async function isTabEnabled(tabId) {
  if (tabId == null) return false;
  const state = await getTabState(tabId);
  return Boolean(state.enabled);
}

function cancelAutoPlayJob(tabId) {
  const job = autoPlayJobs.get(tabId);
  if (!job) return;
  job.cancel = true;
  if (job.timer != null) {
    clearTimeout(job.timer);
    job.timer = null;
  }
  autoPlayJobs.delete(tabId);
}

function stopEndMonitor(tabId) {
  const monitor = endMonitors.get(tabId);
  if (!monitor) return;
  monitor.cancel = true;
  if (monitor.timer != null) {
    clearInterval(monitor.timer);
    monitor.timer = null;
  }
  endMonitors.delete(tabId);
}

function stopAllTabJobs(tabId) {
  cancelAutoPlayJob(tabId);
  stopEndMonitor(tabId);
}

function stopAllBackgroundJobs() {
  for (const tabId of [...autoPlayJobs.keys()]) {
    cancelAutoPlayJob(tabId);
  }
  for (const tabId of [...endMonitors.keys()]) {
    stopEndMonitor(tabId);
  }
}

function scheduleAutoPlayTimer(job, callback, delayMs) {
  if (job.timer != null) {
    clearTimeout(job.timer);
  }
  job.timer = setTimeout(() => {
    job.timer = null;
    void callback();
  }, delayMs);
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
  } catch (error) {
    void vapLogError("autoplay", error, { action: "click-iframe" }, { tabId });
    return false;
  }
}

async function triggerAutoPlayForTab(tabId) {
  const state = await getAutoPlayState(tabId);
  if (!state?.pending) return;
  if (!(await isTabEnabled(tabId))) return;

  if (autoPlayJobs.has(tabId)) return;

  const job = { cancel: false, timer: null };
  autoPlayJobs.set(tabId, job);

  const capture =
    (await browser.storage.local.get(tabCaptureKey(tabId)))[tabCaptureKey(tabId)] || {};

  let attempt = 0;

  const finishAutoPlay = async (messageType) => {
    if (job.cancel) return;
    cancelAutoPlayJob(tabId);
    await browser.storage.local.remove(autoPlayKey(tabId)).catch(() => {});
    if (messageType === "AUTO_PLAY_SUCCEEDED") {
      void vapLog.info("autoplay", "iframe auto play succeeded", { attempts: attempt + 1 }, { tabId });
    } else if (messageType === "AUTO_PLAY_FAILED") {
      void vapLog.warn("autoplay", "iframe auto play failed", { attempts: attempt }, { tabId });
    }
    if (messageType) {
      await sendToTab(tabId, { type: messageType }).catch((error) => {
        void vapLogError("autoplay", error, { messageType }, { tabId });
      });
    }
  };

  const runAttempt = async () => {
    try {
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

      scheduleAutoPlayTimer(job, async () => {
        try {
          if (job.cancel) return;

          if (await isTabAudible(tabId)) {
            await finishAutoPlay("AUTO_PLAY_SUCCEEDED");
            return;
          }

          attempt += 1;
          if (attempt >= AUTO_PLAY_ATTEMPTS) {
            await finishAutoPlay("AUTO_PLAY_FAILED");
            return;
          }

          await runAttempt();
        } catch (error) {
          void vapLogError("autoplay", error, { phase: "scheduled-attempt" }, { tabId });
          await finishAutoPlay("AUTO_PLAY_FAILED");
        }
      }, AUTO_PLAY_INTERVAL_MS);
    } catch (error) {
      void vapLogError("autoplay", error, { phase: "run-attempt" }, { tabId });
      await finishAutoPlay("AUTO_PLAY_FAILED");
    }
  };

  void runAttempt();
  void vapLog.info("autoplay", "auto play job started", null, { tabId });
}

async function startEndMonitor(tabId) {
  if (endMonitors.has(tabId)) return;

  stopEndMonitor(tabId);

  if (!(await isTabEnabled(tabId))) return;

  const capture =
    (await browser.storage.local.get(tabCaptureKey(tabId)))[tabCaptureKey(tabId)] || {};
  if (!capture.playerTarget && capture.iframeIndex == null && !capture.playerClick) {
    return;
  }

  const tabState = await getTabState(tabId);
  if (!Array.isArray(tabState.episodes) || tabState.episodes.length === 0) {
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
    try {
      if (monitor.cancel) return;
      if (!(await tabExists(tabId))) {
        stopEndMonitor(tabId);
        return;
      }

      if (!(await isTabEnabled(tabId))) {
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
        void vapLog.info("end-monitor", "episode ended, play next", { playedMs }, { tabId });
        await sendToTab(tabId, { type: "PLAY_NEXT_EPISODE" }).catch((error) => {
          void vapLogError("end-monitor", error, { action: "play-next" }, { tabId });
        });
      }
    } catch (error) {
      void vapLogError("end-monitor", error, { phase: "tick" }, { tabId });
      stopEndMonitor(tabId);
    }
  };

  monitor.timer = setInterval(tick, END_POLL_MS);
  void tick();
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  void (async () => {
    try {
      const state = await getAutoPlayState(tabId);
      if (state?.pending) {
        await triggerAutoPlayForTab(tabId);
      }
    } catch (error) {
      void vapLogError("autoplay", error, { phase: "tab-complete" }, { tabId });
      cancelAutoPlayJob(tabId);
    }
  })();
});

browser.tabs.onRemoved.addListener((tabId) => {
  stopAllTabJobs(tabId);
  browser.storage.local.remove(autoPlayKey(tabId)).catch(() => {});
  browser.storage.local.remove(tabCaptureKey(tabId)).catch(() => {});
  clearTabState(tabId).catch(() => {});
});

if (browser.runtime.onSuspend) {
  browser.runtime.onSuspend.addListener(() => {
    stopAllBackgroundJobs();
  });
}

browser.runtime.onStartup.addListener(() => {
  stopAllBackgroundJobs();
  void vapLog.info("lifecycle", "browser startup, plugin state reset");

  browser.storage.local.get(null).then((all) => {
    const keys = Object.keys(all).filter(
      (key) =>
        isTabStorageKey(key) ||
        key.startsWith("vapAutoPlay_") ||
        key.startsWith("vapCapture_")
    );
    if (keys.length) {
      browser.storage.local.remove(keys).catch(() => {});
    }
  });
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;

  for (const key of Object.keys(changes)) {
    if (!isTabStorageKey(key)) continue;
    const tabId = tabIdFromStorageKey(key);
    if (tabId == null) continue;

    const next = changes[key]?.newValue;
    if (next && next.enabled === false) {
      stopAllTabJobs(tabId);
    }
  }
});

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        case "GET_STATE": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId == null) {
            sendResponse(defaultTabState());
            break;
          }
          sendResponse(await getTabState(tabId));
          break;
        }

        case "REFRESH_EPISODES": {
          const tab = await getActiveTab(message);
          if (!tab?.id) {
            void vapLog.warn("scan", "refresh failed: no active tab");
            sendResponse({ ok: false, ...defaultTabState() });
            break;
          }
          const episodes = await requestScan(tab.id, true);
          await saveEpisodes(episodes, tab.id);
          sendResponse({ ok: true, ...(await getTabState(tab.id)) });
          break;
        }

        case "EPISODES_UPDATED": {
          const tabId = sender.tab?.id;
          const episodes = message.episodes || [];
          await saveEpisodes(episodes, tabId);
          sendResponse({ ok: true });
          break;
        }

        case "TAB_DISABLED": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId != null) {
            stopAllTabJobs(tabId);
            await sendToTab(tabId, { type: "TAB_DISABLED" }).catch(() => {});
          }
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

        case "VAP_LOG": {
          await handleVapLogMessage(message, sender);
          sendResponse({ ok: true });
          break;
        }

        default:
          sendResponse({ error: "unknown_message" });
      }
    } catch (error) {
      void vapLogError("message", error, { type: message.type });
      sendResponse({ error: String(error) });
    }
  })();

  return true;
});
