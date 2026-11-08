import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export function createAlternateChildFactory() {
  return (pi: ExtensionAPI) => pi.registerProvider("alternate", {
    api: "openai-responses", baseUrl: "https://alternate.invalid/v1", apiKey: "fixture",
    models: [{ id: "faux", name: "ALTERNATE faux", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 256 }],
  });
}
