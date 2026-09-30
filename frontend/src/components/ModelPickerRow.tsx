import { useId, useEffect } from 'react';
import type { ApiKeys, Provider } from '../utils/providers';
import {
  PROVIDER_LABELS, SUPPORTED_PROVIDERS, resolveProviderForModel, getThinkingLevelOptions,
  normalizeThinkingLevel, pickDefaultModel
} from '../utils/providers';
import { useProviderModels } from '../hooks/useProviderModels';

export interface ModelPickerValue {
  model: string;
  provider?: string;
  thinking_level: string;
  supports_reasoning?: boolean;
}

interface ModelPickerRowProps {
  label: string;
  value: ModelPickerValue;
  onChange: (value: ModelPickerValue) => void;
  apiKeys: ApiKeys;
  requireToolCalling?: boolean;
}

/**
 * A self-contained Provider + typeable Model + conditional Thinking picker — the same pattern
 * used by the Trial Run Console and Settings modal, extracted here so any screen (e.g. the
 * Optimization Lab's setup tab) can offer an independent, locally-owned model picker per role
 * without duplicating this logic. Fully controlled: the caller owns the value, this component
 * only computes what the next value should be.
 */
export default function ModelPickerRow({ label, value, onChange, apiKeys, requireToolCalling }: ModelPickerRowProps) {
  const { models } = useProviderModels(apiKeys, { requireToolCalling });
  const datalistId = useId();

  const currentProvider = resolveProviderForModel(value.model, value.provider);
  const configuredProviders = SUPPORTED_PROVIDERS.filter(p => !!apiKeys[p]);
  const suggestions = models.filter(m => m.provider === currentProvider);
  const matched = suggestions.find(m => m.value === value.model);
  const thinkingOptions = getThinkingLevelOptions(value.model, currentProvider, matched?.supportsReasoning ?? value.supports_reasoning);

  // Keeps this picker honest as keys are added/removed (or a Groq/OpenRouter fetch resolves)
  // elsewhere in the app — reassigns off a now-keyless provider rather than silently keeping a
  // dead selection.
  useEffect(() => {
    if (apiKeys[currentProvider]) return;
    const fallback = pickDefaultModel(models);
    if (!fallback) return;
    onChange({
      model: fallback.value,
      provider: fallback.provider,
      supports_reasoning: fallback.supportsReasoning,
      thinking_level: normalizeThinkingLevel(value.thinking_level, getThinkingLevelOptions(fallback.value, fallback.provider, fallback.supportsReasoning)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKeys.google_genai, apiKeys.openai, apiKeys.anthropic, apiKeys.groq, apiKeys.openrouter, models.length]);

  const handleProviderChange = (provider: Provider) => {
    const defaultOption = pickDefaultModel(models.filter(m => m.provider === provider));
    const model = defaultOption?.value || '';
    const supports_reasoning = defaultOption?.supportsReasoning;
    onChange({
      model, provider, supports_reasoning,
      thinking_level: normalizeThinkingLevel(value.thinking_level, getThinkingLevelOptions(model, provider, supports_reasoning)),
    });
  };

  const handleModelChange = (model: string) => {
    const matchedNext = suggestions.find(m => m.value === model);
    onChange({
      ...value,
      model,
      supports_reasoning: matchedNext?.supportsReasoning,
      thinking_level: normalizeThinkingLevel(value.thinking_level, getThinkingLevelOptions(model, currentProvider, matchedNext?.supportsReasoning)),
    });
  };

  return (
    <div style={{ padding: '8px 12px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-color)' }}>
      <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', gap: 6 }}>
        <select
          className="studio-select"
          style={{ width: 100, fontSize: '0.78rem' }}
          value={currentProvider}
          onChange={e => handleProviderChange(e.target.value as Provider)}
        >
          {configuredProviders.map(p => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
        <input
          list={datalistId}
          className="studio-input"
          style={{ flex: 1, fontSize: '0.78rem', padding: '4px 8px' }}
          value={value.model}
          placeholder="Type or pick a model id..."
          onChange={e => handleModelChange(e.target.value)}
        />
        <datalist id={datalistId}>
          {suggestions.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </datalist>
      </div>
      {thinkingOptions.length > 0 && (
        <select
          className="studio-select"
          style={{ width: '100%', marginTop: 6, fontSize: '0.76rem' }}
          value={value.thinking_level}
          onChange={e => onChange({ ...value, thinking_level: e.target.value })}
        >
          {thinkingOptions.map(t => <option key={t} value={t}>Thinking: {t}</option>)}
        </select>
      )}
    </div>
  );
}
