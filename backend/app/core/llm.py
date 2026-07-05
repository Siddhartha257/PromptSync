import logging
import time
from typing import Type
from pydantic import BaseModel
from google import genai
from google.genai import types
from dotenv import load_dotenv

# Setup Logging
logger = logging.getLogger("llm_caller")
if not logger.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s | %(name)s | %(message)s",
    )

load_dotenv()

class LLMCaller:
    def __init__(self, model_name: str = "gemini-3.1-flash-lite", max_retries: int = 3, retry_delay: float = 2.0):
        # Switching default model to standard stable model just in case, but can be overridden
        self.client = genai.Client()
        self.model_name = model_name
        self.max_retries = max_retries
        self.retry_delay = retry_delay

    def run(self, input_text: str, system_prompt: str, json_format: Type[BaseModel]) -> str:
        for attempt in range(1, self.max_retries + 1):
            try:
                logger.info(f"Calling LLM ({self.model_name}) - Attempt {attempt}/{self.max_retries}")
                
                # Using the modern generate_content API
                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=input_text,
                    config=types.GenerateContentConfig(
                        system_instruction=system_prompt,
                        response_mime_type="application/json",
                        response_schema=json_format
                    )
                )
                logger.info("LLM call successful.")
                return response.text
            except Exception as e:
                logger.error(f"LLM call failed on attempt {attempt}: {e}")
                if attempt < self.max_retries:
                    logger.info(f"Retrying in {self.retry_delay} seconds...")
                    time.sleep(self.retry_delay)
                else:
                    raise

    def run_stream(self, input_text: str, system_prompt: str, json_format: Type[BaseModel] = None):
        """Yields text chunks for streaming."""
        logger.info(f"Starting LLM stream ({self.model_name})")
        config = types.GenerateContentConfig(
            system_instruction=system_prompt,
        )
        if json_format:
            config.response_mime_type = "application/json"
            config.response_schema = json_format

        try:
            response = self.client.models.generate_content_stream(
                model=self.model_name,
                contents=input_text,
                config=config
            )
            for chunk in response:
                yield chunk.text
        except Exception as e:
            logger.error(f"Streaming failed: {e}")
            raise e