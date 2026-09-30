import { useState, useEffect, useId } from 'react';
import { X, Play, Sparkles } from 'lucide-react';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import CustomSelect from './CustomSelect';
import {
  getKeyForModel, resolveProviderForModel, getThinkingLevelOptions, normalizeThinkingLevel,
  PROVIDER_LABELS, SUPPORTED_PROVIDERS, pickDefaultModel
} from '../utils/providers';
import type { Provider } from '../utils/providers';
import { useProviderModels } from '../hooks/useProviderModels';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

const THINKING_LABELS: Record<string, string> = {
  None: 'None',
  Minimal: 'Minimal',
  Low: 'Low (1k)',
  Medium: 'Medium (4k)',
  High: 'High (8k)',
  On: 'On',
};

interface TrialRunModalProps {
  isOpen: boolean;
  onClose: () => void;
  prompt: string;
  schema: string;
  theme: string;
}

export default function TrialRunModal({ isOpen, onClose, prompt, schema, theme }: TrialRunModalProps) {
  const { settings } = useSettings();
  const { showToast } = useToast();

  const [trialModel, setTrialModel] = useState('gemini-3.5-flash-lite');
  const [trialProvider, setTrialProvider] = useState<string | undefined>(undefined);
  const [trialSupportsReasoning, setTrialSupportsReasoning] = useState<boolean | undefined>(undefined);
  const [trialTemperature, setTrialTemperature] = useState(0.7);
  const [trialThinking, setTrialThinking] = useState('Low');
  const [trialKb, setTrialKb] = useState('');
  const [trialQuery, setTrialQuery] = useState('');
  const [trialResult, setTrialResult] = useState('');
  const [isTrialRunning, setIsTrialRunning] = useState(false);
  const [isGeneratingKb, setIsGeneratingKb] = useState(false);
  const [isGeneratingQuery, setIsGeneratingQuery] = useState(false);

  const { models: trialModelOptions } = useProviderModels(settings.apiKeys);
  const modelDatalistId = useId();

  // If the currently-selected trial model's provider has no key configured (e.g. only an OpenAI
  // key was ever entered, but this defaulted to a Gemini model), switch to the first model whose
  // provider actually has a key, instead of leaving a keyless model selected.
  useEffect(() => {
    const provider = resolveProviderForModel(trialModel, trialProvider);
    if (settings.apiKeys[provider as keyof typeof settings.apiKeys]) return;
    const fallback = pickDefaultModel(trialModelOptions);
    if (!fallback) return;
    setTrialModel(fallback.value);
    setTrialProvider(fallback.provider);
    setTrialSupportsReasoning(fallback.supportsReasoning);
    setTrialThinking(prev => normalizeThinkingLevel(prev, getThinkingLevelOptions(fallback.value, fallback.provider, fallback.supportsReasoning)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiKeys.google_genai, settings.apiKeys.openai, settings.apiKeys.anthropic, settings.apiKeys.groq, settings.apiKeys.openrouter, trialModelOptions.length]);

  if (!isOpen) return null;

  const currentProvider = resolveProviderForModel(trialModel, trialProvider);
  const trialThinkingValues = getThinkingLevelOptions(trialModel, currentProvider, trialSupportsReasoning);
  const trialThinkingOptions = trialThinkingValues.map(v => ({ value: v, label: THINKING_LABELS[v] || v }));
  const configuredProviders = SUPPORTED_PROVIDERS.filter(p => !!settings.apiKeys[p]);
  const modelSuggestions = trialModelOptions.filter(m => m.provider === currentProvider);

  // Typeable, not a locked dropdown: any model id can be typed directly (needed for Groq/
  // OpenRouter's huge, fast-moving catalogs), with the fetched/static list offered as suggestions.
  const handleTrialModelChange = (model: string) => {
    const opt = modelSuggestions.find(m => m.value === model);
    setTrialModel(model);
    setTrialSupportsReasoning(opt?.supportsReasoning);
    const validOptions = getThinkingLevelOptions(model, currentProvider, opt?.supportsReasoning);
    setTrialThinking(prev => normalizeThinkingLevel(prev, validOptions));
  };

  const handleTrialProviderChange = (provider: Provider) => {
    const defaultOption = pickDefaultModel(trialModelOptions.filter(m => m.provider === provider));
    setTrialProvider(provider);
    setTrialModel(defaultOption?.value || '');
    setTrialSupportsReasoning(defaultOption?.supportsReasoning);
    const validOptions = getThinkingLevelOptions(defaultOption?.value || '', provider, defaultOption?.supportsReasoning);
    setTrialThinking(prev => normalizeThinkingLevel(prev, validOptions));
  };

  const handleTrialRun = async () => {
    if (!trialQuery.trim()) { showToast('Query is required', 'error'); return; }

    setIsTrialRunning(true);
    setTrialResult('');

    try {
      const res = await fetch(`${API_URL}/trial_run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: getKeyForModel(settings.apiKeys, trialModel, trialProvider),
          config: {
            model: trialModel,
            provider: currentProvider,
            temperature: trialTemperature,
            thinking_level: trialThinkingOptions.length > 0 ? trialThinking : 'None',
            supports_reasoning: trialSupportsReasoning,
          },
          prompt,
          json_schema: schema,
          knowledge_base: trialKb,
          query: trialQuery
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setTrialResult(data.detail || `Trial run failed (HTTP ${res.status})`);
        return;
      }
      setTrialResult(typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2));
    } catch (err: any) {
      setTrialResult(err.message || 'Trial run failed');
    } finally {
      setIsTrialRunning(false);
    }
  };

  const handleGenerateKb = async () => {
    if (!prompt.trim()) { showToast('Please write a prompt first.', 'error'); return; }
    setIsGeneratingKb(true);
    try {
      const res = await fetch(`${API_URL}/lab/generate_kb`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: getKeyForModel(settings.apiKeys, settings.generators.model, settings.generators.provider), config: settings.generators, prompt, json_schema: schema })
      });
      const data = await res.json();
      if (data.kb) { setTrialKb(data.kb); showToast('Knowledge Base generated', 'success'); }
    } catch (err: any) {
      showToast('Failed to generate KB: ' + err.message, 'error');
    } finally {
      setIsGeneratingKb(false);
    }
  };

  const handleGenerateQuery = async () => {
    if (!prompt.trim()) { showToast('Please write a prompt first.', 'error'); return; }
    setIsGeneratingQuery(true);
    try {
      const res = await fetch(`${API_URL}/lab/generate_queries`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: getKeyForModel(settings.apiKeys, settings.generators.model, settings.generators.provider), config: settings.generators,
          prompt, kb: trialKb, json_schema: schema, count: 1, levels: ['L1']
        })
      });
      const data = await res.json();
      if (data.queries && data.queries.length > 0) {
        setTrialQuery(data.queries[0].query);
        showToast('User query generated', 'success');
      }
    } catch (err: any) {
      showToast('Failed to generate query: ' + err.message, 'error');
    } finally {
      setIsGeneratingQuery(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-modal" style={{ maxWidth: '95vw', width: '1400px', height: '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div className="modal-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: 16 }}>
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Play size={20} color="var(--accent-primary)" /> Trial Run Console
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 3 }}>
              Run the active prompt against a single query to quickly validate outputs.
            </p>
          </div>
          <button className="btn btn-outline" onClick={onClose} style={{ padding: 8 }}><X size={18} /></button>
        </div>

        {/* Toolbar */}
        <div className="toolbar" style={{ borderBottom: '1px solid var(--border-color)' }}>
          <div className="toolbar-group">
            <span className="toolbar-label">Provider</span>
            <select
              className="user-input"
              style={{ minWidth: 130, padding: '6px 10px' }}
              value={currentProvider}
              onChange={e => handleTrialProviderChange(e.target.value as Provider)}
            >
              {configuredProviders.map(p => (
                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
              ))}
            </select>
          </div>
          <div className="toolbar-group" style={{ marginLeft: 16 }}>
            <span className="toolbar-label">Model</span>
            {/* Typeable, not a locked dropdown — matches the settings picker: suggestions from
                the static/live catalog via the datalist, but any model id can be typed directly. */}
            <input
              list={modelDatalistId}
              className="user-input"
              style={{ minWidth: 200, padding: '6px 10px' }}
              value={trialModel}
              placeholder="Type or pick a model id..."
              onChange={e => handleTrialModelChange(e.target.value)}
            />
            <datalist id={modelDatalistId}>
              {modelSuggestions.map(m => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </datalist>
          </div>
          {trialThinkingOptions.length > 0 && (
            <div className="toolbar-group" style={{ marginLeft: 16 }}>
              <span className="toolbar-label">Thinking</span>
              <CustomSelect value={trialThinking} onChange={setTrialThinking} options={trialThinkingOptions} style={{ minWidth: 140 }} />
            </div>
          )}
          <div className="toolbar-group" style={{ marginLeft: 16 }}>
            <span className="toolbar-label">Temp: {trialTemperature.toFixed(1)}</span>
            <input
              type="range" min="0" max="2" step="0.1" value={trialTemperature}
              onChange={e => setTrialTemperature(parseFloat(e.target.value))}
              className="toolbar-slider"
            />
          </div>
          <div style={{ flex: 1 }} />
          <button
            className="btn btn-primary"
            onClick={handleTrialRun}
            disabled={isTrialRunning || !trialQuery.trim()}
            style={{ padding: '6px 20px', height: 32 }}
          >
            {isTrialRunning ? <div className="loader" style={{ width: 14, height: 14, borderWidth: 2, borderTopColor: '#fff' }} /> : <Play size={14} />}
            Run Trial
          </button>
        </div>

        {/* Body — split pane */}
        <div className="split-pane" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {isTrialRunning && (
            <div style={{ position: 'absolute', inset: 0, background: 'var(--bg-glass)', backdropFilter: 'blur(4px)', zIndex: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <div className="loader" style={{ width: 30, height: 30, borderWidth: 3, borderTopColor: 'var(--accent-primary)' }} />
            </div>
          )}

          {/* Left: Inputs */}
          <div className="pane" style={{ flex: '0 0 45%', minHeight: 0 }}>
            {/* KB */}
            <div className="pane-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>Knowledge Base <span style={{ color: 'var(--text-muted)', fontSize: '0.75rem' }}>(Optional)</span></span>
              <button
                className="btn btn-outline"
                style={{ padding: '3px 10px', fontSize: '0.75rem', gap: 5 }}
                onClick={handleGenerateKb}
                disabled={isGeneratingKb}
              >
                {isGeneratingKb ? <div className="loader" style={{ width: 11, height: 11, borderWidth: 2 }} /> : <Sparkles size={12} />}
                Generate KB
              </button>
            </div>
            <div className="editor-container" style={{ flex: '0 0 40%', padding: 0, display: 'flex', minHeight: 0 }}>
              <CodeMirror
                value={trialKb}
                height="100%"
                extensions={[markdown()]}
                onChange={setTrialKb}
                theme={theme === 'dark' ? 'dark' : 'light'}
                style={{ flex: 1, fontSize: '0.84rem' }}
                placeholder="Paste documents, emails, or context data here…"
              />
            </div>

            <div className="pane-divider" style={{ width: '100%', height: 1 }} />

            {/* Query */}
            <div className="pane-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span>User Query</span>
              <button
                className="btn btn-outline"
                style={{ padding: '3px 10px', fontSize: '0.75rem', gap: 5 }}
                onClick={handleGenerateQuery}
                disabled={isGeneratingQuery}
              >
                {isGeneratingQuery ? <div className="loader" style={{ width: 11, height: 11, borderWidth: 2 }} /> : <Sparkles size={12} />}
                Generate Query
              </button>
            </div>
            <div className="editor-container" style={{ flex: '0 0 60%', padding: 0, display: 'flex', minHeight: 0 }}>
              <CodeMirror
                value={trialQuery}
                height="100%"
                extensions={[]}
                onChange={setTrialQuery}
                theme={theme === 'dark' ? 'dark' : 'light'}
                style={{ flex: 1, fontSize: '0.84rem' }}
                placeholder="What should the model do?"
              />
            </div>
          </div>

          <div className="pane-divider" />

          {/* Right: Output */}
          <div className="pane" style={{ minHeight: 0 }}>
            <div className="pane-header">LLM Output (JSON)</div>
            <div className="editor-container" style={{ flex: 1, padding: 0, display: 'flex', minHeight: 0 }}>
              <CodeMirror
                value={trialResult}
                height="100%"
                extensions={[json()]}
                theme={theme === 'dark' ? 'dark' : 'light'}
                editable={false}
                style={{ flex: 1, fontSize: '0.84rem' }}
                placeholder="Output will appear here after running…"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
