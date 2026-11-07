import { describe, expect, it } from "vitest";
import { presetDraft, presetMatches, type ParameterPresetContent } from "./parameterPresets";
const base: ParameterPresetContent = { driver: "sqlite", mode: "batch", atomic: false, parameters: [{ name: "id", kind: "integer" }, { name: "enabled", kind: "boolean" }], sets: null };
describe("parameter preset conversion", () => {
  it("requires matching names and driver, allowing reordered parameter definitions", () => {
    expect(presetMatches(base, "sqlite", ["enabled", "id"])).toBe(true);
    expect(presetMatches(base, "postgres", ["id", "enabled"])).toBe(false);
    expect(presetMatches(base, "sqlite", ["id"])).toBe(false);
    expect(presetMatches(base, "sqlite", ["id", "other"])).toBe(false);
  });
  it("restores definitions without inventing NULL or invalid boolean values", () => {
    expect(presetDraft(base)).toEqual({ rows: [{ id: "", enabled: "true" }], types: { id: "integer", enabled: "boolean" }, atomic: false });
  });
  it("keeps exact values and safely handles prototype-like parameter names", () => {
    const preset: ParameterPresetContent = { ...base, parameters: [{ name: "__proto__", kind: "integer" }],
      sets: [[{ name: "__proto__", kind: "integer", value: "9223372036854775807" }], [{ name: "__proto__", kind: "integer", value: null }]] };
    const draft = presetDraft(preset);
    expect(Object.hasOwn(draft.types, "__proto__")).toBe(true);
    expect(draft.rows[0].__proto__).toBe("9223372036854775807");
    expect(draft.rows[1].__proto__).toBeNull();
    draft.rows[0].__proto__ = "0";
    expect(preset.sets![0][0].value).toBe("9223372036854775807");
  });
});
