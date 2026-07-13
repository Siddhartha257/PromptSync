import React, { useState } from 'react';
import axios from 'axios';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { Play, CheckCircle, AlertCircle, ArrowRight, Check, ShieldCheck } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import CodeMirror from '@uiw/react-codemirror';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { ThemeContext } from '../context/ThemeContext';
import { useSettings } from '../context/SettingsContext';
import { API_URL } from '../services/api';
import '../index.css';

export default function Editor() {
  const location = useLocation();
  const { theme } = React.useContext(ThemeContext);
  const { settings, setIsSettingsOpen } = useSettings();

  const [prompt, setPrompt] = useState(
    location.state?.initialPrompt || ''
  );
  const [schema, setSchema] = useState(
    location.state?.initialSchema || ''
  );

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

  // Verification state (plan-level)
  const [isVerifying, setIsVerifying] = useState(false);
  const [verificationResult, setVerificationResult] = useState<{ is_aligned: boolean; reason: string } | null>(null);

  // Apply state
  const [isApplying, setIsApplying] = useState(false);
  const [newPrompt, setNewPrompt] = useState('');
  const [newSchema, setNewSchema] = useState('');

  // Output verification state
  const [isOutputVerifying, setIsOutputVerifying] = useState(false);
  const [outputVerificationResult, setOutputVerificationResult] = useState<{ is_aligned: boolean; reason: string; match_with_prompt_instruction?: string; match_with_schema_instruction?: string } | null>(null);
  const [fixAlignmentPending, setFixAlignmentPending] = useState(false);

  const handleOrchestrate = async () => {
    if (!settings.apiKey) {
      setIsSettingsOpen(true);
      return;
    }
    if (!userRequest.trim()) return;
    setIsLoading(true);
    setVerificationResult(null);
    try {
      const res = await axios.post(`${API_URL}/orchestrate`, {
        api_key: settings.apiKey,
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
      alert('Error generating plan. Is the backend running?');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify = async () => {
    if (!settings.apiKey) { setIsSettingsOpen(true); return; }
    setIsVerifying(true);
    try {
      const res = await axios.post(`${API_URL}/verify`, {
        api_key: settings.apiKey,
        config: settings.verifier,
        prompt_instruction: promptInstruction,
        schema_instruction: schemaInstruction,
      });
      setVerificationResult(res.data);
    } catch {
      alert('Verification failed.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleVerifyOutput = async () => {
    if (!settings.apiKey) { setIsSettingsOpen(true); return; }
    setIsOutputVerifying(true);
    try {
      const res = await axios.post(`${API_URL}/verify_output`, {
        api_key: settings.apiKey,
        config: settings.verifier,
        prompt,
        json_schema: schema,
      });
      setOutputVerificationResult(res.data);
      if (res.data.is_aligned) {
        setTimeout(() => setOutputVerificationResult(null), 8000);
      }
    } catch {
      alert('Output verification failed.');
    } finally {
      setIsOutputVerifying(false);
    }
  };

  const handleApply = async () => {
    if (!settings.apiKey) { setIsSettingsOpen(true); return; }
    setIsApplying(true);
    try {
      const res = await axios.post(`${API_URL}/apply_edits`, {
        api_key: settings.apiKey,
        config: settings.generators,
        prompt,
        json_schema: schema,
        prompt_instruction: runPromptAgent ? promptInstruction : '',
        schema_instruction: runSchemaAgent ? schemaInstruction : '',
      });
      setNewPrompt(res.data.new_prompt);
      setNewSchema(res.data.new_json_schema);
      setShowPlanModal(false);
      setShowDiffModal(true);
    } catch {
      alert('Error applying edits.');
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
      // Auto re-verify now that the fix has been applied
      setTimeout(() => handleVerifyOutput(), 100);
    }
  };

  const handleFixAlignment = (source: 'prompt' | 'schema') => {
    if (!outputVerificationResult) return;
    
    if (source === 'schema') {
      setPromptInstruction('');
      setRunPromptAgent(false);
      const aiInstruction = outputVerificationResult.match_with_prompt_instruction || outputVerificationResult.reason;
      setSchemaInstruction(aiInstruction);
      setRunSchemaAgent(true);
    } else {
      setSchemaInstruction('');
      setRunSchemaAgent(false);
      const aiInstruction = outputVerificationResult.match_with_schema_instruction || outputVerificationResult.reason;
      setPromptInstruction(aiInstruction);
      setRunPromptAgent(true);
    }
    
    setFixAlignmentPending(true);
    setOutputVerificationResult(null);
    setShowPlanModal(true);
  };

  return (
    <>
      {/* ── MAIN SPLIT PANE ── */}
      <main className="main-content">
        <div className="split-pane">
          <div className="pane">
            <div className="pane-header">System Prompt</div>
            <div className="editor-container" style={{ flex: 1, overflow: 'auto', display: 'flex', border: 'none' }}>
              <CodeMirror
                value={prompt}
                height="100%"
                extensions={[markdown()]}
                onChange={(value) => setPrompt(value)}
                theme={theme === 'dark' ? 'dark' : 'light'}
                style={{ flex: 1, fontSize: '0.85rem' }}
                placeholder="Your system prompt will appear here..."
              />
            </div>
          </div>

          <div className="pane-divider" />

          <div className="pane">
            <div className="pane-header">JSON Schema</div>
            <div className="editor-container" style={{ flex: 1, overflow: 'auto', display: 'flex', border: 'none' }}>
              <CodeMirror
                value={schema}
                height="100%"
                extensions={[json()]}
                onChange={(value) => setSchema(value)}
                theme={theme === 'dark' ? 'dark' : 'light'}
                style={{ flex: 1, fontSize: '0.85rem' }}
                placeholder="Your JSON schema will appear here..."
              />
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
                  {outputVerificationResult.match_with_prompt_instruction && (
                    <button 
                      className="btn btn-primary" 
                      onClick={() => handleFixAlignment('schema')}
                      style={{ flex: 1 }}
                    >
                      Fix Schema (Match to Prompt)
                    </button>
                  )}
                  {outputVerificationResult.match_with_schema_instruction && (
                    <button 
                      className="btn btn-outline" 
                      onClick={() => handleFixAlignment('prompt')}
                      style={{ flex: 1 }}
                    >
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
          onClick={handleVerifyOutput}
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
      </footer>

      {/* ── PLAN REVIEW MODAL ── */}
      {showPlanModal && (
        <div className="modal-overlay">
          <div className="modal-content glass-modal">
            <div className="modal-header">
              <div>
                <h2>Orchestrator Plan</h2>
                <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 3 }}>
                  Review and tweak agent instructions before applying.
                </p>
              </div>
              <button className="btn btn-outline" onClick={() => setShowPlanModal(false)}>Cancel</button>
            </div>

            <div className="modal-body">
              {/* Prompt instruction */}
              <div className="instruction-group">
                <div>
                  <label>Prompt Agent Instructions</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '0.82rem', textTransform: 'none', letterSpacing: 0 }}>
                    <input type="checkbox" checked={runPromptAgent} onChange={e => setRunPromptAgent(e.target.checked)} />
                    Run agent
                  </label>
                </div>
                <div style={{ flex: 1, overflow: 'auto', display: 'flex', minHeight: 180, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', opacity: runPromptAgent ? 1 : 0.4 }}>
                  <CodeMirror
                    value={promptInstruction}
                    height="100%"
                    extensions={[markdown()]}
                    onChange={(value) => setPromptInstruction(value)}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                    editable={runPromptAgent}
                    style={{ flex: 1, fontSize: '0.82rem' }}
                  />
                </div>
              </div>

              {/* Schema instruction */}
              <div className="instruction-group">
                <div>
                  <label>Schema Agent Instructions</label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontWeight: 500, color: 'var(--text-secondary)', fontSize: '0.82rem', textTransform: 'none', letterSpacing: 0 }}>
                    <input type="checkbox" checked={runSchemaAgent} onChange={e => setRunSchemaAgent(e.target.checked)} />
                    Run agent
                  </label>
                </div>
                <div style={{ flex: 1, overflow: 'auto', display: 'flex', minHeight: 180, borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)', opacity: runSchemaAgent ? 1 : 0.4 }}>
                  <CodeMirror
                    value={schemaInstruction}
                    height="100%"
                    extensions={[markdown()]}
                    onChange={(value) => setSchemaInstruction(value)}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                    editable={runSchemaAgent}
                    style={{ flex: 1, fontSize: '0.82rem' }}
                  />
                </div>
              </div>

              {/* Verification result */}
              {verificationResult && (
                <div className={`alert ${verificationResult.is_aligned ? 'alert-success' : 'alert-danger'}`}>
                  <div style={{ flexShrink: 0, marginTop: 1 }}>
                    {verificationResult.is_aligned ? <CheckCircle size={18} /> : <AlertCircle size={18} />}
                  </div>
                  <div>
                    <strong>{verificationResult.is_aligned ? 'Instructions Aligned' : 'Misalignment Detected'}</strong>
                    <p>{verificationResult.reason}</p>
                  </div>
                </div>
              )}
            </div>

            <div className="modal-footer">
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
                    styles={{
                      variables: {
                        dark: {
                          diffViewerBackground: 'var(--bg-secondary)',
                          addedBackground: 'rgba(16, 185, 129, 0.12)',
                          removedBackground: 'rgba(248, 113, 113, 0.12)',
                          addedColor: '#10b981',
                          removedColor: '#f87171',
                          codeFoldBackground: 'var(--bg-tertiary)',
                          emptyLineBackground: 'var(--bg-primary)',
                        },
                        light: {
                          diffViewerBackground: '#ffffff',
                          addedBackground: 'rgba(5, 150, 105, 0.08)',
                          removedBackground: 'rgba(220, 38, 38, 0.08)',
                        },
                      },
                    }}
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
                    styles={{
                      variables: {
                        dark: {
                          diffViewerBackground: 'var(--bg-secondary)',
                          addedBackground: 'rgba(16, 185, 129, 0.12)',
                          removedBackground: 'rgba(248, 113, 113, 0.12)',
                          addedColor: '#10b981',
                          removedColor: '#f87171',
                        },
                        light: {
                          diffViewerBackground: '#ffffff',
                          addedBackground: 'rgba(5, 150, 105, 0.08)',
                          removedBackground: 'rgba(220, 38, 38, 0.08)',
                        },
                      },
                    }}
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
    </>
  );
}
