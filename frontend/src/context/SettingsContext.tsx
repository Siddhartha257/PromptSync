import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';

export interface AgentConfig {
  model: string;
  thinking_level: string;
}

export interface SettingsState {
  apiKey: string;
  orchestrator: AgentConfig;
  generators: AgentConfig;
  verifier: AgentConfig;
}

interface SettingsContextType {
  settings: SettingsState;
  updateSettings: (newSettings: Partial<SettingsState>) => void;
  isSettingsOpen: boolean;
  setIsSettingsOpen: (isOpen: boolean) => void;
}

const defaultSettings: SettingsState = {
  apiKey: '',
  orchestrator: { model: 'gemini-3.1-flash-lite', thinking_level: 'Low' },
  generators: { model: 'gemini-3.1-flash-lite', thinking_level: 'Low' },
  verifier: { model: 'gemini-3.1-flash-lite', thinking_level: 'Low' },
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
