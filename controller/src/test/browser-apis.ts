import { beforeEach } from "vitest";
// jsdom has no layout engine. Carbon observes element sizes and media queries;
// production behavior is verified separately in a real desktop browser.
function installBrowserApis() {
  if (typeof window === "undefined") return;
  if (!globalThis.ResizeObserver)
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  if (!window.matchMedia)
    window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return true;
      },
    });
  if (!document.getElementById("carbon-test-layout")) {
    const style = document.createElement("style");
    style.id = "carbon-test-layout";
    style.textContent =
      ".cds--text-input__counter-alert:empty,.cds--text-area__counter-alert:empty{display:none}";
    document.head.append(style);
  }
  if (!Element.prototype.scrollIntoView)
    Element.prototype.scrollIntoView = function () {};
}
installBrowserApis();
beforeEach(installBrowserApis);

// FloatingMenu waits for positive layout dimensions. Only menus need this stub;
// jsdom cannot lay them out, while real-browser QA verifies their actual placement.
if (typeof Element !== "undefined") {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("cds--overflow-menu-options"))
      return new DOMRect(0, 0, 240, 160);
    return original.call(this);
  };
}
