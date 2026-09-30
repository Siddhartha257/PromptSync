import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
}

export default function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  if (!content) return null;

  // Split content by fenced code blocks (supporting unclosed blocks during streaming)
  const segments: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
  const codeBlockRegex = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)(?:```|$)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: 'text',
        content: content.substring(lastIndex, match.index)
      });
    }

    segments.push({
      type: 'code',
      language: match[1] || 'text',
      content: match[2]
    });

    lastIndex = codeBlockRegex.lastIndex;
    if (lastIndex === 0) break; // Avoid infinite loop on empty matches
  }

  if (lastIndex < content.length) {
    segments.push({
      type: 'text',
      content: content.substring(lastIndex)
    });
  }

  return (
    <div className="markdown-renderer">
      {segments.map((seg, idx) => {
        if (seg.type === 'code') {
          return (
            <CodeBlockItem
              key={idx}
              code={seg.content}
              language={seg.language || 'text'}
            />
          );
        }
        return <TextSegmentItem key={idx} text={seg.content} />;
      })}
      {isStreaming && <span className="streaming-cursor" />}
    </div>
  );
}

function CodeBlockItem({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="md-code-container">
      <div className="md-code-header">
        <span className="md-code-lang">{language.toUpperCase()}</span>
        <button className="md-copy-btn" onClick={handleCopy} title="Copy code">
          {copied ? <Check size={13} color="var(--success)" /> : <Copy size={13} />}
          <span>{copied ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>
      <pre className="md-code-pre">
        <code>{code}</code>
      </pre>
    </div>
  );
}

// Renders a single list item, recognizing GFM task-list syntax ("[x] "/"[ ] ") so
// checklists (used by the Optimization Lab report) show real checkboxes, not raw brackets.
function ListItemContent({ item }: { item: string }) {
  const taskMatch = item.match(/^\[([ xX])\]\s*(.*)$/);
  if (taskMatch) {
    const checked = taskMatch[1].toLowerCase() === 'x';
    return (
      <span className="md-task-item">
        <span className={`md-checkbox${checked ? ' checked' : ''}`}>{checked ? '✓' : ''}</span>
        <span className={checked ? 'md-task-done' : undefined}>{parseInlineMarkdown(taskMatch[2])}</span>
      </span>
    );
  }
  return <>{parseInlineMarkdown(item)}</>;
}

// Parses a GFM-style pipe table: a header row, a "|---|---|" separator row, then body rows.
function TableItem({ header, aligns, rows }: { header: string[]; aligns: Array<'left' | 'center' | 'right'>; rows: string[][] }) {
  return (
    <div className="md-table-wrap">
      <table className="md-table">
        <thead>
          <tr>
            {header.map((h, i) => (
              <th key={i} style={{ textAlign: aligns[i] || 'left' }}>{parseInlineMarkdown(h.trim())}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rIdx) => (
            <tr key={rIdx}>
              {row.map((cell, cIdx) => (
                <td key={cIdx} style={{ textAlign: aligns[cIdx] || 'left' }}>{parseInlineMarkdown(cell.trim())}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|');
}

const TABLE_SEPARATOR_RE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/;

function TextSegmentItem({ text }: { text: string }) {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];
  let currentList: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushList = () => {
    if (!currentList) return;
    const list = currentList;
    if (list.type === 'ul') {
      elements.push(
        <ul key={`ul-${elements.length}`} className="md-list">
          {list.items.map((item, i) => (
            <li key={i}><ListItemContent item={item} /></li>
          ))}
        </ul>
      );
    } else {
      elements.push(
        <ol key={`ol-${elements.length}`} className="md-list ordered">
          {list.items.map((item, i) => (
            <li key={i}><ListItemContent item={item} /></li>
          ))}
        </ol>
      );
    }
    currentList = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line
    if (!trimmed) {
      flushList();
      i++;
      continue;
    }

    // GFM table: a "| ... |" row immediately followed by a "|---|:---:|" separator row.
    if (trimmed.startsWith('|') && trimmed.endsWith('|') && i + 1 < lines.length && TABLE_SEPARATOR_RE.test(lines[i + 1])) {
      flushList();
      const header = splitTableRow(lines[i]);
      const aligns = splitTableRow(lines[i + 1]).map((cell): 'left' | 'center' | 'right' => {
        const c = cell.trim();
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
      });
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && lines[j].trim().startsWith('|') && lines[j].trim().endsWith('|')) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      elements.push(<TableItem key={`table-${elements.length}`} header={header} aligns={aligns} rows={rows} />);
      i = j;
      continue;
    }

    // Headers
    if (trimmed.startsWith('### ')) {
      flushList();
      elements.push(<h4 key={i} className="md-h4">{parseInlineMarkdown(trimmed.substring(4))}</h4>);
      i++;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      flushList();
      elements.push(<h3 key={i} className="md-h3">{parseInlineMarkdown(trimmed.substring(3))}</h3>);
      i++;
      continue;
    }
    if (trimmed.startsWith('# ')) {
      flushList();
      elements.push(<h2 key={i} className="md-h2">{parseInlineMarkdown(trimmed.substring(2))}</h2>);
      i++;
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('> ')) {
      flushList();
      elements.push(
        <blockquote key={i} className="md-blockquote">
          {parseInlineMarkdown(trimmed.substring(2))}
        </blockquote>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(---+|\*\*\*+|___+)$/.test(trimmed)) {
      flushList();
      elements.push(<hr key={i} className="md-hr" />);
      i++;
      continue;
    }

    // Unordered list (- or *), including "- [x] " / "- [ ] " task items
    const ulMatch = line.match(/^(\s*)[-*]\s+(.*)$/);
    if (ulMatch) {
      if (!currentList || currentList.type !== 'ul') {
        flushList();
        currentList = { type: 'ul', items: [] };
      }
      currentList.items.push(ulMatch[2]);
      i++;
      continue;
    }

    // Ordered list (1. 2.)
    const olMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (olMatch) {
      if (!currentList || currentList.type !== 'ol') {
        flushList();
        currentList = { type: 'ol', items: [] };
      }
      currentList.items.push(olMatch[2]);
      i++;
      continue;
    }

    // Normal paragraph line
    flushList();
    elements.push(
      <p key={i} className="md-p">
        {parseInlineMarkdown(line)}
      </p>
    );
    i++;
  }

  flushList();

  return <>{elements}</>;
}

// Inline formatting: **bold**, *italic*, `code`
function parseInlineMarkdown(text: string): React.ReactNode {
  // Tokenize by inline code first (`...`), then bold (**...**), then italic (*...*)
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;

  let lastIdx = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.substring(lastIdx, match.index));
    }

    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code key={match.index} className="md-inline-code">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={match.index} className="md-bold">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={match.index} className="md-italic">
          {token.slice(1, -1)}
        </em>
      );
    }

    lastIdx = regex.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push(text.substring(lastIdx));
  }

  return parts.length > 0 ? parts : text;
}
