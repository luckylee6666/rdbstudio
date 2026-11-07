import type { DriverKind } from "@/types";
import { parameterInput, type ParameterKind, type QueryParameter } from "./queryParameters";
import type { ParameterBatchDraft } from "./parameterBatch";

export interface ParameterDefinition { name: string; kind: ParameterKind }
export interface ParameterPresetContent {
  driver: DriverKind;
  mode: "single" | "batch";
  parameters: ParameterDefinition[];
  atomic: boolean;
  sets: QueryParameter[][] | null;
}
export interface ParameterPreset extends ParameterPresetContent {
  id: string; revision: string; name: string; updated_at: string;
}
export interface ParameterPresetSummary extends Omit<ParameterPreset, "sets" | "atomic"> {
  set_count: number; has_values: boolean;
}
export interface SaveParameterPreset extends ParameterPresetContent { id: string | null; revision: string | null; name: string }

export function presetMatches(preset: ParameterPresetContent, driver: DriverKind, names: string[]): boolean {
  return preset.driver === driver && preset.parameters.length === names.length
    && names.every(name => preset.parameters.some(p => p.name === name));
}
export function presetDraft(preset: ParameterPresetContent): ParameterBatchDraft {
  const types = Object.fromEntries(preset.parameters.map(p => [p.name, p.kind]));
  const rows = preset.sets
    ? preset.sets.map(set => Object.fromEntries(set.map(p => [p.name, p.value])))
    : [Object.fromEntries(preset.parameters.map(p => [p.name, parameterInput(p.name, undefined, p).value]))];
  return { types, rows, atomic: preset.atomic };
}
