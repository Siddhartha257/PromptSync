import os
import json
import json_repair
import logging
import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.concurrency import run_in_threadpool

logger = logging.getLogger("api")
if not logger.handlers:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s | %(name)s | %(message)s")

from app.core.llm import LLMCaller
from app.agents.orchestrator import Orch
from app.agents.generators import PromptUpdaterAgent, SchemaUpdaterAgent, PromptCreatorAgent, SchemaCreatorAgent
from app.agents.verification import VerificationAgent
from app.utils.patcher import apply_llm_edits
from app.utils.json_patcher import JsonSchemaPatchEngine
from app.models.schemas import (
    StreamPromptRequest, StreamSchemaRequest, OrchestrateRequest, ApplyEditsRequest, VerifyRequest, VerifyOutputRequest, TrialRunRequest
)

app = FastAPI(title="Prompter Studio API")

frontend_url_env = os.getenv("FRONTEND_URL")
allowed_origins = [url.strip() for url in frontend_url_env.split(",")]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

json_patch_engine = JsonSchemaPatchEngine(debug=True)

def get_caller(req_base) -> LLMCaller:
    temperature = getattr(req_base.config, 'temperature', 0.7)
    return LLMCaller(
        api_key=req_base.api_key,
        model_name=req_base.config.model,
        thinking_level=req_base.config.thinking_level,
        temperature=temperature
    )

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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/apply_edits")
async def apply_edits(req: ApplyEditsRequest):
    try:
        def run_prompt_task():
            if not req.prompt_instruction.strip():
                return req.prompt
            
            # Instantiate strictly inside the thread to isolate httpx connection pools
            local_caller = get_caller(req)
            local_prompt_updater = PromptUpdaterAgent(llm_caller=local_caller)
            
            try:
                edits = local_prompt_updater.generate_edits(req.prompt, req.prompt_instruction)
            except Exception as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Prompt Agent failed to generate valid JSON edits. The model may have hallucinated or hit output limits. Error: {str(e)}. Try switching to a more capable model."
                )
            patch_result = apply_llm_edits(req.prompt, edits)
            if not patch_result.success:
                failed = [
                    f"Edit {r_idx+1}: could not locate search string '{edits[r_idx].search[:80].replace(chr(10), '↵')}...'"
                    for r_idx, r in enumerate(patch_result.edit_results)
                    if not r.success
                ]
                raise HTTPException(
                    status_code=422,
                    detail=(
                        f"{len(failed)} of {len(edits)} prompt patch edit(s) failed to apply — "
                        f"the search string was not found in the current prompt text. "
                        f"Failed edits: {'; '.join(failed)}. "
                        f"Try switching to a more capable generator model in Settings."
                    )
                )
            return patch_result.updated_text

        def run_schema_task():
            if not req.schema_instruction.strip():
                return req.json_schema
            logger.info("Applying schema edits...")
            
            # Instantiate strictly inside the thread to isolate httpx connection pools
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
            
            try:
                patches = local_schema_updater.generate_edits(req.json_schema, req.schema_instruction)
            except Exception as e:
                raise HTTPException(
                    status_code=422,
                    detail=f"Schema Agent failed to generate valid JSON patches. The model may have hallucinated or hit output limits. Error: {str(e)}. Try switching to a more capable model."
                )
            patch_result = json_patch_engine.apply(schema_dict, patches)
            if not patch_result.success:
                raise HTTPException(
                    status_code=422,
                    detail=f"Schema Agent failed to apply edits because it generated an invalid JSON patch operation. Error: {patch_result.error}. Please try again."
                )
            return json.dumps(patch_result.updated_schema, indent=2)

        # Run safely in FastAPI's native threadpool. 
        # return_exceptions=True prevents one task failure from silently killing the gather loop prematurely
        results = await asyncio.gather(
            run_in_threadpool(run_prompt_task),
            run_in_threadpool(run_schema_task),
            return_exceptions=True
        )

        # Process results and re-raise any exceptions that occurred in the threads
        for result in results:
            if isinstance(result, Exception):
                raise result

        new_prompt, new_schema = results

        return {
            "new_prompt": new_prompt,
            "new_json_schema": new_schema
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
        result = verification_agent.verify_alignment(req.prompt_instruction, req.schema_instruction)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/verify_output")
def verify_output(req: VerifyOutputRequest):
    try:
        caller = get_caller(req)
        verification_agent = VerificationAgent(llm_caller=caller)
        result = verification_agent.verify_outputs(req.prompt, req.json_schema)
        return result
    except Exception as e:
        logger.error(f"Full document verification failed: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

def sanitize_schema_for_gemini(schema, is_in_properties=False):
    """Recursively removes keys that the Gemini SDK's OpenAPI 3.0 parser rejects."""
    if not isinstance(schema, dict):
        return schema
        
    sanitized = {}
    for key, value in schema.items():
        if key in ["$schema", "$id", "additionalProperties"]:
            continue
            
        if key in ["default", "title"]:
            # If we are inside a 'properties' block, 'title' and 'default' are actually the names 
            # of the user's fields, NOT schema metadata. Don't strip them!
            if not is_in_properties:
                continue
            
        if isinstance(value, dict):
            # If the current key is "properties", then its children are user-defined fields
            child_is_props = (key == "properties")
            sanitized[key] = sanitize_schema_for_gemini(value, is_in_properties=child_is_props)
        elif isinstance(value, list):
            sanitized[key] = [
                sanitize_schema_for_gemini(item, is_in_properties=False) if isinstance(item, dict) else item 
                for item in value
            ]
        else:
            sanitized[key] = value
            
    return sanitized

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

            # Sanitize schema for Gemini OpenAPI 3.0 compatibility
            schema_dict = sanitize_schema_for_gemini(schema_dict)

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
