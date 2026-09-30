export type Provider = 'google_genai' | 'openai' | 'anthropic' | 'groq' | 'openrouter';

export const SUPPORTED_PROVIDERS: Provider[] = ['google_genai', 'openai', 'anthropic', 'groq', 'openrouter'];

export interface ApiKeys {
  google_genai: string;
  openai: string;
  anthropic: string;
  groq: string;
  openrouter: string;
}

export interface ModelOption {
  value: string;
  label: string;
  provider: Provider;
  /** True for models that must never be offered to a chat/tool-calling role (Gemma has no
   * function-calling support). Filtered out of the Co-Pilot's dropdown specifically. */
  noToolCalling?: boolean;
  /** Only meaningful for provider === 'openrouter': whether the live model list (see
   * fetchProviderModels) reported this model supports OpenRouter's unified `reasoning`
   * parameter. Sent back to the backend verbatim as AgentConfig.supports_reasoning. */
  supportsReasoning?: boolean;
}

// The full static catalog across Gemini 2.5-3.8 (flash, flash-lite, and pro), Gemma, OpenAI, and
// Anthropic. Gemma is flagged noToolCalling so it's excluded only from the Co-Pilot role, which
// requires function calling — every other role can use it freely.
//
// Groq and OpenRouter are NOT listed here — both host overlapping/constantly-changing catalogs
// (200+ models on OpenRouter alone) that can't be hand-maintained, so their models are fetched
// live from the backend (see fetchProviderModels/DYNAMIC_PROVIDERS below) once a key is entered.
export const MODEL_CATALOG: ModelOption[] = [
  { value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', provider: 'google_genai' },
  { value: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', provider: 'google_genai' },
  { value: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', provider: 'google_genai' },
  { value: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', provider: 'google_genai' },
  { value: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', provider: 'google_genai' },
  { value: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro', provider: 'google_genai' },
  { value: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash', provider: 'google_genai' },
  { value: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', provider: 'google_genai' },
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'google_genai' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', provider: 'google_genai' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', provider: 'google_genai' },
  { value: 'gemma-4-31b-it', label: 'Gemma 4 31B', provider: 'google_genai', noToolCalling: true },
  { value: 'gemma-4-26b-a4b-it', label: 'Gemma 4 26B', provider: 'google_genai', noToolCalling: true },
  { value: 'gpt-5', label: 'GPT-5', provider: 'openai' },
  { value: 'gpt-5-mini', label: 'GPT-5 Mini', provider: 'openai' },
  { value: 'claude-opus-5', label: 'Claude Opus 5', provider: 'anthropic' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5', provider: 'anthropic' },
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic' },
];

export const PROVIDER_LABELS: Record<Provider, string> = {
  google_genai: 'Google',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  groq: 'Groq',
  openrouter: 'OpenRouter',
};

// Providers whose catalog is fetched live from the backend instead of hardcoded — see
// fetchProviderModels. A model from one of these must always carry an explicit `provider`
// (resolveProviderForModel never infers groq/openrouter from a bare model name: both namespace
// or share model names with every other vendor, so guessing would be wrong more often than right).
export const DYNAMIC_PROVIDERS: Provider[] = ['groq', 'openrouter'];

export function resolveProviderForModel(model: string, explicitProvider?: string): Provider {
  if (explicitProvider && (SUPPORTED_PROVIDERS as string[]).includes(explicitProvider)) {
    return explicitProvider as Provider;
  }
  const known = MODEL_CATALOG.find(m => m.value === model);
  if (known) return known.provider;
  const lower = (model || '').toLowerCase();
  if (lower.includes('gemini') || lower.includes('gemma')) return 'google_genai';
  if (lower.startsWith('gpt-') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) return 'openai';
  if (lower.startsWith('claude')) return 'anthropic';
  return 'google_genai';
}

export function getKeyForModel(apiKeys: ApiKeys, model: string, explicitProvider?: string): string {
  return apiKeys[resolveProviderForModel(model, explicitProvider)] || '';
}

export function hasAnyApiKey(apiKeys: ApiKeys): boolean {
  return Object.values(apiKeys).some(k => !!k);
}

/**
 * Statically-known models actually selectable right now: strictly only from the 3 native
 * providers that have a key entered — no exceptions. (An earlier version kept a role's *current*
 * model visible even without a key for its provider, to avoid a blank <select> after removing a
 * key — but since every role defaults to Gemini, that silently kept a "Google" option/group
 * visible for someone who only ever entered an OpenAI or Anthropic key. Staleness is handled
 * instead by reconcileAgentsForApiKeys, which reassigns a role's model the moment its provider's
 * key disappears, so this filter can stay strict.)
 *
 * Does NOT include Groq/OpenRouter models — those are fetched live; see useProviderModels.
 */
export function getAvailableModels(
  apiKeys: ApiKeys,
  opts: { requireToolCalling?: boolean } = {}
): ModelOption[] {
  const configuredProviders = (Object.keys(apiKeys) as Provider[]).filter(p => !!apiKeys[p]);
  return MODEL_CATALOG.filter(m => {
    if (opts.requireToolCalling && m.noToolCalling) return false;
    return configuredProviders.includes(m.provider);
  });
}

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// Keyed by `${provider}:${apiKey}` so a changed key naturally invalidates the cached list instead
// of needing an explicit bust — avoids refetching on every re-render of a settings panel.
const modelListCache = new Map<string, Promise<ModelOption[]>>();

/** Fetches a provider's live model list from the backend (POST /api/list_models), which in turn
 * hits that provider's own model-listing endpoint — the only way to know what's actually
 * available for Groq/OpenRouter, whose catalogs are too large and volatile to hardcode. Also
 * doubles as key validation: a bad key surfaces here as a thrown Error instead of failing deep
 * inside a later generation call. Results are cached per (provider, key) for the session. */
export async function fetchProviderModels(provider: Provider, apiKey: string): Promise<ModelOption[]> {
  if (!apiKey) return [];
  const cacheKey = `${provider}:${apiKey}`;
  const cached = modelListCache.get(cacheKey);
  if (cached) return cached;

  const promise = (async () => {
    const res = await fetch(`${API_URL}/list_models`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, api_key: apiKey }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `Failed to list ${PROVIDER_LABELS[provider]} models`);
    }
    const data = await res.json();
    const models: ModelOption[] = (data.models || []).map((m: any) => ({
      value: m.id,
      label: m.label || m.id,
      provider,
      noToolCalling: m.supports_tools === false,
      supportsReasoning: m.supports_reasoning === true,
    }));
    return models;
  })();

  modelListCache.set(cacheKey, promise);
  // Don't cache a failed lookup — a typo'd key that gets corrected should retry, not stick to
  // the first error forever.
  promise.catch(() => modelListCache.delete(cacheKey));
  return promise;
}

// --- Thinking-level tiers -----------------------------------------------------------------
// "Thinking level" is not a universal concept — whether a model has one, and what shape it takes,
// varies per model, not just per provider:
// - Gemma: binary (always requests `include_thoughts` for any non-"None" level, no granularity).
// - Gemini 3.x (3.1-3.8, flash/flash-lite/pro): a `thinking_level` enum — None/Low/Medium/High,
//   no "Minimal" tier.
// - Gemini 2.5 and earlier: a numeric `thinking_budget`, which does support "Minimal".
// - OpenAI / Anthropic: mapped to reasoning_effort / an extended-thinking token budget, both of
//   which support the full None/Minimal/Low/Medium/High range (curated catalog, all known to
//   support it).
// - Groq: mostly plain open-weight models with NO thinking concept at all — a small curated
//   allow-list marks the few exceptions (see GROQ_GRADUATED_MARKERS/GROQ_BINARY_MARKERS below),
//   everything else gets no control at all. Mirrors app/core/llm.py's GROQ_GRADUATED_MODELS /
//   GROQ_BINARY_MODELS.
// - OpenRouter: the one provider whose per-model capability can actually be asked for — its
//   /models response's `supported_parameters` includes "reasoning" when a model supports it,
//   which fetchProviderModels already captures as `supportsReasoning`. No support -> no control.
export type ThinkingTier = 'none' | 'binary' | 'graduated';

const FULL_THINKING_LEVELS = ['None', 'Minimal', 'Low', 'Medium', 'High'];
const GEMINI_3_THINKING_LEVELS = ['None', 'Low', 'Medium', 'High'];
const BINARY_THINKING_LEVELS = ['None', 'On'];

const GROQ_GRADUATED_MARKERS = ['openai/gpt-oss'];
const GROQ_BINARY_MARKERS = ['deepseek-r1', 'qwq'];

export function resolveThinkingTier(model: string, provider: Provider, supportsReasoning?: boolean): ThinkingTier {
  const lower = (model || '').toLowerCase();
  if (provider === 'google_genai') return lower.includes('gemma') ? 'binary' : 'graduated';
  if (provider === 'openai' || provider === 'anthropic') return 'graduated';
  if (provider === 'groq') {
    if (GROQ_GRADUATED_MARKERS.some(m => lower.includes(m))) return 'graduated';
    if (GROQ_BINARY_MARKERS.some(m => lower.includes(m))) return 'binary';
    return 'none';
  }
  if (provider === 'openrouter') return supportsReasoning ? 'graduated' : 'none';
  return 'none';
}

/** Which thinking-level options are valid for a given model — an empty array means the model has
 * no thinking control at all, and callers should hide the selector entirely rather than show a
 * dead one. */
export function getThinkingLevelOptions(model: string, provider: Provider, supportsReasoning?: boolean): string[] {
  const tier = resolveThinkingTier(model, provider, supportsReasoning);
  if (tier === 'none') return [];
  if (tier === 'binary') return BINARY_THINKING_LEVELS;
  if (provider === 'google_genai' && model.toLowerCase().includes('gemini-3')) return GEMINI_3_THINKING_LEVELS;
  return FULL_THINKING_LEVELS;
}

// Keeps a role's current thinking_level valid when the model changes to a family with a
// different supported set (e.g. switching from Gemini 2.5 "Minimal" to Gemini 3.8, which has no
// Minimal tier, or to a Groq model with no thinking control at all) — falls back to the closest
// sensible option instead of silently sending an invalid value to the backend.
export function normalizeThinkingLevel(level: string, options: string[]): string {
  if (options.length === 0) return 'None';
  if (options.includes(level)) return level;
  if (level === 'None') return 'None';
  if (options.includes('On')) return 'On';
  if (options.includes('Low')) return 'Low';
  return options[options.length - 1];
}

// OpenRouter's /models list has no "popular"/"reliable" ranking of its own, and mixes real chat
// models in with obscure ones from 50+ vendors — sorting alphabetically (as fetchProviderModels
// does) means "whatever happens to come first" can easily be some barely-used model. When
// auto-picking a default (rather than a user's own explicit choice), prefer a well-known vendor's
// model instead, in this priority order.
const PREFERRED_OPENROUTER_VENDOR_PREFIXES = [
  'openai/', 'anthropic/', 'google/', 'meta-llama/', 'mistralai/', 'deepseek/', 'qwen/', 'x-ai/',
];

/**
 * Picks a sensible default from a list of candidate models. For OpenRouter specifically, prefers
 * a well-known vendor's model (see above) over whatever sorts first — for every other provider
 * (whose catalogs are small/curated or explicitly hand-maintained), the first entry is fine as-is.
 */
export function pickDefaultModel(models: ModelOption[]): ModelOption | undefined {
  if (models.length === 0) return undefined;
  if (models[0].provider === 'openrouter') {
    for (const prefix of PREFERRED_OPENROUTER_VENDOR_PREFIXES) {
      const match = models.find(m => m.value.toLowerCase().startsWith(prefix));
      if (match) return match;
    }
  }
  return models[0];
}

/**
 * Reassigns any agent-role config whose current model's provider no longer has a key, to the
 * first still-available model — called whenever the API key fields change. This is what actually
 * keeps the model pickers honest: rather than a filter that quietly tolerates a stale/keyless
 * selection, the selection itself is corrected the moment its provider's key is removed (or was
 * never entered), so the UI never has a leftover model group showing up just because that's what
 * a role defaulted to.
 *
 * `getModelsForRole` supplies the fallback candidates per role (defaults to the static catalog
 * only). Pass a merged static+live list (see useProviderModels) to also route a role onto a
 * Groq/OpenRouter model once its key is entered — without it, a Groq/OpenRouter-only key can
 * never be picked up here, since the static catalog has no entries for those two providers at
 * all. Because that live list only exists after an async fetch resolves, callers should re-invoke
 * this once the fetch completes (not just at the moment the key is typed) to actually catch a
 * role that was left on a keyless default in the meantime.
 */
export function reconcileAgentsForApiKeys<T extends Record<string, { model: string; thinking_level: string; provider?: string; supports_reasoning?: boolean }>>(
  agents: T,
  apiKeys: ApiKeys,
  toolCallingRoles: Set<keyof T> = new Set(),
  getModelsForRole: (requireToolCalling: boolean) => ModelOption[] = requireToolCalling => getAvailableModels(apiKeys, { requireToolCalling })
): T {
  const next = { ...agents };
  for (const key of Object.keys(agents) as (keyof T)[]) {
    const cfg = agents[key];
    const currentProvider = resolveProviderForModel(cfg.model, cfg.provider);
    if (apiKeys[currentProvider]) continue; // still valid, leave untouched

    const fallback = pickDefaultModel(getModelsForRole(toolCallingRoles.has(key)));
    if (!fallback) continue; // no provider configured at all yet — nothing sensible to fall back to

    const validThinking = getThinkingLevelOptions(fallback.value, fallback.provider, fallback.supportsReasoning);
    next[key] = {
      ...cfg,
      model: fallback.value,
      provider: fallback.provider,
      supports_reasoning: fallback.supportsReasoning,
      thinking_level: normalizeThinkingLevel(cfg.thinking_level, validThinking),
    };
  }
  return next;
}
