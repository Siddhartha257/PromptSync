import os
import json
import json_repair
import logging
import asyncio
import httpx
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from dotenv import load_dotenv
load_dotenv()

logger = logging.getLogger("api")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")

from app.core.llm import LLMCaller, resolve_provider, SUPPORTED_PROVIDERS
from app.core.model_catalog import list_models as fetch_provider_models
from app.agents.orchestrator import Orch
from app.agents.generators import PromptUpdaterAgent, SchemaUpdaterAgent, PromptCreatorAgent, SchemaCreatorAgent
from app.agents.verification import VerificationAgent
from app.utils.patcher import apply_llm_edits, format_retry_context as format_prompt_retry_context
from app.utils.json_patcher import JsonSchemaPatchEngine, format_retry_context as format_schema_retry_context
from app.models.schemas import (
    StreamPromptRequest, StreamSchemaRequest, OrchestrateRequest, ApplyEditsRequest, VerifyRequest, VerifyOutputRequest, TrialRunRequest,
    ChatStreamRequest, ChatClearRequest,
    LabGenerateKBRequest, LabGenerateCriteriaRequest, LabGenerateQueriesRequest,
    LabStartOptimizationRequest, LabResumeRequest, ListModelsRequest
)
from app.agents.copilot import ChatCopilotAgent
from app.agents.lab_generators import LabGenerators
from app.agents.optimization_graph import OptimizationLabEngine
from langgraph.types import Command


app = FastAPI(title="Prompter Studio API")

frontend_url_env = os.getenv("FRONTEND_URL", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173")
allowed_origins = [url.strip() for url in frontend_url_env.split(",") if url.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

json_patch_engine = JsonSchemaPatchEngine(debug=True)

MAX_PATCH_ATTEMPTS = 2  # 1 initial generation + 1 LLM self-correction retry on failed patch application
MAX_VERIFY_ATTEMPTS = 2  # 1 initial check + 1 auto-correction retry on a detected plan misalignment

def resolve_model_provider_and_key(
    model_name: str,
    explicit_provider: Optional[str],
    provided_key: str,
    role_label: str = "this request"
) -> tuple[str, str, str, str]:
    """Resolves the effective (model_name, provider, api_key, fallback_model) for a single agent
    call. Every request must supply its own API key — there is no server-side fallback key or
    free-tier model for keyless callers; a missing key fails fast here with a clear 400 rather
    than surfacing as an opaque error deep inside the first actual LLM call."""
    if not provided_key:
        raise HTTPException(
            status_code=400,
            detail=f"An API key is required for {role_label}. Please configure one in Settings."
        )
    provider = resolve_provider(model_name, explicit_provider)
    fallback_model = "gemini-3.5-flash-lite"
    return model_name, provider, provided_key, fallback_model


def get_caller(req_base) -> LLMCaller:
    """Builds an LLMCaller for the request's chosen model/provider (see
    resolve_model_provider_and_key — requires the caller's own API key)."""
    config = getattr(req_base, 'config', None)
    model_name = getattr(config, 'model', 'gemini-3.5-flash-lite') if config else 'gemini-3.5-flash-lite'
    thinking_level = getattr(config, 'thinking_level', 'Low') if config else 'Low'
    temperature = getattr(config, 'temperature', 0.7) if config else 0.7
    explicit_provider = getattr(config, 'provider', None) if config else None
    supports_reasoning = getattr(config, 'supports_reasoning', None) if config else None
    provided_key = getattr(req_base, 'api_key', '') or ""

    model_name, provider, effective_key, fallback_model = resolve_model_provider_and_key(
        model_name, explicit_provider, provided_key
    )

    return LLMCaller(
        api_key=effective_key,
        model_name=model_name,
        model_provider=provider,
        thinking_level=thinking_level,
        temperature=temperature,
        fallback_model=fallback_model,
        supports_reasoning=supports_reasoning
    )


@app.post("/api/list_models")
async def list_models_endpoint(req: ListModelsRequest):
    """Live model-list lookup for the settings UI's provider->model picker (see
    app/core/model_catalog.py). Doubles as real key validation: an invalid/rejected key surfaces
    here as a 400 instead of only failing deep inside a later generation call.

    Always requires the caller's own key — there is no server-side fallback key for any provider."""
    provider = req.provider
    if provider not in SUPPORTED_PROVIDERS:
        raise HTTPException(400, f"Unknown provider '{provider}'.")

    api_key = req.api_key
    if not api_key:
        raise HTTPException(400, f"An API key is required to list models for '{provider}'.")

    try:
        models = await fetch_provider_models(provider, api_key)
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            400,
            f"Could not list models for '{provider}': the key was rejected (HTTP {e.response.status_code})."
        )
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Failed to reach '{provider}' to list models: {e}")

    return {"models": models}

@app.post("/api/stream/prompt")
def stream_prompt(req: StreamPromptRequest):
    def iter_stream():
        try:
            caller = get_caller(req)
            prompt_creator = PromptCreatorAgent(llm_caller=caller)
            stream = prompt_creator.generate_stream(req.instruction, req.target_model)
            for chunk in stream:
                yield f"data: {json.dumps({'text': chunk})}\n\n"
            yield "data: [DONE]\n\n"
        except HTTPException as e:
            yield f"data: {json.dumps({'error': e.detail})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(iter_stream(), media_type="text/event-stream")

@app.post("/api/stream/schema")
def stream_schema(req: StreamSchemaRequest):
    def iter_stream():
        try:
            caller = get_caller(req)
            schema_creator = SchemaCreatorAgent(llm_caller=caller)
            stream = schema_creator.generate_stream(req.instruction)
            for chunk in stream:
                yield f"data: {json.dumps({'text': chunk})}\n\n"
            yield "data: [DONE]\n\n"
        except HTTPException as e:
            yield f"data: {json.dumps({'error': e.detail})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(iter_stream(), media_type="text/event-stream")

@app.post("/api/orchestrate")
def orchestrate_update(req: OrchestrateRequest):
    try:
        caller = get_caller(req)
        orchestrator = Orch(llm_caller=caller)
        schema_plan = orchestrator.run(
            prompt=req.prompt,
            json_schema=req.json_schema,
            user_request=req.user_request
        )
        return schema_plan.model_dump()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/apply_edits")
async def apply_edits(req: ApplyEditsRequest):
    try:
        async def run_prompt_task():
            if not req.prompt_instruction.strip():
                return req.prompt

            local_caller = get_caller(req)
            local_prompt_updater = PromptUpdaterAgent(llm_caller=local_caller)

            retry_note = None
            last_detail = None
            for attempt in range(1, MAX_PATCH_ATTEMPTS + 1):
                try:
                    edits = await local_prompt_updater.generate_edits_async(
                        req.prompt, req.prompt_instruction, retry_note=retry_note
                    )
                except Exception as e:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Prompt Agent failed to generate valid JSON edits. The model may have hallucinated or hit output limits. Error: {str(e)}. Try switching to a more capable model."
                    )

                patch_result = apply_llm_edits(req.prompt, edits)
                if patch_result.success:
                    if attempt > 1:
                        logger.info(f"Prompt patch succeeded on retry attempt {attempt}/{MAX_PATCH_ATTEMPTS} after LLM self-correction.")
                    return patch_result.updated_text

                failed = [
                    f"Edit {r_idx+1}: could not locate search string '{edits[r_idx].search[:80].replace(chr(10), '↵')}...'"
                    for r_idx, r in enumerate(patch_result.edit_results)
                    if not r.success
                ]
                last_detail = (
                    f"{len(failed)} of {len(edits)} prompt patch edit(s) failed to apply — "
                    f"the search string was not found in the current prompt text. "
                    f"Failed edits: {'; '.join(failed)}."
                )

                if attempt < MAX_PATCH_ATTEMPTS:
                    logger.warning(
                        f"Prompt patch attempt {attempt}/{MAX_PATCH_ATTEMPTS} failed ({len(failed)} edit(s)); "
                        f"retrying with an LLM self-correction call using the verbatim failed search snippet(s)..."
                    )
                    retry_note = format_prompt_retry_context(edits, patch_result)

            raise HTTPException(
                status_code=422,
                detail=f"{last_detail} Retried once with the exact document text but still failed. "
                       f"Try switching to a more capable generator model in Settings."
            )

        async def run_schema_task():
            if not req.schema_instruction.strip():
                return req.json_schema
            logger.info("Applying schema edits...")

            local_caller = get_caller(req)
            local_schema_updater = SchemaUpdaterAgent(llm_caller=local_caller)

            try:
                schema_dict = json.loads(req.json_schema)
            except json.JSONDecodeError as e:
                logger.warning(f"Invalid JSON detected, attempting auto-repair: {str(e)}")
                try:
                    schema_dict = json_repair.loads(req.json_schema)
                    logger.info("Auto-repair successful.")
                except Exception as repair_e:
                    logger.error(f"Auto-repair failed: {str(repair_e)}")
                    raise HTTPException(status_code=422, detail=f"Your JSON Schema has a syntax error that could not be auto-repaired. Please fix it manually: {str(e)}")

            retry_note = None
            last_error = None
            for attempt in range(1, MAX_PATCH_ATTEMPTS + 1):
                try:
                    patches = await local_schema_updater.generate_edits_async(
                        req.json_schema, req.schema_instruction, retry_note=retry_note
                    )
                except Exception as e:
                    raise HTTPException(
                        status_code=422,
                        detail=f"Schema Agent failed to generate valid JSON patches. The model may have hallucinated or hit output limits. Error: {str(e)}. Try switching to a more capable model."
                    )

                patch_result = json_patch_engine.apply(schema_dict, patches)
                if patch_result.success:
                    if attempt > 1:
                        logger.info(f"Schema patch succeeded on retry attempt {attempt}/{MAX_PATCH_ATTEMPTS} after LLM self-correction.")
                    return json.dumps(patch_result.updated_schema, indent=2)

                last_error = patch_result.error
                if attempt < MAX_PATCH_ATTEMPTS:
                    logger.warning(
                        f"Schema patch attempt {attempt}/{MAX_PATCH_ATTEMPTS} failed ({last_error}); "
                        f"retrying with an LLM self-correction call using the exact failing path(s)..."
                    )
                    retry_note = format_schema_retry_context(patches, patch_result)

            raise HTTPException(
                status_code=422,
                detail=f"Schema Agent failed to apply edits because it generated an invalid JSON patch operation, "
                       f"even after a retry with the exact schema paths. Error: {last_error}. Please try again."
            )

        # Run concurrently using asyncio.gather to prevent exceeding Render's 100s timeout.
        # Since these are now fully async, they won't deadlock httpx like the threadpool did!
        results = await asyncio.gather(
            run_prompt_task(),
            run_schema_task(),
            return_exceptions=True
        )

        # Process results and handle partial success
        errors = {"prompt": None, "schema": None}
        prompt_result, schema_result = results

        if isinstance(prompt_result, Exception):
            if isinstance(prompt_result, HTTPException):
                errors["prompt"] = prompt_result.detail
            else:
                errors["prompt"] = str(prompt_result)
            prompt_result = req.prompt  # Fallback to original
            
        if isinstance(schema_result, Exception):
            if isinstance(schema_result, HTTPException):
                errors["schema"] = schema_result.detail
            else:
                errors["schema"] = str(schema_result)
            schema_result = req.json_schema  # Fallback to original

        # If both failed, we still want to throw a 422 to halt everything
        if isinstance(results[0], Exception) and isinstance(results[1], Exception):
            raise HTTPException(
                status_code=422, 
                detail=f"Both updates failed.\nPrompt Error: {errors['prompt']}\nSchema Error: {errors['schema']}"
            )

        return {
            "new_prompt": prompt_result,
            "new_json_schema": schema_result,
            "errors": errors
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/verify")
def verify_alignment(req: VerifyRequest):
    try:
        caller = get_caller(req)
        verification_agent = VerificationAgent(llm_caller=caller)

        prompt_instruction = req.prompt_instruction
        schema_instruction = req.schema_instruction
        auto_fixed = False
        result = {}

        # Mirrors the patch-retry pattern used for prompt/schema edits: on a detected
        # misalignment, don't just report it — apply the verifier's own suggested fix and
        # re-check once before surfacing anything to the user. The suggestion is itself draft
        # replacement text for whichever side is wrong (schema_updater_instruction to fix the
        # schema side, prompt_updater_instruction to fix the prompt side) — prefer fixing the
        # schema to match the prompt, since the prompt is normally the primary statement of
        # intent, falling back to a prompt-side fix only if no schema-side suggestion was given.
        for attempt in range(1, MAX_VERIFY_ATTEMPTS + 1):
            result = verification_agent.verify_alignment(prompt_instruction, schema_instruction)
            if result.get("is_aligned"):
                break
            if attempt >= MAX_VERIFY_ATTEMPTS:
                break
            fix_schema = result.get("schema_updater_instruction")
            fix_prompt = result.get("prompt_updater_instruction")
            if fix_schema:
                schema_instruction = fix_schema
            elif fix_prompt:
                prompt_instruction = fix_prompt
            else:
                break  # nothing to auto-correct with — no point retrying
            auto_fixed = True
            logger.info(
                f"Verification: misalignment detected, auto-correcting via "
                f"{'schema' if fix_schema else 'prompt'}_updater_instruction and re-verifying..."
            )

        result["prompt_instruction"] = prompt_instruction
        result["schema_instruction"] = schema_instruction
        result["auto_fixed"] = auto_fixed
        return result
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/verify_output")
def verify_output(req: VerifyOutputRequest):
    try:
        caller = get_caller(req)
        verification_agent = VerificationAgent(llm_caller=caller)
        result = verification_agent.verify_outputs(req.prompt, req.json_schema)
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Full document verification failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

from app.utils.schema_sanitizer import prepare_schema_for_provider

@app.post("/api/trial_run")
def trial_run(req: TrialRunRequest):
    logger.info("Received /api/trial_run request")
    try:
        caller = get_caller(req)

        # Parse schema — if empty/blank, run in free-form mode (no JSON enforcement)
        schema_dict = None
        if req.json_schema.strip():
            try:
                schema_dict = json.loads(req.json_schema)
            except json.JSONDecodeError:
                try:
                    schema_dict = json_repair.loads(req.json_schema)
                    logger.info("Trial run schema auto-repaired successfully.")
                except Exception as e:
                    raise HTTPException(status_code=422, detail=f"Your JSON Schema has syntax errors. Please fix them before running a trial: {str(e)}")

            # Adjust schema for the target provider's structured-output API (Gemini's OpenAPI 3.0
            # parser vs. the OpenAI-function-calling shape used by openai/anthropic/groq/openrouter)
            schema_dict = prepare_schema_for_provider(schema_dict, caller.provider)

        # Construct input
        input_text = ""
        if req.knowledge_base.strip():
            input_text += f"Knowledge Base:\n{req.knowledge_base}\n\n"
        input_text += f"Query:\n{req.query}"

        if schema_dict:
            # Schema available — enforce structured JSON output
            logger.info("Trial run mode: structured JSON output (schema provided).")
            try:
                result = caller.run(
                    input_text=input_text,
                    system_prompt=req.prompt,
                    json_format=schema_dict
                )
            except Exception as e:
                error_msg = str(e)
                if "has no attribute" in error_msg or "schema" in error_msg.lower() or "openapi" in error_msg.lower():
                    raise HTTPException(
                        status_code=422,
                        detail=f"Your JSON Schema is structurally invalid and could not be parsed by the LLM SDK. Ensure 'properties' and 'items' are objects, not strings. Internal error: {error_msg}"
                    )
                raise
        else:
            # No schema — free-form text output
            logger.info("Trial run mode: free-form text output (no schema provided).")
            result = caller.run_freeform(
                input_text=input_text,
                system_prompt=req.prompt,
            )

        # Try to pretty-print JSON; if not JSON just return raw text
        try:
            parsed_result = json.loads(result)
            formatted_result = json.dumps(parsed_result, indent=2)
        except Exception:
            formatted_result = result

        return {"result": formatted_result}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Trial run failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat/stream")
async def chat_stream(req: ChatStreamRequest):
    try:
        caller = get_caller(req)  # raises 400 early if no key is resolvable for the chosen provider
        copilot = ChatCopilotAgent(llm_caller=caller)
        schema_val = req.json_schema or req.schema_content or ""
        messages_list = [m.model_dump() for m in req.messages]
        if req.message and (not messages_list or messages_list[-1].get("text") != req.message):
            messages_list.append({"role": "user", "text": req.message})

        return StreamingResponse(
            copilot.stream_chat(
                session_id=req.session_id,
                messages=messages_list,
                prompt=req.prompt or "",
                json_schema=schema_val
            ),
            media_type="text/event-stream"
        )
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Chat stream endpoint error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat/clear")
def chat_clear(req: ChatClearRequest):
    # No-op: each ChatCopilotAgent's checkpointer is request-scoped (see copilot.py), so there is
    # no server-side session state to actually clear. Kept as a real endpoint purely because the
    # frontend calls it when a user resets a chat — a 200 here just confirms nothing needs doing.
    return {"status": "cleared", "session_id": req.session_id}


# --- Test & Optimization Lab Endpoints ---
active_lab_engines: dict[str, OptimizationLabEngine] = {}

@app.post("/api/lab/generate_kb")
async def lab_generate_kb(req: LabGenerateKBRequest):
    try:
        caller = get_caller(req)
        gens = LabGenerators(caller)
        kb = await gens.generate_kb(req.prompt, req.json_schema or "")
        return {"kb": kb}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate KB failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/lab/generate_criteria")
async def lab_generate_criteria(req: LabGenerateCriteriaRequest):
    try:
        caller = get_caller(req)
        gens = LabGenerators(caller)
        criteria = await gens.generate_criteria(req.prompt, req.json_schema or "")
        return {"criteria": criteria}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate Criteria failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/lab/generate_queries")
async def lab_generate_queries(req: LabGenerateQueriesRequest):
    try:
        kb_grounded = bool((req.kb or "").strip())
        if not kb_grounded:
            # Queries generated without a KB can only invent entities from the prompt/schema
            # rather than reference concrete, verifiable data — the whole point of the Lab's
            # KB <-> query interlinking. Callers (e.g. the Test Lab UI) should generate or paste
            # a Knowledge Base first; this is surfaced via `kb_grounded` rather than hard-blocked
            # server-side, since programmatic/API callers may intentionally want a KB-less draft.
            logger.warning(
                "lab/generate_queries called with no Knowledge Base — generated queries will "
                "reference entities invented from the prompt/schema alone, not grounded in real KB data."
            )
        caller = get_caller(req)
        gens = LabGenerators(caller)
        queries = await gens.generate_queries(
            prompt=req.prompt,
            kb=req.kb or "",
            json_schema=req.json_schema or "",
            count=req.count,
            levels=req.levels
        )
        return {
            "queries": [q.model_dump() for q in queries],
            "kb_grounded": kb_grounded,
            "warning": None if kb_grounded else (
                "No Knowledge Base was provided — these queries reference entities invented from the "
                "prompt/schema, not real, verifiable data. Generate or paste a Knowledge Base first for "
                "queries that are actually interlinked with it."
            )
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generate Queries failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/lab/stream")
async def lab_stream(req: LabStartOptimizationRequest):
    caller = get_caller(req)  # raises 400 early if no key is resolvable for the base config's provider

    # Build per-role callers if separate configs were provided. Each role can carry its own key
    # (evaluator_api_key/optimizer_api_key) so evaluator/optimizer can point at a different
    # provider than the base config — falling back to the base req.api_key if not given.
    def _make_caller_from_config(cfg, role: str, role_api_key: Optional[str]) -> LLMCaller:
        model_name = getattr(cfg, 'model', caller.model_name)
        explicit_provider = getattr(cfg, 'provider', None)
        provided_key = role_api_key or req.api_key or ""
        model_name, provider, effective_key, fallback_model = resolve_model_provider_and_key(
            model_name, explicit_provider, provided_key, role_label=f"the {role} override"
        )
        return LLMCaller(
            api_key=effective_key,
            model_name=model_name,
            model_provider=provider,
            thinking_level=getattr(cfg, 'thinking_level', caller.thinking_level),
            fallback_model=fallback_model,
            supports_reasoning=getattr(cfg, 'supports_reasoning', None)
        )

    evaluator_caller = _make_caller_from_config(req.evaluator_config, "evaluator", req.evaluator_api_key) if req.evaluator_config else None
    optimizer_caller = _make_caller_from_config(req.optimizer_config, "optimizer", req.optimizer_api_key) if req.optimizer_config else None

    # Warn (rather than silently proceed) if only one of evaluator/optimizer was overridden —
    # the other role then silently falls back to the base config's model, which can produce a
    # confusing loop (e.g. a strong evaluator rejecting a weaker optimizer's rewrites, or vice versa).
    config_warning = None
    if bool(req.evaluator_config) != bool(req.optimizer_config):
        overridden_role = "evaluator" if req.evaluator_config else "optimizer"
        silent_role = "optimizer" if req.evaluator_config else "evaluator"
        config_warning = (
            f"Only the {overridden_role}_config was overridden — the {silent_role} will silently use the base "
            f"config's model ('{caller.model_name}'). If these two roles differ significantly in capability, "
            f"the optimization loop may struggle to converge."
        )
        logger.warning(f"Lab session {req.session_id}: {config_warning}")

    engine = OptimizationLabEngine(
        llm_caller=caller,
        evaluator_caller=evaluator_caller,
        optimizer_caller=optimizer_caller,
    )
    active_lab_engines[req.session_id] = engine

    initial_state = {
        "session_id": req.session_id,
        "base_prompt": req.base_prompt,
        "candidate_prompt": req.base_prompt,
        "json_schema": req.json_schema or "",
        "kb_text": req.kb_text or "",
        "acceptance_criteria": req.acceptance_criteria,
        "test_queries": [q.model_dump() for q in req.test_queries],
        "eval_mode": req.eval_mode,
        "iteration": 1,
        "max_iterations": req.max_iterations,
        "pass_threshold": req.pass_threshold,
        "query_results": [],
        "score": 0,
        "critique": "",
        "is_passed": False,
        "user_action": "continue",
        "proposed_prompt": req.base_prompt,
        "proposed_schema": req.json_schema or "",
        "prompt_instruction": "",
        "schema_instruction": "",
        "history": [],
        "report_markdown": ""
    }

    config = {"configurable": {"thread_id": req.session_id}}

    async def event_generator():
        try:
            yield f"data: {json.dumps({'type': 'lab_started', 'session_id': req.session_id, 'config_warning': config_warning})}\n\n"
            async for chunk in engine.graph.astream(initial_state, config=config):
                for node_name, node_output in chunk.items():
                    if node_name == "__interrupt__":
                        interrupts = node_output if isinstance(node_output, (list, tuple)) else [node_output]
                        for intr in interrupts:
                            val = getattr(intr, "value", intr)
                            yield f"data: {json.dumps({'type': 'interrupt', 'payload': val}, default=str)}\n\n"
                        continue
                    yield f"data: {json.dumps({'type': 'node_complete', 'node': node_name, 'output': node_output}, default=str)}\n\n"

            snapshot = engine.graph.get_state(config)
            if snapshot.next and "human_review" in snapshot.next:
                tasks = snapshot.tasks
                if tasks and tasks[0].interrupts:
                    int_payload = getattr(tasks[0].interrupts[0], "value", tasks[0].interrupts[0])
                    yield f"data: {json.dumps({'type': 'interrupt', 'payload': int_payload}, default=str)}\n\n"
            elif not snapshot.next:
                final_state = snapshot.values
                yield f"data: {json.dumps({'type': 'lab_complete', 'final_state': final_state}, default=str)}\n\n"

            yield "data: {\"type\": \"done\"}\n\n"
        except Exception as e:
            logger.error(f"Lab stream error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            yield "data: {\"type\": \"done\"}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")

@app.post("/api/lab/resume")
async def lab_resume(req: LabResumeRequest):
    engine = active_lab_engines.get(req.session_id)
    if not engine:
        raise HTTPException(status_code=404, detail="Active lab session not found.")

    config = {"configurable": {"thread_id": req.session_id}}

    async def resume_generator():
        try:
            resume_cmd = Command(resume={
                "action": req.action,
                "user_critique": req.user_critique or "",
                "prompt_instruction": req.prompt_instruction or "",
                "schema_instruction": req.schema_instruction or ""
            })
            yield f"data: {json.dumps({'type': 'lab_resumed', 'action': req.action})}\n\n"

            async for chunk in engine.graph.astream(resume_cmd, config=config):
                for node_name, node_output in chunk.items():
                    if node_name == "__interrupt__":
                        interrupts = node_output if isinstance(node_output, (list, tuple)) else [node_output]
                        for intr in interrupts:
                            val = getattr(intr, "value", intr)
                            yield f"data: {json.dumps({'type': 'interrupt', 'payload': val}, default=str)}\n\n"
                        continue
                    yield f"data: {json.dumps({'type': 'node_complete', 'node': node_name, 'output': node_output}, default=str)}\n\n"

            snapshot = engine.graph.get_state(config)
            if snapshot.next and "human_review" in snapshot.next:
                tasks = snapshot.tasks
                if tasks and tasks[0].interrupts:
                    int_payload = getattr(tasks[0].interrupts[0], "value", tasks[0].interrupts[0])
                    yield f"data: {json.dumps({'type': 'interrupt', 'payload': int_payload}, default=str)}\n\n"
            elif not snapshot.next:
                final_state = snapshot.values
                yield f"data: {json.dumps({'type': 'lab_complete', 'final_state': final_state}, default=str)}\n\n"

            yield "data: {\"type\": \"done\"}\n\n"
        except Exception as e:
            logger.error(f"Lab resume error: {e}")
            yield f"data: {json.dumps({'type': 'error', 'error': str(e)})}\n\n"
            yield "data: {\"type\": \"done\"}\n\n"

    return StreamingResponse(resume_generator(), media_type="text/event-stream")

