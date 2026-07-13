from typing import Any, List, Optional
from pydantic import BaseModel, Field

class AgentConfig(BaseModel):
    model: str = "gemini-3.1-flash-lite"
    thinking_level: str = "Low"

# --- API Models ---
class StreamPromptRequest(BaseModel):
    api_key: str
    config: AgentConfig
    instruction: str
    target_model: str

class StreamSchemaRequest(BaseModel):
    api_key: str
    config: AgentConfig
    instruction: str

class OrchestrateRequest(BaseModel):
    api_key: str
    config: AgentConfig
    prompt: str
    json_schema: str
    user_request: str

class ApplyEditsRequest(BaseModel):
    api_key: str
    config: AgentConfig
    prompt: str
    json_schema: str
    prompt_instruction: str
    schema_instruction: str

class VerifyRequest(BaseModel):
    api_key: str
    config: AgentConfig
    prompt_instruction: str
    schema_instruction: str

class VerifyOutputRequest(BaseModel):
    api_key: str
    config: AgentConfig
    prompt: str
    json_schema: str

# --- Orchestrator Models ---
class Schema(BaseModel):
    prompt_instruction: str
    json_schema_instruction: str
    run_prompt_agent: bool
    run_schema_agent: bool

# --- Agent Models ---
class SearchReplaceEditModel(BaseModel):
    search: str = Field(description="The exact text snippet in the original prompt to search for.")
    replace: str = Field(description="The new text snippet to replace the search snippet with.")

class PromptEditsModel(BaseModel):
    edits: List[SearchReplaceEditModel]

class JsonPatchEditModel(BaseModel):
    op: str = Field(description="The JSON patch operation (e.g., 'add', 'remove', 'replace').")
    path: str = Field(description="The JSON pointer path (e.g., '/properties/new_field').")
    value: Optional[Any] = Field(default=None, description="The value to add or replace. Required for 'add' and 'replace' ops.")

class SchemaEditsModel(BaseModel):
    edits: List[JsonPatchEditModel]

class VerificationResultModel(BaseModel):
    is_aligned: bool = Field(description="True if the prompt and schema instructions do the same thing and align perfectly, False otherwise.")
    reason: str = Field(description="A brief explanation of why they are aligned or what is missing/misaligned.")
    match_with_prompt_instruction: Optional[str] = Field(default=None, description="If is_aligned is False, provide specific instructions to the JSON Schema Updater on exactly what fields/properties to add, remove, or change so the Schema matches the Prompt's intent.")
    match_with_schema_instruction: Optional[str] = Field(default=None, description="If is_aligned is False, provide specific instructions to the Prompt Updater on exactly what text or requirements to rewrite so the System Prompt matches the JSON Schema's structure.")
