from typing import Any, List, Optional
from pydantic import BaseModel, Field

class AgentConfig(BaseModel):
    model: str = "gemini-3.5-flash-lite"
    thinking_level: str = "Low"
    provider: Optional[str] = Field(
        default=None,
        description="Explicit LLM provider override: 'google_genai' | 'openai' | 'anthropic' | "
                    "'groq' | 'openrouter'. Required for groq/openrouter (their model names can't "
                    "be inferred, since both host overlapping models from many vendors). Optional "
                    "for the other three, where it's inferred from the model name if omitted."
    )
    supports_reasoning: Optional[bool] = Field(
        default=None,
        description="Only meaningful for provider='openrouter': whether the selected model was "
                    "reported (via /api/list_models' live lookup) to support OpenRouter's unified "
                    "`reasoning` parameter. Determines whether thinking_level is actually sent."
    )

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

class OptimizationPlanModel(BaseModel):
    """The Optimizer's output is PLAN-ONLY — no literal edits. A separate specialized agent
    (PromptUpdaterAgent / SchemaUpdaterAgent, the same ones /api/apply_edits uses) reads
    prompt_instruction/schema_instruction afterward and independently generates the actual
    document changes, exactly like the editor's own Orchestrator -> Updater flow."""
    summary: str = Field(description="High-level summary of the optimization plan")
    prompt_instruction: str = Field(description="Step-by-step instructions of rules/constraints added or modified in the prompt")
    schema_instruction: str = Field(default="No schema adjustments needed.", description="Instructions explaining any JSON schema adjustments, or note that schema remains unchanged")

class JsonPatchEditModel(BaseModel):
    op: str = Field(description="The JSON patch operation (e.g., 'add', 'remove', 'replace').")
    path: str = Field(description="The JSON pointer path (e.g., '/properties/new_field').")
    value: Optional[Any] = Field(default=None, description="The value to add or replace. Required for 'add' and 'replace' ops.")

class SchemaEditsModel(BaseModel):
    edits: List[JsonPatchEditModel]

class VerificationResultModel(BaseModel):
    is_aligned: bool = Field(description="True if the prompt and schema instructions do the same thing and align perfectly, False otherwise.")
    reason: str = Field(description="A brief explanation of why they are aligned or what is missing/misaligned.")
    schema_updater_instruction: Optional[str] = Field(default=None, description="If is_aligned is False, provide specific instructions to the JSON Schema Updater on exactly what fields/properties to add, remove, or change so the Schema matches the Prompt's intent.")
    prompt_updater_instruction: Optional[str] = Field(default=None, description="If is_aligned is False, provide specific instructions to the Prompt Updater on exactly what text or requirements to rewrite so the System Prompt matches the JSON Schema's structure.")

# --- Trial Run Models ---
class TrialRunConfig(BaseModel):
    model: str = "gemini-3.5-flash-lite"
    temperature: float = 0.7
    thinking_level: str = "Low"
    provider: Optional[str] = None
    supports_reasoning: Optional[bool] = None

class TrialRunRequest(BaseModel):
    api_key: str
    config: TrialRunConfig
    prompt: str
    json_schema: str
    knowledge_base: str
    query: str

# --- Chat Co-Pilot Models ---
class ChatMessageModel(BaseModel):
    id: Optional[str] = None
    role: str
    text: str
    timestamp: Optional[float] = None
    tool_calls: Optional[List[dict]] = None

class ChatStreamRequest(BaseModel):
    api_key: str
    config: Optional[AgentConfig] = None
    session_id: str
    messages: List[ChatMessageModel] = Field(default_factory=list)
    message: Optional[str] = None
    prompt: Optional[str] = ""
    json_schema: Optional[str] = ""
    schema_content: Optional[str] = Field(default=None, alias="schema")

    class Config:
        populate_by_name = True

class ChatClearRequest(BaseModel):
    session_id: str

class ChatActionProposal(BaseModel):
    summary: str
    prompt_instruction: str
    schema_instruction: str

# --- Test & Optimization Lab Models ---
class LabQueryItem(BaseModel):
    level: str = Field(description="Difficulty level e.g. L1, L2, L3, L4, L5")
    name: str = Field(description="Level name e.g. Happy Path, Edge Case, Adversarial")
    query: str = Field(description="The test query text")

class LabGenerateKBRequest(BaseModel):
    api_key: str
    config: AgentConfig
    prompt: str
    json_schema: Optional[str] = ""

class LabGenerateCriteriaRequest(BaseModel):
    api_key: str
    config: AgentConfig
    prompt: str
    json_schema: Optional[str] = ""

class LabGenerateCriteriaResponse(BaseModel):
    criteria: List[str] = Field(description="List of explicit, measurable acceptance criteria")

class LabGenerateQueriesRequest(BaseModel):
    api_key: str
    config: AgentConfig
    prompt: str
    kb: Optional[str] = ""
    json_schema: Optional[str] = ""
    count: int = Field(default=3, ge=1, le=5)
    levels: Optional[List[str]] = Field(default_factory=lambda: ["L1", "L2", "L5"])

class LabGenerateQueriesResponse(BaseModel):
    queries: List[LabQueryItem] = Field(description="Generated test query suite")

class LabStartOptimizationRequest(BaseModel):
    api_key: str
    config: AgentConfig
    evaluator_config: Optional[AgentConfig] = None  # If set, overrides config for evaluator agent
    optimizer_config: Optional[AgentConfig] = None  # If set, overrides config for optimizer agent
    evaluator_api_key: Optional[str] = None  # If set, used instead of api_key when evaluator_config resolves to a different provider
    optimizer_api_key: Optional[str] = None  # If set, used instead of api_key when optimizer_config resolves to a different provider
    base_prompt: str
    json_schema: Optional[str] = ""
    kb_text: Optional[str] = ""
    acceptance_criteria: List[str]
    test_queries: List[LabQueryItem]
    eval_mode: str = Field(default="hybrid", description="'autonomous' | 'hybrid'")
    max_iterations: int = Field(default=3, ge=1, le=5)
    pass_threshold: int = Field(
        default=100, ge=1, le=100,
        description="Minimum score (0-100) required to mark the suite as passed and stop early. "
                    "Defaults to 100 (all criteria must pass) but can be relaxed to accept a 'good enough' prompt."
    )
    session_id: str

class ListModelsRequest(BaseModel):
    provider: str
    api_key: str = ""

class LabResumeRequest(BaseModel):
    session_id: str
    action: str = Field(default="continue", description="'continue' | 'stop' | 'finish'")
    user_critique: Optional[str] = ""
    prompt_instruction: Optional[str] = ""
    schema_instruction: Optional[str] = ""

