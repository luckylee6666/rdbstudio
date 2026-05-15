import { writeText as pluginWriteText } from "@tauri-apps/plugin-clipboard-manager";

// Unified clipboard write. Tauri 2's WKWebView is unreliable through the
// standard navigator.clipboard API (it requires plugin-clipboard-manager
// to be installed AND granted), so we prefer the plugin and only fall back
// to the web API in environments where it works (vitest / a real browser).
// Returns true on success so callers can flip "Copied!" state honestly.
export async function copyText(text: string): Promise<boolean> {
  try {
    await pluginWriteText(text);
    return true;
  } catch {
    // Plugin not available in non-Tauri contexts (tests, web preview) —
    // fall back to the standard API where it actually works.
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      /* fall through */
    }
    return false;
  }
}
