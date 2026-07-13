import React from 'react';
import { useSettings } from '../context/SettingsContext';
import type { AgentConfig } from '../context/SettingsContext';
import { X, Key, Cpu, BrainCircuit, ShieldCheck, CheckCircle2 } from 'lucide-react';
import '../index.css';

const MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-pro',
  'gemini-3.1-flash',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
];

const THINKING_LEVELS = ['None', 'Low', 'Medium', 'High'];

export default function SettingsModal() {
  const { settings, updateSettings, isSettingsOpen, setIsSettingsOpen } = useSettings();
  const [localSettings, setLocalSettings] = React.useState(settings);

  React.useEffect(() => {
    if (isSettingsOpen) {
      setLocalSettings(settings);
    }
  }, [isSettingsOpen, settings]);

  if (!isSettingsOpen) return null;

  const handleSave = () => {
    updateSettings(localSettings);
    setIsSettingsOpen(false);
  };

  const updateAgent = (agent: 'orchestrator' | 'generators' | 'verifier', field: keyof AgentConfig, value: string) => {
    setLocalSettings(prev => ({
      ...prev,
      [agent]: { ...prev[agent], [field]: value }
    }));
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-modal" style={{ maxWidth: 640 }}>
        <div className="modal-header">
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <BrainCircuit size={22} color="var(--accent-primary)" /> Deployment Settings
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 4 }}>
              Configure your API keys and multi-agent AI pipeline.
            </p>
          </div>
          <button className="btn btn-outline" onClick={() => setIsSettingsOpen(false)} style={{ padding: 6 }}>
            <X size={18} />
          </button>
        </div>

        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
          
          {/* API KEY SECTION */}
          <div className="instruction-group" style={{ marginBottom: 32 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.95rem' }}>
              <Key size={16} /> Google GenAI API Key
            </label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 12 }}>
              Your key is strictly stored in local memory and is never saved to our servers.
            </p>
            <input
              type="password"
              className="user-input"
              style={{ width: '100%', padding: '12px 16px', background: 'var(--bg-primary)' }}
              placeholder="AIzaSy..."
              value={localSettings.apiKey}
              onChange={e => setLocalSettings(prev => ({ ...prev, apiKey: e.target.value }))}
            />
          </div>

          <h3 style={{ fontSize: '1.05rem', color: 'var(--text-primary)', marginBottom: 16, borderBottom: '1px solid var(--border-color)', paddingBottom: 8 }}>
            Agent Pipeline Architecture
          </h3>

          {/* ORCHESTRATOR */}
          <div className="instruction-group" style={{ background: 'var(--bg-tertiary)', padding: 16, borderRadius: 'var(--radius-md)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Cpu size={16} color="var(--accent-primary)" /> Orchestrator Agent
            </label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 12 }}>
              High-level planner. Needs strong reasoning for complex goals.
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <select 
                className="user-input" 
                style={{ flex: 1, padding: '8px 12px' }}
                value={localSettings.orchestrator.model}
                onChange={e => updateAgent('orchestrator', 'model', e.target.value)}
              >
                {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select 
                className="user-input" 
                style={{ width: 140, padding: '8px 12px' }}
                value={localSettings.orchestrator.thinking_level}
                onChange={e => updateAgent('orchestrator', 'thinking_level', e.target.value)}
              >
                {THINKING_LEVELS.map(t => <option key={t} value={t}>Thinking: {t}</option>)}
              </select>
            </div>
          </div>

          {/* GENERATORS */}
          <div className="instruction-group" style={{ background: 'var(--bg-tertiary)', padding: 16, borderRadius: 'var(--radius-md)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Edit3Icon /> Creator & Updater Agents
            </label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 12 }}>
              Drafts prompts and writes JSON patches. Needs high speed and low latency.
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <select 
                className="user-input" 
                style={{ flex: 1, padding: '8px 12px' }}
                value={localSettings.generators.model}
                onChange={e => updateAgent('generators', 'model', e.target.value)}
              >
                {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select 
                className="user-input" 
                style={{ width: 140, padding: '8px 12px' }}
                value={localSettings.generators.thinking_level}
                onChange={e => updateAgent('generators', 'thinking_level', e.target.value)}
              >
                {THINKING_LEVELS.map(t => <option key={t} value={t}>Thinking: {t}</option>)}
              </select>
            </div>
          </div>

          {/* VERIFIER */}
          <div className="instruction-group" style={{ background: 'var(--bg-tertiary)', padding: 16, borderRadius: 'var(--radius-md)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ShieldCheck size={16} color="var(--danger-color, #f87171)" /> Verification Agent
            </label>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginBottom: 12 }}>
              Cross-references logic. Standard models are usually sufficient here.
            </p>
            <div style={{ display: 'flex', gap: 12 }}>
              <select 
                className="user-input" 
                style={{ flex: 1, padding: '8px 12px' }}
                value={localSettings.verifier.model}
                onChange={e => updateAgent('verifier', 'model', e.target.value)}
              >
                {MODELS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <select 
                className="user-input" 
                style={{ width: 140, padding: '8px 12px' }}
                value={localSettings.verifier.thinking_level}
                onChange={e => updateAgent('verifier', 'thinking_level', e.target.value)}
              >
                {THINKING_LEVELS.map(t => <option key={t} value={t}>Thinking: {t}</option>)}
              </select>
            </div>
          </div>

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

// Inline icon component to avoid extra imports for one usage
function Edit3Icon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
    </svg>
  );
}
