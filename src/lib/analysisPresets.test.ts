import { describe, it, expect } from "vitest";
import { ANALYSIS_CONFIG_BYTES, captureAnalysisConfiguration, parseAnalysisConfiguration, parseAnalysisConfigurationText, suggestAnalysisMapping, applyAnalysisConfiguration, type AnalysisSettings } from "./analysisPresets";
import { DEFAULT_METRIC_OPTIONS } from "./resultCharts";
import { DEFAULT_TIME_OPTIONS } from "./resultTime";
const columns = [{ name: "day", data_type: "TEXT" }, { name: "amount", data_type: "DECIMAL" }, { name: "region", data_type: "TEXT" }];
const settings: AnalysisSettings = { mode: "chart", chart: "line", column: 0, row: 0, split: 2, measure: 1, aggregate: "mean", parseStrings: true,
  axisKind: "time", timeOptions: { ...DEFAULT_TIME_OPTIONS, bucket: "day" }, metricOptions: { ...DEFAULT_METRIC_OPTIONS, target: "dormant-private-input" }, scatterX: 1, scatterY: 1, scatterLabel: 2, sample: true };
const config = () => captureAnalysisConfiguration(columns, settings, { mode: "keys", keys: ['s:"private-region"'] });
describe("analysis configuration boundary", () => {
  it("captures only active settings without source data or dormant options; series values need opt-in", () => {
    const c = config(); expect(c.bindings).toEqual({ row: { name: "day", dataType: "TEXT", ordinal: 0 }, measure: { name: "amount", dataType: "DECIMAL", ordinal: 1 }, split: { name: "region", dataType: "TEXT", ordinal: 2 } });
    expect(c.series).toEqual({ mode: "choose" }); expect(JSON.stringify(c)).not.toContain("private");
    expect(captureAnalysisConfiguration(columns, settings, { mode: "keys", keys: ['s:"private-region"'] }, true).series).toEqual({ mode: "keys", keys: ['s:"private-region"'] });
    const profile = captureAnalysisConfiguration(columns, { ...settings, mode: "profile" }, { mode: "all" });
    expect(Object.keys(profile.bindings)).toEqual(["profile"]); expect(profile.series.mode).toBe("total"); expect(profile.axisKind).toBe("category");
    const scatter = captureAnalysisConfiguration(columns, { ...settings, chart: "scatter" }, { mode: "all" }); expect(Object.keys(scatter.bindings)).toEqual(["x", "y", "label"]);
  });
  it("rejects analysis exports, extra payloads, malformed enums, versions and oversized UTF8", () => {
    for (const bad of [{ version: 1, result: {} }, { ...config(), rows: [["secret"]] }, { ...config(), version: 2 }, { ...config(), mode: "SQL" }, { ...config(), sample: "true" }, { ...config(), timeOptions: { ...DEFAULT_TIME_OPTIONS, timezone: "local" } }, { ...config(), bindings: { ...config().bindings, sql: "SELECT" } }, { ...config(), series: { mode: "total", keys: ["secret"] } }, { ...config(), series: { mode: "keys", keys: ["a", "a"] } }]) expect(() => parseAnalysisConfiguration(bad)).toThrow(/preset_/);
    expect(() => parseAnalysisConfigurationText("{" )).toThrow("preset_invalid");
    expect(() => parseAnalysisConfigurationText(" ".repeat(ANALYSIS_CONFIG_BYTES + 1))).toThrow("preset_size");
    expect(() => parseAnalysisConfiguration({ ...config(), series: { mode: "keys", keys: Array.from({ length: 12 }, (_, i) => "中".repeat(2046) + i) } })).toThrow("preset_size");
    expect(parseAnalysisConfigurationText(JSON.stringify(config()))).toEqual(config());
  });
  it("maps reordered unique fields by name/type; never uses ordinal or ambiguous/mismatched names", () => {
    const c = config(), reordered = [columns[2], columns[0], columns[1]];
    const mapping = suggestAnalysisMapping(c, reordered); expect(mapping).toEqual({ row: 1, measure: 2, split: 0 });
    expect(applyAnalysisConfiguration(c, reordered, mapping)).toMatchObject({ row: 1, measure: 2, split: 0, axisKind: "time" });
    expect(suggestAnalysisMapping(c, [columns[0], columns[0], { ...columns[1], data_type: "INTEGER" }])).toEqual({});
    expect(() => applyAnalysisConfiguration(c, reordered, { row: 0, measure: 1 })).toThrow("preset_mismatch");
    const profile = captureAnalysisConfiguration(columns, { ...settings, mode: "profile" }, { mode: "total" });
    expect(applyAnalysisConfiguration(profile, columns, { profile: 0, split: 500 }).split).toBe(-1);
  });
  it("validates exact decimal KPI and gauge inputs beyond f64 without saving invalid charts", () => {
    expect(captureAnalysisConfiguration(columns, { ...settings, chart: "kpi", metricOptions: { ...DEFAULT_METRIC_OPTIONS, target: "1e512" } }, { mode: "total" }).metricOptions.target).toBe("1e512");
    for (const [minimum, maximum, valid] of [["9223372036854775807", "9223372036854775808", true], ["1e-512", "2e-512", true], ["1e512", "2e512", true], ["-2e512", "-1e512", true], ["-0", "0", false], ["2", "1", false], ["0", "1e513", false]] as const) {
      const capture = () => captureAnalysisConfiguration(columns, { ...settings, chart: "gauge", metricOptions: { ...DEFAULT_METRIC_OPTIONS, minimum, maximum } }, { mode: "total" });
      if (valid) expect(capture().metricOptions).toMatchObject({ minimum, maximum }); else expect(capture).toThrow("preset_range");
    }
  });
});

describe("calculated configuration version 2", () => {
  it("stores only required source bindings and rewrites formulas after column reordering", () => {
    const fields = [{ id: "total", name: "Total", type: "number" as const, expression: "[2] * 2" }, { id: "label", name: "Label", type: "text" as const, expression: "CONCAT(TEXT([4]), '[2]')" }];
    const c = captureAnalysisConfiguration(columns, { ...settings, measure: 3, calculatedFields: fields }, { mode: "total" });
    expect(c.version).toBe(2); expect(c.bindings.measure).toEqual({ calculated: 0 });
    expect(c.calculations?.inputs).toEqual([{ name: "amount", dataType: "DECIMAL", ordinal: 1 }]);
    expect(c.calculations?.fields.map(f=>f.expression)).toEqual(["[1] * 2", "CONCAT(TEXT([2]), '[2]')"]);
    const reordered = [columns[1], columns[2], columns[0]], mapping = suggestAnalysisMapping(c,reordered);
    expect(mapping).toMatchObject({ row: 2, split: 1, measure: 3, "input:0": 0 });
    const applied = applyAnalysisConfiguration(c,reordered,mapping);
    expect(applied.measure).toBe(3); expect(applied.calculatedFields?.map(f=>f.expression)).toEqual(["[1] * 2", "CONCAT(TEXT([4]), '[2]')"]);
    expect(parseAnalysisConfigurationText(JSON.stringify(c))).toEqual(c);
  });
  it("requires explicit input mappings and rejects dangling formulas, extra data and invalid types", () => {
    const c = captureAnalysisConfiguration(columns,{...settings,calculatedFields:[{id:"derived",name:"Derived",type:"number",expression:"[2]+1"}],measure:3},{mode:"total"});
    expect(()=>applyAnalysisConfiguration(c,columns,{row:0,split:2,measure:3})).toThrow("preset_mismatch");
    for(const bad of [
      {...c,calculations:{...c.calculations,rows:[["secret"]]}},
      {...c,calculations:{...c.calculations,fields:[{...c.calculations!.fields[0],expression:"[2]"}]}},
      {...c,bindings:{...c.bindings,measure:{calculated:1}}},
      {...c,version:1},
      {...c,calculations:{...c.calculations,fields:[{...c.calculations!.fields[0],type:"SQL"}]}},
    ])expect(()=>parseAnalysisConfiguration(bad)).toThrow(/preset_/);
    const mapping=suggestAnalysisMapping(c,columns);expect(applyAnalysisConfiguration(c,columns,mapping).calculatedFields).toHaveLength(1);
  });
});
