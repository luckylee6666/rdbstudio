import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";

// Fallback __TAURI_INTERNALS__ so anything that reads it without mockIPC
// won't explode. mockIPC() below overrides this per-test.
declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke: (...args: unknown[]) => unknown;
      transformCallback: (...args: unknown[]) => unknown;
    };
  }
}

if (typeof window !== "undefined") {
  window.__TAURI_INTERNALS__ = {
    invoke: vi.fn(),
    transformCallback: vi.fn(),
  };
}

afterEach(() => {
  clearMocks();
  // Re-install fallback in case clearMocks wiped the internals object.
  if (typeof window !== "undefined") {
    window.__TAURI_INTERNALS__ = {
      invoke: vi.fn(),
      transformCallback: vi.fn(),
    };
  }
});
