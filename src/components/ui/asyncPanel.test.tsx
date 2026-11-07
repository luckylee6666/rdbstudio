import { StrictMode, useEffect, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { asyncPanel } from "./asyncPanel";
import { useI18n } from "@/store/i18n";

const mounted = vi.fn(), unmounted = vi.fn();
function View({ label }: { label: string }) {
  const [count, setCount] = useState(0);
  useEffect(() => { mounted(label); return () => unmounted(label); }, []);
  return <button onClick={() => setCount(n => n + 1)}>{label}: {count}</button>;
}
function deferred() {
  let resolve!: (value: typeof View) => void, reject!: (error: Error) => void;
  const promise = new Promise<typeof View>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { vi.clearAllMocks(); useI18n.setState({ lang: "en" }); });

describe("async workspace panels", () => {
  it("loads only on mount and shares code requests while keeping independent view state", async () => {
    const request = deferred(), load = vi.fn(() => request.promise), Panel = asyncPanel(load);
    expect(load).not.toHaveBeenCalled();
    render(<><Panel label="First" /><Panel label="Second" /></>);
    expect(screen.getAllByRole("status")).toHaveLength(2);
    await act(async () => request.resolve(View));
    expect(load).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "First: 0" }));
    expect(screen.getByRole("button", { name: "First: 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Second: 0" })).toBeInTheDocument();
  });

  it("does not mount a closed panel late, and reuses cached code with fresh props on reopening", async () => {
    const request = deferred(), load = vi.fn(() => request.promise), Panel = asyncPanel(load);
    const ui = render(<Panel label="Closed" />); ui.unmount();
    await act(async () => request.resolve(View));
    expect(mounted).not.toHaveBeenCalled();
    render(<Panel label="Reopened" />);
    expect(screen.getByRole("button", { name: "Reopened: 0" })).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull(); expect(load).toHaveBeenCalledOnce();
  });

  it("uses current props after loading and preserves mounted child state on rerender", async () => {
    const request = deferred(), Panel = asyncPanel(() => request.promise);
    const ui = render(<Panel label="Old" />); ui.rerender(<Panel label="Current" />);
    await act(async () => request.resolve(View));
    expect(mounted).toHaveBeenCalledWith("Current");
    fireEvent.click(screen.getByRole("button", { name: "Current: 0" }));
    ui.rerender(<Panel label="Updated" />);
    expect(screen.getByRole("button", { name: "Updated: 1" })).toBeInTheDocument();
    expect(mounted).toHaveBeenCalledOnce(); expect(unmounted).not.toHaveBeenCalled();
  });

  it("clears rejected requests for retry, hides error details and isolates other panel kinds", async () => {
    const failed = vi.fn().mockRejectedValueOnce(new Error("internal resource path")).mockResolvedValue(View);
    const Panel = asyncPanel<{ label: string }>(failed), Other = asyncPanel(async () => View);
    render(<><Panel label="Recovered" /><Other label="Other" /></>);
    const alert = await screen.findByRole("alert"); expect(alert).toHaveTextContent("Unable to open this view");
    expect(alert).not.toHaveTextContent("internal resource path");
    fireEvent.click(await screen.findByRole("button", { name: "Other: 0" }));
    fireEvent.click(screen.getByRole("button", { name: "Retry opening view" }));
    await screen.findByRole("button", { name: "Recovered: 0" });
    expect(screen.getByRole("button", { name: "Other: 1" })).toBeInTheDocument();
    expect(failed).toHaveBeenCalledTimes(2); expect(screen.queryByRole("alert")).toBeNull();
  });

  it("handles synchronous loading errors and late rejection after all subscribers close", async () => {
    const request = deferred(), load = vi.fn().mockImplementationOnce(() => { throw new Error("sync error"); }).mockReturnValueOnce(request.promise).mockResolvedValue(View);
    const Panel = asyncPanel<{ label: string }>(load), ui = render(<Panel label="Cancelled" />);
    await screen.findByRole("alert"); fireEvent.click(screen.getByRole("button", { name: "Retry opening view" }));
    ui.unmount(); await act(async () => request.reject(new Error("late error")));
    expect(mounted).not.toHaveBeenCalled();
    render(<Panel label="Fresh" />); await screen.findByRole("button", { name: "Fresh: 0" });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("deduplicates StrictMode replay and lets remaining subscribers finish after one closes", async () => {
    const request = deferred(), load = vi.fn(() => request.promise), Panel = asyncPanel(load);
    const ui = render(<StrictMode><Panel key="one" label="One" /><Panel key="two" label="Two" /></StrictMode>);
    ui.rerender(<StrictMode><Panel key="two" label="Two" /></StrictMode>);
    await act(async () => request.resolve(View));
    expect(load).toHaveBeenCalledOnce(); expect(mounted).not.toHaveBeenCalledWith("One");
    expect(screen.getByRole("button", { name: "Two: 0" })).toBeInTheDocument();
  });
});
