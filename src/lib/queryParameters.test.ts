import { describe, expect, it } from "vitest";
import { mergeParameterDefaults, parameterError, parameterInput, type ParameterInput } from "./queryParameters";

const input = (kind: ParameterInput["kind"], value: string): ParameterInput => ({ name: "p", kind, value, isNull: false, saveDefault: false });

describe("query parameter values", () => {
  it("preserves empty text, SQL NULL and runtime values separately", () => {
    expect(parameterInput("p", undefined, { name: "p", kind: "text", value: null })).toMatchObject({ isNull: true, saveDefault: true });
    expect(parameterInput("p", { name: "p", kind: "text", value: "" }, { name: "p", kind: "text", value: "old" })).toMatchObject({ value: "", isNull: false });
    expect(parameterInput("p")).toMatchObject({ value: "", isNull: false, saveDefault: false });
  });
  it("removes an old saved value when saving is unchecked, retaining its type", () => {
    const existing = [{ name: "p", kind: "text" as const, value: "old" }, { name: "other", kind: "text" as const, value: "kept" }];
    const result = mergeParameterDefaults(existing, [input("integer", "42")]);
    expect(result).toEqual([{ name: "p", kind: "integer" }, existing[1]]);
    expect(existing[0].value).toBe("old");
  });
  it("only persists values explicitly selected as defaults", () => {
    expect(mergeParameterDefaults([], [{ ...input("text", "secret") }, { ...input("text", ""), name: "empty", saveDefault: true }, { ...input("integer", ""), name: "null", isNull: true, saveDefault: true }])).toEqual([
      { name: "p", kind: "text" }, { name: "empty", kind: "text", value: "" }, { name: "null", kind: "integer", value: null },
    ]);
  });
  it("validates all signed 64-bit integers without Number rounding", () => {
    for (const value of ["9223372036854775807", "-9223372036854775808", "+42", "0"]) expect(parameterError(input("integer", value))).toBeNull();
    for (const value of ["9223372036854775808", "-9223372036854775809", "1.0", "1e3", ""]) expect(parameterError(input("integer", value))).toBe("integer");
  });
  it("keeps exact decimal text and rejects non-finite floats", () => {
    expect(parameterError(input("decimal", "12345678901234567890.123456789"))).toBeNull();
    expect(parameterError(input("decimal", "1e20"))).toBe("decimal");
    expect(parameterError(input("float", "1e309"))).toBe("float");
    expect(parameterError(input("float", "-1.2e-30"))).toBeNull();
  });
  it("validates JSON, paired hex and booleans", () => {
    expect(parameterError(input("json", '{"key":"value"}'))).toBeNull();
    expect(parameterError(input("json", "{"))).toBe("json");
    expect(parameterError(input("binary", "0x00aAFF"))).toBeNull();
    expect(parameterError(input("binary", "abc"))).toBe("binary");
    expect(parameterError(input("boolean", "false"))).toBeNull();
    expect(parameterError(input("boolean", "0"))).toBe("boolean");
  });
  it("validates leap years and time bounds before executing", () => {
    for (const value of ["2024-02-29", "2000-02-29", "2026-11-06"]) expect(parameterError(input("date", value))).toBeNull();
    for (const value of ["2026-02-29", "1900-02-29", "2026-04-31", "2026-00-01"]) expect(parameterError(input("date", value))).toBe("date");
    expect(parameterError(input("datetime", "2024-02-29T23:59:59.123456789"))).toBeNull();
    for (const value of ["2026-02-30 12:00:00", "2026-11-06 24:00:00", "2026-11-06 12:60:00"]) expect(parameterError(input("datetime", value))).toBe("datetime");
  });
  it("restores a boolean type with a usable default selection", () => {
    const value = parameterInput("p", undefined, { name: "p", kind: "boolean" });
    expect(value.value).toBe("true");
    expect(parameterError(value)).toBeNull();
    expect(value.saveDefault).toBe(false);
  });
  it("counts UTF-8 bytes and allows NULL regardless of the dormant editor value", () => {
    expect(parameterError(input("text", "水".repeat(350000)))).toBe("size");
    expect(parameterError({ ...input("integer", "not a number"), isNull: true })).toBeNull();
  });
});
