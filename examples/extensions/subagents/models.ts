/** "provider:model" ids (e.g. "flatiron:moonshotai/Kimi-K3", "codex:gpt-6-luna") accepted wherever `model` is, so a
 *  workflow names its provider in one constant and imports Agent and run from agentsh itself.  The prefix is split off
 *  only when it names a provider the agent backend can resolve, so a model id with its own colon ("llama3:8b") stays
 *  whole.  An explicit `provider` always wins. */
export interface RoleDef { model?: string; provider?: string; thinking?: string }
export const ROLE_KEYS = ["model", "provider", "thinking"];

/** A role's model, provider and thinking under a spec's own (explicit values win); an unknown role is an error that
 *  lists the known ones.  Roles come from the agent-sh settings (subagents.roles) and a run's config.roles. */
export function applyRole<T extends { role?: string; model?: string; provider?: string; thinking?: string }>(spec: T, roles: Record<string, RoleDef>): T {
  if (!spec.role) return spec;
  const def = roles[spec.role];
  if (!def) {
    const names = Object.keys(roles);
    throw new Error(`unknown role "${spec.role}" (${names.length ? `roles: ${names.join(", ")}` : "no roles defined: set subagents.roles in the agent-sh settings or config.roles"})`);
  }
  const own = Object.fromEntries(Object.entries({ model: spec.model, provider: spec.provider, thinking: spec.thinking }).filter(([, v]) => v !== undefined));
  // a spec that names its own model does not inherit the role's provider
  const inherited = own.model !== undefined && own.provider === undefined ? { thinking: def.thinking } : def;
  return { ...spec, ...inherited, ...own };
}

export function rolesProblems(roles: unknown, where: string): string[] {
  if (roles === undefined) return [];
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return [`${where} must be a dict of role name -> dict(model=..., thinking=...)`];
  const problems: string[] = [];
  for (const [name, def] of Object.entries(roles as Record<string, unknown>)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) { problems.push(`${where}.${name} must be a dict(model=..., thinking=...)`); continue; }
    for (const [k, v] of Object.entries(def as Record<string, unknown>)) {
      if (!ROLE_KEYS.includes(k)) problems.push(`${where}.${name}.${k} isn't a role option (${ROLE_KEYS.join(", ")})`);
      else if (typeof v !== "string") problems.push(`${where}.${name}.${k} must be text`);
    }
  }
  return problems;
}

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
