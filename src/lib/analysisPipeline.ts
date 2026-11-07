import { analyze, type AnalysisRequest, type AnalysisResult } from "./resultAnalysis";
import { calculateRows, CalculationError, type CalculationPlan, type CalculationStats, type CalculationPreview } from "./calculatedFields";
export type AnalysisPipelineRequest = AnalysisRequest & { calculations?: CalculationPlan };
export type PipelineResponse = { result?: AnalysisResult; preview?: CalculationPreview; calculationStats?: CalculationStats; error?: string; calculationError?: { code: string; position: number; field: number; row: number } };
export function runAnalysis(request: AnalysisPipelineRequest): { result: AnalysisResult; calculationStats?: CalculationStats } {
  if (!request.calculations) return { result: analyze(request) };
  if (request.calculations.projection.length !== (request.kind === "profile" ? 1 : 3)) throw new CalculationError("reference");
  const calculated = calculateRows(request.rows, request.calculations);
  const selected = request.calculations.projection.map(i => request.calculations!.fields[i - request.calculations!.sourceCount]?.type === "number");
  const parseStrings = request.parseStrings || selected[request.kind === "profile" ? 0 : 2];
  return { result: analyze(request.kind === "scatter" ? { ...request, rows: calculated.rows, numericStrings: [request.parseStrings || selected[0], request.parseStrings || selected[1]] }
    : { ...request, rows: calculated.rows, parseStrings }), calculationStats: calculated.stats };
}
export function calculationFailure(cause: unknown): PipelineResponse {
  return cause instanceof CalculationError ? { error: "calculation", calculationError: { code: cause.code, position: cause.position, field: cause.field, row: cause.row } }
    : { error: cause instanceof Error ? cause.message : "value" };
}
