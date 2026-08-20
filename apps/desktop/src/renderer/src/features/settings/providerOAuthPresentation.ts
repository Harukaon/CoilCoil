import type { ModelProviderAuthState } from "@coilcoil/runtime-protocol";

export function oauthCallbackUrl(state: ModelProviderAuthState): string | undefined {
  const prompt = state.prompt;
  if (!prompt || prompt.type === "select" || !prompt.placeholder) return undefined;
  try {
    const url = new URL(prompt.placeholder);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
