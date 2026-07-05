import json
import logging
from app.core.llm import LLMCaller
from app.models.schemas import VerificationResultModel
from app.prompts.verifier import VERIFICATION_SYSTEM_PROMPT, OUTPUT_VERIFICATION_SYSTEM_PROMPT

logger = logging.getLogger("agents")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")

class VerificationAgent:
    def __init__(self, llm_caller: LLMCaller = None):
        self.llm_caller = llm_caller or LLMCaller()

    def verify_alignment(self, prompt_instruction: str, schema_instruction: str) -> dict:
        logger.info("VerificationAgent: Verifying alignment...")
        input_text = f"PROMPT INSTRUCTION:\n{prompt_instruction}\n\nSCHEMA INSTRUCTION:\n{schema_instruction}"
        
        response_text = self.llm_caller.run(
            input_text=input_text,
            system_prompt=VERIFICATION_SYSTEM_PROMPT,
            json_format=VerificationResultModel
        )
        
        try:
            return json.loads(response_text)
        except Exception as e:
            logger.error(f"Failed to parse Verification result: {e}")
            raise e

    def verify_outputs(self, prompt: str, schema: str) -> dict:
        logger.info("VerificationAgent: Verifying final outputs...")
        input_text = f"RAW SYSTEM PROMPT:\n{prompt}\n\nRAW JSON SCHEMA:\n{schema}"
        
        response_text = self.llm_caller.run(
            input_text=input_text,
            system_prompt=OUTPUT_VERIFICATION_SYSTEM_PROMPT,
            json_format=VerificationResultModel
        )
        
        try:
            return json.loads(response_text)
        except Exception as e:
            logger.error(f"Failed to parse Output Verification result: {e}")
            raise e
