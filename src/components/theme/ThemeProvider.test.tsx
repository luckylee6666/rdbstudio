import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ThemeProvider, useTheme } from "./ThemeProvider";

function CurrentTheme() {
  const { theme, toggle } = useTheme();
  return <button onClick={toggle}>{theme}</button>;
}
beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([true, false])("respects the system dark preference %s on first launch", (dark) => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: dark })));
  render(<ThemeProvider><CurrentTheme /></ThemeProvider>);
  expect(screen.getByRole("button")).toHaveTextContent(dark ? "dark" : "light");
  expect(document.documentElement.classList.contains("dark")).toBe(dark);
});

it("keeps the saved preference above the system choice", () => {
  localStorage.setItem("rdbstudio.theme", "light");
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  render(<ThemeProvider><CurrentTheme /></ThemeProvider>);
  expect(screen.getByRole("button")).toHaveTextContent("light");
});

it("still opens and toggles when preference storage is denied", () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  render(<ThemeProvider><CurrentTheme /></ThemeProvider>);
  act(() => screen.getByRole("button").click());
  expect(screen.getByRole("button")).toHaveTextContent("dark");
});
