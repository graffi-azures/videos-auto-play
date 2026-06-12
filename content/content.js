/* Episode list from first-clicked sibling anchors + auto play next episode. */

(() => {
  if (window.__videosAutoPlayLoaded) {
    return;
  }
  window.__videosAutoPlayLoaded = true;

  const SESSION_KEYS = {
    episodeContainer: "__vapEpisodeContainer",
    episodeScanMode: "__vapEpisodeScanMode",
    episodeCaptured: "__vapEpisodeCaptured",
    playerTarget: "__vapPlayerTarget",
    playerCaptured: "__vapPlayerCaptured",
    autoPlay: "__vapAutoPlay",
    mirrorEnabled: "__vapMirrorEnabled",
    mirrorDomain: "__vapMirrorDomain",
  };

  const IFRAME_OBSERVER_MAX_MS = 45000;

  function playerPlay() {
    return (
      window.__vapPlayerPlay || {
        findLargeIframes: () => [...document.querySelectorAll("iframe")],
        getPrimaryIframe: () => document.querySelector("iframe"),
        activateIframePlayer: () => false,
      }
    );
  }

  let enabled = false;
  let domain = "";
  let episodes = [];
  let autoPlayPending = false;
  let tabStateReady = false;
  let savedClickPoint = null;
  let savedIframeIndex = -1;
  let iframeObserverStopTimer = null;
  const boundIframes = new WeakSet();

  function tabCaptureStorageKey(tabId) {
    return `vapCapture_${tabId}`;
  }

  async function getCurrentTabId() {
    try {
      const tab = await browser.tabs.getCurrent();
      return tab?.id ?? null;
    } catch {
      return null;
    }
  }

  async function persistTabCapture(patch) {
    const tabId = await getCurrentTabId();
    if (tabId == null) return;

    const key = tabCaptureStorageKey(tabId);
    const prev = (await browser.storage.local.get(key))[key] || {};
    await browser.storage.local.set({ [key]: { ...prev, ...patch } });
  }

  async function clearTabCaptureStorage() {
    const tabId = await getCurrentTabId();
    if (tabId == null) return;
    await browser.storage.local.remove(tabCaptureStorageKey(tabId));
  }

  async function restoreTabState() {
    const tabId = await getCurrentTabId();
    if (tabId == null) {
      tabStateReady = true;
      autoPlayPending = sessionGet(SESSION_KEYS.autoPlay) === "1";
      return;
    }

    const autoKey = `vapAutoPlay_${tabId}`;
    const capKey = tabCaptureStorageKey(tabId);
    const data = await browser.storage.local.get([autoKey, capKey]);
    const auto = data[autoKey];
    const cap = data[capKey] || {};

    if (auto?.pending) {
      autoPlayPending = true;
      sessionSet(SESSION_KEYS.autoPlay, "1");
    } else {
      autoPlayPending = sessionGet(SESSION_KEYS.autoPlay) === "1";
    }

    if (cap.playerTarget) {
      sessionSet(SESSION_KEYS.playerTarget, cap.playerTarget);
      sessionSet(SESSION_KEYS.playerCaptured, "1");
    }

    if (cap.playerClick) {
      savedClickPoint = cap.playerClick;
    }

    if (Number.isInteger(cap.iframeIndex)) {
      savedIframeIndex = cap.iframeIndex;
    }

    tabStateReady = true;
  }

  function stopAutoPlayRetry() {
    // auto-play retries run in the background service worker
  }

  function stopIframeObserver() {
    if (iframeObserverStopTimer != null) {
      clearTimeout(iframeObserverStopTimer);
      iframeObserverStopTimer = null;
    }
    if (window.__vapIframeObserver) {
      window.__vapIframeObserver.disconnect();
      window.__vapIframeObserver = null;
    }
  }

  async function stopBackgroundEndMonitor() {
    try {
      await browser.runtime.sendMessage({ type: "STOP_END_MONITOR" });
    } catch {
      // ignore
    }
  }

  async function startBackgroundEndMonitor() {
    if (!isRunning() || !pageHasIframePlayer()) return;
    try {
      await browser.runtime.sendMessage({ type: "START_END_MONITOR" });
    } catch {
      // ignore
    }
  }

  async function requestBackgroundAutoPlay() {
    try {
      await browser.runtime.sendMessage({ type: "REQUEST_AUTO_PLAY" });
    } catch {
      // ignore
    }
  }

  function stopAllMonitors() {
    stopAutoPlayRetry();
    stopIframeObserver();
    void stopBackgroundEndMonitor();
  }

  function normalizeUrl(url) {
    try {
      return new URL(url, location.href).href.split("#")[0];
    } catch {
      return url;
    }
  }

  function isValidEpisodeHref(href) {
    return href && !href.startsWith("javascript:") && href !== "#";
  }

  function isRunning() {
    return Boolean(enabled && domain);
  }

  function syncMirrorFromState() {
    sessionSet(SESSION_KEYS.mirrorEnabled, enabled ? "1" : "0");
    sessionSet(SESSION_KEYS.mirrorDomain, domain || "");
  }

  function readMirrorToState() {
    const mirrorEnabled = sessionGet(SESSION_KEYS.mirrorEnabled);
    const mirrorDomain = sessionGet(SESSION_KEYS.mirrorDomain);
    if (mirrorEnabled != null) {
      enabled = mirrorEnabled === "1";
    }
    if (mirrorDomain != null) {
      domain = mirrorDomain;
    }
  }

  function isRunningFromMirror() {
    readMirrorToState();
    return isRunning();
  }

  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // ignore
    }
  }

  function sessionRemove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  function clearSessionCaptures() {
    sessionRemove(SESSION_KEYS.episodeContainer);
    sessionRemove(SESSION_KEYS.episodeScanMode);
    sessionRemove(SESSION_KEYS.episodeCaptured);
    sessionRemove(SESSION_KEYS.playerTarget);
    sessionRemove(SESSION_KEYS.playerCaptured);
    sessionRemove(SESSION_KEYS.autoPlay);
    autoPlayPending = false;
    savedClickPoint = null;
    savedIframeIndex = -1;
    stopAllMonitors();
    void clearTabCaptureStorage();
    void browser.runtime.sendMessage({ type: "CLEAR_AUTO_PLAY" }).catch(() => {});
  }

  function isEpisodeListCaptured() {
    return sessionGet(SESSION_KEYS.episodeCaptured) === "1";
  }

  function canCaptureEpisodeList() {
    return !isEpisodeListCaptured() || episodes.length === 0;
  }

  function clearEpisodeListCapture() {
    sessionRemove(SESSION_KEYS.episodeContainer);
    sessionRemove(SESSION_KEYS.episodeScanMode);
    sessionRemove(SESSION_KEYS.episodeCaptured);
  }

  function isPlayerTargetCaptured() {
    return sessionGet(SESSION_KEYS.playerCaptured) === "1";
  }

  function buildDescriptor(element) {
    if (!element) return null;
    if (element.id) {
      return { strategy: "id", value: element.id };
    }

    const tag = element.tagName.toLowerCase();
    const classes = [...element.classList].filter(Boolean).slice(0, 4);
    if (classes.length) {
      return { strategy: "class", tag, classes };
    }

    return { strategy: "selector", value: getSimpleSelector(element) };
  }

  function getSimpleSelector(element) {
    const parts = [];
    let current = element;

    while (current && current !== document.documentElement && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${part}#${CSS.escape(current.id)}`);
        break;
      }
      if (current.classList.length) {
        const cls = [...current.classList]
          .slice(0, 2)
          .map((name) => `.${CSS.escape(name)}`)
          .join("");
        part += cls;
      }
      parts.unshift(part);
      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function findElementByDescriptor(raw) {
    if (!raw) return null;

    try {
      const descriptor = JSON.parse(raw);
      if (descriptor.strategy === "id") {
        return document.getElementById(descriptor.value);
      }
      if (descriptor.strategy === "class") {
        const selector = `${descriptor.tag}.${descriptor.classes.map((name) => CSS.escape(name)).join(".")}`;
        return document.querySelector(selector);
      }
      if (descriptor.strategy === "selector") {
        return document.querySelector(descriptor.value);
      }
    } catch {
      return null;
    }

    return null;
  }

  function anchorsToEpisodes(anchors) {
    const seen = new Set();
    const results = [];

    for (const anchor of anchors) {
      if (!isValidEpisodeHref(anchor.getAttribute("href"))) continue;
      const url = normalizeUrl(anchor.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      results.push({
        url,
        title: (anchor.textContent || "").trim().replace(/\s+/g, " ") || url,
      });
    }

    return results;
  }

  function getDirectChildAnchors(container) {
    return [...container.querySelectorAll(":scope > a[href]")].filter((node) =>
      isValidEpisodeHref(node.getAttribute("href"))
    );
  }

  function discoverEpisodeList(anchor) {
    let best = null;
    let node = anchor.parentElement;

    while (node && node !== document.body) {
      const directAnchors = getDirectChildAnchors(node);
      if (directAnchors.includes(anchor)) {
        const list = anchorsToEpisodes(directAnchors);
        if (list.length > 0 && (!best || list.length > best.list.length)) {
          best = { container: node, mode: "direct", list };
        }
      }
      node = node.parentElement;
    }

    return best;
  }

  function captureEpisodeList(anchor) {
    const found = discoverEpisodeList(anchor);
    if (!found || found.list.length === 0) return [];

    sessionSet(SESSION_KEYS.episodeContainer, JSON.stringify(buildDescriptor(found.container)));
    sessionSet(SESSION_KEYS.episodeScanMode, found.mode);
    sessionSet(SESSION_KEYS.episodeCaptured, "1");

    return found.list;
  }

  function scanEpisodesFromSavedContainer() {
    const container = findElementByDescriptor(sessionGet(SESSION_KEYS.episodeContainer));
    if (!container) return [];

    const mode = sessionGet(SESSION_KEYS.episodeScanMode) || "direct";
    const anchors =
      mode === "row-items"
        ? [...container.querySelectorAll(":scope > * > a[href]")]
        : getDirectChildAnchors(container);

    return anchorsToEpisodes(anchors);
  }

  function scanEpisodes() {
    if (!isEpisodeListCaptured()) return [];
    return scanEpisodesFromSavedContainer();
  }

  function publishEpisodes(list) {
    episodes = list;
    browser.storage.local.set({
      episodes: list,
      episodeCount: list.length,
    });
  }

  function rescanAndPublish() {
    if (!isRunning() || !isEpisodeListCaptured()) return episodes;

    const list = scanEpisodesFromSavedContainer();
    if (list.length === 0) {
      return episodes;
    }

    publishEpisodes(list);
    return list;
  }

  function buildPlayerClickPoint(event) {
    if (!event || event.clientX == null || event.clientY == null) return null;

    return {
      x: event.clientX,
      y: event.clientY,
      ratioX: event.clientX / Math.max(window.innerWidth, 1),
      ratioY: event.clientY / Math.max(window.innerHeight, 1),
    };
  }

  function getSavedIframe() {
    const saved = getSavedPlayerRoot();
    if (saved instanceof HTMLIFrameElement) {
      return saved;
    }

    const frames = playerPlay().findLargeIframes();
    if (savedIframeIndex >= 0 && frames[savedIframeIndex]) {
      return frames[savedIframeIndex];
    }

    return playerPlay().getPrimaryIframe();
  }

  function savePlayerTarget(element, event) {
    const frames = playerPlay().findLargeIframes();
    const iframe =
      element instanceof HTMLIFrameElement
        ? element
        : frames.find((frame) => frame === element || frame.contains(element));

    if (!(iframe instanceof HTMLIFrameElement)) {
      return;
    }

    const clickPoint = buildPlayerClickPoint(event);
    const iframeIndex = frames.indexOf(iframe);

    if (isPlayerTargetCaptured()) {
      if (clickPoint) {
        savedClickPoint = clickPoint;
        savedIframeIndex = iframeIndex;
        void persistTabCapture({ playerClick: clickPoint, iframeIndex });
      }
      return;
    }

    const targetRaw = JSON.stringify(buildDescriptor(iframe));
    sessionSet(SESSION_KEYS.playerTarget, targetRaw);
    sessionSet(SESSION_KEYS.playerCaptured, "1");
    savedIframeIndex = iframeIndex;

    if (clickPoint) {
      savedClickPoint = clickPoint;
    }

    void persistTabCapture({
      playerTarget: targetRaw,
      playerClick: clickPoint,
      iframeIndex,
    });
    void maybeStartEndMonitor();
  }

  function getSavedPlayerRoot() {
    return findElementByDescriptor(sessionGet(SESSION_KEYS.playerTarget));
  }

  function isPlayerRelatedElement(element) {
    if (!(element instanceof Element)) return false;
    if (element instanceof HTMLIFrameElement) return true;

    return playerPlay()
      .findLargeIframes()
      .some((frame) => frame === element || frame.contains(element));
  }

  function pageHasIframePlayer() {
    return isPlayerTargetCaptured() || playerPlay().findLargeIframes().length > 0;
  }

  async function maybeStartEndMonitor() {
    readMirrorToState();
    if (!isRunning() || !pageHasIframePlayer() || shouldAutoPlay()) return;
    if (episodes.length === 0) {
      await refreshEpisodesFromStorage();
    }
    if (episodes.length === 0) return;
    await startBackgroundEndMonitor();
  }

  function urlsMatchEpisode(currentUrl, episodeUrl) {
    const current = normalizeUrl(currentUrl);
    const episode = normalizeUrl(episodeUrl);
    if (current === episode) return true;

    try {
      const currentPath = new URL(current).pathname.replace(/\/+$/, "");
      const episodePath = new URL(episode).pathname.replace(/\/+$/, "");
      if (currentPath && currentPath === episodePath) return true;
    } catch {
      // ignore
    }

    return current.includes(episode) || episode.includes(current);
  }

  function findCurrentEpisodeIndex(list) {
    const current = normalizeUrl(location.href);
    let index = list.findIndex((item) => urlsMatchEpisode(current, item.url));
    if (index >= 0) return index;

    return list.findIndex((item) => {
      try {
        return new URL(item.url).pathname === new URL(current).pathname;
      } catch {
        return false;
      }
    });
  }

  async function markAutoPlayPending(nextUrl) {
    autoPlayPending = true;
    sessionSet(SESSION_KEYS.autoPlay, "1");

    const url = nextUrl ? normalizeUrl(nextUrl) : normalizeUrl(location.href);
    try {
      await browser.runtime.sendMessage({
        type: "MARK_AUTO_PLAY",
        url,
      });
    } catch {
      const tabId = await getCurrentTabId();
      if (tabId != null) {
        await browser.storage.local.set({
          [`vapAutoPlay_${tabId}`]: {
            pending: true,
            url,
            at: Date.now(),
          },
        });
      }
    }
  }

  function shouldAutoPlay() {
    return autoPlayPending || sessionGet(SESSION_KEYS.autoPlay) === "1";
  }

  async function clearAutoPlayPending() {
    autoPlayPending = false;
    sessionRemove(SESSION_KEYS.autoPlay);
    try {
      await browser.runtime.sendMessage({ type: "CLEAR_AUTO_PLAY" });
    } catch {
      const tabId = await getCurrentTabId();
      if (tabId != null) {
        await browser.storage.local.remove(`vapAutoPlay_${tabId}`);
      }
    }
  }

  async function refreshEpisodesFromStorage() {
    try {
      const data = await browser.storage.local.get(["episodes"]);
      if (Array.isArray(data.episodes) && data.episodes.length > 0) {
        episodes = data.episodes;
      }
    } catch {
      // ignore
    }
  }

  async function playNextEpisode() {
    readMirrorToState();
    if (!isRunning() || !pageHasIframePlayer()) return;

    await refreshEpisodesFromStorage();
    if (episodes.length === 0) return;

    const index = findCurrentEpisodeIndex(episodes);
    if (index < 0 || index >= episodes.length - 1) return;

    const nextUrl = episodes[index + 1].url;
    await stopBackgroundEndMonitor();
    await markAutoPlayPending(nextUrl);
    location.href = nextUrl;
  }

  function startAutoPlayRetry() {
    readMirrorToState();
    if (!isRunning() || !shouldAutoPlay() || !pageHasIframePlayer()) return;
    void requestBackgroundAutoPlay();
  }

  function bindIframe(frame) {
    if (boundIframes.has(frame)) return;
    boundIframes.add(frame);
    frame.addEventListener("load", () => {
      if (shouldAutoPlay()) {
        startAutoPlayRetry();
      }
    });
  }

  function observeIframesForAutoPlay() {
    if (!shouldAutoPlay()) return;

    playerPlay().findLargeIframes().forEach(bindIframe);

    if (window.__vapIframeObserver) return;
    window.__vapIframeObserver = new MutationObserver(() => {
      if (!shouldAutoPlay()) {
        stopIframeObserver();
        return;
      }
      playerPlay().findLargeIframes().forEach(bindIframe);
      void requestBackgroundAutoPlay();
    });
    window.__vapIframeObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    iframeObserverStopTimer = setTimeout(() => {
      stopIframeObserver();
    }, IFRAME_OBSERVER_MAX_MS);
  }

  function handleEpisodeCapture(event) {
    if (!isRunningFromMirror() || !canCaptureEpisodeList()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const anchor = target.closest("a[href]");
    if (!anchor || !isValidEpisodeHref(anchor.getAttribute("href"))) return;

    const list = captureEpisodeList(anchor);
    if (list.length > 0) {
      publishEpisodes(list);
      void maybeStartEndMonitor();
    }
  }

  function handlePlayerCapture(event) {
    if (!isRunningFromMirror()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!isPlayerRelatedElement(target)) return;

    savePlayerTarget(target, event);
  }

  function setupClickCapture() {
    if (window.__vapClickBound) return;
    window.__vapClickBound = true;

    document.addEventListener("mousedown", handleEpisodeCapture, true);
    document.addEventListener("pointerdown", handleEpisodeCapture, true);
    document.addEventListener("mousedown", handlePlayerCapture, true);
    document.addEventListener("pointerdown", handlePlayerCapture, true);
    document.addEventListener("click", handlePlayerCapture, true);
  }

  async function bootstrapPlayback() {
    if (!tabStateReady) {
      await restoreTabState();
    }

    readMirrorToState();
    if (!isRunning()) return;

    rescanAndPublish();

    if (!pageHasIframePlayer()) {
      return;
    }

    if (shouldAutoPlay()) {
      observeIframesForAutoPlay();
      startAutoPlayRetry();
      return;
    }

    void maybeStartEndMonitor();
  }

  function applyStorage(data, options = {}) {
    enabled = Boolean(data.enabled);
    domain = data.domain || "";
    episodes = Array.isArray(data.episodes) ? data.episodes : [];

    if (!enabled) {
      clearSessionCaptures();
      stopAllMonitors();
      syncMirrorFromState();
      return;
    }

    if (options.resetCaptures) {
      clearSessionCaptures();
      episodes = [];
    }

    syncMirrorFromState();
    setupClickCapture();
    bootstrapPlayback();
  }

  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (!changes.enabled && !changes.domain && !changes.episodes && !changes.episodeCount) return;

    const resetCaptures =
      changes.enabled?.newValue === true && changes.enabled?.oldValue === false;

    browser.storage.local
      .get(["enabled", "domain", "episodes", "episodeCount"])
      .then((data) => {
        applyStorage(data, { resetCaptures });
        if (Boolean(data.enabled) && data.domain) {
          bootstrapPlayback();
        }
      });
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "PING":
        sendResponse({ ok: true });
        break;
      case "SCAN_EPISODES": {
        const list = scanEpisodes();
        if (list.length > 0) {
          publishEpisodes(list);
        }
        sendResponse({ episodes: list, episodeCount: list.length });
        break;
      }
      case "AUTO_PLAY_NOW":
        readMirrorToState();
        if (isRunning() && shouldAutoPlay() && pageHasIframePlayer()) {
          observeIframesForAutoPlay();
          startAutoPlayRetry();
        }
        sendResponse({ playing: false });
        break;
      case "AUTO_PLAY_SUCCEEDED":
        void clearAutoPlayPending();
        stopAutoPlayRetry();
        stopIframeObserver();
        void maybeStartEndMonitor();
        sendResponse({ ok: true });
        break;
      case "AUTO_PLAY_FAILED":
        void clearAutoPlayPending();
        stopAutoPlayRetry();
        stopIframeObserver();
        void maybeStartEndMonitor();
        sendResponse({ ok: true });
        break;
      case "PLAY_NEXT_EPISODE":
        void playNextEpisode();
        sendResponse({ ok: true });
        break;
      default:
        sendResponse({ error: "unknown_message" });
    }
    return true;
  });

  async function initExtension() {
    await restoreTabState();
    const data = await browser.storage.local.get([
      "enabled",
      "domain",
      "episodes",
      "episodeCount",
    ]);
    applyStorage(data);
  }

  void initExtension();

  window.addEventListener("pageshow", () => {
    void (async () => {
      await restoreTabState();
      const data = await browser.storage.local.get([
        "enabled",
        "domain",
        "episodes",
        "episodeCount",
      ]);
      applyStorage(data);
      await bootstrapPlayback();
    })();
  });

  window.addEventListener("pagehide", () => {
    stopAllMonitors();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      void bootstrapPlayback();
    });
  } else {
    setTimeout(() => {
      void bootstrapPlayback();
    }, 300);
  }
})();
