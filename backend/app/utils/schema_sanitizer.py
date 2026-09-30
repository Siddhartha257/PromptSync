"""Schema sanitization utilities for LLM structured output and validation."""

def prepare_schema_for_provider(schema, provider: str):
    """Adjusts a user-authored JSON Schema for the target provider's structured-output API.

    - google_genai: strips any JSON Schema keyword google.genai.types.Schema doesn't recognize
      (e.g. multipleOf, $schema, examples) — see sanitize_schema_for_gemini.
    - openai / anthropic / groq / openrouter: all go through LangChain's standard function/tool-
      calling machinery (langchain_core.utils.function_calling.convert_to_openai_function), which
      requires a top-level 'title' to name the generated function/tool and raises a ValueError
      without one. Stripping it (as the Gemini path does) breaks these providers outright — inject
      a generic one instead if the schema doesn't already have one.
    """
    if provider == "google_genai":
        return sanitize_schema_for_gemini(schema)
    if isinstance(schema, dict) and not schema.get("title"):
        schema = {**schema, "title": "response"}
    return schema


# The set of JSON-Schema-style keys google.genai.types.Schema's *client-side* Pydantic model
# declares (read off its field aliases) — minus "additionalProperties", "title", and "default",
# which the model happily accepts locally but Gemini's live generateContent API actually rejects
# ("Unknown name 'additional_properties' at 'generation_config.response_schema': Cannot find
# field" — a real 400 from the API itself, not a client-side validation error). The SDK's declared
# type isn't a reliable proxy for what the live endpoint supports, so don't add a field back here
# without confirming it against a real request first.
#
# Its model forbids unknown fields outright, so ANY other JSON Schema keyword — multipleOf,
# uniqueItems, oneOf/allOf/not, const, contains, patternProperties, examples (plural),
# readOnly/writeOnly, $schema, $id, $comment, ... — raises a hard "extra_forbidden" validation
# error deep inside the SDK the moment it tries to build the request. A user-authored schema (or
# one produced by a generic `model_json_schema()`/JSON-Schema tool) can easily contain any of
# these, so this has to be an allowlist, not a denylist of the couple of keys noticed so far.
_GEMINI_SCHEMA_ALLOWED_KEYS = {
    "defs", "ref", "anyOf", "description", "enum", "example",
    "format", "items", "maxItems", "maxLength", "maxProperties", "maximum", "minItems",
    "minLength", "minProperties", "minimum", "nullable", "pattern", "properties",
    "propertyOrdering", "required", "type",
}


def sanitize_schema_for_gemini(schema, is_in_properties=False):
    """Recursively strips any JSON Schema keyword google.genai.types.Schema doesn't recognize —
    see _GEMINI_SCHEMA_ALLOWED_KEYS."""
    if not isinstance(schema, dict):
        return schema

    if is_in_properties:
        # `schema` here IS a `properties` dict: its keys are arbitrary user-chosen field names
        # (could literally be "title", "type", "default", ...), not schema keywords — keep every
        # key as-is and just recurse into each field's own nested schema.
        return {
            field_name: sanitize_schema_for_gemini(field_schema, is_in_properties=False)
            for field_name, field_schema in schema.items()
        }

    sanitized = {}
    for key, value in schema.items():
        if key not in _GEMINI_SCHEMA_ALLOWED_KEYS:
            continue
        if isinstance(value, dict):
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
