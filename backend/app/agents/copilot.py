import json
import json_repair
import re
import asyncio
import logging
from typing import AsyncGenerator, List, Dict, Any, Optional

from langchain.agents import create_agent
from langchain.agents.middleware import (
    before_model,
    after_model,
    SummarizationMiddleware,
    ToolRetryMiddleware
)
from langchain_core.tools import tool
from langchain_core.messages import HumanMessage, AIMessage
from langgraph.checkpoint.memory import InMemorySaver

from app.core.llm import LLMCaller, init_chat_model
from app.utils.grep_tool import grep_documents as grep_docs_impl, read_document as read_docs_impl
from app.prompts.copilot_prompts import COPILOT_SYSTEM_PROMPT_TEMPLATE

logger = logging.getLogger("copilot_agent")


def parse_action_proposal(full_text: str) -> Optional[Dict[str, str]]:
    """Extracts and parses action proposal from XML or markdown block."""
    if not full_text:
        return None
    xml_match = re.search(r"<action_proposal>([\s\S]*?)</action_proposal>", full_text)
    if xml_match:
        block = xml_match.group(1)
        summary_m = re.search(r"<summary>([\s\S]*?)</summary>", block)
        prompt_m = re.search(r"<prompt_instruction>([\s\S]*?)</prompt_instruction>", block)
        schema_m = re.search(r"<schema_instruction>([\s\S]*?)</schema_instruction>", block)
        return {
            "summary": summary_m.group(1).strip() if summary_m else "Proposed Editor Changes",
            "prompt_instruction": prompt_m.group(1).strip() if prompt_m else "",
            "schema_instruction": schema_m.group(1).strip() if schema_m else ""
        }
    md_match = re.search(r"```action_proposal\s*([\s\S]*?)\s*```", full_text)
    if md_match:
        try:
            repaired = json_repair.loads(md_match.group(1))
            if isinstance(repaired, dict):
                return {
                    "summary": repaired.get("summary", "Proposed Editor Changes"),
                    "prompt_instruction": repaired.get("prompt_instruction", ""),
                    "schema_instruction": repaired.get("schema_instruction", "")
                }
        except Exception:
            pass
    return None

def create_copilot_tools(prompt: str, json_schema: str):
    """Creates LangChain @tool decorated functions closed over the active prompt/schema."""
    @tool
    def grep_documents(query: str, target: str = "both") -> str:
        """Searches the active Prompt and/or JSON Schema for matching keywords or regex patterns. Returns matching line numbers and surrounding context."""
        return grep_docs_impl(
            query=query,
            prompt_text=prompt,
            schema_text=json_schema,
            target=target,
            case_sensitive=False
        )

    @tool
    def read_document(target: str, start_line: Optional[int] = 1, end_line: Optional[int] = None) -> str:
        """Reads the full document or a specific line range from the active Prompt or Schema dynamically."""
        return read_docs_impl(
            target=target,
            prompt_text=prompt,
            schema_text=json_schema,
            start_line=start_line or 1,
            end_line=end_line
        )

    return [grep_documents, read_document]


class ChatCopilotAgent:
    def __init__(self, llm_caller: LLMCaller):
        self.llm_caller = llm_caller
        self.checkpointer = InMemorySaver()

    async def stream_chat(
        self,
        session_id: str,
        messages: List[Dict[str, Any]],
        prompt: str,
        json_schema: str,
        summary: Optional[str] = None
    ) -> AsyncGenerator[str, None]:
        """Runs multi-step tool execution loop with LangChain create_agent and middlewares, streaming tokens via astream_events(v2).
        The full conversation is passed in on every call (see main.py's chat_stream) and reconverted
        to LangChain messages here, so conversational continuity comes from the caller resending
        history, not from the checkpointer surviving across requests."""
        prompt_lines = len(prompt.splitlines()) if prompt.strip() else 0
        prompt_chars = len(prompt)
        schema_lines = len(json_schema.splitlines()) if json_schema.strip() else 0
        schema_chars = len(json_schema)

        metadata_banner = (
            f"\n=== ACTIVE WORKSPACE METADATA ===\n"
            f"- System Prompt (`prompt`): {prompt_lines} lines, {prompt_chars} characters\n"
            f"- JSON Schema (`schema`): {schema_lines} lines, {schema_chars} characters\n"
            f"================================\n"
        )
        full_system_prompt = COPILOT_SYSTEM_PROMPT_TEMPLATE + "\n" + metadata_banner

        # Define Dynamic Middleware Hooks
        @before_model
        def dynamic_context_hook(state, runtime):
            """LangChain @before_model hook ensuring latest workspace metadata is injected."""
            return None

        @after_model
        def action_proposal_hook(state, runtime):
            """LangChain @after_model hook inspecting outputs for action proposals."""
            return None

        # Build tools
        tools = create_copilot_tools(prompt, json_schema)

        # Primary Chat Model initialized via official LangChain init_chat_model
        chat_model = init_chat_model(
            self.llm_caller.model_name,
            model_provider=self.llm_caller.provider,
            api_key=self.llm_caller.api_key,
            thinking_level="None",
            temperature=self.llm_caller.temperature,
            max_retries=self.llm_caller.max_retries,
            retry_delay=self.llm_caller.retry_delay,
            fallback_model=self.llm_caller.fallback_model,
            supports_reasoning=self.llm_caller.supports_reasoning
        )
        # Lightweight Model for Summarization. Only Gemini has a cheap sibling we can safely
        # assume exists (flash-lite) — for every other provider there's no reliable "lightweight
        # equivalent" to hardcode (Groq/OpenRouter's catalogs are too volatile, and guessing wrong
        # would reintroduce this exact cross-provider auth mismatch), so it reuses the main chat
        # model/provider/key instead.
        if self.llm_caller.provider == "google_genai":
            summary_model = init_chat_model(
                "gemini-3.5-flash-lite",
                model_provider="google_genai",
                api_key=self.llm_caller.api_key,
                thinking_level="Minimal",
                temperature=0.3
            )
        else:
            summary_model = init_chat_model(
                self.llm_caller.model_name,
                model_provider=self.llm_caller.provider,
                api_key=self.llm_caller.api_key,
                thinking_level="None",
                temperature=0.3,
                supports_reasoning=self.llm_caller.supports_reasoning
            )

        # Assemble Middlewares
        middlewares = [
            dynamic_context_hook,
            action_proposal_hook,
            SummarizationMiddleware(
                model=summary_model,
                trigger=[("messages", 20)],
                keep=("messages", 8)
            ),
            ToolRetryMiddleware(max_retries=2, backoff_factor=2.0)
        ]

        # Create Agent with LangGraph Runtime
        agent = create_agent(
            model=chat_model,
            tools=tools,
            system_prompt=full_system_prompt,
            middleware=middlewares,
            checkpointer=self.checkpointer
        )

        # Convert input messages into LangChain messages
        lang_messages = []
        for m in messages:
            role = m.get("role", "user")
            text = m.get("text", "").strip()
            if not text:
                continue
            if role in ("user", "human"):
                lang_messages.append(HumanMessage(content=text))
            elif role in ("model", "assistant"):
                lang_messages.append(AIMessage(content=text))

        if not lang_messages:
            lang_messages.append(HumanMessage(content="Hello"))

        full_response_text = ""

        try:
            logger.info(f"Starting Middleware-powered Co-Pilot for session {session_id} ({self.llm_caller.model_name})")

            # Stream step-by-step using astream_events(v2)
            config = {"configurable": {"thread_id": session_id}}
            async for event in agent.astream_events(
                {"messages": lang_messages},
                version="v2",
                config=config
            ):
                ev_type = event.get("event")

                # Tool invocation event
                if ev_type == "on_tool_start":
                    tool_name = event.get("name", "tool")
                    tool_input = event.get("data", {}).get("input", {})
                    logger.info(f"Co-Pilot tool start: {tool_name}({tool_input})")
                    yield f"data: {json.dumps({'type': 'tool_call', 'name': tool_name, 'tool': tool_name, 'args': tool_input})}\n\n"

                # Tool completed event
                elif ev_type == "on_tool_end":
                    tool_name = event.get("name", "tool")
                    logger.info(f"Co-Pilot tool finished: {tool_name}")
                    yield f"data: {json.dumps({'type': 'tool_result', 'name': tool_name, 'tool': tool_name, 'summary': f'Completed {tool_name}'})}\n\n"

                # Token streaming event from model
                elif ev_type == "on_chat_model_stream":
                    chunk = event.get("data", {}).get("chunk")
                    chunk_text = ""
                    if chunk:
                        if hasattr(chunk, "content") and isinstance(chunk.content, str):
                            chunk_text = chunk.content
                    if chunk_text:
                        full_response_text += chunk_text
                        yield f"data: {json.dumps({'type': 'token', 'text': chunk_text, 'token': chunk_text})}\n\n"

            # Fallback if streaming did not yield token chunks
            if not full_response_text.strip():
                state = await agent.aget_state(config)
                if state and state.values.get("messages"):
                    last_msg = state.values["messages"][-1]
                    if isinstance(last_msg, AIMessage) and last_msg.content:
                        full_response_text = str(last_msg.content)
                        chunk_size = 24
                        for i in range(0, len(full_response_text), chunk_size):
                            token_slice = full_response_text[i:i + chunk_size]
                            yield f"data: {json.dumps({'type': 'token', 'text': token_slice, 'token': token_slice})}\n\n"
                            await asyncio.sleep(0.01)

            # Parse and emit Action Proposal if present
            proposal_data = parse_action_proposal(full_response_text)
            if proposal_data:
                yield f"data: {json.dumps({'type': 'action_proposal', 'data': proposal_data, **proposal_data})}\n\n"
                logger.info(f"Emitted action_proposal: {proposal_data['summary']}")

            yield "data: {\"type\": \"done\"}\n\n"

        except Exception as e:
            logger.error(f"Middleware Co-Pilot error: {str(e)}")
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            yield "data: {\"type\": \"done\"}\n\n"
