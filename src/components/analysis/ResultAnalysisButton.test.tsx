import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ResultAnalysisButton } from "./ResultAnalysisButton";
import type { AnalysisSnapshot } from "./ResultAnalysis";
import { useI18n } from "@/store/i18n";

const { load, mounted } = vi.hoisted(() => ({ load: vi.fn(), mounted: vi.fn() }));
vi.mock("./loadResultAnalysis", () => ({ loadResultAnalysis: load }));

const snapshot: AnalysisSnapshot = {
  columns: [{ name: "amount", data_type: "INTEGER" }], rows: [[7]],
  label: "Original snapshot", scope: "result",
};
const refreshed: AnalysisSnapshot = { ...snapshot, rows: [[19]], label: "Refreshed snapshot", scope: "page" };
function FakeAnalysis({ snapshot, onClose }: { snapshot: AnalysisSnapshot; onClose: () => void }) {
  mounted(snapshot);
  return <div role="dialog" aria-label="Loaded analysis"><p>{JSON.stringify(snapshot)}</p><button onClick={onClose}>Close loaded analysis</button></div>;
}
const module = { ResultAnalysis: FakeAnalysis };
function deferred() {
  let resolve!: (value: typeof module) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<typeof module>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const open = () => fireEvent.click(screen.getByRole("button", { name: "Analyze data" }));
beforeEach(() => { vi.resetAllMocks(); useI18n.setState({ lang: "en" }); });

describe("analysis module loading", () => {
  it("does not request analysis before a valid click, including compact and disabled buttons", async () => {
    load.mockResolvedValue(module);
    const ui = render(<ResultAnalysisButton {...snapshot} columns={[]} compact />);
    expect(screen.getByRole("button", { name: "Analyze data" })).toBeDisabled(); open();
    ui.rerender(<ResultAnalysisButton {...snapshot} disabled />); open();
    expect(load).not.toHaveBeenCalled();
    ui.rerender(<ResultAnalysisButton {...snapshot} compact />); open();
    expect(screen.getByRole("status")).toHaveTextContent("Opening result analysis");
    expect(screen.getByRole("button", { name: "Analyze data" })).toBeDisabled();
    await screen.findByRole("dialog", { name: "Loaded analysis" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("holds the clicked snapshot through loading and captures fresh data only on reopening", async () => {
    const pending = deferred(); load.mockReturnValueOnce(pending.promise).mockResolvedValue(module);
    const ui = render(<ResultAnalysisButton {...snapshot} />); open();
    ui.rerender(<ResultAnalysisButton {...refreshed} />);
    await act(async () => pending.resolve(module));
    expect(mounted).toHaveBeenLastCalledWith(snapshot);
    fireEvent.click(screen.getByRole("button", { name: "Close loaded analysis" })); open();
    await screen.findByRole("dialog", { name: "Loaded analysis" });
    expect(mounted).toHaveBeenLastCalledWith(refreshed);
  });

  it("shows a recoverable error without exposing import details and retries the same snapshot", async () => {
    load.mockRejectedValueOnce(new Error("private module path")).mockResolvedValue(module);
    const ui = render(<ResultAnalysisButton {...snapshot} />); open();
    const alert = await screen.findByRole("alert"); expect(alert).toHaveTextContent("Unable to open result analysis");
    expect(alert).not.toHaveTextContent("private module path");
    ui.rerender(<ResultAnalysisButton {...refreshed} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry analysis" }));
    await screen.findByRole("dialog", { name: "Loaded analysis" });
    expect(load).toHaveBeenCalledTimes(2); expect(mounted).toHaveBeenLastCalledWith(snapshot);
  });

  it("ignores a closed request even when a new loading dialog is already open", async () => {
    const old = deferred(), next = deferred(); load.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    const ui = render(<ResultAnalysisButton {...snapshot} />); open();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    ui.rerender(<ResultAnalysisButton {...refreshed} />); open();
    await act(async () => old.resolve(module));
    expect(mounted).not.toHaveBeenCalled(); expect(screen.getByRole("status")).toBeInTheDocument();
    await act(async () => next.resolve(module));
    expect(mounted).toHaveBeenLastCalledWith(refreshed);
  });

  it("handles late rejection after unmount and StrictMode effect cleanup", async () => {
    const abandoned = deferred(); load.mockReturnValueOnce(abandoned.promise);
    const ui = render(<ResultAnalysisButton {...snapshot} />); open(); ui.unmount();
    await act(async () => abandoned.reject(new Error("late failure")));
    expect(mounted).not.toHaveBeenCalled();
    const old = deferred(), current = deferred(); load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    render(<StrictMode><ResultAnalysisButton {...snapshot} /></StrictMode>); open();
    await act(async () => current.resolve(module));
    expect(screen.getByRole("dialog", { name: "Loaded analysis" })).toBeInTheDocument();
    await act(async () => old.reject(new Error("obsolete effect")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Loaded analysis" })).toBeInTheDocument();
  });
});
