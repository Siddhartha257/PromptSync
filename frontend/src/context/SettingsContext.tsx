import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import type { ApiKeys } from '../utils/providers';

export interface AgentConfig {
  model: string;
  thinking_level: string;
  provider?: string;
  /** Only meaningful for provider === 'openrouter' — see ModelOption.supportsReasoning. Sent to
   * the backend as-is so it knows whether to apply thinking_level for this model at all. */
  supports_reasoning?: boolean;
}

export interface SettingsState {
  apiKeys: ApiKeys;
  orchestrator: AgentConfig;
  generators: AgentConfig;
  verifier: AgentConfig;
  evaluator: AgentConfig;
  optimizer: AgentConfig;
  copilot: AgentConfig;
}

interface SettingsContextType {
  settings: SettingsState;
  updateSettings: (newSettings: Partial<SettingsState>) => void;
  isSettingsOpen: boolean;
  setIsSettingsOpen: (isOpen: boolean) => void;
}

// Per-role defaults, not one blanket model for everything:
// - Orchestrator / Generators / Evaluator / Co-Pilot: these draft plans, prompts, schema edits,
//   and judge output quality — pick the strongest available model (best capability) for each.
// - Verifier / Optimizer: comparison/rewrite tasks that don't need the top-tier model — the fast,
//   cheap flash-lite tier is enough.
const BEST_MODEL = 'gemini-3.8-flash';
const FAST_MODEL = 'gemini-3.5-flash-lite';

const defaultSettings: SettingsState = {
  apiKeys: { google_genai: '', openai: '', anthropic: '', groq: '', openrouter: '' },
  orchestrator: { model: BEST_MODEL, thinking_level: 'Low' },
  generators: { model: BEST_MODEL, thinking_level: 'Low' },
  verifier: { model: FAST_MODEL, thinking_level: 'Low' },
  evaluator: { model: BEST_MODEL, thinking_level: 'Low' },
  optimizer: { model: FAST_MODEL, thinking_level: 'Low' },
  copilot: { model: BEST_MODEL, thinking_level: 'Low' },
};

const SettingsContext = createContext<SettingsContextType | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<SettingsState>(defaultSettings);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const updateSettings = (newSettings: Partial<SettingsState>) => {
    setSettings((prev) => ({ ...prev, ...newSettings }));
  };

  return (
    <SettingsContext.Provider value={{ settings, updateSettings, isSettingsOpen, setIsSettingsOpen }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
