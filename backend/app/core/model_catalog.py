"""Live model-list fetching for the settings UI's provider->model picker.

Backs POST /api/list_models. A static, hand-maintained catalog doesn't scale to OpenRouter's
200+ constantly-changing models, so instead of guessing what's available, this hits each
provider's own model-listing endpoint directly — which doubles as a real API-key validation
(an invalid key surfaces here as an HTTP error instead of only failing deep inside a later
generation call).

Every provider here is reached over plain REST (not each vendor's SDK) so the raw JSON —
including fields a typed SDK response model might drop, like OpenRouter's `supported_parameters`
— is available to inspect.
"""
import httpx
from typing import Any, Dict, List, Optional

# Providers whose model list is fetched via the OpenAI-compatible `GET /models` shape
# (`{"data": [{"id": ...}, ...]}`) with a bearer token — this covers OpenAI itself plus the two
# OpenAI-API-compatible aggregators.
_OPENAI_SHAPED_LIST_URLS = {
    "openai": "https://api.openai.com/v1/models",
    "groq": "https://api.groq.com/openai/v1/models",
    "openrouter": "https://openrouter.ai/api/v1/models",
}

# Anthropic and Claude model IDs that predate extended-thinking support — excluded from
# supports_reasoning since Anthropic's /models response carries no capability flag to check.
_ANTHROPIC_NO_THINKING_MARKERS = ("claude-2", "claude-instant", "claude-1")

# Groq and (especially) OpenRouter's /models list mixes real chat-completion models in with
# single-purpose utility models (safety/moderation classifiers, embeddings, rerankers, TTS/ASR,
# image generators) that share the same endpoint listing but 404 or behave nonsensically when sent
# a normal chat request. There's no reliable capability flag to detect these, so they're excluded
# by a substring denylist on the model id — this is what caused the Co-Pilot to silently default
# onto a model like "nvidia/nemotron-3.5-content-safety" and 404 on every message.
_NON_CHAT_MODEL_MARKERS = (
    "safety", "moderation", "guard", "embed", "rerank", "-tts", "text-to-speech",
    "speech-to-text", "whisper", "dall-e", "stable-diffusion", "image-generation",
)


async def list_models(provider: str, api_key: str) -> List[Dict[str, Any]]:
    """Fetches the live model catalog for a provider, normalized to
    [{"id": str, "label": str, "supports_reasoning": Optional[bool]}].

    `supports_reasoning` is only ever confidently known for OpenRouter (read straight off its
    `supported_parameters` field). For every other provider it's left None here — thinking-tier
    support for those is instead resolved by app.core.llm.resolve_thinking_tier's own
    hand-curated classification, which doesn't need this flag.

    Raises httpx.HTTPStatusError on an invalid/rejected key, or ValueError for an unknown provider.
    """
    if provider in _OPENAI_SHAPED_LIST_URLS:
        return await _list_openai_shaped(provider, api_key)
    if provider == "anthropic":
        return await _list_anthropic(api_key)
    if provider == "google_genai":
        return await _list_google(api_key)
    raise ValueError(f"Unknown provider '{provider}'")


async def _list_openai_shaped(provider: str, api_key: str) -> List[Dict[str, Any]]:
    headers = {"Authorization": f"Bearer {api_key}"}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(_OPENAI_SHAPED_LIST_URLS[provider], headers=headers)
        resp.raise_for_status()
        data = resp.json().get("data", [])

    results = []
    for m in data:
        model_id = m.get("id")
        if not model_id:
            continue
        if provider in ("groq", "openrouter") and any(marker in model_id.lower() for marker in _NON_CHAT_MODEL_MARKERS):
            continue
        supports_reasoning: Optional[bool] = None
        # Groq's `/models` response carries no capability flags, but the overwhelming majority
        # of its catalog supports OpenAI-style function calling on its own OpenAI-compatible
        # endpoint, so default to True there rather than leaving it unknown.
        supports_tools: Optional[bool] = True if provider == "groq" else None
        if provider == "openrouter":
            supported_params = m.get("supported_parameters") or []
            supports_reasoning = "reasoning" in supported_params
            supports_tools = "tools" in supported_params
        results.append({
            "id": model_id,
            "label": m.get("name") or model_id,
            "supports_reasoning": supports_reasoning,
            "supports_tools": supports_tools,
        })
    results.sort(key=lambda m: m["id"])
    return results


async def _list_anthropic(api_key: str) -> List[Dict[str, Any]]:
    headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get("https://api.anthropic.com/v1/models", headers=headers)
        resp.raise_for_status()
        data = resp.json().get("data", [])

    return [
        {
            "id": m["id"],
            "label": m.get("display_name", m["id"]),
            "supports_reasoning": not any(marker in m["id"] for marker in _ANTHROPIC_NO_THINKING_MARKERS),
            "supports_tools": True,
        }
        for m in data
        if m.get("id")
    ]


async def _list_google(api_key: str) -> List[Dict[str, Any]]:
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(
            "https://generativelanguage.googleapis.com/v1beta/models",
            params={"key": api_key, "pageSize": 1000},
        )
        resp.raise_for_status()
        data = resp.json().get("models", [])

    results = []
    for m in data:
        if "generateContent" not in (m.get("supportedGenerationMethods") or []):
            continue
        model_id = m.get("name", "").split("/", 1)[-1]
        if not model_id:
            continue
        results.append({
            "id": model_id,
            "label": m.get("displayName", model_id),
            "supports_reasoning": None,
            "supports_tools": None,
        })
    return results
