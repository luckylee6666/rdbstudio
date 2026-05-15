import { describe, expect, it } from "vitest";
import { cn } from "./cn";

describe("cn", () => {
  it("joins multiple class names with spaces", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("filters out falsy values", () => {
    // undefined / null / false / '' should be dropped by clsx
    expect(cn("foo", undefined, null, false, "", "bar")).toBe("foo bar");
  });

  it("resolves conflicting tailwind classes via twMerge", () => {
    // last-conflicting-class wins
    expect(cn("p-2", "p-4")).toBe("p-4");
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
  });

  it("supports conditional objects and arrays (clsx)", () => {
    expect(cn(["foo", { bar: true, baz: false }])).toBe("foo bar");
  });

  it("returns empty string for no args", () => {
    expect(cn()).toBe("");
  });
});
