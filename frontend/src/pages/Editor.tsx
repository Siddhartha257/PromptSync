import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import {
  Play, CheckCircle, AlertCircle, ArrowRight, Check,
  ShieldCheck, Code, Sparkles, FlaskConical
} from 'lucide-react';
import { useLocation } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { ThemeContext } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { useToast } from '../context/ToastContext';
import { getKeyForModel } from '../utils/providers';
import ExportModal from '../components/ExportModal';
import CopilotChat, { type ActionProposalData } from '../components/CopilotChat';
import TrialRunModal from '../components/TrialRunModal';
import OptimizationWindow from '../components/OptimizationWindow';
import { API_URL } from '../services/api';
import '../index.css';

type RightTab = 'prompt' | 'schema';

export default function Editor() {
  const location = useLocation();
  const { theme } = React.useContext(ThemeContext);
  const { settings } = useSettings();
  const { showToast } = useToast();

  const STORAGE_KEY = 'prompter_editor_state';

  const savedState = (() => {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { return null; }
  })();

  const [prompt, setPrompt] = useState(location.state?.initialPrompt ?? savedState?.prompt ?? '');
  const [schema, setSchema] = useState(location.state?.initialSchema ?? savedState?.schema ?? '');

  // CopilotChat persists its session id + message history in sessionStorage so a page refresh
  // doesn't lose an in-progress conversation — but that persistence is keyed globally per browser
  // tab, with no notion of "which document" it belongs to. `location.state.initialPrompt` being
  // present means this Editor mount is a genuinely NEW document (Home's Build-from-Scratch /
  // orchestrated-generation flow always sets it), as opposed to resuming the last open one via
  // localStorage — so the old chat session must NOT carry over into it. Done here, synchronously
  // during render (not a useEffect, which would fire after CopilotChat has already mounted and
  // read the stale sessionStorage), guarded by a ref so it only runs once per Editor mount.
  const didResetChatSessionRef = useRef(false);
  if (!didResetChatSessionRef.current && location.state?.initialPrompt !== undefined) {
    didResetChatSessionRef.current = true;
    const oldChatSessionId = sessionStorage.getItem('prompter_chat_session_id');
    if (oldChatSessionId) sessionStorage.removeItem(`prompter_chat_msgs_${oldChatSessionId}`);
    sessionStorage.removeItem('prompter_chat_session_id');
  }

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ prompt, schema })); } catch { /* ignore */ }
  }, [prompt, schema]);

  const [showExportModal, setShowExportModal] = useState(false);
  const [userRequest, setUserRequest] = useState('');

  // Modal & Flow state
  const [isLoading, setIsLoading] = useState(false);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showDiffModal, setShowDiffModal] = useState(false);

  // Plan state
  const [promptInstruction, setPromptInstruction] = useState('');
  const [schemaInstruction, setSchemaInstruction] = useState('');
  const [runPromptAgent, setRunPromptAgent] = useState(true);
  const [runSchemaAgent, setRunSchemaAgent] = useState(true);

  // Verification state
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{ is_aligned: boolean; reason: string } | null>(null);

  // Apply state
  const [isApplying, setIsApplying] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [newSchema, setNewSchema] = useState('');

  // Output verification
  const [isOutputVerifying, setIsOutputVerifying] = useState(false);
  const [outputVerificationResult, setOutputVerificationResult] = useState<{ is_aligned: boolean; reason: string; prompt_updater_instruction?: string; schema_updater_instruction?: string } | null>(null);
  const [fixAlignmentPending, setFixAlignmentPending] = useState(false);

  // Layout state
  const [isChatOpen, setIsChatOpen] = useState(true);
  const [rightTab, setRightTab] = useState<RightTab>('prompt');

  // New modal windows
  const [showTrialModal, setShowTrialModal] = useState(false);
  const [showOptimizeModal, setShowOptimizeModal] = useState(false);

  // Shortcut Cmd+L to toggle chat panel
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        setIsChatOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleApplyChatProposal = (proposal: ActionProposalData) => {
    setPromptInstruction(proposal.prompt_instruction || '');
    setSchemaInstruction(proposal.schema_instruction || '');
    setRunPromptAgent(!!proposal.prompt_instruction);
    setRunSchemaAgent(!!proposal.schema_instruction);
    setShowPlanModal(true);
    showToast('Applied chat proposal to Plan Review', 'success');
  };

  const handleOrchestrate = async () => {
    if (!userRequest.trim()) return;
    setIsLoading(true);
    setVerificationResult(null);
    try {
      const res = await axios.post(`${API_URL}/orchestrate`, {
        api_key: getKeyForModel(settings.apiKeys, settings.orchestrator.model, settings.orchestrator.provider),
        config: settings.orchestrator,
        prompt,
        json_schema: schema,
        user_request: userRequest,
      });
      setPromptInstruction(res.data.prompt_instruction);
      setSchemaInstruction(res.data.json_schema_instruction);
      setRunPromptAgent(res.data.run_prompt_agent);
      setRunSchemaAgent(res.data.run_schema_agent);
      setShowPlanModal(true);
    } catch {
      showToast('Error generating plan. Is the backend running?', 'error');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    setIsVerifying(true);
    try {
      const res = await axios.post(`${API_URL}/verify`, {
        api_key: getKeyForModel(settings.apiKeys, settings.verifier.model, settings.verifier.provider),
        config: settings.verifier,
        prompt_instruction: promptInstruction,
        schema_instruction: schemaInstruction,
      });
      setVerificationResult(res.data);
    } catch {
      showToast('Verification failed.', 'error');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyOutput = async (overridePrompt?: string, overrideSchema?: string) => {
    setIsOutputVerifying(true);
    const p = overridePrompt ?? prompt;
    const s = overrideSchema ?? schema;
    try {
      const res = await axios.post(`${API_URL}/verify_output`, {
        api_key: getKeyForModel(settings.apiKeys, settings.verifier.model, settings.verifier.provider),
        config: settings.verifier,
        prompt: p,
        json_schema: s,
      });
      setOutputVerificationResult(res.data);
      if (res.data.is_aligned) setTimeout(() => setOutputVerificationResult(null), 5000);
    } catch {
      showToast('Output verification failed.', 'error');
    } finally {
      setIsOutputVerifying(false);
    }
  };

  const handleApply = async () => {
    setIsApplying(true);
    try {
      const res = await axios.post(`${API_URL}/apply_edits`, {
        api_key: getKeyForModel(settings.apiKeys, settings.generators.model, settings.generators.provider),
        config: settings.generators,
        prompt,
        json_schema: schema,
        prompt_instruction: runPromptAgent ? promptInstruction : '',
        schema_instruction: runSchemaAgent ? schemaInstruction : '',
      }, { timeout: 180000 });
      setNewPrompt(res.data.new_prompt);
      setNewSchema(res.data.new_json_schema);

      if (res.data.errors && (res.data.errors.prompt || res.data.errors.schema)) {
        let msg = 'Partial success! ';
        if (res.data.errors.prompt) msg += `Prompt Agent failed: ${res.data.errors.prompt} `;
        if (res.data.errors.schema) msg += `Schema Agent failed: ${res.data.errors.schema}`;
        showToast(msg, 'error');
      }

      setShowPlanModal(false);
      setShowDiffModal(true);
    } catch (err: any) {
      showToast(err.response?.data?.detail || 'Error applying edits.', 'error');
    } finally {
      setIsApplying(false);
    }
  };

  const acceptChanges = () => {
    setPrompt(newPrompt);
    setSchema(newSchema);
    setUserRequest('');
    setShowDiffModal(false);
    setOutputVerificationResult(null);
    if (fixAlignmentPending) {
      setFixAlignmentPending(false);
      handleVerifyOutput(newPrompt, newSchema);
    }
  };

  const handleFixAlignment = (source: 'prompt' | 'schema') => {
    if (!outputVerificationResult) return;
    if (source === 'schema') {
      setPromptInstruction('');
      setRunPromptAgent(false);
      setSchemaInstruction(outputVerificationResult.schema_updater_instruction || outputVerificationResult.reason);
      setRunSchemaAgent(true);
    } else {
      setSchemaInstruction('');
      setRunSchemaAgent(false);
      setPromptInstruction(outputVerificationResult.prompt_updater_instruction || outputVerificationResult.reason);
      setRunPromptAgent(true);
    }
    setFixAlignmentPending(true);
    setOutputVerificationResult(null);
    setShowPlanModal(true);
  };

  return (
    <>
      {/* ── MAIN SPLIT LAYOUT ── */}
      <main className="main-content" style={{ display: 'flex', overflow: 'hidden', position: 'relative' }}>

        {/* ── LEFT PANEL: Co-Pilot Chat (40%) ── */}
        <div
          style={{
            width: isChatOpen ? '40%' : 0,
            minWidth: isChatOpen ? 320 : 0,
            maxWidth: isChatOpen ? 600 : 0,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: isChatOpen ? '1px solid var(--border-color)' : 'none',
            overflow: 'hidden',
            transition: 'width 0.2s ease, min-width 0.2s ease',
            position: 'relative'
          }}
        >
          {isChatOpen && (
            <CopilotChat
              prompt={prompt}
              schema={schema}
              theme={theme}
              onApplyProposal={handleApplyChatProposal}
            />
          )}
        </div>

        {/* ── RIGHT PANEL: Prompt + Schema Editors (60%) ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {/* Tab toggle header */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)',
            flexShrink: 0
          }}>
            <button
              onClick={() => setRightTab('prompt')}
              style={{
                padding: '10px 20px',
                fontSize: '0.83rem',
                fontWeight: 500,
                color: rightTab === 'prompt' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                background: 'none',
                border: 'none',
                borderBottom: rightTab === 'prompt' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              System Prompt
            </button>
            <button
              onClick={() => setRightTab('schema')}
              style={{
                padding: '10px 20px',
                fontSize: '0.83rem',
                fontWeight: 500,
                color: rightTab === 'schema' ? 'var(--accent-primary)' : 'var(--text-secondary)',
                background: 'none',
                border: 'none',
                borderBottom: rightTab === 'schema' ? '2px solid var(--accent-primary)' : '2px solid transparent',
                cursor: 'pointer',
                transition: 'all 0.15s'
              }}
            >
              JSON Schema
            </button>
            {rightTab === 'schema' && (
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', padding: '0 12px' }}>
                <button
                  className="btn btn-outline"
                  style={{ padding: '4px 10px', fontSize: '0.75rem', gap: 6 }}
                  onClick={() => setShowExportModal(true)}
                >
                  <Code size={12} /> Export Code
                </button>
              </div>
            )}
          </div>

          {/* Editors */}
          <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, display: rightTab === 'prompt' ? 'flex' : 'none', flexDirection: 'column' }}>
              <div className="editor-container" style={{ flex: 1, overflow: 'auto', display: 'flex', border: 'none' }}>
                <CodeMirror
                  value={prompt}
                  height="100%"
                  extensions={[markdown()]}
                  onChange={value => setPrompt(value)}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  placeholder="Your system prompt will appear here…"
                />
              </div>
            </div>
            <div style={{ position: 'absolute', inset: 0, display: rightTab === 'schema' ? 'flex' : 'none', flexDirection: 'column' }}>
              <div className="editor-container" style={{ flex: 1, overflow: 'auto', display: 'flex', border: 'none' }}>
                <CodeMirror
                  value={schema}
                  height="100%"
                  extensions={[json()]}
                  onChange={value => setSchema(value)}
                  theme={theme === 'dark' ? 'dark' : 'light'}
                  style={{ flex: 1, fontSize: '0.85rem' }}
                  placeholder="Your JSON schema will appear here…"
                />
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* ── OUTPUT VERIFICATION MODAL ── */}
      {outputVerificationResult && (
        <div className="modal-overlay">
          <div className="modal-content glass-modal" style={{ maxWidth: 640 }}>
            <div className="modal-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ color: outputVerificationResult.is_aligned ? 'var(--success-color)' : 'var(--danger-color)' }}>
                  {outputVerificationResult.is_aligned ? <CheckCircle size={24} /> : <AlertCircle size={24} />}
                </div>
                <h2 style={{ margin: 0, color: outputVerificationResult.is_aligned ? 'inherit' : 'var(--danger-color)' }}>
                  {outputVerificationResult.is_aligned ? 'Outputs Perfectly Aligned' : 'Misalignment Detected'}
                </h2>
              </div>
              <button className="icon-btn" onClick={() => setOutputVerificationResult(null)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: '24px' }}>
              <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: 'var(--text-secondary)', margin: 0 }}>
                {outputVerificationResult.reason}
              </p>
              {!outputVerificationResult.is_aligned && (
                <div style={{ display: 'flex', gap: 12, marginTop: 24, paddingTop: 24, borderTop: '1px solid var(--border-color)' }}>
                  {outputVerificationResult.schema_updater_instruction && (
                    <button className="btn btn-primary" onClick={() => handleFixAlignment('schema')} style={{ flex: 1 }}>
                      Fix Schema (Match to Prompt)
                    </button>
                  )}
                  {outputVerificationResult.prompt_updater_instruction && (
                    <button className="btn btn-outline" onClick={() => handleFixAlignment('prompt')} style={{ flex: 1 }}>
                      Fix Prompt (Match to Schema)
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── BOTTOM BAR ── */}
      <footer className="bottom-bar">
        <button
          className="btn btn-outline"
          onClick={() => handleVerifyOutput()}
          disabled={isOutputVerifying || !prompt.trim() || !schema.trim()}
          title="Verify Prompt ↔ Schema alignment"
        >
          {isOutputVerifying ? <div className="loader" style={{ width: 15, height: 15, borderWidth: 2 }} /> : <ShieldCheck size={15} />}
          Verify Alignment
        </button>

        <input
          type="text"
          className="user-input"
          placeholder="Describe the changes you want to make…"
          value={userRequest}
          onChange={e => setUserRequest(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleOrchestrate()}
        />

        <button
          className="btn btn-primary"
          onClick={handleOrchestrate}
          disabled={isLoading || !userRequest.trim()}
          style={{ minWidth: 150 }}
        >
          {isLoading ? <div className="loader" style={{ borderTopColor: '#fff' }} /> : <Play size={15} />}
          Generate Plan
        </button>

        <button
          className="btn btn-outline"
          onClick={() => setShowTrialModal(true)}
          style={{ minWidth: 110, gap: 7 }}
          title="Single-Query Trial Sandbox"
        >
          <Play size={15} /> Trial Run
        </button>

        <button
          className="btn btn-outline"
          onClick={() => setShowOptimizeModal(true)}
          style={{ minWidth: 110, gap: 7 }}
          title="Prompt Test & Optimization Lab"
        >
          <FlaskConical size={15} /> Optimize
        </button>

        <button
          className={`btn ${isChatOpen ? 'btn-primary' : 'btn-outline'}`}
          onClick={() => setIsChatOpen(p => !p)}
          style={{ minWidth: 110, gap: 7 }}
          title="Toggle AI Co-Pilot (Cmd+L)"
        >
          <Sparkles size={15} /> Co-Pilot
        </button>
      </footer>

      {/* ── PLAN REVIEW MODAL ── */}
      {showPlanModal && (
        <div className="modal-overlay">
          <div className="modal-content glass-modal" style={{ maxWidth: '90%', width: '1400px', height: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="modal-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '22px' }}>
              <div>
                <h2>Orchestrator Plan</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 3 }}>
                  Review and tweak the generated agent instructions before applying.
                </p>
              </div>
              <button className="btn btn-outline" onClick={() => setShowPlanModal(false)}>Cancel</button>
            </div>

            <div className="modal-body" style={{ padding: 0, overflow: 'hidden', flex: 1, display: 'flex' }}>
              <div className="split-pane" style={{ flex: 1, minHeight: 0 }}>
                <div className="pane">
                  <div className="pane-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Prompt Agent Instructions</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '0.82rem', textTransform: 'none', letterSpacing: 0 }}>
                      <input type="checkbox" checked={runPromptAgent} onChange={e => setRunPromptAgent(e.target.checked)} />
                      Run agent
                    </label>
                  </div>
                  <div className="editor-container" style={{ flex: 1, overflow: 'auto', display: 'flex', border: 'none', padding: 0, opacity: runPromptAgent ? 1 : 0.4, transition: 'opacity 0.2s' }}>
                    <CodeMirror
                      value={promptInstruction}
                      height="100%"
                      extensions={[markdown()]}
                      onChange={value => setPromptInstruction(value)}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                      editable={runPromptAgent}
                      style={{ flex: 1, fontSize: '0.82rem' }}
                    />
                  </div>
                </div>

                <div className="pane-divider" />

                <div className="pane">
                  <div className="pane-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span>Schema Agent Instructions</span>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '0.82rem', textTransform: 'none', letterSpacing: 0 }}>
                      <input type="checkbox" checked={runSchemaAgent} onChange={e => setRunSchemaAgent(e.target.checked)} />
                      Run agent
                    </label>
                  </div>
                  <div className="editor-container" style={{ flex: 1, overflow: 'auto', display: 'flex', border: 'none', padding: 0, opacity: runSchemaAgent ? 1 : 0.4, transition: 'opacity 0.2s' }}>
                    <CodeMirror
                      value={schemaInstruction}
                      height="100%"
                      extensions={[markdown()]}
                      onChange={value => setSchemaInstruction(value)}
                      theme={theme === 'dark' ? 'dark' : 'light'}
                      editable={runSchemaAgent}
                      style={{ flex: 1, fontSize: '0.82rem' }}
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="modal-footer" style={{ flexDirection: 'column', gap: 12, borderTop: '1px solid var(--border-color)', paddingTop: 16 }}>
              {verificationResult && (
                <div className={`alert ${verificationResult.is_aligned ? 'alert-success' : 'alert-danger'}`} style={{ margin: 0 }}>
                  <div style={{ flexShrink: 0, marginTop: 1 }}>
                    {verificationResult.is_aligned ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                  </div>
                  <div>
                    <strong>{verificationResult.is_aligned ? 'Instructions Aligned' : 'Misalignment Detected'}</strong>
                    <p>{verificationResult.reason}</p>
                  </div>
                </div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn btn-outline" onClick={handleVerify} disabled={isVerifying}>
                  {isVerifying ? <div className="loader" style={{ width: 15, height: 15, borderWidth: 2 }} /> : <CheckCircle size={15} />}
                  Verify Instructions
                </button>
                <button className="btn btn-primary" onClick={handleApply} disabled={isApplying}>
                  {isApplying ? <div className="loader" style={{ borderTopColor: '#fff', width: 15, height: 15 }} /> : <ArrowRight size={15} />}
                  Apply & Preview Diff
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── DIFF REVIEW MODAL ── */}
      {showDiffModal && (
        <div className="modal-overlay">
          <div className="modal-content glass-modal" style={{ maxWidth: '96vw', height: '94vh' }}>
            <div className="modal-header">
              <div>
                <h2>Review Changes</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 3 }}>
                  Word-level diff. Accept to update the editors.
                </p>
              </div>
              <button className="btn btn-outline" onClick={() => setShowDiffModal(false)}>Discard</button>
            </div>

            <div className="modal-body" style={{ display: 'flex', flexDirection: 'row', gap: 0, padding: 0, overflow: 'hidden' }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border-color)', overflow: 'hidden' }}>
                <div className="pane-header">System Prompt Diff</div>
                <div className="diff-wrapper" style={{ flex: 1, borderRadius: 0, border: 'none' }}>
                  <ReactDiffViewer
                    oldValue={prompt}
                    newValue={newPrompt}
                    splitView={false}
                    useDarkTheme={theme === 'dark'}
                    compareMethod={DiffMethod.WORDS}
                    styles={{ variables: { dark: { diffViewerBackground: 'var(--bg-secondary)', addedBackground: 'rgba(16,185,129,0.12)', removedBackground: 'rgba(248,113,113,0.12)', addedColor: '#10b981', removedColor: '#f87171' }, light: { diffViewerBackground: '#ffffff', addedBackground: 'rgba(5,150,105,0.08)', removedBackground: 'rgba(220,38,38,0.08)' } } }}
                  />
                </div>
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="pane-header">JSON Schema Diff</div>
                <div className="diff-wrapper" style={{ flex: 1, borderRadius: 0, border: 'none' }}>
                  <ReactDiffViewer
                    oldValue={schema}
                    newValue={newSchema}
                    splitView={false}
                    useDarkTheme={theme === 'dark'}
                    compareMethod={DiffMethod.WORDS}
                    styles={{ variables: { dark: { diffViewerBackground: 'var(--bg-secondary)', addedBackground: 'rgba(16,185,129,0.12)', removedBackground: 'rgba(248,113,113,0.12)', addedColor: '#10b981', removedColor: '#f87171' }, light: { diffViewerBackground: '#ffffff', addedBackground: 'rgba(5,150,105,0.08)', removedBackground: 'rgba(220,38,38,0.08)' } } }}
                  />
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-primary" onClick={acceptChanges}>
                <Check size={15} /> Accept Changes
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── TRIAL RUN MODAL ── */}
      <TrialRunModal
        isOpen={showTrialModal}
        onClose={() => setShowTrialModal(false)}
        prompt={prompt}
        schema={schema}
        theme={theme}
      />

      {/* ── OPTIMIZATION WINDOW ── */}
      <OptimizationWindow
        isOpen={showOptimizeModal}
        onClose={() => setShowOptimizeModal(false)}
        prompt={prompt}
        schema={schema}
        theme={theme}
        onApplyPrompt={newP => {
          setPrompt(newP);
          showToast('Promoted optimized prompt to Editor!', 'success');
        }}
        onApplySchema={newS => {
          setSchema(newS);
          showToast('Promoted optimized schema to Editor!', 'success');
        }}
      />

      {/* ── EXPORT MODAL ── */}
      <ExportModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
        schemaStr={schema}
        theme={theme}
      />
    </>
  );
}
