# backend/agent.py
# ─────────────────────────────────────────────────────────────
# PYDANTIC AI AGENT
#
# This is the brain of the application.
# PydanticAI wraps the AI model call and provides:
#   1. Structured, validated outputs (not raw text)
#   2. Tool registration (the AI can call our MCP tools)
#   3. Dependency injection (inject user context per request)
#   4. Automatic retries if the AI returns invalid output
#
# MODEL CHOICE:
#   - Default: OpenAI (via API) — easy, no infra needed
#   - Alternative: vLLM (self-hosted open-source model)
#
# To switch to vLLM, change the model string:
#   model="openai:meta-llama/Llama-3-8b-instruct"  (vLLM is OpenAI-compatible)
#   And set base_url to your vLLM server URL
# ─────────────────────────────────────────────────────────────

import os
import time
from dataclasses import dataclass
from typing import Optional
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext
from dotenv import load_dotenv

from tools import (
    tool_web_search, tool_calculator,
    tool_get_datetime, tool_database_query,
    ALL_MCP_SERVERS
)
from observability import AgentTrace, create_trace
from cache import get_session_state, save_session_state, get_recent_messages

load_dotenv()


# ── Output Schema ─────────────────────────────────────────────
# PydanticAI ensures EVERY response matches this shape.
# If the AI returns something invalid, it retries automatically.

class AgentResponse(BaseModel):
    """Structured output from the agent — always validated."""
    answer: str                          # The main response text
    tools_used: list[str] = []           # Which tools were called
    confidence: float = 1.0             # 0.0 - 1.0
    follow_up_suggestions: list[str] = [] # Optional next questions


# ── Dependency Context ────────────────────────────────────────
# This is injected into the agent on every run.
# It gives the agent awareness of WHO is asking and WHAT STATE they're in.

@dataclass
class AgentContext:
    """
    PydanticAI dependency injection context.
    Everything the agent needs to know about the current user/session.
    Think of this as the agent's 'briefing' before it starts working.
    """
    user_id: str
    conversation_id: str
    mode: str                            # "beginner" or "expert"
    active_tools: list[str]             # Which tools are enabled
    current_step: int                   # Where user is in workflow
    total_interactions: int
    trace: AgentTrace                   # The observability trace for this run


# ── Model Configuration ───────────────────────────────────────

def get_model():
    vllm_url = os.getenv("VLLM_BASE_URL")

    if vllm_url:
        # vLLM path — self-hosted open-source model
        from pydantic_ai.models.openai import OpenAIModel
        model_name = os.getenv("VLLM_MODEL", "meta-llama/Llama-3-8b-instruct")
        print(f"🤖 Using vLLM model: {model_name} at {vllm_url}")
        return OpenAIModel(model_name, base_url=f"{vllm_url}/v1")
    else:
        # OpenAI path — reads OPENAI_API_KEY from environment automatically
        from pydantic_ai.models.openai import OpenAIModel
        print("🤖 Using OpenAI API")
        return OpenAIModel("gpt-4o")
    
# ── Agent Definition ──────────────────────────────────────────

agent = Agent(
    model=get_model(),
    output_type=AgentResponse,   # Enforces structured output
    deps_type=AgentContext,       # Type of injected context
    system_prompt="""
You are AgentOS — a helpful, intelligent AI assistant.

You have access to tools: web search, calculator, datetime, and database queries.
Use tools when they would genuinely improve your answer.
Always be clear, concise, and helpful.

Adapt your communication style based on user mode:
- beginner mode: plain English, no jargon, friendly tone
- expert mode: technical detail, include reasoning, be precise

Always report which tools you used in the tools_used field.
Suggest 1-2 relevant follow-up questions when appropriate.
""",
)


# ── Tool Registrations ────────────────────────────────────────
# Register each tool with the PydanticAI agent.
# The agent decides autonomously when to call each tool.

@agent.tool
async def web_search(ctx: RunContext[AgentContext], query: str) -> str:
    """Search the internet for current information about a topic."""
    step = ctx.deps.trace.start_step(f"Tool: web_search('{query[:30]}')")
    result = await tool_web_search(query)
    ctx.deps.trace.log_tool_call("web_search", {"query": query}, result.model_dump())
    step.complete(status="ok", results_count=len(result.results))
    return "\n".join(result.results)


@agent.tool
async def calculator(ctx: RunContext[AgentContext], expression: str) -> str:
    """Evaluate a mathematical expression. Supports +, -, *, /, **, sqrt, etc."""
    step = ctx.deps.trace.start_step(f"Tool: calculator('{expression}')")
    result = await tool_calculator(expression)
    ctx.deps.trace.log_tool_call("calculator", {"expression": expression}, result.model_dump())
    step.complete(status="ok", result=result.result)
    return f"{expression} = {result.result}"


@agent.tool
async def get_current_datetime(ctx: RunContext[AgentContext]) -> str:
    """Get the current date and time."""
    step = ctx.deps.trace.start_step("Tool: get_datetime()")
    result = await tool_get_datetime()
    ctx.deps.trace.log_tool_call("get_datetime", {}, result.model_dump())
    step.complete(status="ok")
    return result.current_datetime


@agent.tool
async def query_database(ctx: RunContext[AgentContext], query_description: str) -> str:
    """Query the application database using natural language."""
    step = ctx.deps.trace.start_step(f"Tool: database_query('{query_description[:30]}')")
    result = await tool_database_query(query_description)
    ctx.deps.trace.log_tool_call("database_query", {"query": query_description}, result)
    step.complete(status="ok")
    return str(result)


# ── Main Agent Runner ─────────────────────────────────────────

async def run_agent(
    user_message: str,
    user_id: str,
    conversation_id: str,
) -> dict:
    """
    Main entry point for running the agent.
    
    Flow:
    1. Load session state from Redis
    2. Load conversation history from Redis/PostgreSQL
    3. Create observability trace
    4. Build agent context (dependency injection)
    5. Run PydanticAI agent with full context
    6. Save updated state back to Redis
    7. Return structured response + trace
    """

    # Step 1: Load session state (Redis)
    session_state = await get_session_state(user_id)

    # Step 2: Load conversation history (Redis cache)
    history = await get_recent_messages(conversation_id)

    # Step 3: Create trace
    trace = create_trace(conversation_id, user_message)
    
    # Step 4: Build context for dependency injection
    context = AgentContext(
        user_id=user_id,
        conversation_id=conversation_id,
        mode=session_state.get("mode", "beginner"),
        active_tools=session_state.get("active_tools", ["web_search", "calculator"]),
        current_step=session_state.get("current_step", 1),
        total_interactions=session_state.get("total_interactions", 0),
        trace=trace,
    )

    # Step 5: Build message history for context window
    # PydanticAI sends this entire history to the model each turn
    # This IS the context/state management — the AI sees the whole conversation
    step_load = trace.start_step("PydanticAI: Loading context & state")
    history_text = ""
    for msg in history[-10:]:
        role = "User" if msg["role"] == "user" else "Assistant"
        history_text += f"{role}: {msg['content']}\n"
    step_load.complete(status="ok", messages_in_context=len(history))

    # Step 6: Run the agent
    step_model = trace.start_step("AI Model: Generating response")
    try:
        # Then update the agent.run call:
        full_message = user_message
        if history_text:
            full_message = f"Previous conversation:\n{history_text}\nUser: {user_message}"

        result = await agent.run(
            full_message,
            deps=context,
        )
        response: AgentResponse = result.output
        step_model.complete(status="ok", tools_used=response.tools_used)

    except Exception as e:
        step_model.complete(status="error", error=str(e))
        trace.complete(response="", status="error", error=str(e))
        raise

    # Step 7: Update state in Redis
    step_state = trace.start_step("Redis: Saving session state")
    session_state["current_step"] = context.current_step + 1
    session_state["total_interactions"] = context.total_interactions + 1
    await save_session_state(user_id, session_state)

    # Append to conversation history in Redis
    history.append({"role": "user", "content": user_message})
    history.append({"role": "assistant", "content": response.answer})
    from cache import save_recent_messages
    await save_recent_messages(conversation_id, history)
    step_state.complete(status="ok")

    # Complete the trace
    trace.complete(response=response.answer, status="success")

    return {
        "answer": response.answer,
        "tools_used": response.tools_used,
        "confidence": response.confidence,
        "follow_up_suggestions": response.follow_up_suggestions,
        "trace": trace.to_dict(),
        "session_state": session_state,
    }
