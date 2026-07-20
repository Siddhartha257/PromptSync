import json
import logging
from typing import List

from app.core.llm import LLMCaller
from app.utils.patcher import SearchReplaceEdit
from app.utils.json_patcher import JsonPatchEdit
from app.models.schemas import PromptEditsModel, SchemaEditsModel
from app.prompts.updaters import PROMPT_UPDATER_SYSTEM_PROMPT, SCHEMA_UPDATER_SYSTEM_PROMPT
from app.prompts.creators import PROMPT_CREATOR_SYSTEM_PROMPT_TEMPLATE, PROMPT_CREATOR_BEST_PRACTICES, SCHEMA_CREATOR_SYSTEM_PROMPT

logger = logging.getLogger("agents")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")

class PromptUpdaterAgent:
    def __init__(self, llm_caller: LLMCaller = None):
        self.llm_caller = llm_caller or LLMCaller()

    def generate_edits(self, original_prompt: str, instruction: str) -> List[SearchReplaceEdit]:
        logger.info("PromptUpdaterAgent: Generating prompt edits...")
        input_text = f"ORIGINAL PROMPT:\n{original_prompt}\n\nUPDATE INSTRUCTION:\n{instruction}"
        
        response_text = self.llm_caller.run(
            input_text=input_text,
            system_prompt=PROMPT_UPDATER_SYSTEM_PROMPT,
            json_format=PromptEditsModel
        )
        return self._parse_response(response_text)

    async def generate_edits_async(self, original_prompt: str, instruction: str) -> List[SearchReplaceEdit]:
        logger.info("PromptUpdaterAgent: Generating prompt edits (async)...")
        input_text = f"ORIGINAL PROMPT:\n{original_prompt}\n\nUPDATE INSTRUCTION:\n{instruction}"
        
        response_text = await self.llm_caller.run_async(
            input_text=input_text,
            system_prompt=PROMPT_UPDATER_SYSTEM_PROMPT,
            json_format=PromptEditsModel
        )
        return self._parse_response(response_text)

    def _parse_response(self, response_text: str) -> List[SearchReplaceEdit]:
        try:
            data = json.loads(response_text)
            parsed = PromptEditsModel(**data)
            edits = [SearchReplaceEdit(search=e.search, replace=e.replace) for e in parsed.edits]

            logger.info(f"PromptUpdaterAgent: LLM returned {len(edits)} search/replace edit(s).")
            for i, edit in enumerate(edits, start=1):
                search_preview = edit.search[:120].replace('\n', '↵')
                replace_preview = edit.replace[:120].replace('\n', '↵')
                logger.info(
                    f"  Edit {i}/{len(edits)}:\n"
                    f"    SEARCH  → '{search_preview}{'...' if len(edit.search) > 120 else ''}'\n"
                    f"    REPLACE → '{replace_preview}{'...' if len(edit.replace) > 120 else ''}'"
                )

            return edits
        except Exception as e:
            logger.error(f"Failed to parse Prompt edits: {e}")
            raise e


class SchemaUpdaterAgent:
    def __init__(self, llm_caller: LLMCaller = None):
        self.llm_caller = llm_caller or LLMCaller()

    def generate_edits(self, original_schema: str, instruction: str) -> List[JsonPatchEdit]:
        logger.info("SchemaUpdaterAgent: Generating schema JSON patches...")
        input_text = f"ORIGINAL JSON SCHEMA:\n{original_schema}\n\nUPDATE INSTRUCTION:\n{instruction}"
        
        response_text = self.llm_caller.run(
            input_text=input_text,
            system_prompt=SCHEMA_UPDATER_SYSTEM_PROMPT,
            json_format=SchemaEditsModel
        )
        return self._parse_response(response_text)

    async def generate_edits_async(self, original_schema: str, instruction: str) -> List[JsonPatchEdit]:
        logger.info("SchemaUpdaterAgent: Generating schema JSON patches (async)...")
        input_text = f"ORIGINAL JSON SCHEMA:\n{original_schema}\n\nUPDATE INSTRUCTION:\n{instruction}"
        
        response_text = await self.llm_caller.run_async(
            input_text=input_text,
            system_prompt=SCHEMA_UPDATER_SYSTEM_PROMPT,
            json_format=SchemaEditsModel
        )
        return self._parse_response(response_text)

    def _parse_response(self, response_text: str) -> List[JsonPatchEdit]:
        try:
            data = json.loads(response_text)
            parsed = SchemaEditsModel(**data)
            patches = [JsonPatchEdit(op=e.op, path=e.path, value=e.value) for e in parsed.edits]

            logger.info(f"SchemaUpdaterAgent: LLM returned {len(patches)} JSON patch operation(s).")
            for i, patch in enumerate(patches, start=1):
                value_preview = str(patch.value)[:80].replace('\n', '↵') if patch.value is not None else 'N/A'
                logger.info(
                    f"  Patch {i}/{len(patches)}: op='{patch.op}' path='{patch.path}' value='{value_preview}'"
                )

            return patches
        except Exception as e:
            logger.error(f"Failed to parse Schema patches: {e}")
            raise e


class PromptCreatorAgent:
    def __init__(self, llm_caller: LLMCaller = None):
        self.llm_caller = llm_caller or LLMCaller()

    def generate_stream(self, instruction: str, target_model: str):
        logger.info(f"PromptCreatorAgent: Generating prompt from scratch for {target_model}...")
        
        best_practices = PROMPT_CREATOR_BEST_PRACTICES.get(target_model.lower(), PROMPT_CREATOR_BEST_PRACTICES["gpt"])
        system_prompt = PROMPT_CREATOR_SYSTEM_PROMPT_TEMPLATE.format(best_practices=best_practices)

        return self.llm_caller.run_stream(
            input_text=f"INSTRUCTION:\n{instruction}",
            system_prompt=system_prompt
        )


class SchemaCreatorAgent:
    def __init__(self, llm_caller: LLMCaller = None):
        self.llm_caller = llm_caller or LLMCaller()

    def generate_stream(self, instruction: str):
        logger.info("SchemaCreatorAgent: Generating schema from scratch...")
        
        return self.llm_caller.run_stream(
            input_text=f"INSTRUCTION:\n{instruction}",
            system_prompt=SCHEMA_CREATOR_SYSTEM_PROMPT
        )
