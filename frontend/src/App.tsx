import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { Moon, Sun, Zap, Settings } from 'lucide-react';
import HomePage from './pages/Home';
import EditorPage from './pages/Editor';
import { ThemeContext } from './context/ThemeContext';
import { SettingsProvider, useSettings } from './context/SettingsContext';
import SettingsModal from './components/SettingsModal';
import './index.css';

function GlobalLayout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const { theme, toggleTheme } = React.useContext(ThemeContext);
  const { setIsSettingsOpen } = useSettings();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  return (
    <div className="app-container">
      <header className="header">
        {/* Logo */}
        <button
          onClick={() => navigate('/', { state: { reset: true } })}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
          title="Back to Home"
        >
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-hover))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 2px 12px var(--accent-glow)',
            }}
          >
            <Zap size={16} color="#fff" strokeWidth={2.5} />
          </div>
          <span className="header-title">PromptSync</span>
        </button>

        {/* Right: Actions */}
        <div style={{ display: 'flex', gap: 12 }}>
          <button className="icon-btn" onClick={() => setIsSettingsOpen(true)} title="Settings">
            <Settings size={18} />
          </button>
          <button className="icon-btn" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </header>

      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {children}
      </div>
      <SettingsModal />
    </div>
  );
}

function App() {
  const [theme, setTheme] = useState('light');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      <SettingsProvider>
        <BrowserRouter>
          <GlobalLayout>
            <Routes>
              <Route path="/" element={<HomePage />} />
              <Route path="/editor" element={<EditorPage />} />
            </Routes>
          </GlobalLayout>
        </BrowserRouter>
      </SettingsProvider>
    </ThemeContext.Provider>
  );
}

export default App;
