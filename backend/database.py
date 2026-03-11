# backend/database.py
# ─────────────────────────────────────────────────────────────
# DATABASE LAYER
# Uses SQLAlchemy (async) with PostgreSQL via asyncpg.
# Tables:
#   - users          → tracks each user session
#   - conversations  → one row per conversation
#   - messages       → individual chat messages
#   - traces         → observability / logfire trace records
# ─────────────────────────────────────────────────────────────

import os
from datetime import datetime
from sqlalchemy import (
    Column, String, Text, Integer, Float,
    DateTime, ForeignKey, JSON
)
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import declarative_base, relationship, sessionmaker
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite+aiosqlite:///./agentOS.db")

# ── Engine ────────────────────────────────────────────────────
# For PostgreSQL in production:  postgresql+asyncpg://user:pass@host/db
# For local dev/demo:            sqlite+aiosqlite:///./agentOS.db
engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
Base = declarative_base()


# ── Models ────────────────────────────────────────────────────

class User(Base):
    """
    Represents a session user.
    In production this would link to an auth system.
    """
    __tablename__ = "users"

    id           = Column(String, primary_key=True)          # e.g. "user-abc123"
    created_at   = Column(DateTime, default=datetime.utcnow)
    last_seen    = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    preferences  = Column(JSON, default=dict)                # e.g. {"mode": "expert"}

    conversations = relationship("Conversation", back_populates="user")


class Conversation(Base):
    """
    A single conversation thread.
    One user can have many conversations (one per session or topic).
    """
    __tablename__ = "conversations"

    id           = Column(String, primary_key=True)
    user_id      = Column(String, ForeignKey("users.id"))
    title        = Column(String, default="New Conversation")
    created_at   = Column(DateTime, default=datetime.utcnow)
    updated_at   = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    current_step = Column(Integer, default=1)                # state: where user is in workflow

    user     = relationship("User", back_populates="conversations")
    messages = relationship("Message", back_populates="conversation", order_by="Message.created_at")
    traces   = relationship("Trace", back_populates="conversation")


class Message(Base):
    """
    Individual message in a conversation.
    Stores role (user/assistant), content, and which tools were used.
    This IS the context window — loaded and sent to the AI every turn.
    """
    __tablename__ = "messages"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    conversation_id = Column(String, ForeignKey("conversations.id"))
    role            = Column(String)                         # "user" or "assistant"
    content         = Column(Text)
    tools_used      = Column(JSON, default=list)             # ["web_search", "calculator"]
    created_at      = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="messages")


class Trace(Base):
    """
    Observability record — one trace per agent run.
    Mirrors what Logfire would capture automatically.
    Stores every step, timing, and outcome.
    """
    __tablename__ = "traces"

    id              = Column(String, primary_key=True)       # "trace-abc123"
    conversation_id = Column(String, ForeignKey("conversations.id"))
    user_message    = Column(Text)
    steps           = Column(JSON, default=list)             # [{label, time_ms, status}]
    tools_called    = Column(JSON, default=list)
    total_time_ms   = Column(Float)
    status          = Column(String, default="success")      # success | error
    error_detail    = Column(Text, nullable=True)
    created_at      = Column(DateTime, default=datetime.utcnow)

    conversation = relationship("Conversation", back_populates="traces")


# ── Helpers ───────────────────────────────────────────────────

async def get_db():
    """FastAPI dependency — yields a DB session per request."""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def init_db():
    """Create all tables on startup if they don't exist."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
