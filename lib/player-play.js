(() => {
  function findLargeIframes(root = document, minSize = 120) {
    const iframes =
      root instanceof Document || root instanceof Element
        ? [...root.querySelectorAll("iframe")]
        : [];

    return iframes
      .filter((frame) => frame.offsetWidth >= minSize && frame.offsetHeight >= minSize)
      .sort(
        (a, b) =>
          b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight
      );
  }

  function getPrimaryIframe(root = document) {
    return findLargeIframes(root)[0] || null;
  }

  function clickAtPoint(x, y) {
    const target = document.elementFromPoint(x, y);
    if (!(target instanceof Element)) return false;

    const base = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      view: window,
    };

    for (const type of ["pointerdown", "mousedown", "mouseup", "click", "pointerup"]) {
      try {
        target.dispatchEvent(
          new PointerEvent(type, {
            ...base,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        );
      } catch {
        // ignore
      }
      target.dispatchEvent(new MouseEvent(type, base));
    }

    if (target instanceof HTMLElement) {
      target.click();
    }

    return true;
  }

  function clickElementCenter(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return clickAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function resolveClickPoint(clickPoint) {
    if (!clickPoint) return null;

    if (clickPoint.ratioX != null && clickPoint.ratioY != null) {
      return {
        x: clickPoint.ratioX * window.innerWidth,
        y: clickPoint.ratioY * window.innerHeight,
      };
    }

    if (clickPoint.x != null && clickPoint.y != null) {
      return { x: clickPoint.x, y: clickPoint.y };
    }

    return null;
  }

  function activateIframePlayer(options = {}) {
    let iframe = options.iframe;
    if (!(iframe instanceof HTMLIFrameElement)) {
      const frames = findLargeIframes();
      if (Number.isInteger(options.iframeIndex) && options.iframeIndex >= 0) {
        iframe = frames[options.iframeIndex] || null;
      }
      if (!(iframe instanceof HTMLIFrameElement)) {
        iframe = getPrimaryIframe();
      }
    }

    if (iframe instanceof HTMLIFrameElement) {
      iframe.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      try {
        iframe.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }

    const clickPoint = resolveClickPoint(options.clickPoint);
    let clicked = false;

    if (clickPoint) {
      clicked = clickAtPoint(clickPoint.x, clickPoint.y);
    }

    if (iframe instanceof HTMLIFrameElement) {
      clicked = clickElementCenter(iframe) || clicked;
    }

    return clicked;
  }

  window.__vapPlayerPlay = {
    findLargeIframes,
    getPrimaryIframe,
    clickAtPoint,
    clickElementCenter,
    activateIframePlayer,
  };
})();
