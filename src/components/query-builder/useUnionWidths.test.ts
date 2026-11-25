import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { importSelect } from "@/lib/importSelect";
import { compileQuery } from "@/lib/queryBuilder";
import { useUnionWidths } from "./useUnionWidths";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api", () => ({ api: { queryBuilderStarWidth: lookup } }));
afterEach(() => { lookup.mockReset(); vi.useRealTimers(); });

it("releases the editor at the total deadline and ignores late column counts", async () => {
  vi.useFakeTimers();
  lookup.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve(2), 3000)));
  const query = importSelect("SELECT * FROM a UNION ALL SELECT * FROM b UNION SELECT 1", "sqlite");
  const { result } = renderHook(() => useUnionWidths(query, "db", true, 0));
  expect(result.current.pending).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(3000));
  expect(lookup).toHaveBeenCalledTimes(2);
  await act(() => vi.advanceTimersByTimeAsync(2000));
  expect(result.current).toMatchObject({ pending: false, unknown: true });
  expect(result.current.widths.size).toBe(1);
  expect(() => compileQuery(query, "sqlite", result.current.widths)).toThrow("union_width");
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(result.current.widths.size).toBe(1);
});

it("uses only the latest connection and refresh, including unknown and offline widths", async () => {
  let old!: (width: number) => void;
  lookup.mockImplementationOnce(() => new Promise<number>(resolve => { old = resolve; }))
    .mockResolvedValueOnce(1).mockResolvedValueOnce(null);
  const query = importSelect("SELECT * FROM a UNION SELECT 1", "sqlite");
  const { result, rerender } = renderHook(({ id, online, revision }) => useUnionWidths(query, id, online, revision),
    { initialProps: { id: "old", online: true, revision: 0 } });
  rerender({ id: "new", online: true, revision: 0 }); await act(async () => {});
  await act(async () => old(2));
  expect(result.current.unknown).toBe(false);
  expect(() => compileQuery(query, "sqlite", result.current.widths)).not.toThrow();
  rerender({ id: "new", online: true, revision: 1 }); await act(async () => {});
  expect(result.current).toMatchObject({ pending: false, unknown: true });
  rerender({ id: "new", online: false, revision: 1 });
  expect(result.current.widths.size).toBe(0);
  expect(lookup).toHaveBeenCalledTimes(3);
});
