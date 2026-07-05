import json
import logging
from app.core.llm import LLMCaller
from app.models.schemas import Schema
from app.prompts.orchestrator import ORCHESTRATOR_SYSTEM_PROMPT

logger = logging.getLogger("orch")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")

class Orch:
    def __init__(self, llm_caller: LLMCaller = None):
        self.llm_caller = llm_caller or LLMCaller()
        
    def run(self, prompt: str, json_schema: str, user_request: str) -> Schema:
        logger.info("Orchestrating instructions for Prompt and JSON Schema update.")
        knowledge_base = f"""
# prompt :
{prompt}

# json schema :
{json_schema}

<user_request>
{user_request}
</user_request>
"""
        response_text = self.llm_caller.run(
            input_text=knowledge_base,
            system_prompt=ORCHESTRATOR_SYSTEM_PROMPT,
            json_format=Schema
        )
        
        try:
            data = json.loads(response_text)
            return Schema(**data)
        except json.JSONDecodeError as e:
            logger.error(f"Failed to parse JSON response from LLM: {response_text}")
            raise e
