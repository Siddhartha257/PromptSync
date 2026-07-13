import os
import httpx
from google import genai
from google.genai import types
import json

api_key = os.environ.get("GEMINI_API_KEY", "")

client = genai.Client(api_key=api_key)

try:
    response = client.models.generate_content(
        model='gemma-4-31b-it',
        contents='Hello',
        config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(include_thoughts=True)
        )
    )
    print("SUCCESS")
except Exception as e:
    print(f"FAILED: {e}")
