import React, { useState, useEffect } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { generateTypeScript, generatePydantic } from '../utils/codeGenerator';
import { X, Copy, CheckCircle } from 'lucide-react';
import { useToast } from '../context/ToastContext';
import CustomSelect from './CustomSelect';

interface ExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  schemaStr: string;
  theme: string;
}

export default function ExportModal({ isOpen, onClose, schemaStr, theme }: ExportModalProps) {
  const [tsCode, setTsCode] = useState('');
  const [pyCode, setPyCode] = useState('');
  const [activeLang, setActiveLang] = useState('ts');
  const [copied, setCopied] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (isOpen) {
      setTsCode(generateTypeScript(schemaStr));
      setPyCode(generatePydantic(schemaStr));
      setCopied(false);
    }
  }, [isOpen, schemaStr]);

  const handleCopy = () => {
    const textToCopy = activeLang === 'ts' ? tsCode : pyCode;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    showToast(`Copied ${activeLang === 'ts' ? 'TypeScript' : 'Python'} code!`, 'success');
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay">
      <div className="modal-content glass-modal" style={{ maxWidth: '90%', width: '1400px', height: '88vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        
        {/* ── HEADER ── */}
        <div className="modal-header" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          <div>
            <h2>Export Code</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.8rem', marginTop: 3 }}>
              Ready-to-use models generated directly from your JSON Schema.
            </p>
          </div>
          <button className="btn btn-outline" onClick={onClose} style={{ padding: '8px' }}>
            <X size={20} />
          </button>
        </div>

        {/* ── CONFIG TOOLBAR ── */}
        <div className="toolbar" style={{ borderBottom: '1px solid var(--border-color)', paddingBottom: '16px', marginBottom: 0 }}>
          <div className="toolbar-group">
            <span className="toolbar-label">Language</span>
            <CustomSelect 
              value={activeLang} 
              onChange={setActiveLang}
              options={[
                { value: 'ts', label: 'TypeScript Interface' },
                { value: 'py', label: 'Python Pydantic' }
              ]}
              style={{ minWidth: 220 }}
            />
          </div>
          <div style={{ flex: 1 }} />
          <button 
            className="btn btn-primary" 
            onClick={handleCopy}
            style={{ padding: '8px 16px' }}
          >
            {copied ? <CheckCircle size={15} /> : <Copy size={15} />}
            {copied ? 'Copied' : 'Copy Code'}
          </button>
        </div>

        {/* ── EDITOR BODY ── */}
        <div className="modal-body" style={{ padding: 0, overflow: 'hidden', flex: 1, display: 'flex' }}>
          <div className="editor-container" style={{ flex: 1, overflow: 'auto', display: 'flex', border: 'none', padding: 0, minHeight: 0 }}>
            <CodeMirror
              value={activeLang === 'ts' ? tsCode : pyCode}
              height="100%"
              extensions={activeLang === 'ts' ? [javascript({ typescript: true })] : [python()]}
              theme={theme === 'dark' ? 'dark' : 'light'}
              editable={false}
              style={{ flex: 1, fontSize: '0.85rem' }}
            />
          </div>
        </div>

      </div>
    </div>
  );
}
