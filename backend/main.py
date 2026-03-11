# backend/main.py
# ─────────────────────────────────────────────────────────────
# FASTAPI APPLICATION — THE FRONT DOOR
#
# FastAPI is the web server layer. It:
#   - Receives HTTP requests from the React frontend
#   - Validates request/response shapes with Pydantic
#   - Routes requests to the PydanticAI agent
#   - Returns structured JSON responses
#   - Serves the observability and state endpoints
#
# Routes:
#   POST /api/chat          → Send a message to the agent
#   GET  /api/traces        → Get observability traces
#   GET  /api/state/{uid}   → Get session state
#   PUT  /api/state/{uid}   → Update session state
#   GET  /api/mcp/tools     → List all available MCP tools
#   GET  /api/health        → Health check
# ─────────────────────────────────────────────────────────────

import os
import uuid
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, desc
from dotenv import load_dotenv

from database import init_db, get_db, User, Conversation, Message, Trace
from cache import get_session_state, save_session_state
from agent import run_agent
from observability import get_recent_traces
from tools import ALL_MCP_SERVERS

import logfire

from fastapi.responses import StreamingResponse
import json

from cache import get_session_state, save_session_state, get_recent_messages, save_recent_messages

load_dotenv()


# ── Startup / Shutdown ────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    """Runs on startup and shutdown."""
    print("🚀 AgentOS starting...")
    await init_db()                      # Create DB tables
    print("✅ Database ready")
    print("✅ Redis cache ready")
    print("✅ MCP servers ready:", list(ALL_MCP_SERVERS.keys()))
    print("🎯 AgentOS ready at http://localhost:8000")
    yield
    print("👋 AgentOS shutting down")


# ── App Instance ──────────────────────────────────────────────

app = FastAPI(
    title="AgentOS API",
    description="PydanticAI + FastAPI + vLLM AI Agent Backend",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS — allow React frontend to talk to this backend
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "http://localhost:5173").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Request / Response Models ─────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    user_id: Optional[str] = None         # Auto-generated if not provided
    conversation_id: Optional[str] = None  # Auto-generated for new conversations


class ChatResponse(BaseModel):
    answer: str
    tools_used: list[str]
    follow_up_suggestions: list[str]
    trace_id: str
    conversation_id: str
    user_id: str
    session_state: dict


class StateUpdateRequest(BaseModel):
    mode: Optional[str] = None            # "beginner" | "expert"
    active_tools: Optional[list[str]] = None


# ── Routes ────────────────────────────────────────────────────

@app.get("/api/health")
async def health_check():
    """Health check endpoint — confirms the server is running."""
    return {
        "status": "healthy",
        "service": "AgentOS",
        "version": "1.0.0",
        "mcp_servers": list(ALL_MCP_SERVERS.keys()),
    }


@app.post("/api/chat", response_model=ChatResponse)
async def chat(request: ChatRequest, db: AsyncSession = Depends(get_db)):
    """
    Main chat endpoint.
    
    1. Creates or loads user + conversation from PostgreSQL
    2. Runs the PydanticAI agent
    3. Saves message + trace to PostgreSQL
    4. Returns structured response
    """

    # Generate IDs if not provided (new session)
    user_id = request.user_id or f"user-{uuid.uuid4().hex[:8]}"
    conversation_id = request.conversation_id or f"conv-{uuid.uuid4().hex[:8]}"

    # Ensure user exists in DB
    user = await db.get(User, user_id)
    if not user:
        user = User(id=user_id)
        db.add(user)

    # Ensure conversation exists in DB
    conversation = await db.get(Conversation, conversation_id)
    if not conversation:
        conversation = Conversation(
            id=conversation_id,
            user_id=user_id,
            title=request.message[:50]  # Use first message as title
        )
        db.add(conversation)

    # Run the PydanticAI agent
    try:
        result = await run_agent(
            user_message=request.message,
            user_id=user_id,
            conversation_id=conversation_id,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Agent error: {str(e)}")

    # Save messages to PostgreSQL (long-term storage)
    db.add(Message(
        conversation_id=conversation_id,
        role="user",
        content=request.message,
    ))
    db.add(Message(
        conversation_id=conversation_id,
        role="assistant",
        content=result["answer"],
        tools_used=result["tools_used"],
    ))

    # Save trace to PostgreSQL (observability artifact)
    trace_data = result["trace"]
    db.add(Trace(
        id=trace_data["id"],
        conversation_id=conversation_id,
        user_message=request.message,
        steps=trace_data["steps"],
        tools_called=trace_data["tools_called"],
        total_time_ms=trace_data["total_time_ms"],
        status=trace_data["status"],
    ))

    return ChatResponse(
        answer=result["answer"],
        tools_used=result["tools_used"],
        follow_up_suggestions=result["follow_up_suggestions"],
        trace_id=trace_data["id"],
        conversation_id=conversation_id,
        user_id=user_id,
        session_state=result["session_state"],
    )

@app.post("/api/chat/stream")
async def chat_stream(request: ChatRequest):
    """
    Streaming chat endpoint.
    Sends the LLM response token-by-token using Server-Sent Events (SSE).
    """
    user_id = request.user_id or f"user-{uuid.uuid4().hex[:8]}"
    conversation_id = request.conversation_id or f"conv-{uuid.uuid4().hex[:8]}"

    session_state = await get_session_state(user_id)
    history = await get_recent_messages(conversation_id)

    history_text = ""
    for msg in history[-10:]:
        role = "User" if msg["role"] == "user" else "Assistant"
        history_text += f"{role}: {msg['content']}\n"

    full_message = request.message
    if history_text:
        full_message = f"Previous conversation:\n{history_text}\nUser: {request.message}"

    async def generate():
        with logfire.span('streaming chat', message=request.message):
            full_response = ""
            try:
                from openai import AsyncOpenAI
                client = AsyncOpenAI(api_key=os.getenv("OPENAI_API_KEY"))

                stream = await client.chat.completions.create(
                    model="gpt-4o",
                    messages=[
                        {
                            "role": "system",
                            "content": "You are AgentOS — a helpful AI assistant. Be clear, concise, and helpful."
                        },
                        {
                            "role": "user",
                            "content": full_message
                        }
                    ],
                    stream=True,
                )

                async for chunk in stream:
                    token = chunk.choices[0].delta.content
                    if token:
                        full_response += token
                        yield f"data: {json.dumps({'token': token, 'done': False})}\n\n"

                yield f"data: {json.dumps({'token': '', 'done': True, 'full_response': full_response})}\n\n"

                history.append({"role": "user", "content": request.message})
                history.append({"role": "assistant", "content": full_response})
                await save_recent_messages(conversation_id, history)
                session_state["total_interactions"] = session_state.get("total_interactions", 0) + 1
                await save_session_state(user_id, session_state)

            except Exception as e:
                yield f"data: {json.dumps({'error': str(e), 'done': True})}\n\n"

    # StreamingResponse is OUTSIDE generate() — this is the fix
    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
@app.get("/api/traces")
async def get_traces(limit: int = 20):
    """
    Returns recent agent traces for the observability dashboard.
    This is what powers the Logfire-style trace viewer in the UI.
    """
    return {"traces": get_recent_traces(limit)}


@app.get("/api/state/{user_id}")
async def get_state(user_id: str):
    """Returns the current session state for a user (from Redis)."""
    state = await get_session_state(user_id)
    return {"user_id": user_id, "state": state}


@app.put("/api/state/{user_id}")
async def update_state(user_id: str, request: StateUpdateRequest):
    """
    Updates session state — called when user changes mode or toggles tools.
    Saves to Redis for fast retrieval.
    """
    state = await get_session_state(user_id)
    if request.mode:
        state["mode"] = request.mode
    if request.active_tools is not None:
        state["active_tools"] = request.active_tools
    await save_session_state(user_id, state)
    return {"user_id": user_id, "state": state}


@app.get("/api/mcp/tools")
async def list_mcp_tools():
    """
    Lists all available MCP server tools.
    The frontend uses this to show which tools are available.
    """
    servers = {}
    for server_name, server in ALL_MCP_SERVERS.items():
        servers[server_name] = {
            "name": server.name,
            "version": server.version,
            "tools": server.list_tools(),
        }
    return {"mcp_servers": servers}


@app.get("/api/conversations/{user_id}")
async def get_conversations(user_id: str, db: AsyncSession = Depends(get_db)):
    """Returns all conversations for a user from PostgreSQL."""
    result = await db.execute(
        select(Conversation)
        .where(Conversation.user_id == user_id)
        .order_by(desc(Conversation.updated_at))
        .limit(20)
    )
    conversations = result.scalars().all()
    return {
        "conversations": [
            {
                "id": c.id,
                "title": c.title,
                "current_step": c.current_step,
                "created_at": c.created_at.isoformat(),
            }
            for c in conversations
        ]
    }


@app.get("/api/conversations/{conversation_id}/messages")
async def get_messages(conversation_id: str, db: AsyncSession = Depends(get_db)):
    """Returns full message history for a conversation from PostgreSQL."""
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation_id)
        .order_by(Message.created_at)
    )
    messages = result.scalars().all()
    return {
        "messages": [
            {
                "role": m.role,
                "content": m.content,
                "tools_used": m.tools_used,
                "created_at": m.created_at.isoformat(),
            }
            for m in messages
        ]
    }
