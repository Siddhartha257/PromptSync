import re
import logging
from typing import Literal, List, Dict, Any, Optional

logger = logging.getLogger("grep_tool")

def grep_text_lines(
    text: str,
    query: str,
    doc_name: str,
    case_sensitive: bool = False,
    context_lines: int = 2,
    max_results: int = 15
) -> List[Dict[str, Any]]:
    if not text or not query:
        return []
    
    # Try regex first, fall back to literal escape if regex is invalid
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        pattern = re.compile(query, flags)
    except re.error:
        pattern = re.compile(re.escape(query), flags)

    lines = text.splitlines()
    matches = []

    for idx, line in enumerate(lines):
        if pattern.search(line):
            line_no = idx + 1
            start_idx = max(0, idx - context_lines)
            end_idx = min(len(lines), idx + context_lines + 1)
            
            context_snippet = []
            for c_idx in range(start_idx, end_idx):
                c_line_no = c_idx + 1
                prefix = ">" if c_line_no == line_no else " "
                context_snippet.append(f"{c_line_no:4d} {prefix} {lines[c_idx]}")
            
            matches.append({
                "doc": doc_name,
                "line": line_no,
                "matched_text": line.strip(),
                "context": "\n".join(context_snippet)
            })

            if len(matches) >= max_results:
                break

    return matches


def grep_documents(
    query: str,
    prompt_text: str,
    schema_text: str,
    target: Literal["both", "prompt", "schema"] = "both",
    case_sensitive: bool = False,
    max_results: int = 15
) -> str:
    """Searches the active Prompt and/or JSON Schema for matching keywords or regex patterns.
    Returns matching line numbers and surrounding context."""
    results = []

    if target in ("both", "prompt") and prompt_text:
        prompt_matches = grep_text_lines(
            text=prompt_text,
            query=query,
            doc_name="PROMPT",
            case_sensitive=case_sensitive,
            max_results=max_results
        )
        results.extend(prompt_matches)

    remaining = max_results - len(results)
    if target in ("both", "schema") and schema_text and remaining > 0:
        schema_matches = grep_text_lines(
            text=schema_text,
            query=query,
            doc_name="JSON SCHEMA",
            case_sensitive=case_sensitive,
            max_results=remaining
        )
        results.extend(schema_matches)

    if not results:
        return f"No matches found for query '{query}' in {target}."

    formatted_output = [f"Found {len(results)} match(es) for query '{query}':\n"]
    for m in results:
        formatted_output.append(f"[{m['doc']} - Line {m['line']}]")
        formatted_output.append(m['context'])
        formatted_output.append("-" * 40)

    return "\n".join(formatted_output)


def format_document_slice(
    lines: List[str],
    doc_name: str,
    start_line: Optional[int],
    end_line: Optional[int]
) -> str:
    total_lines = len(lines)
    if total_lines == 0:
        return f"=== {doc_name} (Empty) ==="

    req_start = max(1, start_line or 1)
    req_end = min(total_lines, end_line or total_lines)

    # If small range (<= 5 lines) or single line, provide 2 lines of surrounding context
    is_narrow_query = (req_end - req_start) <= 4
    if is_narrow_query:
        view_start = max(1, req_start - 2)
        view_end = min(total_lines, req_end + 2)
    else:
        view_start = req_start
        view_end = req_end

    header = f"=== {doc_name} (Lines {view_start}-{view_end} of {total_lines})"
    if is_narrow_query and (view_start != req_start or view_end != req_end):
        header += f" [Target: {req_start}-{req_end}]"
    header += " ==="

    out = [header]
    for idx in range(view_start - 1, view_end):
        line_no = idx + 1
        is_target = req_start <= line_no <= req_end
        prefix = ">" if is_target else " "
        line_text = lines[idx]

        if not line_text.strip():
            display_text = "[EMPTY LINE]"
        else:
            display_text = line_text

        out.append(f"{line_no:4d} {prefix} {display_text}")

    return "\n".join(out)


def read_document(
    target: Literal["both", "prompt", "schema"],
    prompt_text: str,
    schema_text: str,
    start_line: Optional[int] = None,
    end_line: Optional[int] = None
) -> str:
    """Reads the full document or a specific line range from the active Prompt or Schema.
    Automatically formats blank lines as [EMPTY LINE] and provides context for small line queries."""
    output = []

    if target in ("both", "prompt"):
        lines = prompt_text.splitlines()
        output.append(format_document_slice(lines, "SYSTEM PROMPT", start_line, end_line))

    if target in ("both", "schema"):
        lines = schema_text.splitlines()
        output.append(format_document_slice(lines, "JSON SCHEMA", start_line, end_line))

    return "\n\n".join(output)


