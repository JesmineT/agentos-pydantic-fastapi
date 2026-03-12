# AgentOS — Full Stack AI Agent

A complete AI agent application demonstrating every layer of the stack.

```
[ React Frontend ]
        ↕
  [ FastAPI ]         ← Web server / API layer
        ↕
  [ PydanticAI ]  ←── 👁️ Observability (Logfire)
  ↙    📝 Memory   ↘
Tools &          Structured
MCP Servers      Responses
  ↘      ↕        ↙
[ AI Model + vLLM ]
        ↕
[ PostgreSQL + Redis ]
```

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Frontend | React + Vite | User interface |
| API Server | FastAPI | HTTP routing, request validation |
| Agent Framework | PydanticAI | Agent logic, structured outputs, tools |
| AI Model | OpenAI / vLLM | Language model |
| Short-term Memory | Redis | Session state, conversation cache |
| Long-term Storage | PostgreSQL | Users, messages, traces |
| Observability | Logfire / custom | Tracing, artifact logging |
| MCP Servers | Custom MCPServer | Standardised tool protocol |

## Project Structure

```
agentOS/
├── docker-compose.yml        # PostgreSQL + Redis
├── backend/
│   ├── main.py               # FastAPI app + all routes
│   ├── agent.py              # PydanticAI agent definition
│   ├── tools.py              # Tools + MCP server implementations
│   ├── database.py           # SQLAlchemy models (PostgreSQL)
│   ├── cache.py              # Redis session cache
│   ├── observability.py      # Tracing + artifact logging
│   ├── requirements.txt      # Python dependencies
│   └── .env.example          # Environment variables template
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx          # React entry point
        ├── App.jsx           # Full UI application
        └── api.js            # All backend API calls
```

## Getting Started

### 1. Start databases
```bash
docker-compose up -d
```

### 2. Configure backend
```bash
cd backend
cp .env.example .env
# Add your ANTHROPIC_API_KEY to .env
```

### 3. Run backend
```bash
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
# API docs: http://localhost:8000/docs
```

### 4. Run frontend
```bash
cd frontend
npm install
npm run dev
# App: http://localhost:5173
```

## Switching to vLLM

```bash
# 1. Start vLLM
pip install vllm
python -m vllm.entrypoints.openai.api_server \
  --model meta-llama/Llama-3-8b-instruct --port 8001

# 2. Update .env
VLLM_BASE_URL=http://localhost:8001
VLLM_MODEL=meta-llama/Llama-3-8b-instruct
```

The `agent.py` `get_model()` function switches automatically based on env vars.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | Send message to agent |
| GET | `/api/traces` | Observability traces |
| GET | `/api/state/{user_id}` | Session state |
| PUT | `/api/state/{user_id}` | Update state |
| GET | `/api/mcp/tools` | List MCP tools |
| GET | `/api/health` | Health check |

## Observability

Every agent run generates:
- A trace record in the UI (Traces tab)
- A log line in `agentOS_traces.log`
- A JSON artifact in `agentOS_artifacts.jsonl`
- A database record in the `traces` table

Enable full Logfire: add `LOGFIRE_TOKEN` to `.env` and uncomment the Logfire lines in `observability.py`.

## Why These Choices?

**PydanticAI over LangChain** - cleaner API, better type safety, easier to debug, no magic chains.

**FastAPI over Flask** - async by default, automatic OpenAPI docs, Pydantic built-in.

**Redis + PostgreSQL** - Redis for fast session reads (<1ms), PostgreSQL for durable long-term storage.

**vLLM as alternative** - privacy (data stays local), cost savings at scale, fastest open-source inference engine.
