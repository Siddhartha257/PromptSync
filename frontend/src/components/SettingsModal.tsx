import React from 'react';
import { useSettings } from '../context/SettingsContext';
import type { AgentConfig } from '../context/SettingsContext';
import {
  PROVIDER_LABELS, SUPPORTED_PROVIDERS, hasAnyApiKey, getThinkingLevelOptions, resolveProviderForModel,
  normalizeThinkingLevel, reconcileAgentsForApiKeys, pickDefaultModel
} from '../utils/providers';
import type { Provider, ApiKeys, ModelOption } from '../utils/providers';
import { useProviderModels } from '../hooks/useProviderModels';
import { X, Key, Cpu, BrainCircuit, ShieldCheck, CheckCircle2, FlaskConical, Bot, Info } from 'lucide-react';
import '../index.css';

type AgentKey = 'orchestrator' | 'generators' | 'verifier' | 'evaluator' | 'optimizer' | 'copilot';
const TOOL_CALLING_ROLES = new Set<AgentKey>(['copilot']);

const API_KEY_FIELDS: { provider: Provider; label: string; placeholder: string }[] = [
  { provider: 'google_genai', label: 'Google (Gemini)', placeholder: 'AIzaSy...' },
  { provider: 'openai', label: 'OpenAI', placeholder: 'sk-...' },
  { provider: 'anthropic', label: 'Anthropic (Claude)', placeholder: 'sk-ant-...' },
  { provider: 'groq', label: 'Groq', placeholder: 'gsk_...' },
  { provider: 'openrouter', label: 'OpenRouter', placeholder: 'sk-or-...' },
];

function AgentConfigRow({
  label,
  icon,
  description,
  config,
  apiKeys,
  models,
  loading,
  errors,
  requireToolCalling,
  onProviderChange,
  onModelChange,
  onThinkingChange,
}: {
  label: string;
  icon: React.ReactNode;
  description: string;
  config: AgentConfig;
  apiKeys: ApiKeys;
  models: ModelOption[];
  loading?: Partial<Record<Provider, boolean>>;
  errors?: Partial<Record<Provider, string>>;
  requireToolCalling?: boolean;
  onProviderChange: (provider: Provider) => void;
  onModelChange: (model: string) => void;
  onThinkingChange: (v: string) => void;
}) {
  const datalistId = React.useId();
  const configuredProviders = SUPPORTED_PROVIDERS.filter(p => !!apiKeys[p]);
  const currentProvider = resolveProviderForModel(config.model, config.provider);
  const suggestions = models.filter(m => m.provider === currentProvider);
  const matched = suggestions.find(m => m.value === config.model);
  const thinkingOptions = getThinkingLevelOptions(config.model, currentProvider, matched?.supportsReasoning ?? config.supports_reasoning);

  const dynamicLoading = loading?.groq || loading?.openrouter;
  const dynamicError = errors?.groq || errors?.openrouter;
  const noToolCallingWarning = requireToolCalling && matched?.noToolCalling;

  return (
    <div className="instruction-group" style={{ background: 'var(--bg-tertiary)', padding: 16, borderRadius: 'var(--radius-md)' }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {icon} {label}
      </label>
      <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 12 }}>{description}</p>
      <div style={{ display: 'flex', gap: 12 }}>
        <select
          className="user-input"
          style={{ width: 150, padding: '8px 12px' }}
          value={currentProvider}
          onChange={e => onProviderChange(e.target.value as Provider)}
        >
          {configuredProviders.map(p => (
            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
          ))}
        </select>
        {/* Typeable, not a locked dropdown: suggestions (static catalog + any live Groq/OpenRouter
            fetch) are offered via the datalist, but any model id can be typed directly — needed
            for Groq/OpenRouter's huge, fast-moving catalogs, and kept consistent for every
            provider rather than special-casing just those two. */}
        <input
          list={datalistId}
          className="user-input"
          style={{ flex: 1, padding: '8px 12px' }}
          value={config.model}
          placeholder="Type or pick a model id..."
          onChange={e => onModelChange(e.target.value)}
        />
        <datalist id={datalistId}>
          {suggestions.map(m => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </datalist>
        {/* An empty thinkingOptions means this specific model has no thinking/reasoning control
            at all (most Groq models, non-reasoning OpenRouter models, or any model we have no
            metadata for because it was typed by hand) — hide the selector rather than show one
            that silently does nothing. */}
        {thinkingOptions.length > 0 && (
          <select
            className="user-input"
            style={{ width: 140, padding: '8px 12px' }}
            value={config.thinking_level}
            onChange={e => onThinkingChange(e.target.value)}
          >
            {thinkingOptions.map(t => <option key={t} value={t}>Thinking: {t}</option>)}
          </select>
        )}
      </div>
      {dynamicLoading && (
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>Fetching live model list…</p>
      )}
      {dynamicError && (
        <p style={{ fontSize: '0.72rem', color: 'var(--danger-color, #f87171)', marginTop: 6 }}>{dynamicError}</p>
      )}
      {noToolCallingWarning && (
        <p style={{ fontSize: '0.72rem', color: 'var(--danger-color, #f87171)', marginTop: 6 }}>
          This model doesn't support tool calling — the Co-Pilot's search/read tools won't work.
        </p>
      )}
    </div>
  );
}

export default function SettingsModal() {
  const { settings, updateSettings, isSettingsOpen, setIsSettingsOpen } = useSettings();
  const [localSettings, setLocalSettings] = React.useState(settings);

  React.useEffect(() => {
    if (isSettingsOpen) {
      setLocalSettings(settings);
    }
  }, [isSettingsOpen, settings]);

  // Two lookups because the Co-Pilot role must exclude non-tool-calling models (Gemma, and any
  // Groq/OpenRouter model reported as not supporting function calling) while every other role
  // may use them freely. Both share fetchProviderModels' own per-key cache, so this doesn't
  // double the network calls.
  const standard = useProviderModels(localSettings.apiKeys, { requireToolCalling: false });
  const toolCapable = useProviderModels(localSettings.apiKeys, { requireToolCalling: true });

  const ALL_AGENT_KEYS: AgentKey[] = ['orchestrator', 'generators', 'verifier', 'evaluator', 'optimizer', 'copilot'];

  // Reconciles every role against a given apiKeys set, using the merged static+live model list
  // (standard.models / toolCapable.models per role) rather than just the static catalog — needed
  // so a Groq/OpenRouter-only key can actually route a role there, not just Gemini/OpenAI/Anthropic.
  const reconcileAllAgents = (prev: typeof localSettings, apiKeys: ApiKeys) => {
    const agents = Object.fromEntries(ALL_AGENT_KEYS.map(k => [k, prev[k]])) as Record<AgentKey, AgentConfig>;
    return reconcileAgentsForApiKeys(
      agents, apiKeys, TOOL_CALLING_ROLES,
      requireToolCalling => requireToolCalling ? toolCapable.models : standard.models
    );
  };

  // Groq/OpenRouter's model list only exists after an async fetch resolves — a reconciliation
  // that fires the instant a key is typed can't route a role to one yet at that point. Re-run it
  // once the live fetch actually completes, so a role left on its keyless native default in the
  // meantime still gets corrected. Must run above the isSettingsOpen early return (Rules of Hooks).
  React.useEffect(() => {
    setLocalSettings(prev => {
      const reconciled = reconcileAllAgents(prev, prev.apiKeys);
      const changed = ALL_AGENT_KEYS.some(k => reconciled[k].model !== prev[k].model || reconciled[k].provider !== prev[k].provider);
      return changed ? { ...prev, ...reconciled } : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [standard.models.length, toolCapable.models.length]);

  if (!isSettingsOpen) return null;

  const handleSave = () => {
    updateSettings(localSettings);
    setIsSettingsOpen(false);
  };

  const updateAgent = (agent: AgentKey, field: keyof AgentConfig, value: string) => {
    setLocalSettings(prev => ({
      ...prev,
      [agent]: { ...prev[agent], [field]: value }
    }));
  };

  // Switching provider picks that provider's first known/fetched model as a starting point
  // (rather than leaving a stale model id from the old provider) — the user can still type over
  // it immediately.
  const setAgentProvider = (agent: AgentKey, provider: Provider) => {
    setLocalSettings(prev => {
      const relevantModels = TOOL_CALLING_ROLES.has(agent) ? toolCapable.models : standard.models;
      const defaultOption = pickDefaultModel(relevantModels.filter(m => m.provider === provider));
      const model = defaultOption?.value || '';
      const supports_reasoning = defaultOption?.supportsReasoning;
      const validThinking = getThinkingLevelOptions(model, provider, supports_reasoning);
      const thinking_level = normalizeThinkingLevel(prev[agent].thinking_level, validThinking);
      return { ...prev, [agent]: { ...prev[agent], model, provider, supports_reasoning, thinking_level } };
    });
  };

  // Free-text model entry: if the typed value happens to match a known/fetched suggestion its
  // capability metadata (supports_reasoning) comes along for free; otherwise it's left undefined
  // and the thinking-tier resolution falls back to that provider's generic default.
  const setAgentModelText = (agent: AgentKey, model: string) => {
    setLocalSettings(prev => {
      const provider = resolveProviderForModel(prev[agent].model, prev[agent].provider);
      const relevantModels = TOOL_CALLING_ROLES.has(agent) ? toolCapable.models : standard.models;
      const matched = relevantModels.find(m => m.value === model && m.provider === provider);
      const supports_reasoning = matched?.supportsReasoning;
      const validThinking = getThinkingLevelOptions(model, provider, supports_reasoning);
      const thinking_level = normalizeThinkingLevel(prev[agent].thinking_level, validThinking);
      return { ...prev, [agent]: { ...prev[agent], model, supports_reasoning, thinking_level } };
    });
  };

  // Updating a key can make a role's currently-selected model unavailable (its provider's key
  // was just cleared) — reconcile every role's selection immediately rather than leaving a stale
  // choice pointing at a now-keyless provider.
  const updateApiKey = (provider: Provider, value: string) => {
    setLocalSettings(prev => {
      const apiKeys = { ...prev.apiKeys, [provider]: value };
      return { ...prev, apiKeys, ...reconcileAllAgents(prev, apiKeys) };
    });
  };

  const configured = hasAnyApiKey(localSettings.apiKeys);

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-modal" style={{ maxWidth: 680 }}>
        <div className="modal-header">
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BrainCircuit size={22} color="var(--accent-primary)" /> Deployment Settings
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 4 }}>
              Configure your API keys and the AI model for each agent role.
            </p>
          </div>
          <button className="btn btn-outline" onClick={() => setIsSettingsOpen(false)} style={{ padding: 6 }}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ maxHeight: '70vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 24 }}>

          {/* API KEYS */}
          <div className="instruction-group" style={{ marginBottom: 0 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.95rem' }}>
              <Key size={16} /> API Keys
            </label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 12 }}>
              Stored only in local memory — never sent to our servers. Only providers with a key entered here show up in the model pickers below.
              Groq and OpenRouter model lists are fetched live once a key is entered, since both host catalogs too large to list here.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {API_KEY_FIELDS.map(({ provider, label, placeholder }) => (
                <div key={provider}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>{label}</span>
                  <input
                    type="password"
                    className="user-input"
                    style={{ width: '100%', padding: '10px 14px', background: 'var(--bg-primary)' }}
                    placeholder={placeholder}
                    value={localSettings.apiKeys[provider]}
                    onChange={e => updateApiKey(provider, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>

          {!configured ? (
            <div style={{
              display: 'flex', gap: 10, padding: '14px 16px', borderRadius: 'var(--radius-md)',
              background: 'var(--accent-light)', border: '1px solid var(--accent-primary)'
            }}>
              <Info size={16} color="var(--accent-primary)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                No API key yet — an API key is required to use Prompter Studio. Add one above
                to unlock model selection for each agent role below.
              </div>
            </div>
          ) : (
            <>
              {/* SECTION: Editor Pipeline */}
              <div>
                <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: 12, borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                  Editor Agent Pipeline
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <AgentConfigRow
                    label="Orchestrator Agent"
                    icon={<Cpu size={16} color="var(--accent-primary)" />}
                    description="High-level planner. Needs strong reasoning for complex goals."
                    config={localSettings.orchestrator}
                    apiKeys={localSettings.apiKeys}
                    models={standard.models}
                    loading={standard.loading}
                    errors={standard.errors}
                    onProviderChange={p => setAgentProvider('orchestrator', p)}
                    onModelChange={m => setAgentModelText('orchestrator', m)}
                    onThinkingChange={v => updateAgent('orchestrator', 'thinking_level', v)}
                  />
                  <AgentConfigRow
                    label="Creator & Updater Agents"
                    icon={<Edit3Icon />}
                    description="Drafts prompts and writes JSON patches. Best-capability model recommended — it's writing the prompt itself."
                    config={localSettings.generators}
                    apiKeys={localSettings.apiKeys}
                    models={standard.models}
                    loading={standard.loading}
                    errors={standard.errors}
                    onProviderChange={p => setAgentProvider('generators', p)}
                    onModelChange={m => setAgentModelText('generators', m)}
                    onThinkingChange={v => updateAgent('generators', 'thinking_level', v)}
                  />
                  <AgentConfigRow
                    label="Verification Agent"
                    icon={<ShieldCheck size={16} color="var(--danger-color, #f87171)" />}
                    description="Cross-references prompt and schema logic. Fast models are usually sufficient."
                    config={localSettings.verifier}
                    apiKeys={localSettings.apiKeys}
                    models={standard.models}
                    loading={standard.loading}
                    errors={standard.errors}
                    onProviderChange={p => setAgentProvider('verifier', p)}
                    onModelChange={m => setAgentModelText('verifier', m)}
                    onThinkingChange={v => updateAgent('verifier', 'thinking_level', v)}
                  />
                </div>
              </div>

              {/* SECTION: Optimization Lab */}
              <div>
                <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: 12, borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                  Optimization Lab Agents
                </h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <AgentConfigRow
                    label="Evaluator Agent"
                    icon={<ShieldCheck size={16} color="var(--accent-secondary, #a78bfa)" />}
                    description="Scores prompt outputs against acceptance criteria. Use a stronger model for deeper analysis."
                    config={localSettings.evaluator}
                    apiKeys={localSettings.apiKeys}
                    models={standard.models}
                    loading={standard.loading}
                    errors={standard.errors}
                    onProviderChange={p => setAgentProvider('evaluator', p)}
                    onModelChange={m => setAgentModelText('evaluator', m)}
                    onThinkingChange={v => updateAgent('evaluator', 'thinking_level', v)}
                  />
                  <AgentConfigRow
                    label="Optimizer Agent"
                    icon={<FlaskConical size={16} color="var(--accent-secondary, #a78bfa)" />}
                    description="Rewrites the prompt based on evaluator critique. Fast models work well here."
                    config={localSettings.optimizer}
                    apiKeys={localSettings.apiKeys}
                    models={standard.models}
                    loading={standard.loading}
                    errors={standard.errors}
                    onProviderChange={p => setAgentProvider('optimizer', p)}
                    onModelChange={m => setAgentModelText('optimizer', m)}
                    onThinkingChange={v => updateAgent('optimizer', 'thinking_level', v)}
                  />
                </div>
              </div>

              {/* SECTION: Co-Pilot */}
              <div>
                <h3 style={{ fontSize: '0.9rem', color: 'var(--text-primary)', marginBottom: 12, borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
                  Co-Pilot Chat
                </h3>
                <AgentConfigRow
                  label="Co-Pilot Model"
                  icon={<Bot size={16} color="var(--accent-primary)" />}
                  description="Powers the AI chat assistant. Needs tool-calling support and strong reasoning for best-quality answers and proposals."
                  config={localSettings.copilot}
                  apiKeys={localSettings.apiKeys}
                  models={toolCapable.models}
                  loading={toolCapable.loading}
                  errors={toolCapable.errors}
                  requireToolCalling
                  onProviderChange={p => setAgentProvider('copilot', p)}
                  onModelChange={m => setAgentModelText('copilot', m)}
                  onThinkingChange={v => updateAgent('copilot', 'thinking_level', v)}
                />
              </div>
            </>
          )}

        </div>

        <div className="modal-footer">
          <button className="btn btn-primary" onClick={handleSave} style={{ width: '100%', justifyContent: 'center' }}>
            <CheckCircle2 size={16} /> Save Configuration
          </button>
        </div>
      </div>
    </div>
  );
}

// Inline icon component
function Edit3Icon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
  );
}
