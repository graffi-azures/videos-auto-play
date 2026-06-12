/* Episode list auto-scan from playlist-class anchors + iframe auto play. */

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
  };

  const IFRAME_OBSERVER_MAX_MS = 45000;

  const EPISODE_LINK_CLASS_PATTERN =
    /(?:playlist|play-list|play_list|play-list|ep-?list|eplist|episode|num-?list|serial|series|选集|剧集|分集|集数|ju-?list|sortlist)/i;

  const ACTIVE_TAB_PANEL_SELECTORS = [
    '[role="tabpanel"][aria-hidden="false"]',
    ".tab-pane.active",
    ".tab-pane.show.active",
    ".tab-pane.show",
    ".tab-content > .active",
    ".tab-body > .active",
    ".tabs-content > .active",
    '[class*="tab-panel"].active',
    '[class*="tab-panel"][class*="active"]',
    '[class*="tabPanel"].active',
    '[class*="tab-con"].active',
    '[class*="tabCon"].active',
  ];

  const TAB_TRIGGER_SELECTORS = [
    '[role="tab"][aria-selected="true"]',
    ".nav-tabs .active",
    ".nav-tabs .show",
    '[class*="tab-item"].active',
    '[class*="tab-item"].on',
    '[class*="tab-item"].cur',
    '[class*="tabItem"].active',
    '[class*="tab-btn"].active',
    '[class*="tab-btn"].on',
    '[class*="tabBtn"].active',
    '[class*="tab-nav"] .active',
    '[class*="tab-nav"] .on',
    '[class*="tab-nav"] .cur',
  ];

  const TAB_CONTENT_WRAPPER_SELECTORS = [
    '[class*="tab-content"]',
    '[class*="tabContent"]',
    '[class*="tabs-content"]',
    '[class*="tab-con"]',
    '[class*="tabCon"]',
    '[class*="tab-body"]',
  ];

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
  let bootstrapDelayTimer = null;
  let bootstrapRunId = 0;
  const boundIframes = new WeakSet();
  let settingsReady = false;
  let settingsReadyPromise = null;

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

  function clearBootstrapDelayTimer() {
    if (bootstrapDelayTimer != null) {
      clearTimeout(bootstrapDelayTimer);
      bootstrapDelayTimer = null;
    }
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
    } catch (error) {
      vapLogError("end-monitor", error, { action: "stop" });
    }
  }

  async function startBackgroundEndMonitor() {
    if (!isRunning() || !pageHasIframePlayer()) return;
    try {
      await browser.runtime.sendMessage({ type: "START_END_MONITOR" });
      vapLog.info("end-monitor", "started background end monitor");
    } catch (error) {
      vapLogError("end-monitor", error, { action: "start" });
    }
  }

  async function requestBackgroundAutoPlay() {
    try {
      await browser.runtime.sendMessage({ type: "REQUEST_AUTO_PLAY" });
      vapLog.info("autoplay", "requested background auto play");
    } catch (error) {
      vapLogError("autoplay", error, { action: "request" });
    }
  }

  function stopAllMonitors() {
    bootstrapRunId += 1;
    stopAutoPlayRetry();
    stopIframeObserver();
    clearBootstrapDelayTimer();
    void stopBackgroundEndMonitor();
  }

  function scheduleBootstrapPlayback(delayMs = 0) {
    clearBootstrapDelayTimer();
    const runId = ++bootstrapRunId;
    bootstrapDelayTimer = setTimeout(() => {
      bootstrapDelayTimer = null;
      if (runId !== bootstrapRunId) return;
      void bootstrapPlayback().catch(() => {
        stopAllMonitors();
      });
    }, delayMs);
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

  function hasPlaylistClass(element) {
    if (!(element instanceof Element)) return false;
    for (const name of element.classList) {
      if (EPISODE_LINK_CLASS_PATTERN.test(name)) {
        return true;
      }
    }
    return false;
  }

  function isEpisodeAnchor(anchor) {
    return (
      anchor instanceof HTMLAnchorElement &&
      isValidEpisodeHref(anchor.getAttribute("href")) &&
      hasPlaylistClass(anchor)
    );
  }

  function isElementVisible(element) {
    if (!(element instanceof Element)) return false;
    if (element.hidden) return false;

    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    return element.getClientRects().length > 0;
  }

  function hasActiveTabClass(element) {
    if (!(element instanceof Element)) return false;
    if (element.getAttribute("aria-selected") === "true") return true;

    for (const name of element.classList) {
      if (/^(active|cur|current|selected|show)$/i.test(name)) return true;
      if (/^(?:is-)?active$/i.test(name)) return true;
      if (/^(?:tab-)?on$/i.test(name)) return true;
      if (/tab.*active|active.*tab/i.test(name)) return true;
    }

    return false;
  }

  function countEpisodeAnchors(root) {
    return [...root.querySelectorAll("a[href]")].filter(isEpisodeAnchor).length;
  }

  function pickBestTabPanel(candidates) {
    let best = null;
    let bestCount = -1;

    for (const panel of candidates) {
      if (!isElementVisible(panel)) continue;
      const count = countEpisodeAnchors(panel);
      if (count > bestCount) {
        best = panel;
        bestCount = count;
      }
    }

    return best;
  }

  function resolveTabPanelFromTrigger(trigger) {
    if (!(trigger instanceof Element)) return null;

    const href = trigger.getAttribute("href");
    if (href?.startsWith("#") && href.length > 1) {
      const panel = document.querySelector(href);
      if (panel instanceof Element) return panel;
    }

    const controls = trigger.getAttribute("aria-controls");
    if (controls) {
      const panel = document.getElementById(controls);
      if (panel instanceof Element) return panel;
    }

    const target = trigger.dataset?.target || trigger.dataset?.bsTarget;
    if (target) {
      const panel = document.querySelector(target);
      if (panel instanceof Element) return panel;
    }

    const nav = trigger.closest('[class*="tab-nav"], [class*="tabNav"], .nav-tabs, ul');
    const contentRoot = nav?.parentElement;
    if (!nav || !contentRoot) return null;

    const triggers = [...nav.querySelectorAll("a, [role='tab'], li")].filter(
      (node) => node instanceof Element
    );
    const index = triggers.findIndex(
      (node) => node === trigger || node.contains(trigger) || trigger.contains(node)
    );
    if (index < 0) return null;

    for (const selector of TAB_CONTENT_WRAPPER_SELECTORS) {
      const wrapper = contentRoot.querySelector(selector);
      if (!(wrapper instanceof Element)) continue;
      const panel = wrapper.children[index];
      if (panel instanceof Element) return panel;
    }

    return null;
  }

  function findVisibleTabPanelFromWrappers() {
    for (const selector of TAB_CONTENT_WRAPPER_SELECTORS) {
      for (const wrapper of document.querySelectorAll(selector)) {
        const visibleChildren = [...wrapper.children].filter(isElementVisible);
        const withEpisodes = visibleChildren.filter((child) => countEpisodeAnchors(child) > 0);
        if (withEpisodes.length === 0) continue;

        const activeChild = withEpisodes.find(
          (child) => hasActiveTabClass(child) || child.querySelector(".active, .on, .cur, .current, .selected")
        );
        if (activeChild) return activeChild;

        if (withEpisodes.length === 1) return withEpisodes[0];
        return pickBestTabPanel(withEpisodes);
      }
    }

    return null;
  }

  function findActiveTabPanel() {
    for (const selector of ACTIVE_TAB_PANEL_SELECTORS) {
      let matches = [];
      try {
        matches = [...document.querySelectorAll(selector)].filter(isElementVisible);
      } catch {
        matches = [];
      }

      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const activeMatches = matches.filter(hasActiveTabClass);
        if (activeMatches.length === 1) return activeMatches[0];
        const picked = pickBestTabPanel(activeMatches.length ? activeMatches : matches);
        if (picked) return picked;
      }
    }

    for (const selector of TAB_TRIGGER_SELECTORS) {
      let triggers = [];
      try {
        triggers = [...document.querySelectorAll(selector)];
      } catch {
        triggers = [];
      }

      for (const trigger of triggers) {
        const panel = resolveTabPanelFromTrigger(trigger);
        if (panel instanceof Element && isElementVisible(panel)) {
          return panel;
        }
      }
    }

    return findVisibleTabPanelFromWrappers();
  }

  function getEpisodeSearchRoot() {
    return findActiveTabPanel() || document;
  }

  function isWithinEpisodeSearchRoot(element, root = getEpisodeSearchRoot()) {
    if (!(element instanceof Element)) return false;
    return root === document || root.contains(element);
  }

  function isRunning() {
    return Boolean(enabled && domain);
  }

  function loadPluginSettings(data, options = {}) {
    enabled = Boolean(data.enabled);
    domain = data.domain || "";
    episodes = Array.isArray(data.episodes) ? data.episodes : [];

    if (!enabled) {
      clearSessionCaptures();
      stopAllMonitors();
      return false;
    }

    if (options.resetCaptures) {
      clearSessionCaptures();
      episodes = [];
    }

    return true;
  }

  async function ensureSettingsLoaded() {
    if (settingsReady) return;
    if (settingsReadyPromise) {
      await settingsReadyPromise;
      return;
    }

    settingsReadyPromise = (async () => {
      const data = await browser.storage.local.get([
        "enabled",
        "domain",
        "episodes",
        "episodeCount",
      ]);
      loadPluginSettings(data);
      settingsReady = true;
    })();

    await settingsReadyPromise;
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
    return [...container.querySelectorAll(":scope > a[href]")].filter(isEpisodeAnchor);
  }

  function getRowItemAnchors(container) {
    return [...container.querySelectorAll(":scope > * > a[href]")].filter(isEpisodeAnchor);
  }

  function discoverEpisodeList(anchor, root = getEpisodeSearchRoot()) {
    if (!isEpisodeAnchor(anchor) || !isWithinEpisodeSearchRoot(anchor, root)) return null;

    let best = null;
    let node = anchor.parentElement;

    while (node && node !== document.body && isWithinEpisodeSearchRoot(node, root)) {
      const directAnchors = getDirectChildAnchors(node);
      if (directAnchors.includes(anchor)) {
        const list = anchorsToEpisodes(directAnchors);
        if (list.length > 0 && (!best || list.length > best.list.length)) {
          best = { container: node, mode: "direct", list };
        }
      }

      const rowAnchors = getRowItemAnchors(node);
      if (rowAnchors.includes(anchor)) {
        const list = anchorsToEpisodes(rowAnchors);
        if (list.length > 0 && (!best || list.length > best.list.length)) {
          best = { container: node, mode: "row-items", list };
        }
      }

      node = node.parentElement;
    }

    return best;
  }

  function discoverEpisodeListAuto() {
    const root = getEpisodeSearchRoot();
    const seeds = [...root.querySelectorAll("a[href]")].filter(isEpisodeAnchor);
    if (seeds.length === 0) return null;

    let best = null;
    for (const anchor of seeds) {
      const found = discoverEpisodeList(anchor, root);
      if (found && found.list.length > 0 && (!best || found.list.length > best.list.length)) {
        best = found;
      }
    }

    return best;
  }

  function saveEpisodeListCapture(found) {
    sessionSet(SESSION_KEYS.episodeContainer, JSON.stringify(buildDescriptor(found.container)));
    sessionSet(SESSION_KEYS.episodeScanMode, found.mode);
    sessionSet(SESSION_KEYS.episodeCaptured, "1");
  }

  function captureEpisodeList(anchor) {
    const found = discoverEpisodeList(anchor);
    if (!found || found.list.length === 0) return [];

    saveEpisodeListCapture(found);
    return found.list;
  }

  function scanEpisodesFromSavedContainer() {
    const container = findElementByDescriptor(sessionGet(SESSION_KEYS.episodeContainer));
    if (!container) return [];

    const root = getEpisodeSearchRoot();
    if (root !== document && !root.contains(container)) {
      return [];
    }
    if (!isElementVisible(container)) {
      return [];
    }

    const mode = sessionGet(SESSION_KEYS.episodeScanMode) || "direct";
    const anchors = mode === "row-items" ? getRowItemAnchors(container) : getDirectChildAnchors(container);

    return anchorsToEpisodes(anchors);
  }

  function scanEpisodes(options = {}) {
    if (options.rediscover) {
      clearEpisodeListCapture();
    }

    if (isEpisodeListCaptured() && !options.rediscover) {
      const saved = scanEpisodesFromSavedContainer();
      if (saved.length > 0) {
        return saved;
      }
    }

    const found = discoverEpisodeListAuto();
    if (found) {
      saveEpisodeListCapture(found);
      return found.list;
    }

    return [];
  }

  function autoScanAndPublish(options = {}) {
    if (!isRunning()) return episodes;

    const list = scanEpisodes(options);
    if (list.length > 0) {
      publishEpisodes(list);
      void maybeStartEndMonitor();
      vapLog.info("scan", "episode list updated on page", { count: list.length });
    } else if (options.rediscover) {
      vapLog.warn("scan", "no episode list found on page");
    }
    return list;
  }

  function publishEpisodes(list) {
    episodes = list;
    browser.storage.local.set({
      episodes: list,
      episodeCount: list.length,
    });
  }

  function rescanAndPublish() {
    return autoScanAndPublish({ rediscover: false });
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
    await ensureSettingsLoaded();
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
    await ensureSettingsLoaded();
    if (!isRunning() || !pageHasIframePlayer()) return;

    await refreshEpisodesFromStorage();
    if (episodes.length === 0) return;

    const index = findCurrentEpisodeIndex(episodes);
    if (index < 0 || index >= episodes.length - 1) {
      vapLog.warn("autoplay", "cannot play next episode", {
        index,
        total: episodes.length,
        current: location.href,
      });
      return;
    }

    const nextUrl = episodes[index + 1].url;
    vapLog.info("autoplay", "navigating to next episode", { index: index + 1, nextUrl });
    await stopBackgroundEndMonitor();
    await markAutoPlayPending(nextUrl);
    location.href = nextUrl;
  }

  function startAutoPlayRetry() {
    void (async () => {
      await ensureSettingsLoaded();
      if (!isRunning() || !shouldAutoPlay() || !pageHasIframePlayer()) return;
      void requestBackgroundAutoPlay();
    })();
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
    if (!shouldAutoPlay()) {
      stopIframeObserver();
      return;
    }

    playerPlay().findLargeIframes().forEach(bindIframe);

    stopIframeObserver();
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
    void (async () => {
      await ensureSettingsLoaded();
      if (!isRunning()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;

    const anchor = target.closest("a[href]");
    if (!isEpisodeAnchor(anchor)) return;

    const list = captureEpisodeList(anchor);
    if (list.length > 0) {
      publishEpisodes(list);
      void maybeStartEndMonitor();
    }
    })();
  }

  function handlePlayerCapture(event) {
    void (async () => {
      await ensureSettingsLoaded();
      if (!isRunning()) return;

    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!isPlayerRelatedElement(target)) return;

    savePlayerTarget(target, event);
    })();
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
    try {
      await ensureSettingsLoaded();
      if (!tabStateReady) {
        await restoreTabState();
      }

      if (!isRunning()) return;

      autoScanAndPublish({ rediscover: false });

      if (!pageHasIframePlayer()) {
        return;
      }

      if (shouldAutoPlay()) {
        observeIframesForAutoPlay();
        startAutoPlayRetry();
        return;
      }

      void maybeStartEndMonitor();
    } catch (error) {
      vapLogError("bootstrap", error);
      stopAllMonitors();
    }
  }

  function applyStorage(data, options = {}) {
    settingsReady = true;
    const wasEnabled = enabled;
    const active = loadPluginSettings(data, options);
    if (!active) {
      if (wasEnabled || data.enabled === false) {
        vapLog.info("plugin", "plugin inactive on page", { enabled: false, domain: data.domain || "" });
      }
      return;
    }

    if (options.resetCaptures) {
      vapLog.info("plugin", "plugin enabled, captures reset");
    } else if (!wasEnabled && enabled) {
      vapLog.info("plugin", "plugin active on page", { domain });
    }

    setupClickCapture();
    void bootstrapPlayback();
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
      });
  });

  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.type) {
      case "PING":
        sendResponse({ ok: true });
        break;
      case "SCAN_EPISODES": {
        const list = scanEpisodes({ rediscover: Boolean(message.rediscover) });
        if (list.length > 0) {
          publishEpisodes(list);
          void maybeStartEndMonitor();
        }
        sendResponse({ episodes: list, episodeCount: list.length });
        break;
      }
      case "AUTO_PLAY_NOW":
        void (async () => {
          await ensureSettingsLoaded();
          if (isRunning() && shouldAutoPlay() && pageHasIframePlayer()) {
            observeIframesForAutoPlay();
            startAutoPlayRetry();
          }
          sendResponse({ playing: false });
        })();
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
    try {
      await restoreTabState();
      await ensureSettingsLoaded();
      if (isRunning()) {
        setupClickCapture();
      }
    } catch (error) {
      vapLogError("init", error);
      stopAllMonitors();
    }
  }

  void initExtension();

  window.addEventListener("pageshow", () => {
    void (async () => {
      stopAllMonitors();
      try {
        await restoreTabState();
        settingsReady = false;
        settingsReadyPromise = null;
        await ensureSettingsLoaded();
        if (isRunning()) {
          setupClickCapture();
          await bootstrapPlayback();
        }
      } catch (error) {
        vapLogError("page", error, { phase: "pageshow" });
        stopAllMonitors();
      }
    })();
  });

  window.addEventListener("pagehide", () => {
    stopAllMonitors();
  });

  window.addEventListener("beforeunload", () => {
    stopAllMonitors();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      scheduleBootstrapPlayback(0);
    });
  } else {
    scheduleBootstrapPlayback(300);
  }
})();
