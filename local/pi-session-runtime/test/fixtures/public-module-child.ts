import { StringEnum, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export function create(observe: (exports: { StringEnum: unknown; openAIResponsesApi: unknown }) => void): ExtensionFactory {
  return () => { observe({ StringEnum, openAIResponsesApi }); };
}
