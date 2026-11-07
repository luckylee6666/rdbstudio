import { runAnalysis, calculationFailure, type AnalysisPipelineRequest } from "./analysisPipeline";
self.onmessage = (event: MessageEvent<AnalysisPipelineRequest>) => {
  try { self.postMessage(runAnalysis(event.data)); }
  catch (error) { self.postMessage(calculationFailure(error)); }
};
