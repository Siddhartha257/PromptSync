import { useState, useRef, type CSSProperties } from 'react';
import {
  X, Play, Sparkles, CheckCircle2, AlertCircle,
  Plus, Trash2, Copy, Download, Check, ChevronDown, ChevronRight, Printer,
  ArrowLeft, ArrowRight, Edit3
} from 'lucide-react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { useSettings } from '../context/SettingsContext';
import { getKeyForModel } from '../utils/providers';
import { useToast } from '../context/ToastContext';
import MarkdownRenderer from './MarkdownRenderer';
import ModelPickerRow, { type ModelPickerValue } from './ModelPickerRow';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

export interface TestQuery {
  level: string;
  name: string;
  query: string;
}

interface OptimizationWindowProps {
  isOpen: boolean;
  onClose: () => void;
  prompt: string;
  schema: string;
  theme: string;
  onApplyPrompt: (newPrompt: string) => void;
  onApplySchema: (newSchema: string) => void;
}

const LEVEL_LABELS: Record<string, string> = {
  L1: 'Normal', L2: 'Incomplete', L3: 'Boundary', L4: 'Malicious', L5: 'Adversarial'
};

export default function OptimizationWindow({ isOpen, onClose, prompt, schema, theme: _theme, onApplyPrompt, onApplySchema }: OptimizationWindowProps) {
  const { settings } = useSettings();
  const { showToast } = useToast();

  const [activeTab, setActiveTab] = useState<'setup' | 'run' | 'report'>('setup');

  // Setup state
  const [kbText, setKbText] = useState('');
  const [isKbExpanded, setIsKbExpanded] = useState(false);
  const [isGeneratingKb, setIsGeneratingKb] = useState(false);
  // Explicit opt-out for prompts that genuinely don't operate over external context (e.g. a
  // stateless single-input classifier) — lets users skip the KB requirement deliberately instead
  // of the generator silently inventing unrelated content when no KB is grounding it.
  const [kbNotNeeded, setKbNotNeeded] = useState(false);
  // Snapshot of kbText at the moment queries were last generated from it, so we can warn when the
  // KB has since changed (or was never actually the KB the current queries were grounded in).
  const [queriesKbSnapshot, setQueriesKbSnapshot] = useState<string | null>(null);

  // Acceptance criteria are a single free-form text field (one criterion per line) rather than
  // an add-one-at-a-time list — simpler to bulk-edit/paste, and avoids the per-item UI reading
  // like a set of little tabs. `cleanedCriteria` is the derived, trimmed, non-empty array
  // actually sent to the backend.
  const [criteriaText, setCriteriaText] = useState(
    'Must output strictly valid JSON adhering to the schema\n' +
    'Must reject out-of-scope requests with clear error code\n' +
    'Must handle missing parameters gracefully without guessing'
  );
  const cleanedCriteria = criteriaText.split('\n').map(c => c.trim()).filter(Boolean);
  const [isGeneratingCriteria, setIsGeneratingCriteria] = useState(false);

  const [queryCount, setQueryCount] = useState(3);
  const [selectedLevels, setSelectedLevels] = useState<string[]>(['L1', 'L2', 'L5']);
  // Intentionally empty by default: shipping generic pre-baked queries here would let a run start
  // with a test suite that has zero relationship to the actual Knowledge Base. Forcing an explicit
  // "Generate Query Suite" (or manual entry) keeps the suite meaningful.
  const [queries, setQueries] = useState<TestQuery[]>([]);
  const [isGeneratingQueries, setIsGeneratingQueries] = useState(false);

  const [evalMode, setEvalMode] = useState<'autonomous' | 'hybrid'>('hybrid');
  const [maxIterations, setMaxIterations] = useState(3);

  // Model configuration for the 3 roles active during an actual optimization run — independent
  // of the global Settings modal's roles, same pattern as the standalone Trial Run Console (own
  // Provider/Model/Thinking picker, own default, editable per-session here in the Lab setup).
  // KB/Criteria/Query generation intentionally stays on the global `settings.generators` role
  // (see fetchGeneratedKb/handleGenerateCriteria/handleGenerateQueries below) — it's a one-time
  // setup helper, not part of the loop these 3 drive.
  const [runnerConfig, setRunnerConfig] = useState<ModelPickerValue>({ model: 'gemini-3.5-flash-lite', thinking_level: 'Low' });
  const [evaluatorConfig, setEvaluatorConfig] = useState<ModelPickerValue>({ model: 'gemini-3.5-flash-lite', thinking_level: 'Low' });
  const [optimizerConfig, setOptimizerConfig] = useState<ModelPickerValue>({ model: 'gemini-3.5-flash-lite', thinking_level: 'Low' });

  // Run state
  const [isLabRunning, setIsLabRunning] = useState(false);
  const [labSessionId, setLabSessionId] = useState('');
  const [currentIteration, setCurrentIteration] = useState(1);
  const [currentScore, setCurrentScore] = useState<number | null>(null);
  const [isPassed, setIsPassed] = useState(false);
  const [queryResults, setQueryResults] = useState<any[]>([]);
  const [critique, setCritique] = useState('');
  const [history, setHistory] = useState<any[]>([]);

  // Per-iteration prompt-change visibility (autonomous mode has no human_review interrupt to pause
  // on, so without this the prompt silently changes under the hood with nothing on screen to prove
  // it). `iterationUpdates` is a permanent log the user can revisit any time; `activeUpdateIdx`
  // tracks which one is auto-expanded — set on each new update, then cleared after 5s so it
  // collapses back into the log instead of staying open forever.
  const [iterationUpdates, setIterationUpdates] = useState<{ iteration: number; oldPrompt: string; newPrompt: string; oldSchema: string; newSchema: string; instruction: string }[]>([]);
  // Which iteration's entry is auto-expanded right now — keyed by iteration NUMBER rather than
  // array index, since index would be stale-closure-prone inside the long-lived SSE reader below.
  const [activeUpdateIteration, setActiveUpdateIteration] = useState<number | null>(null);
  const lastKnownPromptRef = useRef('');
  const lastKnownSchemaRef = useRef('');
  // Schema at the moment the run started — OptimizationState only preserves an immutable
  // base_prompt on the backend, not a base schema, so this is tracked client-side instead.
  const baseSchemaRef = useRef('');
  const pendingInstructionRef = useRef('');
  const autoCollapseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Base vs. fully-optimized-prompt/schema diff, shown in the Report tab once a run completes.
  const [finalDiff, setFinalDiff] = useState<{ base: string; final: string; baseSchema: string; finalSchema: string } | null>(null);

  // Studio Subview & Tab Navigation (Wireframe Flow)
  const [runSubView, setRunSubView] = useState<'evaluation' | 'plan' | 'diff'>('evaluation');
  const [selectedQueryTab, setSelectedQueryTab] = useState(0);
  const [editedFeedbacks, setEditedFeedbacks] = useState<Record<number, string>>({});
  const [promptInstructionInput, setPromptInstructionInput] = useState('');
  const [schemaInstructionInput, setSchemaInstructionInput] = useState('');

  // Interrupt state
  const [interruptPayload, setInterruptPayload] = useState<any | null>(null);
  const [userCritiqueInput, setUserCritiqueInput] = useState('');
  const [isResuming, setIsResuming] = useState(false);

  // Report state
  const [reportMarkdown, setReportMarkdown] = useState('');
  const [copiedReport, setCopiedReport] = useState(false);

  if (!isOpen) return null;

  // ── Generators ──────────────────────────────────────
  // Raw KB fetch, factored out so both the explicit "Auto-Generate" button and the Query Suite's
  // auto-cascade (see handleGenerateQueries) can reuse it.
  const fetchGeneratedKb = async (): Promise<string | null> => {
    try {
      const res = await fetch(`${API_URL}/lab/generate_kb`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: getKeyForModel(settings.apiKeys, settings.generators.model, settings.generators.provider), config: settings.generators, prompt, json_schema: schema })
      });
      const data = await res.json();
      return data.kb || null;
    } catch (err: any) {
      showToast('Failed to generate KB: ' + err.message, 'error');
      return null;
    }
  };

  const handleGenerateKb = async () => {
    if (!prompt.trim()) { showToast('Please write a prompt first.', 'error'); return; }
    setIsGeneratingKb(true);
    try {
      const kb = await fetchGeneratedKb();
      if (kb) {
        setKbText(kb);
        setIsKbExpanded(true);
        showToast('Knowledge Base generated', 'success');
        // The KB changed — any queries already generated reference the OLD content. Warn rather
        // than silently letting a mismatched suite run (this is exactly how a stale/unrelated
        // query like "add auth middleware" can end up paired with an unrelated KB).
        if (queriesKbSnapshot !== null && queriesKbSnapshot !== kb && queries.length > 0) {
          showToast('Knowledge Base changed — existing test queries reference the old KB. Click "Generate Suite" again to keep them in sync.', 'error');
        }
      }
    } finally {
      setIsGeneratingKb(false);
    }
  };

  const handleGenerateCriteria = async () => {
    if (!prompt.trim()) { showToast('Please write a prompt first.', 'error'); return; }
    setIsGeneratingCriteria(true);
    try {
      const res = await fetch(`${API_URL}/lab/generate_criteria`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: getKeyForModel(settings.apiKeys, settings.generators.model, settings.generators.provider), config: settings.generators, prompt, json_schema: schema })
      });
      const data = await res.json();
      if (data.criteria?.length > 0) { setCriteriaText(data.criteria.join('\n')); showToast(`Extracted ${data.criteria.length} criteria`, 'success'); }
    } catch (err: any) { showToast('Failed to generate criteria: ' + err.message, 'error'); }
    finally { setIsGeneratingCriteria(false); }
  };

  // Queries MUST be grounded in the Knowledge Base's concrete entities/IDs to be meaningful.
  // Instead of dead-ending with an error when no KB exists yet, this auto-cascades: it silently
  // generates the KB first (unless the user explicitly opted out via kbNotNeeded), then chains
  // straight into query generation — this is the fix for queries drifting to whatever the System
  // Prompt implies (e.g. "add auth middleware") instead of the actual pasted KB.
  const handleGenerateQueries = async () => {
    if (!prompt.trim()) { showToast('Please write a prompt first.', 'error'); return; }

    setIsGeneratingQueries(true);
    try {
      let effectiveKb = kbText;
      if (!effectiveKb.trim() && !kbNotNeeded) {
        showToast('No Knowledge Base yet — generating one first so queries are properly grounded...', 'success');
        setIsGeneratingKb(true);
        const kb = await fetchGeneratedKb();
        setIsGeneratingKb(false);
        if (!kb) {
          showToast('Could not auto-generate a Knowledge Base. Try again, or check "No external context needed" to skip it.', 'error');
          return;
        }
        effectiveKb = kb;
        setKbText(kb);
        setIsKbExpanded(true);
      }

      const res = await fetch(`${API_URL}/lab/generate_queries`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_key: getKeyForModel(settings.apiKeys, settings.generators.model, settings.generators.provider), config: settings.generators, prompt, kb: effectiveKb, json_schema: schema, count: queryCount, levels: selectedLevels })
      });
      const data = await res.json();
      if (data.queries?.length > 0) {
        setQueries(data.queries);
        setQueriesKbSnapshot(effectiveKb);
        showToast(`Generated ${data.queries.length} queries`, 'success');
        if (data.warning) {
          showToast(data.warning, 'error');
        }
      }
    } catch (err: any) {
      showToast('Failed to generate queries: ' + err.message, 'error');
    } finally {
      setIsGeneratingQueries(false);
    }
  };

  const toggleLevel = (lvl: string) => {
    setSelectedLevels(prev => prev.includes(lvl) ? prev.filter(l => l !== lvl) : [...prev, lvl]);
  };

  // ── Optimization ─────────────────────────────────────
  const handleLabStreamEvent = (event: any) => {
    if (event.type === 'node_complete') {
      const node = event.node;
      const out = event.output || {};
      if (node === 'run_query_suite' && out.query_results) {
        // Fresh, not-yet-evaluated results (no criteria_checks/passed/feedback on them yet) — clear
        // the PREVIOUS iteration's score/pass state and feedback text too, so the UI doesn't show
        // last iteration's leftover pass/fail marks and feedback next to this iteration's new
        // outputs while waiting for the evaluator node to actually score them.
        setQueryResults(out.query_results);
        setCurrentScore(null);
        setIsPassed(false);
        setCritique('');
        setEditedFeedbacks({});
      }
      else if (node === 'evaluator') {
        if (out.score !== undefined) setCurrentScore(out.score);
        if (out.is_passed !== undefined) setIsPassed(out.is_passed);
        if (out.critique) setCritique(out.critique);
        if (out.history) setHistory(out.history);
        if (out.query_results) {
          setQueryResults(out.query_results);
          const initialFeedbacks: Record<number, string> = {};
          out.query_results.forEach((qr: any, idx: number) => {
            if (qr.feedback) initialFeedbacks[idx] = qr.feedback;
          });
          setEditedFeedbacks(initialFeedbacks);
        }
      } else if (node === 'optimizer') {
        if (out.prompt_instruction) setPromptInstructionInput(out.prompt_instruction);
        if (out.schema_instruction) setSchemaInstructionInput(out.schema_instruction);
        // Stashed here so the following apply_autonomous event (which carries the actual new
        // prompt text) can pair it with the instruction that produced it.
        pendingInstructionRef.current = out.prompt_instruction || '';
      } else if (node === 'apply_autonomous') {
        if (out.candidate_prompt) {
          // apply_autonomous only ever runs in autonomous mode (route_after_optimizer sends
          // hybrid mode to human_review instead), which has no interrupt to pause on — without
          // this log, the prompt/schema change under the hood with nothing on screen to prove it.
          // `out.iteration` is already the UPCOMING iteration (apply_autonomous_node increments
          // it), so the one that just completed and produced this update is iteration - 1.
          const oldPrompt = lastKnownPromptRef.current;
          const newPrompt = out.candidate_prompt;
          const oldSchema = lastKnownSchemaRef.current;
          const newSchema = out.json_schema !== undefined ? out.json_schema : oldSchema;
          const completedIteration = (out.iteration || 2) - 1;
          lastKnownPromptRef.current = newPrompt;
          lastKnownSchemaRef.current = newSchema;

          setIterationUpdates(prev => [...prev, {
            iteration: completedIteration, oldPrompt, newPrompt, oldSchema, newSchema, instruction: pendingInstructionRef.current
          }]);
          setActiveUpdateIteration(completedIteration);
          if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
          autoCollapseTimerRef.current = setTimeout(() => setActiveUpdateIteration(null), 5000);

          onApplyPrompt(newPrompt);
          if (newSchema !== oldSchema) onApplySchema(newSchema);
        }
        if (out.iteration) setCurrentIteration(out.iteration);
      } else if (node === 'report_generator') {
        if (out.report_markdown) { setReportMarkdown(out.report_markdown); setActiveTab('report'); }
      }
    } else if (event.type === 'interrupt') {
      setInterruptPayload(event.payload);
      if (event.payload?.critique) setUserCritiqueInput(event.payload.critique);
      if (event.payload?.prompt_instruction) setPromptInstructionInput(event.payload.prompt_instruction);
      if (event.payload?.schema_instruction) setSchemaInstructionInput(event.payload.schema_instruction);
      if (event.payload?.query_results) {
        setQueryResults(event.payload.query_results);
        const initialFeedbacks: Record<number, string> = {};
        event.payload.query_results.forEach((qr: any, idx: number) => {
          if (qr.feedback) initialFeedbacks[idx] = qr.feedback;
        });
        setEditedFeedbacks(initialFeedbacks);
      }
      setIsLabRunning(false);
      setRunSubView('evaluation');
    } else if (event.type === 'lab_complete') {
      const finalState = event.final_state || {};
      if (finalState.report_markdown) { setReportMarkdown(finalState.report_markdown); setActiveTab('report'); }
      if (finalState.candidate_prompt) {
        onApplyPrompt(finalState.candidate_prompt);
      }
      if (finalState.json_schema !== undefined && finalState.json_schema !== baseSchemaRef.current) {
        onApplySchema(finalState.json_schema);
      }
      if (finalState.base_prompt && finalState.candidate_prompt) {
        setFinalDiff({
          base: finalState.base_prompt,
          final: finalState.candidate_prompt,
          baseSchema: baseSchemaRef.current,
          finalSchema: finalState.json_schema ?? baseSchemaRef.current,
        });
      }
      if (finalState.query_results) setQueryResults(finalState.query_results);
      setIsLabRunning(false);
    }
  };

  const handleStartOptimization = async () => {
    if (!prompt.trim()) { showToast('Base prompt cannot be empty', 'error'); return; }
    if (cleanedCriteria.length === 0) { showToast('Add at least one acceptance criterion.', 'error'); return; }
    if (queries.length === 0) { showToast('Add at least one query', 'error'); return; }
    // Non-blocking heads-up: queries were generated from a KB that has since changed (or was
    // cleared), so they may reference entities/content no longer present in the current KB.
    if (!kbNotNeeded && queriesKbSnapshot !== null && queriesKbSnapshot !== kbText) {
      showToast('Heads up: your test queries were generated from an earlier Knowledge Base — regenerate them to stay in sync before running.', 'error');
    }

    const newSessionId = 'lab_' + Date.now();
    setLabSessionId(newSessionId);
    setIsLabRunning(true);
    setCurrentIteration(1);
    setCurrentScore(null);
    setIsPassed(false);
    setQueryResults([]);
    setCritique('');
    setHistory([]);
    setInterruptPayload(null);
    setUserCritiqueInput('');
    setReportMarkdown('');
    setSelectedQueryTab(0);
    setEditedFeedbacks({});
    setPromptInstructionInput('');
    setSchemaInstructionInput('');
    setIterationUpdates([]);
    setActiveUpdateIteration(null);
    setFinalDiff(null);
    lastKnownPromptRef.current = prompt;
    lastKnownSchemaRef.current = schema;
    baseSchemaRef.current = schema;
    pendingInstructionRef.current = '';
    if (autoCollapseTimerRef.current) clearTimeout(autoCollapseTimerRef.current);
    setRunSubView('evaluation');
    setActiveTab('run');

    try {
      const response = await fetch(`${API_URL}/lab/stream`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: getKeyForModel(settings.apiKeys, runnerConfig.model, runnerConfig.provider),
          config: runnerConfig,
          evaluator_config: evaluatorConfig,
          evaluator_api_key: getKeyForModel(settings.apiKeys, evaluatorConfig.model, evaluatorConfig.provider),
          optimizer_config: optimizerConfig,
          optimizer_api_key: getKeyForModel(settings.apiKeys, optimizerConfig.model, optimizerConfig.provider),
          session_id: newSessionId,
          base_prompt: prompt,
          json_schema: schema,
          kb_text: kbText,
          acceptance_criteria: cleanedCriteria,
          test_queries: queries,
          eval_mode: evalMode,
          max_iterations: maxIterations
        })
      });

      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response stream');
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '{"type": "done"}') { setIsLabRunning(false); continue; }
          try { handleLabStreamEvent(JSON.parse(raw)); } catch (e) {}
        }
      }
    } catch (err: any) {
      showToast('Optimization error: ' + err.message, 'error');
      setIsLabRunning(false);
    }
  };

  const handleResume = async (action: 'continue' | 'stop') => {
    setIsResuming(true);
    try {
      const queryFeedbackNotes = Object.entries(editedFeedbacks)
        .map(([idx, fb]) => `Query #${Number(idx) + 1} Note: ${fb}`)
        .join('\n');
      const combinedCritique = [userCritiqueInput, queryFeedbackNotes].filter(Boolean).join('\n\n');

      const response = await fetch(`${API_URL}/lab/resume`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: labSessionId,
          action,
          user_critique: combinedCritique,
          prompt_instruction: promptInstructionInput,
          schema_instruction: schemaInstructionInput
        })
      });
      setInterruptPayload(null);
      setRunSubView('evaluation');
      if (action === 'continue') {
        setIsLabRunning(true);
        setCurrentIteration(p => p + 1);
        setCurrentScore(null);
        setSelectedQueryTab(0);
      }

      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of decoder.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '{"type": "done"}') { setIsLabRunning(false); continue; }
          try { handleLabStreamEvent(JSON.parse(raw)); } catch (e) {}
        }
      }
    } catch (err: any) {
      showToast('Resume error: ' + err.message, 'error');
    } finally {
      setIsResuming(false);
      setIsLabRunning(false);
    }
  };

  const handleCopyReport = () => {
    navigator.clipboard.writeText(reportMarkdown);
    setCopiedReport(true);
    setTimeout(() => setCopiedReport(false), 2000);
    showToast('Report copied to clipboard', 'success');
  };

  const handleDownloadMd = () => {
    const blob = new Blob([reportMarkdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `optimization_report_${Date.now()}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handlePrintPdf = () => {
    window.print();
  };

  // ── Inline query editor ──────────────────────────────
  const updateQuery = (idx: number, field: keyof TestQuery, value: string) => {
    setQueries(prev => prev.map((q, i) => i === idx ? { ...q, [field]: value } : q));
  };

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-modal" style={{ maxWidth: '98vw', width: '1500px', height: '94vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Header */}
        <div className="modal-header" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: 16 }}>
          <div>
            <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Optimization Lab
              {isLabRunning && <div className="loader" style={{ width: 14, height: 14, borderWidth: 2, borderTopColor: 'var(--accent-primary)', marginLeft: 8 }} />}
            </h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 3 }}>
              Non-destructive multi-iteration prompt improvement with automated evaluation.
            </p>
          </div>
          <button className="btn btn-outline" onClick={onClose} style={{ padding: 8 }}><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, padding: '0 20px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)', flexShrink: 0 }}>
          {(['setup', 'run', 'report'] as const).map((tab, i) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              style={{
                padding: '10px 18px', fontSize: '0.83rem', fontWeight: 500,
                borderBottom: activeTab === tab ? '2px solid var(--accent-primary)' : '2px solid transparent',
                color: activeTab === tab ? 'var(--accent-primary)' : 'var(--text-secondary)',
                background: 'none', border: 'none', cursor: 'pointer', transition: 'all 0.15s'
              }}
            >
              {i + 1}. {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab === 'run' && isLabRunning && <span style={{ marginLeft: 6, width: 6, height: 6, borderRadius: '50%', background: 'var(--accent-primary)', display: 'inline-block', animation: 'pulse 1.5s infinite' }} />}
              {tab === 'report' && reportMarkdown && <span style={{ marginLeft: 6, width: 6, height: 6, borderRadius: '50%', background: 'var(--success-color)', display: 'inline-block' }} />}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>

          {/* ── TAB 1: SETUP ── */}
          {activeTab === 'setup' && (
            <>
              {/* KB */}
              <div className="studio-card">
                <div className="studio-card-header" onClick={() => setIsKbExpanded(p => !p)} style={{ cursor: 'pointer' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {isKbExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>Knowledge Base (Context)</span>
                    {kbText && <span className="tag-pill">{kbText.length} chars</span>}
                  </div>
                  <button
                    className="btn btn-outline" style={{ padding: '3px 10px', fontSize: '0.75rem', gap: 5 }}
                    onClick={e => { e.stopPropagation(); handleGenerateKb(); }}
                    disabled={isGeneratingKb || kbNotNeeded}
                  >
                    {isGeneratingKb ? <div className="loader" style={{ width: 11, height: 11, borderWidth: 2 }} /> : <Sparkles size={12} />}
                    Auto-Generate
                  </button>
                </div>
                {isKbExpanded ? (
                  <div style={{ padding: '12px', borderTop: '1px solid var(--border-color)' }}>
                    <textarea
                      className="studio-textarea" rows={5}
                      placeholder="Paste reference text, source code, a document, records, or other context data…"
                      value={kbText}
                      onChange={e => setKbText(e.target.value)}
                      disabled={kbNotNeeded}
                      style={{ opacity: kbNotNeeded ? 0.5 : 1 }}
                    />
                  </div>
                ) : (
                  <div style={{ padding: '8px 12px', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px solid var(--border-color)' }}>
                    {kbText ? kbText.slice(0, 100) + '…' : 'No KB set. Click to expand or Auto-Generate.'}
                  </div>
                )}
                <label
                  onClick={e => e.stopPropagation()}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, padding: '8px 12px',
                    borderTop: '1px solid var(--border-color)',
                    fontSize: '0.75rem', color: 'var(--text-secondary)', cursor: 'pointer'
                  }}
                >
                  <input type="checkbox" checked={kbNotNeeded} onChange={e => setKbNotNeeded(e.target.checked)} />
                  This prompt doesn't need external context (skip Knowledge Base)
                </label>
              </div>

              {/* Acceptance Criteria */}
              <div className="studio-card" style={{ padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                    Acceptance Criteria <span className="tag-pill">{cleanedCriteria.length}</span>
                  </span>
                  <button
                    className="btn btn-outline" style={{ padding: '3px 10px', fontSize: '0.75rem', gap: 5 }}
                    onClick={handleGenerateCriteria} disabled={isGeneratingCriteria}
                  >
                    {isGeneratingCriteria ? <div className="loader" style={{ width: 11, height: 11, borderWidth: 2 }} /> : <Sparkles size={12} />}
                    Auto-Extract
                  </button>
                </div>

                <textarea
                  className="studio-textarea"
                  rows={6}
                  placeholder={'One acceptance criterion per line, e.g.\nMust output strictly valid JSON adhering to the schema\nMust reject out-of-scope requests with clear error code'}
                  value={criteriaText}
                  onChange={e => setCriteriaText(e.target.value)}
                  style={{ fontSize: '0.82rem', lineHeight: 1.6 }}
                />
                <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: 6 }}>
                  {cleanedCriteria.length} criterion{cleanedCriteria.length === 1 ? '' : 'ia'} detected — one per line.
                </div>
              </div>

              {/* Query Suite */}
              <div className="studio-card" style={{ padding: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                    Test Query Suite <span className="tag-pill">{queries.length}</span>
                  </span>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select className="studio-select" value={queryCount} onChange={e => setQueryCount(Number(e.target.value))}>
                      <option value={1}>1 query</option>
                      <option value={3}>3 queries</option>
                      <option value={5}>5 queries</option>
                    </select>
                    <button
                      className="btn btn-outline" style={{ padding: '3px 10px', fontSize: '0.75rem', gap: 5 }}
                      onClick={handleGenerateQueries} disabled={isGeneratingQueries}
                    >
                      {isGeneratingQueries ? <div className="loader" style={{ width: 11, height: 11, borderWidth: 2 }} /> : <Sparkles size={12} />}
                      Generate Suite
                    </button>
                  </div>
                </div>

                {!kbText.trim() && !kbNotNeeded && (
                  <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: 10 }}>
                    No Knowledge Base yet — clicking "Generate Suite" will synthesize one first, then generate queries grounded in it.
                  </div>
                )}

                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  {Object.entries(LEVEL_LABELS).map(([lvl, label]) => (
                    <button
                      key={lvl}
                      className={`tier-pill ${selectedLevels.includes(lvl) ? 'active' : ''}`}
                      onClick={() => toggleLevel(lvl)}
                    >
                      {lvl} {label}
                    </button>
                  ))}
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 280, overflowY: 'auto' }}>
                  {queries.map((q, idx) => (
                    <div key={idx} style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', padding: '10px 12px' }}>
                      <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                        <span className="tag-pill" style={{ fontSize: '0.7rem' }}>{q.level}</span>
                        <input
                          className="studio-input" value={q.name}
                          onChange={e => updateQuery(idx, 'name', e.target.value)}
                          style={{ width: 140, fontSize: '0.78rem', padding: '3px 8px' }}
                          placeholder="Name"
                        />
                        <div style={{ flex: 1 }} />
                        <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--danger-color)' }} onClick={() => setQueries(p => p.filter((_, i) => i !== idx))}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <textarea
                        className="studio-textarea"
                        value={q.query}
                        onChange={e => updateQuery(idx, 'query', e.target.value)}
                        rows={2}
                        style={{ fontSize: '0.8rem', marginBottom: 0 }}
                        placeholder="Query text…"
                      />
                    </div>
                  ))}
                  <button
                    className="btn btn-outline"
                    style={{ width: '100%', padding: '6px', fontSize: '0.8rem', gap: 5 }}
                    onClick={() => setQueries(p => [...p, { level: 'L1', name: 'New Query', query: '' }])}
                  >
                    <Plus size={13} /> Add Query
                  </button>
                </div>
              </div>

              {/* Settings */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="studio-card" style={{ padding: '12px' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Evaluation Mode</span>
                  <select className="studio-select" style={{ width: '100%' }} value={evalMode} onChange={e => setEvalMode(e.target.value as any)}>
                    <option value="hybrid">🤝 Hybrid (LLM + Human Review)</option>
                    <option value="autonomous">🤖 Autonomous (Until 100% Pass)</option>
                  </select>
                </div>
                <div className="studio-card" style={{ padding: '12px' }}>
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 }}>Max Iterations</span>
                  <select className="studio-select" style={{ width: '100%' }} value={maxIterations} onChange={e => setMaxIterations(Number(e.target.value))}>
                    <option value={1}>1 Iteration (Single Pass)</option>
                    <option value={3}>3 Iterations (Recommended)</option>
                    <option value={5}>5 Iterations (Deep Search)</option>
                  </select>
                </div>
              </div>

              {/* Runner / Evaluator / Optimizer model configuration — independent per-session
                  pickers, same pattern as the Trial Run Console, not tied to the global Settings
                  modal's roles. */}
              <div className="studio-card" style={{ padding: '12px' }}>
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 8 }}>Model Configuration</span>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                  <ModelPickerRow
                    label="Runner (executes test queries)"
                    value={runnerConfig}
                    onChange={setRunnerConfig}
                    apiKeys={settings.apiKeys}
                  />
                  <ModelPickerRow
                    label="Evaluator (scores outputs)"
                    value={evaluatorConfig}
                    onChange={setEvaluatorConfig}
                    apiKeys={settings.apiKeys}
                  />
                  <ModelPickerRow
                    label="Optimizer (rewrites the prompt)"
                    value={optimizerConfig}
                    onChange={setOptimizerConfig}
                    apiKeys={settings.apiKeys}
                  />
                </div>
              </div>

              <button
                className="btn btn-primary"
                style={{ width: '100%', padding: '12px', fontSize: '0.9rem', fontWeight: 600 }}
                onClick={handleStartOptimization}
                disabled={isLabRunning}
              >
                <Play size={16} /> Start Non-Destructive Optimization Run
              </button>
            </>
          )}

          {/* ── TAB 2: RUN ── */}
          {activeTab === 'run' && (
            <>
              {/* SUBVIEW 1: EVALUATION STUDIO (Wireframe Left View) */}
              {runSubView === 'evaluation' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                  {/* Score Header Card — kept deliberately compact so the real content below
                      (LLM Output / Acceptance Criteria / Feedback) gets the vertical space. */}
                  <div className="studio-card" style={{ padding: '10px 16px', background: 'var(--bg-secondary)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                        {/* Compact circular score gauge */}
                        {(() => {
                          const gaugeColor = isPassed || (currentScore !== null && currentScore >= 90)
                            ? 'var(--success)'
                            : (currentScore !== null && currentScore >= 50) ? 'var(--warning, #d97706)' : 'var(--danger)';
                          const gaugeDeg = (currentScore ?? 0) * 3.6;
                          return (
                            <div style={{
                              width: 46, height: 46, borderRadius: '50%', flexShrink: 0,
                              background: currentScore !== null
                                ? `conic-gradient(${gaugeColor} ${gaugeDeg}deg, var(--bg-tertiary) 0deg)`
                                : 'var(--bg-tertiary)',
                              display: 'flex', alignItems: 'center', justifyContent: 'center'
                            }}>
                              <div style={{
                                width: 36, height: 36, borderRadius: '50%', background: 'var(--bg-secondary)',
                                display: 'flex', alignItems: 'center', justifyContent: 'center'
                              }}>
                                <span style={{ fontSize: '0.72rem', fontWeight: 800, fontFamily: 'var(--font-mono, monospace)', color: currentScore !== null ? gaugeColor : 'var(--text-muted)' }}>
                                  {currentScore !== null ? currentScore : isLabRunning ? '…' : '--'}
                                </span>
                              </div>
                            </div>
                          );
                        })()}

                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: '0.92rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                            Iteration #{currentIteration} of {maxIterations}
                            {queryResults.length > 0 && (
                              <span style={{ fontSize: '0.74rem', fontWeight: 500, color: 'var(--text-secondary)', marginLeft: 8 }}>
                                {queryResults.filter((q: any) => q.passed).length}/{queryResults.length} queries passed
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: '0.74rem', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                            {isPassed ? (
                              <span style={{ color: 'var(--success-color)', display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
                                <CheckCircle2 size={12} /> 100% Passed — All criteria met!
                              </span>
                            ) : isLabRunning ? (
                              <span style={{ color: 'var(--accent-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                <div className="loader" style={{ width: 10, height: 10, borderWidth: 2 }} />
                                Running candidate model…
                              </span>
                            ) : interruptPayload ? (
                              <span style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                                <Sparkles size={11} color="var(--accent-primary)" />
                                Evaluated — review outputs, then the plan.
                              </span>
                            ) : (
                              <span style={{ color: 'var(--text-muted)' }}>Ready — Click Start to begin.</span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Iteration History — compact inline chips, only shown once there's history */}
                      {history.length > 0 && (
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
                          {history.map((h: any) => (
                            <div key={h.iteration} title={`Iteration ${h.iteration}: ${h.score}%`} style={{
                              display: 'flex', alignItems: 'center', gap: 4,
                              padding: '3px 8px', borderRadius: 'var(--radius-full)',
                              background: 'var(--bg-primary)',
                              border: `1px solid ${h.is_passed ? 'var(--success)' : 'var(--border-color)'}`
                            }}>
                              <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>#{h.iteration}</span>
                              <span style={{ fontSize: '0.74rem', fontWeight: 700, fontFamily: 'var(--font-mono, monospace)', color: h.is_passed ? 'var(--success)' : 'var(--text-secondary)' }}>
                                {h.score}%
                              </span>
                            </div>
                          ))}
                        </div>
                      )}

                      {interruptPayload && (
                        <button
                          className="btn btn-primary"
                          onClick={() => setRunSubView('plan')}
                          style={{ padding: '7px 16px', fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
                        >
                          <span>Review Updates &amp; Plan</span>
                          <ArrowRight size={13} />
                        </button>
                      )}
                    </div>

                    {/* Suite-level critique — deliberately separate from any per-query feedback
                        box below (which never falls back to this), so it reads as the evaluator's
                        overall diagnosis across the whole suite, not one query's own note. */}
                    {critique && !isPassed && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-color)', fontSize: '0.76rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                        <span style={{ fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: '0.66rem', letterSpacing: '0.04em' }}>Suite-Level Critique: </span>
                        {critique}
                      </div>
                    )}
                  </div>

                  {/* Autonomous-mode prompt-change log — apply_autonomous has no human_review
                      interrupt to pause on, so this is the only on-screen proof the prompt
                      actually changed each iteration. The most recent entry auto-expands (with a
                      full diff) for 5s, then collapses back into a one-line summary — the whole
                      log stays clickable/re-expandable afterward, so a missed 5s window doesn't
                      mean the information is gone. */}
                  {evalMode === 'autonomous' && iterationUpdates.length > 0 && (
                    <div className="studio-card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        Prompt Changes This Run
                      </div>
                      {iterationUpdates.map((u, idx) => {
                        const isExpanded = activeUpdateIteration === u.iteration;
                        const promptChanged = u.oldPrompt !== u.newPrompt;
                        const schemaChanged = u.oldSchema !== u.newSchema;
                        const changed = promptChanged || schemaChanged;
                        return (
                          <div key={u.iteration} style={{ borderBottom: idx < iterationUpdates.length - 1 ? '1px solid var(--border-color)' : 'none' }}>
                            <div
                              onClick={() => setActiveUpdateIteration(isExpanded ? null : u.iteration)}
                              style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', cursor: 'pointer' }}
                            >
                              {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              <span className="tag-pill" style={{ fontSize: '0.68rem', flexShrink: 0 }}>Iter {u.iteration}</span>
                              <span style={{ flex: 1, fontSize: '0.8rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: isExpanded ? 'normal' : 'nowrap' }}>
                                {changed ? (u.instruction || 'Prompt updated.') : 'No change applied this iteration.'}
                              </span>
                              {schemaChanged && <span className="tag-pill" style={{ fontSize: '0.65rem', flexShrink: 0 }}>+ Schema</span>}
                            </div>
                            {isExpanded && promptChanged && (
                              <div style={{ maxHeight: 320, overflowY: 'auto', borderTop: '1px solid var(--border-color)' }}>
                                <ReactDiffViewer
                                  oldValue={u.oldPrompt}
                                  newValue={u.newPrompt}
                                  splitView={false}
                                  useDarkTheme={_theme === 'dark'}
                                  compareMethod={DiffMethod.WORDS}
                                />
                              </div>
                            )}
                            {isExpanded && schemaChanged && (
                              <div style={{ borderTop: '1px solid var(--border-color)' }}>
                                <div style={{ padding: '6px 16px', fontSize: '0.7rem', fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-primary)' }}>JSON SCHEMA</div>
                                <div style={{ maxHeight: 320, overflowY: 'auto' }}>
                                  <ReactDiffViewer
                                    oldValue={u.oldSchema}
                                    newValue={u.newSchema}
                                    splitView={false}
                                    useDarkTheme={_theme === 'dark'}
                                    compareMethod={DiffMethod.WORDS}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Running with no results yet — show the pending query suite instead of empty space */}
                  {isLabRunning && queryResults.length === 0 && (
                    <div className="studio-card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        Running {queries.length} test quer{queries.length === 1 ? 'y' : 'ies'} against the candidate prompt…
                      </div>
                      {queries.map((q, idx) => (
                        <div key={idx} style={{
                          display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
                          borderBottom: idx < queries.length - 1 ? '1px solid var(--border-color)' : 'none'
                        }}>
                          <div className="loader" style={{ width: 13, height: 13, borderWidth: 2, flexShrink: 0 }} />
                          <span className="tag-pill" style={{ fontSize: '0.68rem', flexShrink: 0 }}>{q.level}</span>
                          <span style={{ fontSize: '0.82rem', fontWeight: 500, flexShrink: 0 }}>{q.name}</span>
                          <span style={{ flex: 1, fontSize: '0.78rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {q.query}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Query Tabs & Split Evaluation */}
                  {queryResults.length > 0 && (
                    <div className="studio-card" style={{ padding: '0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                      {/* Tabs Bar: q1, q2, q3 */}
                      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', overflowX: 'auto' }}>
                        {queryResults.map((qr, idx) => {
                          const isQrPassed = qr.passed !== undefined ? qr.passed : ((currentScore !== null && currentScore >= 100) || isPassed);
                          const isSelected = selectedQueryTab === idx;
                          return (
                            <button
                              key={idx}
                              onClick={() => setSelectedQueryTab(idx)}
                              style={{
                                padding: '10px 18px',
                                border: 'none',
                                borderBottom: isSelected ? '2px solid var(--accent-primary)' : '2px solid transparent',
                                background: isSelected ? 'var(--bg-secondary)' : 'transparent',
                                color: isSelected ? 'var(--text-primary)' : 'var(--text-muted)',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                fontSize: '0.82rem',
                                fontWeight: isSelected ? 600 : 500,
                                transition: 'all 0.15s ease',
                                whiteSpace: 'nowrap'
                              }}
                            >
                              <span>Q{idx + 1} ({qr.level || `Case ${idx+1}`})</span>
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  fontWeight: 700,
                                  padding: '1px 6px',
                                  borderRadius: '4px',
                                  background: isQrPassed ? 'var(--success-bg, rgba(5,150,105,0.12))' : 'var(--danger-bg, rgba(220,38,38,0.12))',
                                  color: isQrPassed ? 'var(--success-color)' : 'var(--danger-color)'
                                }}
                              >
                                {isQrPassed ? '✓' : '✗'}
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Selected Query Content Area (50% / 50% split) */}
                      {(() => {
                        const activeQr = queryResults[selectedQueryTab] || queryResults[0];
                        const isQrPassed = activeQr.passed !== undefined ? activeQr.passed : ((currentScore !== null && currentScore >= 100) || isPassed);
                        // Deliberately NOT falling back to the shared suite-level `critique` here —
                        // that made every query lacking its own feedback display identical text,
                        // as if they weren't independently evaluated. Each tab shows only its own
                        // (or a per-query placeholder), never another query's or the suite's.
                        const activeFeedback = editedFeedbacks[selectedQueryTab] !== undefined ? editedFeedbacks[selectedQueryTab] : (activeQr.feedback || '');

                        // Each of the 3 panels below is its own bordered, radiused card sitting on the
                        // --bg-primary "gutter" (with a real gap between them), and each panel's own
                        // header uses --bg-tertiary — three genuinely distinct tones (primary < secondary
                        // < tertiary) instead of a single shared card with only hairline dividers, so the
                        // sections read as clearly separate at a glance.
                        const cardStyle: CSSProperties = {
                          background: 'var(--bg-secondary)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 'var(--radius-md)',
                          overflow: 'hidden',
                          display: 'flex',
                          flexDirection: 'column',
                          boxShadow: 'var(--shadow-xs)'
                        };
                        const cardHeaderStyle: CSSProperties = {
                          padding: '10px 16px',
                          borderBottom: '1px solid var(--border-color)',
                          background: 'var(--bg-tertiary)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          flexShrink: 0
                        };

                        return (
                          <div style={{
                            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: 12,
                            background: 'var(--bg-primary)', minHeight: 'min(640px, calc(100vh - 320px))'
                          }}>
                            {/* LLM Output */}
                            <div style={cardStyle}>
                              <div style={cardHeaderStyle}>
                                <div style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                  LLM Output
                                </div>
                                <span style={{ fontSize: '0.75rem', fontWeight: 600, color: isQrPassed ? 'var(--success-color)' : 'var(--danger-color)' }}>
                                  {isQrPassed ? '✓ PASSED' : '✗ FAILED'}
                                </span>
                              </div>
                              <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', color: 'var(--text-muted)', flexShrink: 0 }}>
                                <span style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Query: </span>
                                {activeQr.query || activeQr.name}
                              </div>
                              <div style={{ flex: 1, padding: '14px 16px', overflowY: 'auto' }}>
                                <pre style={{ margin: 0, fontSize: '0.8rem', fontFamily: 'var(--font-mono, monospace)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--text-primary)', lineHeight: 1.5 }}>
                                  {activeQr.output || activeQr.response || '(No output recorded)'}
                                </pre>
                              </div>
                            </div>

                            {/* Right Column: Acceptance Criteria card (top) + Feedback card (bottom), with a real gap between them */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
                              {/* Acceptance Criteria Check */}
                              <div style={{ ...cardStyle, flex: '1 1 55%', maxHeight: 360 }}>
                                <div style={cardHeaderStyle}>
                                  <span style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                                    Acceptance Criteria Check
                                  </span>
                                </div>
                                <div style={{ flex: 1, padding: '12px 16px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                                  {activeQr.criteria_checks && activeQr.criteria_checks.length > 0 ? (
                                    activeQr.criteria_checks.map((chk: any, cIdx: number) => (
                                      <div key={cIdx} style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                                        <span style={{ marginTop: 2, fontSize: '0.8rem', color: chk.passed ? 'var(--success-color)' : 'var(--danger-color)' }}>
                                          {chk.passed ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                                        </span>
                                        <div style={{ flex: 1 }}>
                                          <div style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-primary)' }}>
                                            {chk.criterion}
                                          </div>
                                          {chk.reason && (
                                            <div style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginTop: 2, lineHeight: 1.4 }}>
                                              {chk.reason}
                                            </div>
                                          )}
                                        </div>
                                      </div>
                                    ))
                                  ) : currentScore === null ? (
                                    // Genuinely not evaluated yet (fresh run_query_suite output,
                                    // evaluator hasn't scored it) — show pending, not stale
                                    // pass/fail marks left over from the previous iteration.
                                    cleanedCriteria.map((c, cIdx) => (
                                      <div key={cIdx} style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8, opacity: 0.6 }}>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                                          <div className="loader" style={{ width: 12, height: 12, borderWidth: 2 }} />
                                        </span>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{c} — pending evaluation…</span>
                                      </div>
                                    ))
                                  ) : (
                                    cleanedCriteria.map((c, cIdx) => (
                                      <div key={cIdx} style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-primary)', border: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 8 }}>
                                        <span style={{ fontSize: '0.8rem', color: isQrPassed ? 'var(--success-color)' : 'var(--text-muted)' }}>
                                          {isQrPassed ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                                        </span>
                                        <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }}>{c}</span>
                                      </div>
                                    ))
                                  )}
                                </div>
                              </div>

                              {/* LLM Feedback (Editable Text Box) */}
                              <div style={{ ...cardStyle, flex: '1 1 45%' }}>
                                <div style={cardHeaderStyle}>
                                  <div style={{ fontWeight: 600, fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <Edit3 size={13} color="var(--accent-primary)" />
                                    <span>LLM Feedback &amp; Diagnostics</span>
                                  </div>
                                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Editable</span>
                                </div>
                                <div style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                                  <textarea
                                    value={activeFeedback}
                                    onChange={e => setEditedFeedbacks(prev => ({ ...prev, [selectedQueryTab]: e.target.value }))}
                                    placeholder="Feedback diagnosing why this query failed or guidance for the optimizer..."
                                    rows={6}
                                    style={{
                                      flex: 1,
                                      width: '100%',
                                      resize: 'none',
                                      border: '1px solid var(--border-color)',
                                      borderRadius: 'var(--radius-sm)',
                                      padding: '10px 12px',
                                      fontSize: '0.82rem',
                                      lineHeight: 1.5,
                                      fontFamily: 'var(--font-sans)',
                                      color: 'var(--text-primary)',
                                      background: 'var(--bg-primary)',
                                      outline: 'none'
                                    }}
                                  />
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                    💡 You can edit or add notes here. The optimizer uses this feedback when generating updates.
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  )}
                </div>
              )}

              {/* SUBVIEW 2: PLAN OF UPDATES (Wireframe Right View) */}
              {runSubView === 'plan' && (
                <div className="studio-card" style={{ padding: '0', overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 520 }}>
                  {/* Header */}
                  <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>
                        Plan of Updates
                      </div>
                      <div style={{ fontSize: '1.15rem', fontWeight: 700, marginTop: 2 }}>
                        Iteration #{currentIteration} Refinement Plan
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 10 }}>
                      <button
                        className="btn btn-outline"
                        onClick={() => setRunSubView('evaluation')}
                        style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <ArrowLeft size={14} /> Back to Evaluation
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => setRunSubView('diff')}
                        style={{ fontSize: '0.82rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <span>Approve Plan &amp; View Diff</span>
                        <ArrowRight size={14} />
                      </button>
                    </div>
                  </div>

                  {/* Split Pane: Left = Prompt Instructions, Right = Schema Instructions */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, minHeight: 440 }}>
                    {/* Left Pane: Prompt Update instruction */}
                    <div style={{ borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column' }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                          Prompt Update Instruction (Iteration #{currentIteration})
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Editable</span>
                      </div>
                      <div style={{ flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
                        <textarea
                          value={promptInstructionInput}
                          onChange={e => setPromptInstructionInput(e.target.value)}
                          placeholder="Prompt update instructions..."
                          style={{
                            flex: 1,
                            width: '100%',
                            resize: 'none',
                            border: '1px solid var(--border-color)',
                            borderRadius: 'var(--radius-sm)',
                            padding: '12px',
                            fontFamily: 'var(--font-mono, monospace)',
                            fontSize: '0.82rem',
                            lineHeight: 1.5,
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            outline: 'none'
                          }}
                        />
                      </div>
                    </div>

                    {/* Right Pane: Schema Update instruction */}
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-primary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.82rem', color: 'var(--text-secondary)' }}>
                          JSON Schema Update Instruction (Iteration #{currentIteration})
                        </span>
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Editable</span>
                      </div>
                      <div style={{ flex: 1, padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
                        <textarea
                          value={schemaInstructionInput}
                          onChange={e => setSchemaInstructionInput(e.target.value)}
                          placeholder="JSON schema update instructions..."
                          style={{
                            flex: 1,
                            width: '100%',
                            resize: 'none',
                            border: '1px solid var(--border-color)',
                            borderRadius: 'var(--radius-sm)',
                            padding: '12px',
                            fontFamily: 'var(--font-mono, monospace)',
                            fontSize: '0.82rem',
                            lineHeight: 1.5,
                            background: 'var(--bg-secondary)',
                            color: 'var(--text-primary)',
                            outline: 'none'
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* SUBVIEW 3: LIVE DIFF REVIEW */}
              {runSubView === 'diff' && interruptPayload && (
                <div className="studio-card" style={{ padding: '20px', borderColor: 'var(--accent-primary)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <Sparkles size={18} color="var(--accent-primary)" />
                      <span style={{ fontWeight: 700, fontSize: '1rem' }}>
                        Live Diff Review — Iteration #{currentIteration}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                      <button
                        className="btn btn-outline"
                        onClick={() => setRunSubView('plan')}
                        disabled={isResuming}
                        style={{ fontSize: '0.82rem', display: 'flex', alignItems: 'center', gap: 6 }}
                      >
                        <ArrowLeft size={14} /> Back to Plan
                      </button>
                      <button
                        className="btn btn-outline"
                        onClick={() => handleResume('stop')}
                        disabled={isResuming}
                        style={{ fontSize: '0.82rem' }}
                      >
                        Reject &amp; Stop
                      </button>
                      <button
                        className="btn btn-outline"
                        onClick={() => {
                          if (interruptPayload.new_prompt) {
                            onApplyPrompt(interruptPayload.new_prompt);
                            showToast('Main prompt updated!', 'success');
                          }
                          if (interruptPayload.new_schema !== undefined && interruptPayload.new_schema !== interruptPayload.old_schema) {
                            onApplySchema(interruptPayload.new_schema);
                          }
                          handleResume('stop');
                        }}
                        disabled={isResuming}
                        style={{ fontSize: '0.82rem' }}
                      >
                        <Check size={14} /> Approve &amp; Finish Here
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={() => {
                          if (interruptPayload.new_prompt) {
                            onApplyPrompt(interruptPayload.new_prompt);
                            showToast('Main prompt updated! Running next test iteration…', 'success');
                          }
                          if (interruptPayload.new_schema !== undefined && interruptPayload.new_schema !== interruptPayload.old_schema) {
                            onApplySchema(interruptPayload.new_schema);
                          }
                          handleResume('continue');
                        }}
                        disabled={isResuming}
                        style={{ fontSize: '0.82rem', padding: '8px 18px', fontWeight: 600 }}
                      >
                        {isResuming ? <div className="loader" style={{ width: 14, height: 14, borderWidth: 2 }} /> : <Play size={14} />}
                        Apply &amp; Run Iteration #{currentIteration + 1}
                      </button>
                    </div>
                  </div>

                  {/* Word-Level Diff View */}
                  <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      <span>Current System Prompt</span>
                      <span>Proposed Improvements</span>
                    </div>
                    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                      <ReactDiffViewer
                        oldValue={interruptPayload.old_prompt || prompt}
                        newValue={interruptPayload.new_prompt || ''}
                        splitView={false}
                        useDarkTheme={_theme === 'dark'}
                        compareMethod={DiffMethod.WORDS}
                        styles={{
                          variables: {
                            dark: {
                              diffViewerBackground: 'var(--bg-secondary)',
                              addedBackground: 'rgba(16,185,129,0.12)',
                              removedBackground: 'rgba(248,113,113,0.12)',
                              addedColor: '#10b981',
                              removedColor: '#f87171'
                            },
                            light: {
                              diffViewerBackground: '#ffffff',
                              addedBackground: 'rgba(5,150,105,0.08)',
                              removedBackground: 'rgba(220,38,38,0.08)'
                            }
                          }
                        }}
                      />
                    </div>
                  </div>

                  {/* Word-Level Diff View — JSON Schema, only when the optimizer actually
                      proposed a schema change (schema_instruction warranted one) */}
                  {interruptPayload.new_schema !== undefined && interruptPayload.new_schema !== interruptPayload.old_schema && (
                    <div style={{ border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 14px', background: 'var(--bg-tertiary)', borderBottom: '1px solid var(--border-color)', fontSize: '0.78rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        <span>Current JSON Schema</span>
                        <span>Proposed Schema</span>
                      </div>
                      <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                        <ReactDiffViewer
                          oldValue={interruptPayload.old_schema || schema}
                          newValue={interruptPayload.new_schema || ''}
                          splitView={false}
                          useDarkTheme={_theme === 'dark'}
                          compareMethod={DiffMethod.WORDS}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── TAB 3: REPORT ── */}
          {activeTab === 'report' && (
            <>
              {reportMarkdown ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '1rem' }}>Optimization Summary Report</div>
                      {history.length > 0 && <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 2 }}>{history.length} iteration{history.length > 1 ? 's' : ''} recorded{currentScore !== null ? ` — Final Score: ${currentScore}%` : ''}</div>}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button className="btn btn-outline" style={{ gap: 6, fontSize: '0.8rem' }} onClick={handleCopyReport}>
                        <Copy size={14} />{copiedReport ? 'Copied!' : 'Copy'}
                      </button>
                      <button className="btn btn-outline" style={{ gap: 6, fontSize: '0.8rem' }} onClick={handleDownloadMd}>
                        <Download size={14} /> Download .md
                      </button>
                      <button className="btn btn-outline" style={{ gap: 6, fontSize: '0.8rem' }} onClick={handlePrintPdf}>
                        <Printer size={14} /> Save as PDF
                      </button>
                    </div>
                  </div>

                  {/* Styled report */}
                  <div
                    className="printable-report"
                    style={{
                      background: 'var(--bg-secondary)',
                      border: '1px solid var(--border-color)',
                      borderRadius: 'var(--radius-md)',
                      padding: '32px 36px',
                      lineHeight: 1.7,
                      fontSize: '0.9rem'
                    }}
                  >
                    <MarkdownRenderer content={reportMarkdown} />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px', background: 'rgba(16,185,129,0.1)', border: '1px solid var(--success)', borderRadius: 'var(--radius-sm)', color: 'var(--success)', fontWeight: 600, fontSize: '0.85rem' }}>
                    <CheckCircle2 size={16} /> System Prompt in Main Editor is updated with these results
                  </div>

                  {/* Overall base-prompt vs. final-after-all-iterations diff */}
                  {finalDiff && finalDiff.base !== finalDiff.final && (
                    <div className="studio-card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        Full Diff — Base Prompt vs. Final Prompt ({history.length} iteration{history.length === 1 ? '' : 's'})
                      </div>
                      <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                        <ReactDiffViewer
                          oldValue={finalDiff.base}
                          newValue={finalDiff.final}
                          splitView={true}
                          useDarkTheme={_theme === 'dark'}
                          compareMethod={DiffMethod.WORDS}
                        />
                      </div>
                    </div>
                  )}

                  {/* Overall base-schema vs. final-after-all-iterations schema diff */}
                  {finalDiff && finalDiff.baseSchema !== finalDiff.finalSchema && (
                    <div className="studio-card" style={{ padding: 0, overflow: 'hidden' }}>
                      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-tertiary)', fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        Full Diff — Base Schema vs. Final Schema
                      </div>
                      <div style={{ maxHeight: 480, overflowY: 'auto' }}>
                        <ReactDiffViewer
                          oldValue={finalDiff.baseSchema}
                          newValue={finalDiff.finalSchema}
                          splitView={true}
                          useDarkTheme={_theme === 'dark'}
                          compareMethod={DiffMethod.WORDS}
                        />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div style={{ textAlign: 'center', padding: '80px 0', color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>📋</div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>No report yet</div>
                  <p style={{ fontSize: '0.85rem' }}>Complete an optimization run to see the experiment report here.</p>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
