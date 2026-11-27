/** "provider:model" ids (e.g. "flatiron:moonshotai/Kimi-K3", "codex:gpt-6-luna") accepted wherever `model` is, so a
 *  workflow names its provider in one constant and imports Agent and run from agentsh itself.  The prefix is split off
 *  only when it names a provider the agent backend can resolve, so a model id with its own colon ("llama3:8b") stays
 *  whole.  An explicit `provider` always wins. */
export function splitProviderModel<T extends { model?: string; provider?: string }>(spec: T, isProvider: (name: string) => boolean): T {
  if (spec.provider || !spec.model) return spec;
  const colon = spec.model.indexOf(":");
  const slash = spec.model.indexOf("/");
  if (colon <= 0 || (slash >= 0 && slash < colon)) return spec;
  const provider = spec.model.slice(0, colon);
  const model = spec.model.slice(colon + 1);
  if (!model || !isProvider(provider)) return spec;
  return { ...spec, provider, model };
}
