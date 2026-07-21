import logging
from dataclasses import dataclass
from typing import List, Tuple
from diff_match_patch import diff_match_patch

logger = logging.getLogger("patcher")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")


@dataclass
class SearchReplaceEdit:
    search: str
    replace: str


@dataclass
class SingleEditResult:
    success: bool
    updated_text: str
    patch_text: str
    applied_flags: List[bool]


@dataclass
class ApplyEditsResult:
    old_text: str
    updated_text: str
    changes: List[Tuple[int, str]]
    success: bool
    edit_results: List[SingleEditResult]


class TextPatcher:
    """Handles text diffing and patching using diff_match_patch."""
    
    def __init__(
        self,
        match_threshold: float = 0.4,
        match_distance: int = 10**9,
        patch_margin: int = 32,
        delete_threshold: float = 0.5,
        debug: bool = False
    ):
        self.dmp = diff_match_patch()
        self.dmp.Match_Threshold = match_threshold
        self.dmp.Match_Distance = match_distance
        self.dmp.Patch_Margin = patch_margin
        self.dmp.Patch_DeleteThreshold = delete_threshold
        self.debug = debug

    def _apply_single_edit(self, full_text: str, edit: SearchReplaceEdit) -> SingleEditResult:
        # Normalize newlines to prevent \r\n vs \n mismatches
        norm_full = full_text.replace('\r\n', '\n')
        norm_search = edit.search.replace('\r\n', '\n')
        norm_replace = edit.replace.replace('\r\n', '\n')

        # 1. Fast Path: Exact Match (Highly reliable, bypasses fuzzy chunking bugs)
        if norm_search in norm_full:
            if self.debug:
                logger.info("Exact match found. Bypassing fuzzy patcher.")
            updated_text = norm_full.replace(norm_search, norm_replace, 1)
            return SingleEditResult(
                success=True,
                updated_text=updated_text,
                patch_text="[Exact Match Replace]",
                applied_flags=[True]
            )

        # 2. Relaxed Path: Stripped Exact Match (Ignores LLM trailing/leading whitespace hallucinations)
        stripped_search = norm_search.strip()
        if stripped_search and stripped_search in norm_full:
            if self.debug:
                logger.info("Stripped exact match found. LLM hallucinated edge whitespace.")
            updated_text = norm_full.replace(stripped_search, norm_replace.strip(), 1)
            return SingleEditResult(
                success=True,
                updated_text=updated_text,
                patch_text="[Stripped Exact Match Replace]",
                applied_flags=[True]
            )

        # 3. Line-by-Line Fuzzy Match (Ignores all indentation and intermediate blank lines)
        search_lines = [line.strip() for line in norm_search.splitlines() if line.strip()]
        full_lines = norm_full.splitlines()
        
        if search_lines:
            match_start_idx = -1
            match_end_idx = -1
            
            for i in range(len(full_lines)):
                if full_lines[i].strip() == search_lines[0]:
                    current_search_idx = 0
                    current_full_idx = i
                    
                    while current_search_idx < len(search_lines) and current_full_idx < len(full_lines):
                        if full_lines[current_full_idx].strip() == search_lines[current_search_idx]:
                            current_search_idx += 1
                        elif full_lines[current_full_idx].strip() == "":
                            # Ignore empty lines in full text during matching
                            pass
                        else:
                            break
                        current_full_idx += 1
                        
                    if current_search_idx == len(search_lines):
                        match_start_idx = i
                        match_end_idx = current_full_idx
                        break
                        
            if match_start_idx != -1:
                if self.debug:
                    logger.info("Line-by-line fuzzy match found. Bypassing DMP.")
                
                before_text = "\n".join(full_lines[:match_start_idx])
                after_text = "\n".join(full_lines[match_end_idx:])
                
                if before_text and not before_text.endswith("\n"): before_text += "\n"
                if after_text and not after_text.startswith("\n"): after_text = "\n" + after_text
                
                updated_text = before_text + norm_replace + after_text
                return SingleEditResult(
                    success=True,
                    updated_text=updated_text,
                    patch_text="[Line-by-Line Fuzzy Replace]",
                    applied_flags=[True]
                )

        # 4. Fallback: Fuzzy Patch Match using DMP
        patches = self.dmp.patch_make(norm_search, norm_replace)
        patch_text = self.dmp.patch_toText(patches)

        if self.debug:
            logger.info(f"Generated Patch:\n{patch_text}")

        updated_text, applied_flags = self.dmp.patch_apply(patches, norm_full)
        success = all(applied_flags) and len(applied_flags) > 0

        if self.debug:
            logger.info(f"Applied Flags: {applied_flags} | Success: {success}")

        return SingleEditResult(
            success=success,
            updated_text=updated_text,
            patch_text=patch_text,
            applied_flags=applied_flags,
        )

    def apply_edits(self, original_text: str, edits: List[SearchReplaceEdit]) -> ApplyEditsResult:
        """Applies multiple search/replace edits sequentially and computes a final diff."""
        current_text = original_text
        results: List[SingleEditResult] = []
        failed_edits: List[Tuple[int, str]] = []  # (index, search_preview)

        if self.debug:
            logger.info(f"Starting Text Edit Session with {len(edits)} edits.")

        for index, edit in enumerate(edits, start=1):
            if self.debug:
                logger.info(f"--- Applying Edit {index}/{len(edits)} ---")
                
            result = self._apply_single_edit(current_text, edit)
            results.append(result)

            if not result.success:
                search_preview = edit.search[:120].replace('\n', '↵')
                logger.warning(f"  ❌ Edit {index}/{len(edits)} failed. Search string not found in original.")
                failed_edits.append((index, search_preview))
            else:
                logger.info(f"  ✅ Edit {index}/{len(edits)} applied successfully using {result.patch_text}")
                current_text = result.updated_text

        # Compute final UI diff
        changes = self.dmp.diff_main(original_text, current_text)
        self.dmp.diff_cleanupSemantic(changes)

        if self.debug:
            logger.info("=== FINAL DIFF ===")
            for op, text in changes:
                tag = "DELETE" if op == -1 else "INSERT" if op == 1 else "EQUAL "
                logger.info(f"{tag:<8} {repr(text)}")

        overall_success = len(failed_edits) == 0

        if not overall_success:
            failed_summary = "; ".join(
                [f"Edit {i}: could not locate '{s[:60]}...'" for i, s in failed_edits]
            )
            logger.warning(f"Patch session completed with {len(failed_edits)} failed edit(s): {failed_summary}")

        return ApplyEditsResult(
            old_text=original_text,
            updated_text=current_text,
            changes=changes,
            success=overall_success,
            edit_results=results,
        )

# Maintain backwards compatibility function wrapper for existing code
def apply_llm_edits(
    full_text: str,
    edits: List[SearchReplaceEdit],
    debug: bool = False,
    **kwargs
) -> ApplyEditsResult:
    patcher = TextPatcher(debug=debug, **kwargs)
    return patcher.apply_edits(full_text, edits)