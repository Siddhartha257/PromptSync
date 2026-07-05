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
        patch_margin: int = 4,
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
        patches = self.dmp.patch_make(edit.search, edit.replace)
        patch_text = self.dmp.patch_toText(patches)

        if self.debug:
            logger.info(f"Generated Patch:\n{patch_text}")

        updated_text, applied_flags = self.dmp.patch_apply(patches, full_text)
        success = all(applied_flags)

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

        if self.debug:
            logger.info(f"Starting Text Edit Session with {len(edits)} edits.")

        for index, edit in enumerate(edits, start=1):
            if self.debug:
                logger.info(f"--- Applying Edit {index}/{len(edits)} ---")
            
            result = self._apply_single_edit(current_text, edit)
            results.append(result)

            if not result.success:
                logger.error(f"Text Edit {index} FAILED.")
            
            current_text = result.updated_text

        # Compute final UI diff
        changes = self.dmp.diff_main(original_text, current_text)
        self.dmp.diff_cleanupSemantic(changes)

        if self.debug:
            logger.info("=== FINAL DIFF ===")
            for op, text in changes:
                tag = "DELETE" if op == -1 else "INSERT" if op == 1 else "EQUAL "
                logger.info(f"{tag:<8} {repr(text)}")

        return ApplyEditsResult(
            old_text=original_text,
            updated_text=current_text,
            changes=changes,
            success=all(r.success for r in results),
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