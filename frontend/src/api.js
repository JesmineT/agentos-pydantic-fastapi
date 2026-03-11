// frontend/src/api.js
// ─────────────────────────────────────────────────────────────
// API CLIENT
// All calls to the FastAPI backend go through here.
// Centralising API calls makes it easy to:
//   - Add auth headers in one place
//   - Handle errors consistently
//   - Mock responses for testing
// ─────────────────────────────────────────────────────────────

const BASE_URL = '/api'  // Proxied to http://localhost:8000 by Vite

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' }))
    throw new Error(error.detail || `HTTP ${response.status}`)
  }

  return response.json()
}

// ── Chat ──────────────────────────────────────────────────────

export async function sendMessage({ message, userId, conversationId }) {
  return request('/chat', {
    method: 'POST',
    body: JSON.stringify({
      message,
      user_id: userId,
      conversation_id: conversationId,
    }),
  })
}

// ── Observability ─────────────────────────────────────────────

export async function getTraces(limit = 20) {
  return request(`/traces?limit=${limit}`)
}

// ── State ─────────────────────────────────────────────────────

export async function getState(userId) {
  return request(`/state/${userId}`)
}

export async function updateState(userId, { mode, activeTools }) {
  return request(`/state/${userId}`, {
    method: 'PUT',
    body: JSON.stringify({
      mode,
      active_tools: activeTools,
    }),
  })
}

// ── MCP Tools ─────────────────────────────────────────────────

export async function getMCPTools() {
  return request('/mcp/tools')
}

// ── Health ────────────────────────────────────────────────────

export async function healthCheck() {
  return request('/health')
}
