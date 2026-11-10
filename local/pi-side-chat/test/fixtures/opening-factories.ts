/** Planning-only substitute: opening cleanup tests execute the real coordinator. */
export async function sideExecutionPlan() {
  return { tools: [], modelScope: ["fixture/model"], factories: async () => [], beforeDispose: async () => {} };
}
export async function sidePresentationFactories() { return []; }
