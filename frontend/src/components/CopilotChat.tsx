import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Send, RotateCcw, Brain, Wrench, ChevronDown, Check, ArrowRight, User, Loader2 } from 'lucide-react';
import { useSettings } from '../context/SettingsContext';
import { getKeyForModel } from '../utils/providers';
import { useToast } from '../context/ToastContext';
import MarkdownRenderer from './MarkdownRenderer';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// Turns a raw tool name + args into the human-readable step text shown in the tool activity
// dropdown — e.g. "Searching '429' in schema" or "Reading prompt (lines 50-100)" — instead of
// just the bare args object.
function describeToolCall(name: string, args: Record<string, any> = {}): string {
  if (name === 'grep_documents') {
    const query = args.query ?? '';
    const target = args.target && args.target !== 'both' ? ` in ${args.target}` : '';
    return `Searching "${query}"${target}`;
  }
  if (name === 'read_document') {
    const target = args.target || 'document';
    const start = args.start_line ?? 1;
    const end = args.end_line;
    if (end === undefined || end === null) return `Reading ${target} (from line ${start})`;
    if (end === start) return `Reading ${target} (line ${start})`;
    return `Reading ${target} (lines ${start}-${end})`;
  }
  return name;
}

export interface ActionProposalData {
  summary: string;
  prompt_instruction: string;
  schema_instruction: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  text: string;
  timestamp: number;
  tool_calls?: Array<{ type: string; name: string; args?: any; summary?: string; status?: 'pending' | 'done' }>;
  action_proposal?: ActionProposalData;
  isStreaming?: boolean;
}

interface CopilotChatProps {
  prompt: string;
  schema: string;
  theme: string;
  onApplyProposal: (proposal: ActionProposalData) => void;
}

export default function CopilotChat({ prompt, schema, theme: _theme, onApplyProposal }: CopilotChatProps) {
  const { settings } = useSettings();
  const { showToast } = useToast();

  const [chatSessionId] = useState(() => {
    const existing = sessionStorage.getItem('prompter_chat_session_id');
    if (existing) return existing;
    const newId = 'session_' + Math.random().toString(36).substring(2, 11);
    sessionStorage.setItem('prompter_chat_session_id', newId);
    return newId;
  });

  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const saved = sessionStorage.getItem(`prompter_chat_msgs_${chatSessionId}`);
    if (saved) { try { return JSON.parse(saved); } catch (e) {} }
    return [];
  });

  const [chatInput, setChatInput] = useState('');
  const [isChatStreaming, setIsChatStreaming] = useState(false);
  // Per-message manual expand/collapse override for the tool-activity dropdown. Undefined means
  // "use the default" (expanded while the message is still streaming, collapsed once it's done).
  const [toolOverrides, setToolOverrides] = useState<Record<string, boolean>>({});
  const isToolsExpanded = (msg: ChatMessage) => toolOverrides[msg.id] ?? !!msg.isStreaming;
  const toggleTools = (id: string, current: boolean) =>
    setToolOverrides(prev => ({ ...prev, [id]: !current }));
  const chatMessagesEndRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (messages.length > 0) {
      sessionStorage.setItem(`prompter_chat_msgs_${chatSessionId}`, JSON.stringify(messages));
    }
  }, [messages, chatSessionId]);

  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isChatStreaming]);

  const handleClearChat = async () => {
    try {
      await fetch(`${API_URL}/chat/clear`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: chatSessionId })
      });
    } catch (e) {}
    sessionStorage.removeItem(`prompter_chat_msgs_${chatSessionId}`);
    setMessages([]);
    showToast('Chat history cleared', 'info');
  };

  const handleSendChat = async (overrideText?: string) => {
    const textToSend = (overrideText || chatInput).trim();
    if (!textToSend || isChatStreaming) return;

    const userMsgId = 'msg_' + Date.now();
    const newUserMsg: ChatMessage = { id: userMsgId, role: 'user', text: textToSend, timestamp: Date.now() };
    const assistantMsgId = 'msg_' + (Date.now() + 1);
    const newAssistantMsg: ChatMessage = { id: assistantMsgId, role: 'model', text: '', timestamp: Date.now(), tool_calls: [], isStreaming: true };

    setMessages(prev => [...prev, newUserMsg, newAssistantMsg]);
    if (!overrideText) setChatInput('');
    setIsChatStreaming(true);

    try {
      const allMessages = [...messages, newUserMsg].map(m => ({
        id: m.id, role: m.role, text: m.text, timestamp: m.timestamp
      }));

      const response = await fetch(`${API_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_key: getKeyForModel(settings.apiKeys, settings.copilot.model, settings.copilot.provider),
          config: settings.copilot,
          session_id: chatSessionId,
          messages: allMessages,
          message: textToSend,
          prompt,
          json_schema: schema,
          schema
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(errText || `HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No readable stream available');

      const decoder = new TextDecoder();
      let accumulatedText = '';
      let detectedProposal: ActionProposalData | undefined;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const dataStr = line.slice(6).trim();
          if (dataStr === '[DONE]' || dataStr === '{"type": "done"}') continue;

          try {
            const event = JSON.parse(dataStr);

            if (event.type === 'token') {
              const tokenText = event.text !== undefined ? event.text : (event.token !== undefined ? event.token : '');
              accumulatedText += tokenText;
              setMessages(prev => prev.map(msg =>
                msg.id === assistantMsgId ? { ...msg, text: accumulatedText } : msg
              ));
            } else if (event.type === 'tool_call') {
              const toolName = event.name || event.tool || 'tool';
              setMessages(prev => prev.map(msg =>
                msg.id === assistantMsgId
                  ? { ...msg, tool_calls: [...(msg.tool_calls || []), { type: 'call', name: toolName, args: event.args || {}, summary: describeToolCall(toolName, event.args || {}), status: 'pending' }] }
                  : msg
              ));
            } else if (event.type === 'tool_result') {
              const toolName = event.name || event.tool || 'tool';
              setMessages(prev => prev.map(msg => {
                if (msg.id !== assistantMsgId) return msg;
                let marked = false;
                return {
                  ...msg,
                  tool_calls: (msg.tool_calls || []).map(tc => {
                    if (!marked && tc.name === toolName && tc.status !== 'done') {
                      marked = true;
                      return { ...tc, status: 'done' as const };
                    }
                    return tc;
                  })
                };
              }));
            } else if (event.type === 'action_proposal') {
              detectedProposal = event.data || {
                summary: event.summary || 'Proposed Workspace Changes',
                prompt_instruction: event.prompt_instruction || '',
                schema_instruction: event.schema_instruction || ''
              };
              setMessages(prev => prev.map(msg =>
                msg.id === assistantMsgId ? { ...msg, action_proposal: detectedProposal } : msg
              ));
            } else if (event.type === 'error') {
              showToast(event.error, 'error');
            }
          } catch (pErr) {}
        }
      }

      setMessages(prev => prev.map(msg =>
        msg.id === assistantMsgId ? { ...msg, isStreaming: false, action_proposal: detectedProposal } : msg
      ));
    } catch (err: any) {
      showToast(err.message || 'Chat stream failed', 'error');
      setMessages(prev => prev.map(msg =>
        msg.id === assistantMsgId
          ? { ...msg, text: msg.text + `\n\n*(Error: ${err.message || 'Failed to stream response'})*`, isStreaming: false }
          : msg
      ));
    } finally {
      setIsChatStreaming(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendChat();
    }
  };

  const renderCleanText = (text: string) => {
    return text
      .replace(/```action_proposal[\s\S]*?```/g, '')
      .replace(/<action_proposal>[\s\S]*?<\/action_proposal>/g, '')
      .trim();
  };

  const getProposal = (m: ChatMessage): ActionProposalData | undefined => {
    if (m.action_proposal) return m.action_proposal;
    const xmlMatch = m.text.match(/<action_proposal>([\s\S]*?)<\/action_proposal>/);
    if (xmlMatch) {
      const block = xmlMatch[1];
      return {
        summary: block.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || 'Proposed Editor Changes',
        prompt_instruction: block.match(/<prompt_instruction>([\s\S]*?)<\/prompt_instruction>/)?.[1]?.trim() || '',
        schema_instruction: block.match(/<schema_instruction>([\s\S]*?)<\/schema_instruction>/)?.[1]?.trim() || ''
      };
    }
    const mdMatch = m.text.match(/```action_proposal\s*([\s\S]*?)\s*```/);
    if (mdMatch) {
      try {
        const data = JSON.parse(mdMatch[1]);
        return { summary: data.summary || 'Proposed Editor Changes', prompt_instruction: data.prompt_instruction || '', schema_instruction: data.schema_instruction || '' };
      } catch (e) {}
    }
    return undefined;
  };

  const SUGGESTION_CHIPS = [
    { label: '📖 Summarize the prompt & schema', text: 'Read the whole prompt and schema. What does this pipeline do, and what are its key constraints?' },
    { label: '🔍 Sample output from schema', text: 'What does sample output look like based on the active schema?' },
    { label: '⚖️ Check for contradictions', text: 'Grep for rules and check if there are any contradictions or gaps.' },
    { label: '🛡️ Find error handling rules', text: 'Grep for error handling and fallback rules in the prompt.' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', borderBottom: '1px solid var(--border-color)',
        background: 'var(--bg-secondary)', flexShrink: 0
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Sparkles size={15} color="var(--accent-primary)" />
          <span style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--text-primary)' }}>Co-Pilot</span>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: 'var(--success)',
            display: 'inline-block'
          }} title="Live Ground Truth Synced" />
        </div>
        <button
          className="icon-btn-small"
          onClick={handleClearChat}
          disabled={messages.length === 0 || isChatStreaming}
          title="Clear chat history"
          style={{ opacity: messages.length === 0 ? 0.4 : 1 }}
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 0 }}>
        {messages.length === 0 ? (
          <div style={{ textAlign: 'center', paddingTop: 32 }}>
            <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
              <Brain size={22} color="var(--accent-primary)" />
            </div>
            <div style={{ fontWeight: 600, fontSize: '0.92rem', marginBottom: 6 }}>Ask anything about your prompt</div>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0 0 20px 0', lineHeight: 1.6 }}>
              I have live access to your active prompt &amp; schema. Ask for summaries, grep for specific rules, or request surgical refactors.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {SUGGESTION_CHIPS.map((chip, i) => (
                <button key={i} className="chip-btn" onClick={() => handleSendChat(chip.text)} style={{ textAlign: 'left' }}>
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map(msg => {
            const proposal = msg.role === 'model' ? getProposal(msg) : undefined;
            const cleanText = renderCleanText(msg.text);
            return (
              <div key={msg.id} className={`chat-message-row ${msg.role}`}>
                <div className={`chat-avatar ${msg.role}`}>
                  {msg.role === 'user' ? <User size={15} /> : <Sparkles size={15} />}
                </div>

                <div className={`chat-bubble ${msg.role}`}>
                  <div className="chat-meta">
                    <span className="sender">{msg.role === 'user' ? 'You' : 'Co-Pilot'}</span>
                    <span className="time">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                  </div>

                  {msg.tool_calls && msg.tool_calls.length > 0 && (() => {
                    const expanded = isToolsExpanded(msg);
                    const stepCount = msg.tool_calls.length;
                    const isWorking = msg.tool_calls.some(tc => tc.status !== 'done');
                    return (
                      <div className="tool-activity">
                        <button
                          type="button"
                          className="tool-activity-toggle"
                          onClick={() => toggleTools(msg.id, expanded)}
                        >
                          <Wrench size={12} />
                          <span>{isWorking ? 'Working…' : `${stepCount} step${stepCount === 1 ? '' : 's'}`}</span>
                          <ChevronDown size={12} className={`tool-activity-chevron${expanded ? ' open' : ''}`} />
                        </button>
                        {expanded && (
                          <div className="tool-activity-list">
                            {msg.tool_calls.map((tc, idx) => (
                              <div key={idx} className="tool-activity-item">
                                {tc.status === 'done'
                                  ? <Check size={11} className="tool-item-done" />
                                  : <Loader2 size={11} className="tool-item-spin" />}
                                <span className="tool-item-text" title={tc.summary}>{tc.summary}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="message-content">
                    {cleanText ? (
                      <MarkdownRenderer content={cleanText} />
                    ) : msg.isStreaming ? (
                      <div className="typing-indicator"><span /><span /><span /></div>
                    ) : null}
                  </div>

                  {proposal && (
                    <div className="action-proposal-card">
                      <div className="proposal-badge"><Sparkles size={12} /><span>Action Proposal</span></div>
                      <div className="proposal-title">{proposal.summary}</div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {proposal.prompt_instruction && (
                          <div className="instruction-preview">
                            <span className="inst-label">Prompt Refactor</span>
                            <span className="inst-text">{proposal.prompt_instruction}</span>
                          </div>
                        )}
                        {proposal.schema_instruction && (
                          <div className="instruction-preview">
                            <span className="inst-label">Schema Refactor</span>
                            <span className="inst-text">{proposal.schema_instruction}</span>
                          </div>
                        )}
                      </div>
                      <button className="btn btn-primary proposal-apply-btn" onClick={() => onApplyProposal(proposal)}>
                        <span>Review &amp; Apply Plan</span>
                        <ArrowRight size={13} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
        <div ref={chatMessagesEndRef} />
      </div>

      {/* Input */}
      <div className="copilot-input-container">
        <div className="copilot-input-card">
          <textarea
            ref={chatInputRef}
            className="copilot-chat-textarea"
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question or describe a change to prompt & schema…"
            rows={2}
            disabled={isChatStreaming}
          />
          <div className="copilot-input-footer">
            <div className="copilot-input-shortcut">
              <kbd>↵ Enter</kbd> to send <span className="shortcut-sep">•</span> <kbd>Shift ↵</kbd> newline
            </div>
            <button
              className="copilot-send-button"
              onClick={() => handleSendChat()}
              disabled={!chatInput.trim() || isChatStreaming}
              title="Send message (Enter)"
            >
              {isChatStreaming ? (
                <Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <Send size={15} />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
