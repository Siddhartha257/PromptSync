import json
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from app.core.llm import LLMCaller
from app.agents.orchestrator import Orch
from app.agents.generators import PromptUpdaterAgent, SchemaUpdaterAgent, PromptCreatorAgent, SchemaCreatorAgent
from app.agents.verification import VerificationAgent
from app.utils.patcher import apply_llm_edits
from app.utils.json_patcher import JsonSchemaPatchEngine
from app.models.schemas import (
    StreamPromptRequest, StreamSchemaRequest, OrchestrateRequest, ApplyEditsRequest, VerifyRequest, VerifyOutputRequest
)

app = FastAPI(title="Prompter Studio API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Initialize singletons
llm_caller = LLMCaller()
orchestrator = Orch(llm_caller=llm_caller)
prompt_updater = PromptUpdaterAgent(llm_caller=llm_caller)
schema_updater = SchemaUpdaterAgent(llm_caller=llm_caller)
prompt_creator = PromptCreatorAgent(llm_caller=llm_caller)
schema_creator = SchemaCreatorAgent(llm_caller=llm_caller)
verification_agent = VerificationAgent(llm_caller=llm_caller)
json_patch_engine = JsonSchemaPatchEngine(debug=True)

@app.post("/api/stream/prompt")
def stream_prompt(req: StreamPromptRequest):
    def iter_stream():
        try:
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
        schema_plan = orchestrator.run(
            prompt=req.prompt,
            json_schema=req.json_schema,
            user_request=req.user_request
        )
        return schema_plan.model_dump()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/apply_edits")
def apply_edits(req: ApplyEditsRequest):
    try:
        new_prompt = req.prompt
        if req.prompt_instruction.strip():
            edits = prompt_updater.generate_edits(req.prompt, req.prompt_instruction)
            patch_result = apply_llm_edits(req.prompt, edits)
            new_prompt = patch_result.updated_text

        new_schema = req.json_schema
        if req.schema_instruction.strip():
            patches = schema_updater.generate_edits(req.json_schema, req.schema_instruction)
            schema_dict = json.loads(req.json_schema)
            patch_result = json_patch_engine.apply(schema_dict, patches)
            if not patch_result.success:
                raise Exception(f"JSON Patch Failed: {patch_result.error}")
            new_schema = json.dumps(patch_result.updated_schema, indent=2)

        return {
            "new_prompt": new_prompt,
            "new_json_schema": new_schema
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/verify")
def verify_alignment(req: VerifyRequest):
    try:
        result = verification_agent.verify_alignment(req.prompt_instruction, req.schema_instruction)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/verify_output")
def verify_output(req: VerifyOutputRequest):
    try:
        result = verification_agent.verify_outputs(req.prompt, req.json_schema)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
