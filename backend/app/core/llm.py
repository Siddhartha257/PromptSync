import logging
import time
import asyncio
import json
import json_repair
from typing import Type, Optional, List, Any, Union, Dict, Sequence, Callable, AsyncIterator, Literal
from pydantic import BaseModel, Field
from google import genai
from google.genai import types

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import BaseMessage, AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain_core.outputs import ChatResult, ChatGeneration, ChatGenerationChunk
from langchain_core.tools import BaseTool
from langchain_core.runnables import Runnable, RunnableLambda
from langchain_core.utils.function_calling import convert_to_openai_tool, dereference_refs

# Setup Logging
logger = logging.getLogger("llm_caller")
if not logger.handlers:
    logging.basicConfig(
        level=logging.INFO,
        format="%(levelname)s | %(name)s | %(message)s",
    )

MODEL_ALIASES = {
    "gemini-3.1-pro": "gemini-3.1-pro-preview",
}

NO_TEMPERATURE_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.6-flash",
    "gemini-3.7-flash",
    "gemini-3.8-flash",
]

# --- Multi-Provider Resolution -----------------------------------------------------
# Prompter is Gemini-first (ChatGoogleGenAI below), but every LLM call in this codebase
# goes through LangChain's public BaseChatModel interface, so OpenAI and Anthropic models
# work transparently via the official `langchain-openai` / `langchain-anthropic` integrations
# once `init_chat_model()` resolves the right provider and stops forwarding Gemini-only kwargs
# (thinking_level, fallback_model, retry_delay) to them.
GEMINI_MODEL_MARKERS = ("gemini", "gemma")
OPENAI_MODEL_PREFIXES = ("gpt-", "o1", "o3", "o4", "chatgpt", "text-embedding")
ANTHROPIC_MODEL_PREFIXES = ("claude",)

SUPPORTED_PROVIDERS = ("google_genai", "openai", "anthropic", "groq", "openrouter")

# Groq and OpenRouter speak the OpenAI chat-completions wire protocol, so both are served through
# the same ChatOpenAI integration as native OpenAI — only the base_url (and key) differ. Neither
# can be inferred from a bare model name (Groq hosts "openai/gpt-oss-*"; OpenRouter namespaces
# everything as "<vendor>/<model>", overlapping with every other provider's names), so callers
# MUST pass an explicit provider for these two — resolve_provider does not guess them.
OPENAI_COMPATIBLE_BASE_URLS = {
    "groq": "https://api.groq.com/openai/v1",
    "openrouter": "https://openrouter.ai/api/v1",
}


def resolve_provider(model: str, explicit_provider: Optional[str] = None) -> str:
    """Infers the LangChain provider key for a given model name.
    An explicit provider (from the request/UI) always wins. A `provider:model` colon
    prefix is respected next. Otherwise the model name is pattern-matched against the
    three natively-inferable providers, defaulting to `google_genai` (this app's original
    default). Groq/OpenRouter are never inferred this way — see OPENAI_COMPATIBLE_BASE_URLS."""
    if explicit_provider:
        return explicit_provider
    if not model:
        return "google_genai"
    if ":" in model:
        prefix = model.split(":", 1)[0].strip().lower()
        if prefix in SUPPORTED_PROVIDERS:
            return prefix
    lower = model.lower()
    if any(marker in lower for marker in GEMINI_MODEL_MARKERS):
        return "google_genai"
    if any(lower.startswith(p) for p in OPENAI_MODEL_PREFIXES):
        return "openai"
    if any(lower.startswith(p) for p in ANTHROPIC_MODEL_PREFIXES):
        return "anthropic"
    return "google_genai"


def _map_thinking_to_openai_effort(level: Optional[str]) -> Optional[str]:
    """Maps Prompter's UI thinking level to OpenAI's `reasoning_effort` for reasoning models."""
    if not level or level in ("None", "none"):
        return None
    return {"Minimal": "minimal", "Low": "low", "Medium": "medium", "High": "high"}.get(level)


def _map_thinking_to_claude_budget(level: Optional[str]) -> Optional[int]:
    """Maps Prompter's UI thinking level to an Anthropic extended-thinking token budget."""
    if not level or level in ("None", "none"):
        return None
    return {"Minimal": 1024, "Low": 2048, "Medium": 4096, "High": 8192}.get(level)


def _map_thinking_to_openrouter_reasoning(level: Optional[str]) -> Optional[Dict[str, str]]:
    """Maps Prompter's UI thinking level to OpenRouter's unified `reasoning` request field.
    OpenRouter translates this internally into whatever the underlying (possibly non-OpenAI,
    non-Anthropic) model actually needs, so this is the one provider where a single param covers
    every reasoning-capable model regardless of vendor. OpenRouter's `effort` only accepts
    low/medium/high (no "minimal"), so Minimal folds into low."""
    if not level or level in ("None", "none"):
        return None
    effort = {"Minimal": "low", "Low": "low", "Medium": "medium", "High": "high"}.get(level)
    return {"effort": effort} if effort else None


# Groq's `/models` endpoint carries no capability metadata, and its catalog is overwhelmingly
# plain open-weight chat models (Llama, Mixtral, etc.) with no reasoning concept at all — so
# thinking support there is a small hand-curated allow-list rather than inferred or fetched.
GROQ_GRADUATED_MODELS = ("openai/gpt-oss",)  # Groq-hosted models exposing OpenAI-style reasoning_effort
GROQ_BINARY_MODELS = ("deepseek-r1", "qwq")  # always reason; Groq exposes no dial for these

ThinkingTier = Literal["none", "binary", "graduated"]


def resolve_thinking_tier(provider: str, model: str, supports_reasoning: Optional[bool] = None) -> ThinkingTier:
    """Classifies a model's thinking-control shape so callers know whether to apply/render a
    thinking_level at all:
      - "none": no such control exists — don't send anything, don't show a selector.
      - "binary": always reasons or never does, no granularity (Gemma; Groq's raw reasoning models).
      - "graduated": a real effort/budget dial (Gemini 3.x+, OpenAI, Anthropic, and any OpenRouter
        model that advertises "reasoning" support).

    Google/OpenAI/Anthropic are hand-classified since their catalogs are small and stable. Groq is
    hand-classified too, via the curated lists above. OpenRouter is the one provider whose
    per-model capability can actually be *asked for* — its /models response's `supported_parameters`
    includes "reasoning" when a model supports it — so `supports_reasoning` should be threaded in
    from that live lookup (see app/core/model_catalog.py) rather than guessed."""
    lower = (model or "").lower()
    if provider == "google_genai":
        return "binary" if "gemma" in lower else "graduated"
    if provider in ("openai", "anthropic"):
        return "graduated"
    if provider == "groq":
        if any(m in lower for m in GROQ_GRADUATED_MODELS):
            return "graduated"
        if any(m in lower for m in GROQ_BINARY_MODELS):
            return "binary"
        return "none"
    if provider == "openrouter":
        return "graduated" if supports_reasoning else "none"
    return "none"


def structured_output_kwargs_for_provider(provider: str) -> Dict[str, Any]:
    """Picks the with_structured_output() `method` for a given provider.

    LangChain's own default for ChatOpenAI-backed models is method="json_schema" — OpenAI's
    newer, strict Structured Outputs API (`response_format: {"type": "json_schema", ...}`), which
    only a narrow set of models actually implement. Groq/OpenRouter route requests to many models
    outside that set, which surfaces as a confusing 400 ("'response_format' of type 'json_schema'
    is not supported with this model") instead of the request just working.

    Tool/function calling is a much older, far more universally supported capability, so
    openai/groq/openrouter default here to method="function_calling" instead — any model
    advertised as tool-capable supports it, with no per-model capability check needed.
    ChatGoogleGenAI's own with_structured_output takes no such kwarg at all (it always builds its
    own response_schema-constrained call), so google_genai gets no override; Anthropic's
    integration already defaults to a tool-based method with no such Structured-Outputs-style
    capability gap, so it's left alone too.

    Used both by LLMCaller.run/run_async and by any agent that calls with_structured_output()
    directly on a bare chat_model (lab_generators.py, optimization_graph.py) instead of going
    through LLMCaller."""
    if provider in ("openai", "groq", "openrouter"):
        return {"method": "function_calling"}
    return {}


def convert_tool_to_genai_declaration(tool: Union[Dict[str, Any], type, Callable, BaseTool]) -> types.FunctionDeclaration:
    """Converts any LangChain-compatible tool (BaseTool, Pydantic BaseModel, Callable, or schema dict)
    into a google.genai.types.FunctionDeclaration strictly conforming to official LangChain specifications."""
    try:
        openai_tool = convert_to_openai_tool(tool)
        fn_data = openai_tool.get("function", {}) if "function" in openai_tool else openai_tool
        name = fn_data.get("name") or getattr(tool, "name", "tool")
        description = fn_data.get("description") or getattr(tool, "description", "") or ""
        parameters = fn_data.get("parameters") or {}
        if parameters:
            try:
                parameters = dereference_refs(parameters)
            except Exception:
                pass
        return types.FunctionDeclaration(
            name=name,
            description=description,
            parameters=parameters
        )
    except Exception as e:
        logger.warning(f"Fallback converting tool {tool}: {e}")
        name = getattr(tool, "name", str(tool))
        desc = getattr(tool, "description", "") or ""
        return types.FunctionDeclaration(
            name=name,
            description=desc,
            parameters={"type": "object", "properties": {}}
        )


def build_tool_config(tool_choice: Any) -> Optional[types.ToolConfig]:
    """Maps LangChain tool_choice options into Google GenAI ToolConfig.
    Supports:
    - 'auto' -> AUTO
    - 'any' / 'required' / True -> ANY
    - 'none' / False -> NONE
    - specific tool name string or dict -> ANY with allowed_function_names
    """
    if tool_choice is None:
        return None

    if isinstance(tool_choice, bool):
        mode = types.FunctionCallingConfigMode.ANY if tool_choice else types.FunctionCallingConfigMode.NONE
        return types.ToolConfig(
            function_calling_config=types.FunctionCallingConfig(mode=mode)
        )

    if isinstance(tool_choice, str):
        choice_lower = tool_choice.lower()
        if choice_lower == "auto":
            return types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.AUTO
                )
            )
        elif choice_lower in ("any", "required"):
            return types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY
                )
            )
        elif choice_lower == "none":
            return types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.NONE
                )
            )
        else:
            return types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY,
                    allowed_function_names=[tool_choice]
                )
            )

    if isinstance(tool_choice, dict):
        fn_name = None
        if "function" in tool_choice and isinstance(tool_choice["function"], dict):
            fn_name = tool_choice["function"].get("name")
        elif "name" in tool_choice:
            fn_name = tool_choice.get("name")
        if fn_name:
            return types.ToolConfig(
                function_calling_config=types.FunctionCallingConfig(
                    mode=types.FunctionCallingConfigMode.ANY,
                    allowed_function_names=[fn_name]
                )
            )

    return None


class ChatGoogleGenAI(BaseChatModel):
    """LangChain BaseChatModel implementation wrapping google-genai SDK directly.
    Ensures seamless LangGraph compatibility, structured outputs, and streaming."""
    api_key: str = Field(default="", exclude=True)
    model_name: str = "gemini-3.5-flash-lite"
    thinking_level: str = "Low"
    temperature: float = 0.7
    max_tokens: Optional[int] = None
    max_retries: int = 3
    retry_delay: float = 2.0
    fallback_model: str = "gemini-3.5-flash-lite"
    _client: Optional[genai.Client] = None

    class Config:
        arbitrary_types_allowed = True

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.model_name = MODEL_ALIASES.get(self.model_name, self.model_name)
        self.fallback_model = MODEL_ALIASES.get(self.fallback_model, self.fallback_model)
        # No env-var fallback here — callers must always supply their own key (see
        # resolve_model_provider_and_key in main.py, which enforces this before a caller is ever
        # constructed).
        self._client = genai.Client(api_key=self.api_key) if self.api_key else None

    @property
    def _llm_type(self) -> str:
        return "google-genai-chat"

    def _should_include_temperature(self) -> bool:
        return not any(m in self.model_name for m in NO_TEMPERATURE_MODELS)

    def _get_thinking_config(self) -> Optional[types.ThinkingConfig]:
        level = self.thinking_level
        if level in ("None", "none", None):
            return None

        if "gemma" in self.model_name.lower():
            return types.ThinkingConfig(include_thoughts=True)

        if "gemini-3" in self.model_name.lower():
            return types.ThinkingConfig(thinking_level=level.upper())

        if level == "Minimal":
            return types.ThinkingConfig(thinking_budget=64)
        elif level == "Low":
            return types.ThinkingConfig(thinking_budget=1024)
        elif level == "Medium":
            return types.ThinkingConfig(thinking_budget=4096)
        elif level == "High":
            return types.ThinkingConfig(thinking_budget=8192)

        return None

    def _build_generate_config(
        self,
        system_inst: str,
        stop: Optional[List[str]] = None,
        response_schema: Any = None,
        tools_arg: Any = None,
        tool_choice_arg: Any = None,
    ) -> types.GenerateContentConfig:
        config_kwargs: Dict[str, Any] = {}
        if system_inst:
            config_kwargs["system_instruction"] = system_inst
        if self._should_include_temperature():
            config_kwargs["temperature"] = self.temperature
        if self.max_tokens is not None:
            config_kwargs["max_output_tokens"] = self.max_tokens
        if response_schema:
            config_kwargs["response_mime_type"] = "application/json"
            config_kwargs["response_schema"] = response_schema
        if stop:
            config_kwargs["stop_sequences"] = stop

        gemini_tools = self._prepare_tools(tools_arg)
        if gemini_tools:
            config_kwargs["tools"] = gemini_tools
            tool_config = build_tool_config(tool_choice_arg)
            if tool_config:
                config_kwargs["tool_config"] = tool_config

        config = types.GenerateContentConfig(**config_kwargs)
        thinking = self._get_thinking_config()
        if thinking:
            if gemini_tools and self.thinking_level not in ("High", "Medium"):
                pass
            else:
                config.thinking_config = thinking
        return config

    def bind_tools(
        self,
        tools: Sequence[Union[Dict[str, Any], type, Callable, BaseTool]],
        *,
        tool_choice: Optional[Union[Dict[str, Any], str, Literal["auto", "none", "required", "any"], bool]] = None,
        **kwargs: Any,
    ) -> Runnable:
        """Bind tool-like objects to this chat model strictly conforming to LangChain's bind_tools API.

        Args:
            tools: Sequence of tool definitions (BaseTool, Pydantic BaseModel, Callable, or dict schema).
            tool_choice: 'auto', 'any'/'required'/True, 'none'/False, or specific tool name/dict.
            **kwargs: Extra parameters passed to RunnableBinding.

        Returns:
            A Runnable (RunnableBinding) configured with tools and tool_choice.
        """
        formatted_tools = [convert_to_openai_tool(t) for t in tools]
        return self.bind(tools=formatted_tools, tool_choice=tool_choice, **kwargs)

    def _prepare_tools(self, tools: Optional[Sequence[Any]]) -> Optional[List[types.Tool]]:
        """Converts LangChain tool sequence to Google GenAI Tool list."""
        if not tools:
            return None
        declarations = []
        for t in tools:
            try:
                decl = convert_tool_to_genai_declaration(t)
                declarations.append(decl)
            except Exception as e:
                logger.warning(f"Failed to prepare tool declaration for {t}: {e}")
        if declarations:
            return [types.Tool(function_declarations=declarations)]
        return None

    def _convert_messages(self, messages: List[BaseMessage]) -> tuple[str, List[types.Content]]:
        """Converts LangChain messages to Gemini system_instruction and Content objects,
        preserving thought signatures and batching multi-tool responses into single user turns."""
        system_instruction = ""
        contents: List[types.Content] = []

        for m in messages:
            if isinstance(m, SystemMessage):
                system_instruction += (m.content if isinstance(m.content, str) else str(m.content)) + "\n"
            elif isinstance(m, HumanMessage):
                text = m.content if isinstance(m.content, str) else str(m.content)
                if contents and contents[-1].role == "user" and not any(getattr(p, "function_response", None) for p in contents[-1].parts):
                    contents[-1].parts[0].text += "\n\n" + text
                else:
                    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=text)]))
            elif isinstance(m, AIMessage):
                text = m.content if isinstance(m.content, str) else str(m.content)
                parts = []
                if text:
                    parts.append(types.Part.from_text(text=text))
                if hasattr(m, "tool_calls") and m.tool_calls:
                    extra_signatures = {}
                    if hasattr(m, "additional_kwargs") and isinstance(m.additional_kwargs, dict):
                        extra_signatures.update(m.additional_kwargs.get("thought_signatures", {}))
                    if hasattr(m, "response_metadata") and isinstance(m.response_metadata, dict):
                        extra_signatures.update(m.response_metadata.get("thought_signatures", {}))

                    for tc in m.tool_calls:
                        tc_id = tc.get("id") or ""
                        tc_name = tc.get("name") or ""
                        sig = (
                            tc.get("thought_signature")
                            or extra_signatures.get(tc_id)
                            or extra_signatures.get(tc_name)
                            or b"skip_thought_signature_validator"
                        )
                        if isinstance(sig, str):
                            sig = sig.encode("utf-8")
                        parts.append(types.Part(
                            function_call=types.FunctionCall(name=tc["name"], args=tc.get("args", {})),
                            thought_signature=sig
                        ))
                if not parts:
                    parts.append(types.Part.from_text(text=""))
                contents.append(types.Content(role="model", parts=parts))
            elif isinstance(m, ToolMessage):
                text = m.content if isinstance(m.content, str) else str(m.content)
                fn_name = getattr(m, "name", "tool") or "tool"
                tool_part = types.Part.from_function_response(name=fn_name, response={"result": text})
                # If preceding content turn is already user containing a function response, group them into the same turn
                if contents and contents[-1].role == "user" and any(getattr(p, "function_response", None) for p in contents[-1].parts):
                    contents[-1].parts.append(tool_part)
                else:
                    contents.append(types.Content(role="user", parts=[tool_part]))
            else:
                text = m.content if isinstance(m.content, str) else str(m.content)
                contents.append(types.Content(role="user", parts=[types.Part.from_text(text=text)]))

        return system_instruction.strip(), contents

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Any = None,
        response_schema: Any = None,
        **kwargs
    ) -> ChatResult:
        system_inst, contents = self._convert_messages(messages)
        config = self._build_generate_config(
            system_inst=system_inst,
            stop=stop,
            response_schema=response_schema,
            tools_arg=kwargs.get("tools"),
            tool_choice_arg=kwargs.get("tool_choice")
        )

        if not self._client:
            raise ValueError("No Gemini API key provided. Please configure an API key in Settings.")
        for attempt in range(1, self.max_retries + 1):
            try:
                resp = self._client.models.generate_content(
                    model=self.model_name,
                    contents=contents,
                    config=config
                )
                text = ""
                tool_calls = []
                signatures = {}
                call_signatures = {}
                if hasattr(resp, "candidates") and resp.candidates:
                    cand = resp.candidates[0]
                    if hasattr(cand, "content") and hasattr(cand.content, "parts") and cand.content.parts:
                        for p in cand.content.parts:
                            if getattr(p, "text", None):
                                text += p.text
                            if getattr(p, "function_call", None) and getattr(p, "thought_signature", None):
                                signatures[p.function_call.name] = p.thought_signature

                if hasattr(resp, "function_calls") and resp.function_calls:
                    for idx, fc in enumerate(resp.function_calls):
                        call_id = f"call_{fc.name}_{int(time.time()*1000)}_{idx}"
                        sig = signatures.get(fc.name) or b"skip_thought_signature_validator"
                        call_signatures[call_id] = sig
                        call_signatures[fc.name] = sig
                        tool_calls.append({
                            "name": fc.name,
                            "args": dict(fc.args) if fc.args else {},
                            "id": call_id,
                        })
                return ChatResult(generations=[ChatGeneration(message=AIMessage(
                    content=text,
                    tool_calls=tool_calls,
                    additional_kwargs={"thought_signatures": call_signatures},
                    response_metadata={"thought_signatures": call_signatures}
                ))])
            except Exception as e:
                err_str = str(e)
                if "429" in err_str or "500" in err_str or "503" in err_str or "internal" in err_str.lower() or "timeout" in err_str.lower():
                    if self.model_name != self.fallback_model:
                        logger.warning(f"Falling back from {self.model_name} to {self.fallback_model}")
                        self.model_name = self.fallback_model
                        continue
                if attempt < self.max_retries:
                    time.sleep(self.retry_delay)
                else:
                    raise

    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Any = None,
        response_schema: Any = None,
        **kwargs
    ) -> ChatResult:
        system_inst, contents = self._convert_messages(messages)
        config = self._build_generate_config(
            system_inst=system_inst,
            stop=stop,
            response_schema=response_schema,
            tools_arg=kwargs.get("tools"),
            tool_choice_arg=kwargs.get("tool_choice")
        )

        if not self._client:
            raise ValueError("No Gemini API key provided. Please configure an API key in Settings.")
        for attempt in range(1, self.max_retries + 1):
            try:
                resp = await self._client.aio.models.generate_content(
                    model=self.model_name,
                    contents=contents,
                    config=config
                )
                text = ""
                tool_calls = []
                signatures = {}
                call_signatures = {}
                if hasattr(resp, "candidates") and resp.candidates:
                    cand = resp.candidates[0]
                    if hasattr(cand, "content") and hasattr(cand.content, "parts") and cand.content.parts:
                        for p in cand.content.parts:
                            if getattr(p, "text", None):
                                text += p.text
                            if getattr(p, "function_call", None) and getattr(p, "thought_signature", None):
                                signatures[p.function_call.name] = p.thought_signature

                if hasattr(resp, "function_calls") and resp.function_calls:
                    for idx, fc in enumerate(resp.function_calls):
                        call_id = f"call_{fc.name}_{int(time.time()*1000)}_{idx}"
                        sig = signatures.get(fc.name) or b"skip_thought_signature_validator"
                        call_signatures[call_id] = sig
                        call_signatures[fc.name] = sig
                        tool_calls.append({
                            "name": fc.name,
                            "args": dict(fc.args) if fc.args else {},
                            "id": call_id,
                        })
                return ChatResult(generations=[ChatGeneration(message=AIMessage(
                    content=text,
                    tool_calls=tool_calls,
                    additional_kwargs={"thought_signatures": call_signatures},
                    response_metadata={"thought_signatures": call_signatures}
                ))])
            except Exception as e:
                err_str = str(e)
                if "429" in err_str or "500" in err_str or "503" in err_str or "internal" in err_str.lower() or "timeout" in err_str.lower():
                    if self.model_name != self.fallback_model:
                        logger.warning(f"Falling back async from {self.model_name} to {self.fallback_model}")
                        self.model_name = self.fallback_model
                        continue
                if attempt < self.max_retries:
                    await asyncio.sleep(self.retry_delay)
                else:
                    raise

    async def _astream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Any = None,
        response_schema: Any = None,
        **kwargs
    ) -> AsyncIterator[ChatGenerationChunk]:
        system_inst, contents = self._convert_messages(messages)
        config = self._build_generate_config(
            system_inst=system_inst,
            stop=stop,
            response_schema=response_schema,
            tools_arg=kwargs.get("tools"),
            tool_choice_arg=kwargs.get("tool_choice")
        )

        if not self._client:
            raise ValueError("No Gemini API key provided. Please configure an API key in Settings.")
        response = await self._client.aio.models.generate_content_stream(
            model=self.model_name,
            contents=contents,
            config=config
        )
        async for chunk in response:
            delta_text = ""
            if hasattr(chunk, "candidates") and chunk.candidates:
                cand = chunk.candidates[0]
                if hasattr(cand, "content") and hasattr(cand.content, "parts") and cand.content.parts:
                    for p in cand.content.parts:
                        if getattr(p, "text", None):
                            delta_text += p.text
            elif hasattr(chunk, "text") and chunk.text:
                try:
                    delta_text = chunk.text
                except Exception:
                    pass

            tool_call_chunks = []
            if hasattr(chunk, "function_calls") and chunk.function_calls:
                for idx, fc in enumerate(chunk.function_calls):
                    tool_call_chunks.append({
                        "name": fc.name,
                        "args": json.dumps(dict(fc.args)) if fc.args else "{}",
                        "id": f"call_{fc.name}_{int(time.time()*1000)}_{idx}",
                        "index": idx
                    })
            msg_chunk = AIMessageChunk(content=delta_text, tool_call_chunks=tool_call_chunks)
            gen_chunk = ChatGenerationChunk(message=msg_chunk)
            if run_manager and delta_text:
                await run_manager.on_llm_new_token(delta_text, chunk=gen_chunk)
            yield gen_chunk

    def with_structured_output(self, schema: Union[Type[BaseModel], dict]):
        """Constrains generation via response_schema and parses result."""
        def _clean_json(raw: str) -> str:
            cleaned = (raw or "").strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            elif cleaned.startswith("```"):
                cleaned = cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            return cleaned.strip()

        def _parse(raw_text: str):
            cleaned = _clean_json(raw_text)
            if isinstance(schema, type) and issubclass(schema, BaseModel):
                try:
                    return schema.model_validate_json(cleaned)
                except Exception:
                    parsed = json_repair.loads(cleaned)
                    return schema.model_validate(parsed)
            return json_repair.loads(cleaned)

        def sync_call(messages):
            if isinstance(messages, str):
                messages = [HumanMessage(content=messages)]
            result = self._generate(messages=messages, response_schema=schema)
            return _parse(result.generations[0].message.content)

        async def async_call(messages):
            if isinstance(messages, str):
                messages = [HumanMessage(content=messages)]
            result = await self._agenerate(messages=messages, response_schema=schema)
            return _parse(result.generations[0].message.content)

        return RunnableLambda(func=sync_call, afunc=async_call)


# =====================================================================
# Official LangChain init_chat_model Provider Integration
# Reference: https://reference.langchain.com/python/langchain/chat_models/base/init_chat_model
# =====================================================================
import langchain.chat_models.base as lc_base
from langchain.chat_models import init_chat_model as _lc_init_chat_model
from langchain_openai import ChatOpenAI

def _call_custom_google(model: str, cls=None, **kwargs):
    kwargs.pop("cls", None)
    return ChatGoogleGenAI(model_name=model, **kwargs)

if hasattr(lc_base, "_BUILTIN_PROVIDERS"):
    lc_base._BUILTIN_PROVIDERS["google_genai"] = ("app.core.llm", "ChatGoogleGenAI", _call_custom_google)
    lc_base._BUILTIN_PROVIDERS["google_vertexai"] = ("app.core.llm", "ChatGoogleGenAI", _call_custom_google)
    if hasattr(lc_base._get_chat_model_creator, "cache_clear"):
        lc_base._get_chat_model_creator.cache_clear()

if hasattr(lc_base, "_SUPPORTED_PROVIDERS"):
    if isinstance(lc_base._SUPPORTED_PROVIDERS, dict):
        lc_base._SUPPORTED_PROVIDERS["google_genai"] = ("app.core.llm", "ChatGoogleGenAI", _call_custom_google)
        lc_base._SUPPORTED_PROVIDERS["google_vertexai"] = ("app.core.llm", "ChatGoogleGenAI", _call_custom_google)
    elif isinstance(lc_base._SUPPORTED_PROVIDERS, set):
        lc_base._SUPPORTED_PROVIDERS.add("google_genai")
        lc_base._SUPPORTED_PROVIDERS.add("google_vertexai")


def init_chat_model(
    model: str = "gemini-3.5-flash-lite",
    model_name: Optional[str] = None,
    *,
    model_provider: Optional[str] = None,
    configurable_fields: Optional[Any] = None,
    config_prefix: str = "",
    api_key: str = "",
    thinking_level: str = "Low",
    temperature: float = 0.7,
    max_retries: int = 3,
    retry_delay: float = 2.0,
    fallback_model: str = "gemini-3.5-flash-lite",
    supports_reasoning: Optional[bool] = None,
    **kwargs
) -> BaseChatModel:
    """Universal, multi-provider chat model initializer built on LangChain's init_chat_model API:
    https://reference.langchain.com/python/langchain/chat_models/base/init_chat_model

    Supports:
    - Fixed model initialization ('gemini-3.5-flash-lite', 'gpt-4o', 'claude-sonnet-4-5', etc.)
    - Provider colon syntax (e.g. 'google_genai:gemini-3.5-flash-lite', 'openai:gpt-4o')
    - Explicit model_provider ('google_genai', 'openai', 'anthropic', 'groq', 'openrouter')
    - Runtime configurability via configurable_fields=('model', 'model_provider', 'temperature')
    - Namespacing with config_prefix
    - A UI-level `thinking_level` mapped to each provider's own reasoning knob (see
      resolve_thinking_tier for which models actually have one):
      Gemini -> ThinkingConfig, OpenAI -> reasoning_effort, Anthropic -> extended-thinking budget,
      OpenRouter -> its unified `reasoning` field, Groq -> reasoning_effort for its curated
      reasoning-capable models only.
      `fallback_model`/`retry_delay` are Gemini-only (ChatGoogleGenAI) extensions and are never
      forwarded to non-Gemini providers, since their LangChain integrations don't accept them.
    """
    effective_model = model_name or model
    provider = resolve_provider(effective_model, model_provider)
    # Only pass an explicit provider through when the model string doesn't already carry
    # a `provider:model` prefix — init_chat_model resolves that itself otherwise.
    provider_arg = model_provider or (provider if ":" not in effective_model else None)

    if provider in OPENAI_COMPATIBLE_BASE_URLS:
        # Groq and OpenRouter are OpenAI-API-compatible: rather than teaching LangChain's
        # provider registry about them, build the same ChatOpenAI integration directly and just
        # point it at that provider's base_url + key (the officially documented pattern for any
        # OpenAI-compatible endpoint).
        chat_kwargs: Dict[str, Any] = dict(kwargs)
        chat_kwargs["base_url"] = OPENAI_COMPATIBLE_BASE_URLS[provider]
        chat_kwargs["max_retries"] = max_retries
        if api_key:
            chat_kwargs["api_key"] = api_key

        tier = resolve_thinking_tier(provider, effective_model, supports_reasoning)
        effort_applied = False
        if tier == "graduated":
            if provider == "openrouter":
                reasoning = _map_thinking_to_openrouter_reasoning(thinking_level)
                if reasoning:
                    chat_kwargs["extra_body"] = {"reasoning": reasoning}
                    effort_applied = True
            else:  # groq's curated reasoning-capable models speak OpenAI's reasoning_effort
                effort = _map_thinking_to_openai_effort(thinking_level)
                if effort:
                    chat_kwargs["reasoning_effort"] = effort
                    effort_applied = True
        if not effort_applied and temperature is not None:
            chat_kwargs["temperature"] = temperature

        return ChatOpenAI(model=effective_model, **chat_kwargs)

    extra_kwargs = dict(kwargs)
    if api_key:
        extra_kwargs["api_key"] = api_key

    if provider == "google_genai":
        if temperature is not None:
            extra_kwargs["temperature"] = temperature
        extra_kwargs["thinking_level"] = thinking_level
        extra_kwargs["max_retries"] = max_retries
        extra_kwargs["retry_delay"] = retry_delay
        extra_kwargs["fallback_model"] = fallback_model
    elif provider == "openai":
        effort = _map_thinking_to_openai_effort(thinking_level)
        if effort:
            extra_kwargs["reasoning_effort"] = effort
            # OpenAI reasoning models (o1/o3/o4/gpt-5 "thinking" variants) reject a custom temperature.
        elif temperature is not None:
            extra_kwargs["temperature"] = temperature
        extra_kwargs["max_retries"] = max_retries
    elif provider == "anthropic":
        budget = _map_thinking_to_claude_budget(thinking_level)
        if budget:
            extra_kwargs["thinking"] = {"type": "enabled", "budget_tokens": budget}
            extra_kwargs["max_tokens"] = extra_kwargs.get("max_tokens", budget + 2048)
            # Claude forbids a custom temperature while extended thinking is enabled.
        elif temperature is not None:
            extra_kwargs["temperature"] = temperature
        extra_kwargs["max_retries"] = max_retries
    else:
        if temperature is not None:
            extra_kwargs["temperature"] = temperature
        extra_kwargs["max_retries"] = max_retries

    return _lc_init_chat_model(
        model=effective_model,
        model_provider=provider_arg,
        configurable_fields=configurable_fields,
        config_prefix=config_prefix,
        **extra_kwargs
    )

class LLMCaller:
    """Central LLM Caller supporting both classic direct execution and LangChain integration.
    Fully provider-agnostic: Gemini, OpenAI, and Anthropic are all driven through the same
    public BaseChatModel interface (`with_structured_output`, `invoke`/`ainvoke`, `astream`) —
    there is no provider-specific branching here, since every LangChain chat model resolves
    those calls down to the same underlying `_generate`/`_agenerate`/`_astream` regardless of
    provider."""
    def __init__(
        self,
        api_key: str = "",
        model_name: str = "gemini-3.5-flash-lite",
        model_provider: Optional[str] = None,
        thinking_level: str = "Low",
        temperature: float = 0.7,
        max_retries: int = 3,
        retry_delay: float = 2.0,
        fallback_model: str = "gemini-3.5-flash-lite",
        supports_reasoning: Optional[bool] = None
    ):
        self.api_key = api_key
        self.model_name = MODEL_ALIASES.get(model_name, model_name)
        self.provider = resolve_provider(self.model_name, model_provider)
        self.thinking_level = thinking_level
        self.temperature = temperature
        self.max_retries = max_retries
        self.retry_delay = retry_delay
        self.fallback_model = MODEL_ALIASES.get(fallback_model, fallback_model)
        # Only meaningful for provider == "openrouter" — whether the live model-list lookup
        # reported this model supports OpenRouter's unified `reasoning` parameter.
        self.supports_reasoning = supports_reasoning
        # Instantiate model strictly via official LangChain init_chat_model
        # Reference: https://reference.langchain.com/python/langchain/chat_models/base/init_chat_model
        self.chat_model = init_chat_model(
            self.model_name,
            model_provider=self.provider,
            api_key=api_key,
            thinking_level=self.thinking_level,
            temperature=self.temperature,
            max_retries=self.max_retries,
            retry_delay=self.retry_delay,
            fallback_model=self.fallback_model,
            supports_reasoning=self.supports_reasoning
        )

    def _structured_output_kwargs(self) -> Dict[str, Any]:
        return structured_output_kwargs_for_provider(self.provider)

    @staticmethod
    def _serialize_structured(parsed: Any) -> str:
        """Structured-output calls return an already-parsed object (pydantic model or dict,
        per LangChain's `with_structured_output` contract) — re-serialize to the JSON string
        every call site in this codebase expects."""
        if isinstance(parsed, BaseModel):
            return parsed.model_dump_json()
        if isinstance(parsed, str):
            return parsed
        return json.dumps(parsed)

    def run(self, input_text: str, system_prompt: str, json_format: Type[BaseModel] | dict) -> str:
        messages = []
        if system_prompt:
            messages.append(SystemMessage(content=system_prompt))
        messages.append(HumanMessage(content=input_text))

        if json_format:
            structured = self.chat_model.with_structured_output(json_format, **self._structured_output_kwargs())
            parsed = structured.invoke(messages)
            return self._serialize_structured(parsed)
        return self.chat_model.invoke(messages).content

    def run_freeform(self, input_text: str, system_prompt: str) -> str:
        return self.run(input_text, system_prompt, json_format=None)

    async def run_async(self, input_text: str, system_prompt: str, json_format: Type[BaseModel] | dict) -> str:
        messages = []
        if system_prompt:
            messages.append(SystemMessage(content=system_prompt))
        messages.append(HumanMessage(content=input_text))

        if json_format:
            structured = self.chat_model.with_structured_output(json_format, **self._structured_output_kwargs())
            parsed = await structured.ainvoke(messages)
            return self._serialize_structured(parsed)
        resp = await self.chat_model.ainvoke(messages)
        return resp.content

    def run_stream(self, input_text: str, system_prompt: str, json_format: Type[BaseModel] = None):
        """Yields text chunks for streaming, provider-agnostic. Bridges LangChain's async
        `astream` (implemented by ChatGoogleGenAI, ChatOpenAI, and ChatAnthropic alike) onto a
        synchronous generator via a background thread + queue, since callers of this method
        (the greenfield Prompt/Schema Creator streaming endpoints) are plain sync generators."""
        logger.info(f"Starting LLM stream ({self.provider}:{self.model_name})")
        messages = []
        if system_prompt:
            messages.append(SystemMessage(content=system_prompt))
        messages.append(HumanMessage(content=input_text))

        import queue
        import threading

        q: "queue.Queue" = queue.Queue()
        _SENTINEL = object()

        async def _produce():
            try:
                async for chunk in self.chat_model.astream(messages):
                    text = getattr(chunk, "content", None)
                    if text:
                        q.put(text)
            except Exception as e:
                q.put(e)
            finally:
                q.put(_SENTINEL)

        thread = threading.Thread(target=lambda: asyncio.run(_produce()), daemon=True)
        thread.start()

        while True:
            item = q.get()
            if item is _SENTINEL:
                break
            if isinstance(item, Exception):
                logger.error(f"Streaming failed: {item}")
                raise item
            yield item
        thread.join()