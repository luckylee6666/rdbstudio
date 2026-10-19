import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateSettings } from "./UpdateSettings";
import { useI18n } from "@/store/i18n";

const mocks = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: mocks.check }));

describe("UpdateSettings", () => {
  beforeEach(() => {
    mocks.check.mockReset().mockResolvedValue(null);
    useI18n.setState({ lang: "en" });
  });
  afterEach(() => vi.clearAllMocks());

  it("keeps the mounted guard active after StrictMode's effect replay", async () => {
    render(<StrictMode><UpdateSettings /></StrictMode>);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("You are on the latest version")).toBeInTheDocument();
    expect(mocks.check).toHaveBeenCalledOnce();
  });

  it("confirms installation and shows download progress", async () => {
    let finishDownload: (() => void) | undefined;
    const update = {
      version: "1.2.3",
      close: vi.fn().mockResolvedValue(undefined),
      downloadAndInstall: vi.fn(async (onEvent: (event: { event: string; data: { contentLength?: number; chunkLength?: number } }) => void) => {
        onEvent({ event: "Started", data: { contentLength: 8 } });
        onEvent({ event: "Progress", data: { chunkLength: 2 } });
        await new Promise<void>((resolve) => { finishDownload = resolve; });
      }),
    };
    mocks.check.mockResolvedValue(update);
    render(<UpdateSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("Update available: 1.2.3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Download & install" }));
    // The confirmation dialog repeats the action label on its confirm button.
    const confirmButtons = screen.getAllByRole("button", { name: "Download & install" });
    fireEvent.click(confirmButtons[confirmButtons.length - 1]);
    await waitFor(() => expect(update.downloadAndInstall).toHaveBeenCalledOnce());
    expect(await screen.findByText("25%")).toBeInTheDocument();
    await act(async () => { finishDownload?.(); });
    expect(await screen.findByText("Update installed. Restart to use it.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart app" })).toBeInTheDocument();
  });
});
