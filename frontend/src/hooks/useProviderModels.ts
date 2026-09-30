import { useEffect, useState } from 'react';
import type { ApiKeys, ModelOption, Provider } from '../utils/providers';
import { DYNAMIC_PROVIDERS, fetchProviderModels, getAvailableModels } from '../utils/providers';

/**
 * Merges the static native-provider catalog with a live fetch of any Groq/OpenRouter models,
 * refetching whenever those two keys change. Every model picker in the app should go through
 * this hook rather than getAvailableModels directly, so Groq/OpenRouter show up once a key is
 * entered instead of only ever offering Gemini/OpenAI/Anthropic.
 */
export function useProviderModels(apiKeys: ApiKeys, opts: { requireToolCalling?: boolean } = {}) {
  const [dynamicModels, setDynamicModels] = useState<Partial<Record<Provider, ModelOption[]>>>({});
  const [loading, setLoading] = useState<Partial<Record<Provider, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<Provider, string>>>({});

  useEffect(() => {
    DYNAMIC_PROVIDERS.forEach(provider => {
      const key = apiKeys[provider];
      if (!key) {
        setDynamicModels(prev => ({ ...prev, [provider]: [] }));
        setErrors(prev => ({ ...prev, [provider]: undefined }));
        return;
      }
      setLoading(prev => ({ ...prev, [provider]: true }));
      fetchProviderModels(provider, key)
        .then(models => {
          setDynamicModels(prev => ({ ...prev, [provider]: models }));
          setErrors(prev => ({ ...prev, [provider]: undefined }));
        })
        .catch((err: Error) => {
          setDynamicModels(prev => ({ ...prev, [provider]: [] }));
          setErrors(prev => ({ ...prev, [provider]: err.message }));
        })
        .finally(() => setLoading(prev => ({ ...prev, [provider]: false })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeys.groq, apiKeys.openrouter]);

  const requireToolCalling = !!opts.requireToolCalling;
  const dynamicList = DYNAMIC_PROVIDERS.flatMap(p => dynamicModels[p] || []).filter(
    m => !(requireToolCalling && m.noToolCalling)
  );
  const staticList = getAvailableModels(apiKeys, opts);

  return {
    models: [...staticList, ...dynamicList],
    loading,
    errors,
  };
}
