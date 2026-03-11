# backend/observability.py
# ─────────────────────────────────────────────────────────────
# OBSERVABILITY — TRACING & ARTIFACT LOGGING
#
# This is the "CCTV and black box recorder" for the AI agent.
# Every request gets a Trace — a full record of:
#   - What the user asked
#   - What steps the agent took
#   - Which tools were called (with inputs/outputs)
#   - How long each step took
#   - What the final response was
#   - Any errors that occurred
#
# In production: use Logfire (logfire.pydantic.dev)
# Here: we implement the same pattern manually + log to DB.
#
# Logfire integration is one line:
#   logfire.configure()
#   logfire.instrument_pydantic_ai()
# ─────────────────────────────────────────────────────────────

import os
import time
import uuid
import json
import logging
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional
from dotenv import load_dotenv

load_dotenv()

# Standard Python logger — outputs to console + file
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[
        logging.StreamHandler(),                          # Console
        logging.FileHandler("agentOS_traces.log"),        # File (artifact log)
    ]
)
logger = logging.getLogger("agentOS.observability")

# Optional Logfire integration
# Uncomment when LOGFIRE_TOKEN is set in .env
try:
    import logfire
    logfire.configure(token=os.getenv("LOGFIRE_TOKEN"))
    logfire.instrument_pydantic_ai()
    logger.info("Logfire connected")

except Exception:
    logger.info("Logfire not configured — using local tracing")


# ── Trace Data Structure ──────────────────────────────────────

@dataclass
class TraceStep:
    """One step within an agent run trace."""
    label: str
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None
    status: str = "running"          # running | ok | error
    metadata: dict = field(default_factory=dict)

    def complete(self, status: str = "ok", **metadata):
        self.ended_at = time.time()
        self.status = status
        self.metadata.update(metadata)

    @property
    def duration_ms(self) -> float:
        if self.ended_at:
            return round((self.ended_at - self.started_at) * 1000, 2)
        return round((time.time() - self.started_at) * 1000, 2)

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "time_ms": self.duration_ms,
            "status": self.status,
            "metadata": self.metadata,
        }


@dataclass
class AgentTrace:
    """
    Full trace for one agent run.
    Created at the start of each request, completed at the end.
    """
    id: str = field(default_factory=lambda: f"trace-{uuid.uuid4().hex[:8]}")
    conversation_id: str = ""
    user_message: str = ""
    steps: list[TraceStep] = field(default_factory=list)
    tools_called: list[dict] = field(default_factory=list)
    final_response: str = ""
    status: str = "running"
    error_detail: Optional[str] = None
    started_at: float = field(default_factory=time.time)
    ended_at: Optional[float] = None

    def start_step(self, label: str) -> TraceStep:
        """Begin a new step and add it to the trace."""
        step = TraceStep(label=label)
        self.steps.append(step)
        logger.info(f"[{self.id}] Step started: {label}")
        return step

    def log_tool_call(self, tool_name: str, inputs: dict, output: dict):
        """Record a tool invocation with its inputs and outputs."""
        self.tools_called.append({
            "tool": tool_name,
            "inputs": inputs,
            "output": output,
            "timestamp": datetime.utcnow().isoformat(),
        })
        logger.info(f"[{self.id}] Tool called: {tool_name} | inputs={inputs}")

    def complete(self, response: str, status: str = "success", error: str = None):
        """Mark the trace as complete."""
        self.ended_at = time.time()
        self.final_response = response
        self.status = status
        self.error_detail = error

        # Log to file (artifact logging)
        logger.info(
            f"[{self.id}] TRACE COMPLETE | "
            f"status={status} | "
            f"total_ms={self.total_time_ms:.0f} | "
            f"steps={len(self.steps)} | "
            f"tools={[t['tool'] for t in self.tools_called]}"
        )

        # Write artifact log (JSON record for audit trail)
        self._write_artifact()

    @property
    def total_time_ms(self) -> float:
        if self.ended_at:
            return round((self.ended_at - self.started_at) * 1000, 2)
        return round((time.time() - self.started_at) * 1000, 2)

    def _write_artifact(self):
        """
        Artifact logging — write a complete JSON record of this trace.
        In production, these go to S3, GCS, or Logfire.
        Here they go to a local JSONL file (one JSON object per line).
        """
        artifact = {
            "trace_id": self.id,
            "conversation_id": self.conversation_id,
            "user_message": self.user_message,
            "steps": [s.to_dict() for s in self.steps],
            "tools_called": self.tools_called,
            "final_response": self.final_response[:500],  # Truncate for log
            "total_time_ms": self.total_time_ms,
            "status": self.status,
            "error": self.error_detail,
            "timestamp": datetime.utcnow().isoformat(),
        }
        try:
            with open("agentOS_artifacts.jsonl", "a") as f:
                f.write(json.dumps(artifact) + "\n")
        except Exception as e:
            logger.warning(f"Could not write artifact: {e}")

    def to_dict(self) -> dict:
        """Serialise to dict for API response and DB storage."""
        return {
            "id": self.id,
            "conversation_id": self.conversation_id,
            "user_message": self.user_message,
            "steps": [s.to_dict() for s in self.steps],
            "tools_called": self.tools_called,
            "total_time_ms": self.total_time_ms,
            "status": self.status,
            "timestamp": datetime.utcnow().isoformat(),
        }


# ── Active Trace Store ────────────────────────────────────────
# Keeps traces in memory during the request lifecycle.
# In production, use Redis for distributed systems.

_active_traces: dict[str, AgentTrace] = {}


def create_trace(conversation_id: str, user_message: str) -> AgentTrace:
    trace = AgentTrace(
        conversation_id=conversation_id,
        user_message=user_message
    )
    _active_traces[trace.id] = trace
    logger.info(f"[{trace.id}] New trace started | conversation={conversation_id}")
    return trace


def get_trace(trace_id: str) -> Optional[AgentTrace]:
    return _active_traces.get(trace_id)


def get_recent_traces(limit: int = 20) -> list[dict]:
    """Return the most recent N traces for the observability dashboard."""
    traces = list(_active_traces.values())
    traces.sort(key=lambda t: t.started_at, reverse=True)
    return [t.to_dict() for t in traces[:limit]]
