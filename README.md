# PromptSync ⚡

PromptSync is a professional, high-fidelity IDE designed for **Prompt Engineering** and **JSON Schema Architecture**. Re-engineered from the ground up to follow structured, modular software architecture principles, it features a glassmorphic design and scroll-driven micro-animations.

It implements a **Dual-Agent pipeline** to help developers architect, iterate, and verify LLM instructions with strict structural safety.

---

## Key Features

*   **Dual-Agent Orchestration**: Breaks down complex natural language intents into coordinated sub-instructions for Prompt (System Instructions) and Schema (JSON Output Constraints) agents.
*   **Real-time Split-Pane Streaming**: Watch prompt logic and JSON Schema materialize simultaneously, side-by-side.
*   **Deterministic Alignment Verification**: Automatically cross-references system prompts against JSON schemas to check for missing properties, ghost fields, or constraint conflicts using LLMs.
*   **Surgical Diff Editing**: Apply edits using text search-replace engines and RFC 6902 JSON patch engines. Review word-level diffs side-by-side before updating your workspace.
*   **Modular Architecture**: Isolated prompt assets, type-safe API schemas, and robust error handling built for scale.

---

## Directory Structure

```text
PromptSync/
├── backend/
│   ├── app/
│   │   ├── main.py             # FastAPI entry point & API routes
│   │   ├── core/
│   │   │   └── llm.py          # LLM Call / Google GenAI abstraction
│   │   ├── models/
│   │   │   └── schemas.py      # Type-safe request/response Pydantic models
│   │   ├── agents/
│   │   │   ├── orchestrator.py # Master orchestration agent
│   │   │   ├── generators.py   # Creator / Updater agents
│   │   │   └── verification.py # Prompt/Schema alignment verifiers
│   │   ├── prompts/
│   │   │   ├── orchestrator.py # Orchestrator system prompts
│   │   │   ├── creators.py     # Prompt/Schema scratch creation prompts
│   │   │   ├── updaters.py     # Update prompts
│   │   │   └── verifier.py     # Verification prompts
│   │   └── utils/
│   │       ├── patcher.py      # Search-replace text patching engine
│   │       └── json_patcher.py # RFC 6902 JSON schema patching engine
│   └── .env                    # API keys and backend settings
│
└── frontend/
    ├── src/
    │   ├── context/
    │   │   └── ThemeContext.tsx # HMR-friendly theme provider
    │   ├── services/
    │   │   └── api.ts          # Centralized API service configuration
    │   ├── pages/
    │   │   ├── Home.tsx        # Hero landing page & scratch building
    │   │   └── Editor.tsx      # Split-pane IDE workspace & diff reviewer
    │   ├── App.tsx             # Root router & persistent layout wrapper
    │   └── index.css           # Glassmorphic UI design tokens & theme layers
    └── vite.config.ts          # Vite asset pipeline configuration
```

---

## Getting Started

### Prerequisites
- Node.js (v18+)
- Python (3.10+)
- Gemini API Key (Google AI Studio)

---

### 1. Backend Setup

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Create and activate a virtual environment:
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   ```
3. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```
4. Create a `.env` file in the `backend/` directory:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
5. Run the server:
   ```bash
   uvicorn app.main:app --reload
   ```
   *The backend will be running on `http://localhost:8000`.*

---

### 2. Frontend Setup

1. Open a new terminal and navigate to the frontend directory:
   ```bash
   cd frontend
   ```
2. Install npm dependencies:
   ```bash
   npm install
   ```
3. Run the development server:
   ```bash
   npm run dev
   ```
   *The frontend will boot up on `http://localhost:5173`.*

---

## Verification & Deployment

To verify the TypeScript builds compile cleanly without emitting errors, run:
```bash
cd frontend
npm run build
# or to check types only:
npx tsc --noEmit
```
