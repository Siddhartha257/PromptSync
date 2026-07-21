import logging
import time
import asyncio
from typing import Type, Optional
from pydantic import BaseModel
from google import genai
from google.genai import types

# Setup Logging
logger = logging.getLogger("llm_caller")
if not logger.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s | %(name)s | %(message)s",
    )

class LLMCaller:
    def __init__(self, api_key: str, model_name: str = "gemini-3.1-flash-lite", thinking_level: str = "Low", temperature: float = 0.7, max_retries: int = 3, retry_delay: float = 2.0, fallback_model: str = "gemini-3.1-flash-lite"):
        self.client = genai.Client(api_key=api_key)
        self.model_name = model_name
        self.thinking_level = thinking_level
        self.temperature = temperature
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.fallback_model = fallback_model

    def _get_thinking_config(self) -> Optional[types.ThinkingConfig]:
        if self.thinking_level == "None":
            return None
            
        if "gemma" in self.model_name.lower():
            # Newer Gemma models use `include_thoughts` boolean instead of token budgets
            return types.ThinkingConfig(include_thoughts=True)

        if self.thinking_level == "Low":
            return types.ThinkingConfig(thinking_budget=1024)
        elif self.thinking_level == "Medium":
            return types.ThinkingConfig(thinking_budget=4096)
        elif self.thinking_level == "High":
            return types.ThinkingConfig(thinking_budget=8192)
            
        return None

    def run(self, input_text: str, system_prompt: str, json_format: Type[BaseModel] | dict) -> str:
        for attempt in range(1, self.max_retries + 1):
            try:
                logger.info(f"Calling LLM ({self.model_name}) - Attempt {attempt}/{self.max_retries}")
                
                config = types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type="application/json",
                    response_schema=json_format,
                    temperature=self.temperature
                )
                
                thinking = self._get_thinking_config()
                if thinking:
                    config.thinking_config = thinking

                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=input_text,
                    config=config
                )
                logger.info("LLM call successful.")
                return response.text
            except Exception as e:
                err_str = str(e)
                logger.error(f"LLM call failed on attempt {attempt}: {err_str}")
                
                # Fail-fast on 429 Quota/Rate Limit or 503 Overloaded and switch to fallback
                if "429" in err_str or "503" in err_str:
                    if self.model_name != self.fallback_model:
                        logger.warning(f"Model overloaded. Falling back instantly from {self.model_name} to {self.fallback_model}")
                        self.model_name = self.fallback_model
                        continue # Retry immediately with fallback model
                
                if attempt < self.max_retries:
                    logger.info(f"Retrying in {self.retry_delay} seconds...")
                    time.sleep(self.retry_delay)
                else:
                    raise

    def run_freeform(self, input_text: str, system_prompt: str) -> str:
        """Run the LLM without any response schema enforcement — returns raw text."""
        for attempt in range(1, self.max_retries + 1):
            try:
                logger.info(f"Calling LLM freeform ({self.model_name}) - Attempt {attempt}/{self.max_retries}")

                config = types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    temperature=self.temperature
                )

                thinking = self._get_thinking_config()
                if thinking:
                    config.thinking_config = thinking

                response = self.client.models.generate_content(
                    model=self.model_name,
                    contents=input_text,
                    config=config
                )
                logger.info("LLM freeform call successful.")
                return response.text
            except Exception as e:
                err_str = str(e)
                logger.error(f"LLM freeform call failed on attempt {attempt}: {err_str}")
                
                if "429" in err_str or "503" in err_str:
                    if self.model_name != self.fallback_model:
                        logger.warning(f"Model overloaded. Falling back instantly from {self.model_name} to {self.fallback_model}")
                        self.model_name = self.fallback_model
                        continue
                
                if attempt < self.max_retries:
                    logger.info(f"Retrying in {self.retry_delay} seconds...")
                    time.sleep(self.retry_delay)
                else:
                    raise

    async def run_async(self, input_text: str, system_prompt: str, json_format: Type[BaseModel] | dict) -> str:
        for attempt in range(1, self.max_retries + 1):
            try:
                logger.info(f"Calling LLM async ({self.model_name}) - Attempt {attempt}/{self.max_retries}")
                
                config = types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type="application/json",
                    response_schema=json_format,
                    temperature=self.temperature
                )
                
                thinking = self._get_thinking_config()
                if thinking:
                    config.thinking_config = thinking

                response = await self.client.aio.models.generate_content(
                    model=self.model_name,
                    contents=input_text,
                    config=config
                )
                logger.info("LLM async call successful.")
                return response.text
            except Exception as e:
                err_str = str(e)
                logger.error(f"LLM async call failed on attempt {attempt}: {err_str}")
                
                if "429" in err_str or "503" in err_str:
                    if self.model_name != self.fallback_model:
                        logger.warning(f"Model overloaded. Falling back instantly from {self.model_name} to {self.fallback_model}")
                        self.model_name = self.fallback_model
                        continue
                
                if attempt < self.max_retries:
                    logger.info(f"Retrying async in {self.retry_delay} seconds...")
                    await asyncio.sleep(self.retry_delay)
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

        thinking = self._get_thinking_config()
        if thinking:
            config.thinking_config = thinking

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