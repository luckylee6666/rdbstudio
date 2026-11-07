/** Keep analysis code out of the initial query/table view module graph. */
export function loadResultAnalysis() {
  return import("./ResultAnalysis");
}
