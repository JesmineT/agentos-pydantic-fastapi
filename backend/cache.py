# backend/cache.py
# ─────────────────────────────────────────────────────────────
# REDIS CACHE LAYER
# Redis handles SHORT-TERM state:
#   - Active session data (current step, active tools)
#   - Recent conversation history (fast retrieval without DB hit)
#   - Rate limiting counters
#
# PostgreSQL handles LONG-TERM state (conversation history, users).
# Redis is the fast notepad; PostgreSQL is the filing cabinet.
# ─────────────────────────────────────────────────────────────

import os
import json
import redis.asyncio as aioredis
from dotenv import load_dotenv

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# In-memory fallback when Redis isn't available (for local dev without Redis)
_memory_store: dict = {}
_redis_client = None


async def get_redis():
    """Returns Redis client, or None if unavailable (falls back to memory)."""
    global _redis_client
    if _redis_client is None:
        try:
            _redis_client = aioredis.from_url(REDIS_URL, decode_responses=True)
            await _redis_client.ping()
            print("Redis connected")
        except Exception:
            print("Redis unavailable — using in-memory fallback")
            _redis_client = None
    return _redis_client


async def cache_set(key: str, value: dict, ttl_seconds: int = 3600):
    """
    Store a value in Redis (or memory fallback).
    TTL default = 1 hour — sessions expire automatically.
    """
    serialized = json.dumps(value)
    client = await get_redis()
    if client:
        await client.setex(key, ttl_seconds, serialized)
    else:
        _memory_store[key] = serialized


async def cache_get(key: str) -> dict | None:
    """Retrieve a cached value. Returns None if not found or expired."""
    client = await get_redis()
    if client:
        data = await client.get(key)
    else:
        data = _memory_store.get(key)

    if data:
        return json.loads(data)
    return None


async def cache_delete(key: str):
    """Remove a key from cache."""
    client = await get_redis()
    if client:
        await client.delete(key)
    else:
        _memory_store.pop(key, None)


# ── Session-specific helpers ──────────────────────────────────

async def get_session_state(user_id: str) -> dict:
    """
    Load the current session state for a user.
    This is what PydanticAI uses as its 'dependency injection' context.
    """
    state = await cache_get(f"session:{user_id}")
    if not state:
        # Default state for new session
        state = {
            "user_id": user_id,
            "current_step": 1,
            "active_tools": ["web_search", "calculator"],
            "mode": "beginner",
            "total_interactions": 0,
        }
    return state


async def save_session_state(user_id: str, state: dict):
    """Persist updated session state back to Redis."""
    await cache_set(f"session:{user_id}", state, ttl_seconds=7200)


async def get_recent_messages(conversation_id: str) -> list:
    """
    Pull the last 20 messages from Redis (fast context window retrieval).
    Falls back to empty list — main app will load from PostgreSQL if needed.
    """
    data = await cache_get(f"messages:{conversation_id}")
    return data.get("messages", []) if data else []


async def save_recent_messages(conversation_id: str, messages: list):
    """Cache the conversation history for fast retrieval."""
    await cache_set(
        f"messages:{conversation_id}",
        {"messages": messages[-20:]},  # Keep last 20 messages only
        ttl_seconds=3600
    )
