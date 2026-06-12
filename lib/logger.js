/* Background logger: persists to storage and exports to Downloads/videos-auto-play/vap-debug.log */

const VAP_LOG_STORAGE_KEY = "vapLogText";
const VAP_LOG_MAX_CHARS = 250000;
const VAP_LOG_FILE = "videos-auto-play/vap-debug.log";
const VAP_LOG_FILE_FLUSH_MS = 15000;
const VAP_LOG_PERSIST_MS = 5000;

let logBuffer = "";
let logLoaded = false;
let logFlushTimer = null;
let logPersistTimer = null;
let logFlushInFlight = false;

function serializeDetail(detail) {
  if (detail == null) return "";
  try {
    const text = typeof detail === "string" ? detail : JSON.stringify(detail);
    return text.length > 2000 ? `${text.slice(0, 2000)}…` : text;
  } catch {
    return String(detail);
  }
}

function formatLogLine(level, category, message, detail, meta) {
  const url = meta?.url ? ` url=${meta.url}` : "";
  const tab = meta?.tabId != null ? ` tab=${meta.tabId}` : "";
  const detailText = detail == null ? "" : ` detail=${serializeDetail(detail)}`;
  return `[${new Date().toISOString()}] [${level}] [${category}]${tab}${url} ${message}${detailText}`;
}

async function loadLogBuffer() {
  if (logLoaded) return;
  try {
    const data = await browser.storage.local.get(VAP_LOG_STORAGE_KEY);
    logBuffer = typeof data[VAP_LOG_STORAGE_KEY] === "string" ? data[VAP_LOG_STORAGE_KEY] : "";
  } catch {
    logBuffer = "";
  }
  logLoaded = true;
}

async function persistLogBuffer() {
  try {
    await browser.storage.local.set({ [VAP_LOG_STORAGE_KEY]: logBuffer });
  } catch {
    // ignore
  }
}

function schedulePersistLogBuffer() {
  if (logPersistTimer != null) return;
  logPersistTimer = setTimeout(() => {
    logPersistTimer = null;
    void persistLogBuffer();
  }, VAP_LOG_PERSIST_MS);
}

function scheduleLogFileFlush(immediate = false) {
  if (immediate) {
    if (logFlushTimer != null) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    void flushLogToFile();
    return;
  }
  if (logFlushTimer != null) return;
  logFlushTimer = setTimeout(() => {
    logFlushTimer = null;
    void flushLogToFile();
  }, VAP_LOG_FILE_FLUSH_MS);
}

async function flushLogToFile() {
  if (logFlushInFlight || !logBuffer) return;
  logFlushInFlight = true;
  try {
    const blob = new Blob([logBuffer], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      await browser.downloads.download({
        url,
        filename: VAP_LOG_FILE,
        conflictAction: "overwrite",
        saveAs: false,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    }
  } catch (error) {
    console.error("[Videos Auto Play] failed to write log file", error);
  } finally {
    logFlushInFlight = false;
  }
}

async function writeVapLog(level, category, message, detail, meta = {}) {
  await loadLogBuffer();
  const line = formatLogLine(level, category, message, detail, meta);
  logBuffer += `${line}\n`;
  if (logBuffer.length > VAP_LOG_MAX_CHARS) {
    logBuffer = logBuffer.slice(logBuffer.length - VAP_LOG_MAX_CHARS);
  }

  if (level === "ERROR") {
    console.error("[Videos Auto Play]", line);
    void persistLogBuffer();
    scheduleLogFileFlush(true);
  } else if (level === "WARN") {
    console.warn("[Videos Auto Play]", line);
    void persistLogBuffer();
    scheduleLogFileFlush(false);
  } else {
    schedulePersistLogBuffer();
  }
}

function vapLogError(category, error, detail, meta) {
  const err = error instanceof Error ? error : new Error(String(error));
  return writeVapLog(
    "ERROR",
    category,
    err.message,
    { ...(detail || {}), stack: err.stack },
    meta
  );
}

const vapLog = {
  info(category, message, detail, meta) {
    return writeVapLog("INFO", category, message, detail, meta);
  },
  warn(category, message, detail, meta) {
    return writeVapLog("WARN", category, message, detail, meta);
  },
  error(category, message, detail, meta) {
    return writeVapLog("ERROR", category, message, detail, meta);
  },
};

async function handleVapLogMessage(message, sender) {
  const meta = {
    tabId: sender?.tab?.id,
    url: message.url || sender?.tab?.url,
  };
  await writeVapLog(
    message.level || "INFO",
    message.category || "unknown",
    message.message || "",
    message.detail,
    meta
  );
}

void loadLogBuffer();
