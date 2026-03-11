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


export async function sendMessageStream({ message, userId, conversationId, onToken, onDone }) {
  const response = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      user_id: userId,
      conversation_id: conversationId,
    }),
  })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    // Parse SSE chunks
    const chunk = decoder.decode(value)
    const lines = chunk.split('\n').filter(line => line.startsWith('data: '))

    for (const line of lines) {
      try {
        const data = JSON.parse(line.replace('data: ', ''))
        if (data.error) {
          onDone({ error: data.error })
          return
        }
        if (data.token) onToken(data.token)   // Send each token to UI
        if (data.done) onDone({ fullResponse: data.full_response })
      } catch { /* skip malformed chunks */ }
    }
  }
}