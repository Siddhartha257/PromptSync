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
        
        try:
            data = json.loads(response_text)
            parsed = PromptEditsModel(**data)
            return [SearchReplaceEdit(search=e.search, replace=e.replace) for e in parsed.edits]
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
        
        try:
            data = json.loads(response_text)
            parsed = SchemaEditsModel(**data)
            return [JsonPatchEdit(op=e.op, path=e.path, value=e.value) for e in parsed.edits]
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
