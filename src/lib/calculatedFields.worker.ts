import { calculateRows, type CalculationPlan } from "./calculatedFields";
import { calculationFailure } from "./analysisPipeline";
self.onmessage = (event: MessageEvent<{ rows: unknown[][]; plan: CalculationPlan }>) => {
  try { self.postMessage({ preview: calculateRows(event.data.rows, event.data.plan, true).preview }); }
  catch (error) { self.postMessage(calculationFailure(error)); }
};
