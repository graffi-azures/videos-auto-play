(() => {
  if (globalThis.__vapLogClientLoaded) {
    return;
  }
  globalThis.__vapLogClientLoaded = true;

  function send(level, category, message, detail) {
    try {
      browser.runtime
        .sendMessage({
          type: "VAP_LOG",
          level,
          category,
          message,
          detail,
          url: globalThis.location?.href,
        })
        .catch(() => {});
    } catch {
      // ignore
    }
  }

  globalThis.vapLog = {
    info(category, message, detail) {
      send("INFO", category, message, detail);
    },
    warn(category, message, detail) {
      send("WARN", category, message, detail);
    },
    error(category, message, detail) {
      send("ERROR", category, message, detail);
    },
  };

  globalThis.vapLogError = (category, error, detail) => {
    const err = error instanceof Error ? error : new Error(String(error));
    send("ERROR", category, err.message, { ...(detail || {}), stack: err.stack });
  };
})();
