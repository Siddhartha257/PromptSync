import json
import logging
import copy
from dataclasses import dataclass
from typing import Any, List, Dict, Optional
import jsonpatch

logger = logging.getLogger("schema_patch")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")


@dataclass
class JsonPatchEdit:
    op: str              # add | remove | replace | move | copy | test
    path: str           # JSON Pointer (e.g. /properties/age)
    value: Any = None   # optional (required for add/replace/copy)


@dataclass
class PatchResult:
    success: bool
    original_schema: dict
    updated_schema: dict
    applied_patch: List[dict]
    error: Optional[str] = None


class JsonSchemaPatchEngine:
    """Engine to safely apply RFC 6902 JSON patches to a JSON schema dictionary."""
    
    def __init__(self, debug: bool = False):
        self.debug = debug

    def _validate_patch(self, edits: List[JsonPatchEdit]) -> List[dict]:
        """Validates and converts JsonPatchEdit objects into standard dict operations."""
        patch_ops = []
        valid_ops = {"add", "remove", "replace", "move", "copy", "test"}
        
        for i, edit in enumerate(edits):
            if edit.op not in valid_ops:
                raise ValueError(f"Invalid operation '{edit.op}' at index {i}.")

            op_dict = {
                "op": edit.op,
                "path": edit.path,
            }

            if edit.op in {"add", "replace", "copy", "test"}:
                op_dict["value"] = edit.value

            patch_ops.append(op_dict)

        return patch_ops

    def apply(self, schema: Dict[str, Any], edits: List[JsonPatchEdit], dry_run: bool = False) -> PatchResult:
        """Applies a list of JSON patches to the schema."""
        original = copy.deepcopy(schema)

        try:
            patch_ops = self._validate_patch(edits)

            if self.debug:
                logger.info(f"Starting JSON Schema Patch with {len(patch_ops)} operations.")
                for op in patch_ops:
                    logger.info(f"OP: {op}")

            patch = jsonpatch.JsonPatch(patch_ops)

            if dry_run:
                if self.debug:
                    logger.info("Dry run enabled - no changes applied.")
                return PatchResult(
                    success=True,
                    original_schema=original,
                    updated_schema=original,
                    applied_patch=patch_ops,
                )

            updated = patch.apply(original, in_place=False)

            if self.debug:
                logger.info("JSON Schema Patch applied successfully.")

            return PatchResult(
                success=True,
                original_schema=original,
                updated_schema=updated,
                applied_patch=patch_ops,
            )

        except Exception as e:
            if self.debug:
                logger.error(f"JSON Patch FAILED: {str(e)}")

            return PatchResult(
                success=False,
                original_schema=original,
                updated_schema=original,
                applied_patch=[],
                error=str(e),
            )