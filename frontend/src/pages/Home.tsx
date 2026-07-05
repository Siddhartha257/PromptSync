import { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import {
  Bot, Wand2, Edit3, ArrowRight, Play, CheckCircle,
  GitBranch, Layers, ShieldCheck, Cpu, Zap
} from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { API_URL } from '../services/api';
import '../index.css';

export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const { settings, setIsSettingsOpen } = useSettings();

  const [mode, setMode] = useState<'select' | 'scratch'>('select');
  const [userRequest, setUserRequest] = useState('');
  const [targetModel, setTargetModel] = useState('gpt');

  // Plan state
  const [isPlanning, setIsPlanning] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [promptInstruction, setPromptInstruction] = useState('');
  const [schemaInstruction, setSchemaInstruction] = useState('');
  const [runPromptAgent, setRunPromptAgent] = useState(true);
  const [runSchemaAgent, setRunSchemaAgent] = useState(true);

  // Stream state
  const [isStreaming, setIsStreaming] = useState(false);
  const [generatedPrompt, setGeneratedPrompt] = useState('');
  const [generatedSchema, setGeneratedSchema] = useState('');
  const [showDualStreams, setShowDualStreams] = useState(false);

  const promptEndRef = useRef<HTMLDivElement>(null);
  const schemaEndRef = useRef<HTMLDivElement>(null);

  // Reset when home button clicked
  useEffect(() => {
    if (location.state && (location.state as any).reset) {
      setMode('select');
      setShowDualStreams(false);
      setIsPlanning(false);
      setShowPlanModal(false);
      setUserRequest('');
      setGeneratedPrompt('');
      setGeneratedSchema('');
      navigate('/', { replace: true, state: {} });
    }
  }, [location.state, navigate]);

  // Scroll auto-follow
  useEffect(() => {
    promptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [generatedPrompt]);
  useEffect(() => {
    schemaEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [generatedSchema]);

  // Scroll reveal observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('reveal-visible'); }),
      { threshold: 0.1 }
    );
    document.querySelectorAll('.scroll-reveal').forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [mode, showDualStreams]);

  const handleGeneratePlan = async () => {
    if (!settings.apiKey) {
      setIsSettingsOpen(true);
      return;
    }
    if (!userRequest.trim()) return;
    setIsPlanning(true);
    try {
      const res = await axios.post(`${API_URL}/orchestrate`, {
        api_key: settings.apiKey,
        config: settings.orchestrator,
        prompt: '',
        json_schema: '',
        user_request: userRequest,
      });
      setPromptInstruction(res.data.prompt_instruction);
      setSchemaInstruction(res.data.json_schema_instruction);
      setRunPromptAgent(res.data.run_prompt_agent);
      setRunSchemaAgent(res.data.run_schema_agent);
      setShowPlanModal(true);
    } catch {
      alert('Error generating plan. Is the backend running?');
    } finally {
      setIsPlanning(false);
    }
  };

  const streamFromEndpoint = async (endpoint: string, body: object, onChunk: (t: string) => void) => {
    const res = await fetch(`${API_URL}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.body) throw new Error('No body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n\n')) {
        if (!line.startsWith('data: ')) continue;
        const dataStr = line.slice(6);
        if (dataStr === '[DONE]') break;
        try {
          const parsed = JSON.parse(dataStr);
          if (parsed.text) onChunk(parsed.text);
        } catch { /* partial chunk */ }
      }
    }
  };

  const handleExecuteStreams = async () => {
    setShowPlanModal(false);
    setShowDualStreams(true);
    setIsStreaming(true);
    setGeneratedPrompt('');
    setGeneratedSchema('');
    const promises = [];
    if (runPromptAgent)
      promises.push(streamFromEndpoint('stream/prompt', { api_key: settings.apiKey, config: settings.generators, instruction: promptInstruction, target_model: targetModel }, chunk => setGeneratedPrompt(p => p + chunk)));
    if (runSchemaAgent)
      promises.push(streamFromEndpoint('stream/schema', { api_key: settings.apiKey, config: settings.generators, instruction: schemaInstruction }, chunk => setGeneratedSchema(p => p + chunk)));
    try { await Promise.all(promises); } catch { alert('Streaming failed.'); }
    finally { setIsStreaming(false); }
  };

  const handleContinue = () => {
    navigate('/editor', { state: { initialPrompt: generatedPrompt.trim() || ' ', initialSchema: generatedSchema.trim() || ' ' } });
  };

  const features = [
    {
      icon: <GitBranch size={24} />,
      title: 'Dual-Agent Orchestration',
      desc: 'A master Orchestrator LLM decomposes your intent into perfectly synchronized instructions for specialized Prompt and Schema agents.',
      delay: '',
    },
    {
      icon: <Layers size={24} />,
      title: 'Full-Featured Editor',
      desc: 'CodeMirror integration providing line numbers, real-time syntax highlighting for JSON & Markdown, and synchronized split-pane scrolling.',
      delay: 'reveal-delay-1',
    },
    {
      icon: <Cpu size={24} />,
      title: 'Granular Multi-Agent Configs',
      desc: 'Independently configure LLM models and explicit Thinking Budgets for the Orchestrator, Generator, and Verifier agents.',
      delay: 'reveal-delay-2',
    },
    {
      icon: <ShieldCheck size={24} />,
      title: 'Secure & Deployment Ready',
      desc: 'Render-ready architecture. API keys are handled purely in-memory via React state and payload injection, with zero backend persistence.',
      delay: 'reveal-delay-3',
    },
  ];

  return (
    <div className="home-page">
      {!showDualStreams && (
        <>
          {/* ── HERO ─────────────────────────────── */}
          <section style={{ padding: 'clamp(80px, 12vh, 140px) 24px clamp(60px, 8vh, 100px)', maxWidth: 900, margin: '0 auto', textAlign: 'center' }}>
            <div className="hero-badge" style={{ animation: 'slideUp 0.4s ease-out' }}>
              <Zap size={11} /> AI-Powered Prompt Engineering IDE
            </div>
            <div style={{ textAlign: 'center', animation: 'slideUp 0.4s ease-out' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 24 }}>
                <Bot size={56} color="var(--text-primary)" />
                <h1 className="hero-title" style={{ fontSize: '4rem' }}>PromptSync</h1>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '1.25rem', lineHeight: 1.6, maxWidth: '600px', margin: '0 auto' }}>
                The professional IDE for Prompt Engineering and JSON Schema Architecture. Build, optimize, and safely iterate on LLM instructions using dual-agent orchestration.
              </p>
            </div>

            {/* ── SELECT MODE ── */}
            {mode === 'select' && (
              <div style={{ display: 'flex', gap: 20, justifyContent: 'center', marginTop: 52, animation: 'slideUp 0.5s ease-out 0.15s both', flexWrap: 'wrap' }}>
                <button className="action-card" onClick={() => setMode('scratch')} style={{ maxWidth: 320 }}>
                  <div className="feature-icon">
                    <Wand2 size={22} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Build from Scratch</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
                      Describe your goal. The agent pipeline architects the Prompt and Schema for you.
                    </p>
                  </div>
                  <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-primary)', fontSize: '0.85rem', fontWeight: 600 }}>
                    Get started <ArrowRight size={14} />
                  </div>
                </button>

                <button className="action-card" onClick={() => navigate('/editor')} style={{ maxWidth: 320 }}>
                  <div className="feature-icon">
                    <Edit3 size={22} />
                  </div>
                  <div>
                    <h3 style={{ fontSize: '1.15rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>Edit Existing</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.6 }}>
                      Jump into the split-pane editor to iterate on your own Prompt and Schema.
                    </p>
                  </div>
                  <div style={{ marginTop: 'auto', display: 'flex', alignItems: 'center', gap: 6, color: 'var(--accent-primary)', fontSize: '0.85rem', fontWeight: 600 }}>
                    Open editor <ArrowRight size={14} />
                  </div>
                </button>
              </div>
            )}

            {/* ── SCRATCH FORM ── */}
            {mode === 'scratch' && (
              <div
                className="glass-panel"
                style={{
                  marginTop: 48,
                  padding: '36px',
                  borderRadius: 'var(--radius-xl)',
                  textAlign: 'left',
                  animation: 'modalIn 0.35s cubic-bezier(0.16,1,0.3,1)',
                  maxWidth: 720,
                  margin: '48px auto 0',
                }}
              >
                <h3 style={{ fontWeight: 700, fontSize: '1.1rem', marginBottom: 6 }}>Architectural Intent</h3>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: 20, lineHeight: 1.5 }}>
                  Describe what you want to build. Be specific about the data fields and reasoning the model should output.
                </p>
                <textarea
                  className="instruction-editor"
                  placeholder="e.g. Build a document classification agent that reads customer emails, classifies intent as billing / technical_support / general_inquiry, flags escalation if the customer is angry, and returns a reasoning string..."
                  value={userRequest}
                  onChange={e => setUserRequest(e.target.value)}
                  disabled={isPlanning}
                  style={{ minHeight: 160, resize: 'vertical', marginBottom: 20 }}
                />

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <label style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Target model:</label>
                    <select
                      value={targetModel}
                      onChange={e => setTargetModel(e.target.value)}
                      disabled={isPlanning}
                      style={{
                        padding: '9px 16px',
                        borderRadius: 'var(--radius-full)',
                        background: 'var(--bg-secondary)',
                        color: 'var(--text-primary)',
                        border: '1px solid var(--border-color)',
                        outline: 'none',
                        cursor: 'pointer',
                        fontSize: '0.875rem',
                        fontFamily: 'var(--font-sans)',
                      }}
                    >
                      <option value="gpt">GPT (OpenAI)</option>
                      <option value="claude">Claude (Anthropic)</option>
                      <option value="gemini">Gemini (Google)</option>
                    </select>
                  </div>

                  <div style={{ display: 'flex', gap: 10 }}>
                    <button className="btn btn-outline" onClick={() => setMode('select')} disabled={isPlanning}>
                      Back
                    </button>
                    <button
                      className="btn btn-primary"
                      onClick={handleGeneratePlan}
                      disabled={isPlanning || !userRequest.trim()}
                      style={{ minWidth: 160 }}
                    >
                      {isPlanning ? <div className="loader" style={{ borderTopColor: '#fff' }} /> : <Play size={15} />}
                      Generate Plan
                    </button>
                  </div>
                </div>
              </div>
            )}
          </section>

          {/* ── FEATURE SECTIONS ── */}
          {mode === 'select' && (
            <section style={{ maxWidth: 1100, margin: '0 auto', padding: '0 24px 120px' }}>
              <div style={{ textAlign: 'center', marginBottom: 60 }}>
                <p className="hero-badge scroll-reveal reveal-hidden" style={{ justifyContent: 'center' }}>
                  How it works
                </p>
                <h2 className="scroll-reveal reveal-hidden" style={{ fontSize: 'clamp(1.6rem, 3vw, 2.4rem)', fontWeight: 800, letterSpacing: '-0.03em', marginTop: 12 }}>
                  A Pipeline Built for Production
                </h2>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 20 }}>
                {features.map(f => (
                  <div key={f.title} className={`feature-card glass-panel scroll-reveal reveal-hidden ${f.delay}`}>
                    <div className="feature-icon">{f.icon}</div>
                    <h3 style={{ fontWeight: 700, fontSize: '1rem', marginBottom: 10, color: 'var(--text-primary)' }}>{f.title}</h3>
                    <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', lineHeight: 1.7 }}>{f.desc}</p>
                  </div>
                ))}
              </div>

              {/* CTA */}
              <div
                className="glass-panel scroll-reveal reveal-hidden"
                style={{
                  marginTop: 60,
                  padding: '48px',
                  borderRadius: 'var(--radius-xl)',
                  textAlign: 'center',
                  borderColor: 'var(--accent-primary)',
                }}
              >
                <h2 style={{ fontWeight: 800, fontSize: '1.8rem', letterSpacing: '-0.03em', marginBottom: 12 }}>
                  Ready to forge your first prompt?
                </h2>
                <p style={{ color: 'var(--text-secondary)', fontSize: '1rem', marginBottom: 28 }}>
                  Start from scratch or bring your own prompt to iterate on.
                </p>
                <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
                  <button className="btn btn-primary" onClick={() => setMode('scratch')} style={{ padding: '12px 28px' }}>
                    <Wand2 size={16} /> Build from Scratch
                  </button>
                  <button className="btn btn-outline" onClick={() => navigate('/editor')} style={{ padding: '12px 28px' }}>
                    <Edit3 size={16} /> Edit Existing
                  </button>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {/* ── DUAL STREAM VIEW ── */}
      {showDualStreams && (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative' }}>
          {/* Top bar */}
          <div style={{
            padding: '12px 24px',
            borderBottom: '1px solid var(--border-color)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            background: 'var(--bg-glass)',
            backdropFilter: 'blur(16px)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {isStreaming ? (
                <><div className="loader" /><span style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>Generating…</span></>
              ) : (
                <><CheckCircle size={16} color="var(--success)" /><span style={{ fontSize: '0.875rem', color: 'var(--success)' }}>Generation complete</span></>
              )}
            </div>
            {!isStreaming && (
              <button className="btn btn-primary" onClick={handleContinue}>
                Continue to Editor <ArrowRight size={15} />
              </button>
            )}
          </div>

          {/* Split pane */}
          <div className="split-pane" style={{ flex: 1 }}>
            <div className="pane">
              <div className="pane-header">Prompt Generation Stream</div>
              <div className="editor-container">
                <div style={{
                  height: '100%',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.82rem',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.7,
                  color: 'var(--text-primary)',
                  padding: 4,
                }}>
                  {generatedPrompt || <span style={{ color: 'var(--text-muted)' }}>Waiting for stream…</span>}
                  <div ref={promptEndRef} />
                </div>
              </div>
            </div>
            <div className="pane-divider" />
            <div className="pane">
              <div className="pane-header">Schema Generation Stream</div>
              <div className="editor-container">
                <div style={{
                  height: '100%',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '0.82rem',
                  whiteSpace: 'pre-wrap',
                  lineHeight: 1.7,
                  color: 'var(--text-primary)',
                  padding: 4,
                }}>
                  {generatedSchema || <span style={{ color: 'var(--text-muted)' }}>Waiting for stream…</span>}
                  <div ref={schemaEndRef} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── PLAN REVIEW MODAL ── */}
      {showPlanModal && (
        <div className="modal-overlay" style={{ position: 'fixed' }}>
          <div className="modal-content glass-modal">
            <div className="modal-header">
              <div>
                <h2>Orchestrator Plan</h2>
                <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: 3 }}>
                  Review and edit the agent instructions before executing.
                </p>
              </div>
              <button className="btn btn-outline" onClick={() => setShowPlanModal(false)}>Cancel</button>
            </div>

            <div className="modal-body">
              <div className="instruction-group">
                <div>
                  <label>Prompt Agent Instructions</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '0.82rem', textTransform: 'none', letterSpacing: 0 }}>
                    <input type="checkbox" checked={runPromptAgent} onChange={e => setRunPromptAgent(e.target.checked)} />
                    Execute
                  </label>
                </div>
                <textarea
                  className="instruction-editor"
                  value={promptInstruction}
                  onChange={e => setPromptInstruction(e.target.value)}
                  disabled={!runPromptAgent}
                  style={{ opacity: runPromptAgent ? 1 : 0.4, minHeight: 200 }}
                />
              </div>

              <div className="instruction-group">
                <div>
                  <label>Schema Agent Instructions</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '0.82rem', textTransform: 'none', letterSpacing: 0 }}>
                    <input type="checkbox" checked={runSchemaAgent} onChange={e => setRunSchemaAgent(e.target.checked)} />
                    Execute
                  </label>
                </div>
                <textarea
                  className="instruction-editor"
                  value={schemaInstruction}
                  onChange={e => setSchemaInstruction(e.target.value)}
                  disabled={!runSchemaAgent}
                  style={{ opacity: runSchemaAgent ? 1 : 0.4, minHeight: 200 }}
                />
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-primary" onClick={handleExecuteStreams}>
                <ArrowRight size={15} /> Execute Build
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
