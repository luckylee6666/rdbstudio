// Platform detection for UI affordances (modifier-key labels, macOS
// traffic-light padding). navigator.platform is deprecated but still the most
// reliable signal in an offline desktop webview — `userAgentData` isn't
// supported in WKWebView; falls back to userAgent where platform is empty.
export const isMac: boolean = (() => {
  if (typeof navigator === "undefined") return false;
  const haystack =
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    navigator.platform || navigator.userAgent || "";
  return /Mac|iPhone|iPad/i.test(haystack);
})();

export const modKey = isMac ? "⌘" : "Ctrl";
export const shiftKey = isMac ? "⇧" : "Shift";
export const enterKey = isMac ? "↵" : "Enter";
