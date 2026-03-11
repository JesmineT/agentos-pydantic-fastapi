// frontend/src/App.jsx
// ─────────────────────────────────────────────────────────────
// REACT FRONTEND — Connected to real FastAPI backend
//
// Architecture:
//   - All AI calls go to FastAPI → PydanticAI → AI Model
//   - State is managed in React (session) + Redis (backend)
//   - Traces come from the backend observability layer
//   - MCP tools are fetched from the backend registry
//
// Usability:
//   - Beginner mode: simple UI, quick prompts, plain language
//   - Expert mode: tool toggles, trace IDs, raw state viewer
// ─────────────────────────────────────────────────────────────

import { useState, useEffect, useRef, useCallback } from 'react'
import { sendMessage, sendMessageStream, getTraces, getState, updateState, getMCPTools, healthCheck } from './api'

// Generate stable IDs for this browser session
const SESSION_USER_ID = `user-${Math.random().toString(36).slice(2, 9)}`
const SESSION_CONV_ID = `conv-${Math.random().toString(36).slice(2, 9)}`

const BEGINNER_PROMPTS = [
  { icon: '🔍', label: 'Search something', prompt: 'Search for the latest news about artificial intelligence.' },
  { icon: '🧮', label: 'Calculate', prompt: 'What is the square root of 1764 multiplied by 3.14?' },
  { icon: '🕐', label: 'Date & Time', prompt: 'What is the current date and time?' },
  { icon: '💡', label: 'Explain something', prompt: 'Explain how PydanticAI works in simple terms.' },
]

export default function App() {
  const [mode, setMode] = useState('beginner')
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadingStep, setLoadingStep] = useState('')
  const [activeTab, setActiveTab] = useState('chat')
  const [traces, setTraces] = useState([])
  const [expandedTrace, setExpandedTrace] = useState(null)
  const [sessionState, setSessionState] = useState(null)
  const [mcpTools, setMcpTools] = useState({})
  const [activeTools, setActiveTools] = useState(['web_search', 'calculator'])
  const [backendStatus, setBackendStatus] = useState('checking')
  const [error, setError] = useState(null)
  const bottomRef = useRef(null)

  // ── Initialisation ──────────────────────────────────────────

  useEffect(() => {
    initApp()
    setMessages([{
      role: 'assistant',
      content: "Hello! I'm AgentOS — powered by PydanticAI, FastAPI, and a real AI model. I can search the web, do calculations, check the time, and more. What would you like help with?",
      tools_used: [],
    }])
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function initApp() {
    // Check backend health
    try {
      await healthCheck()
      setBackendStatus('connected')
    } catch {
      setBackendStatus('disconnected')
    }

    // Load session state
    try {
      const { state } = await getState(SESSION_USER_ID)
      setSessionState(state)
      setMode(state.mode || 'beginner')
      setActiveTools(state.active_tools || ['web_search', 'calculator'])
    } catch {
      // Backend unavailable — use defaults
    }

    // Load MCP tools
    try {
      const { mcp_servers } = await getMCPTools()
      setMcpTools(mcp_servers)
    } catch {
      // Use static fallback
      setMcpTools({})
    }
  }

  // ── Mode Switch ─────────────────────────────────────────────

  async function switchMode(newMode) {
    setMode(newMode)
    try {
      await updateState(SESSION_USER_ID, { mode: newMode, activeTools })
    } catch { /* offline — state saved locally only */ }
  }

  // ── Tool Toggle ─────────────────────────────────────────────

  async function toggleTool(toolName) {
    const updated = activeTools.includes(toolName)
      ? activeTools.filter(t => t !== toolName)
      : [...activeTools, toolName]
    setActiveTools(updated)
    try {
      await updateState(SESSION_USER_ID, { mode, activeTools: updated })
    } catch { /* offline */ }
  }

  // ── Send Message ────────────────────────────────────────────

  const handleSend = useCallback(async (text) => {
    const userText = text || input.trim()
    if (!userText || loading) return
    setInput('')
    setError(null)

    setMessages(prev => [...prev, { role: 'user', content: userText }])
    setLoading(true)

    try {
      // Simulate visible loading steps (matches backend flow)
      setLoadingStep('FastAPI: Receiving request...')
      await sleep(200)
      setLoadingStep('PydanticAI: Loading context & state...')
      await sleep(300)
      setLoadingStep('AI Model: Generating response...')

      // Add empty placeholder bubble — tokens will fill it in real time
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '',
        tools_used: [],
        streaming: true,
      }])

      await sendMessageStream({
        message: userText,
        userId: SESSION_USER_ID,
        conversationId: SESSION_CONV_ID,
        onToken: (token) => {
          // Append each token to the last message bubble as it arrives
          setMessages(prev => {
            const updated = [...prev]
            const last = updated[updated.length - 1]
            updated[updated.length - 1] = {
              ...last,
              content: last.content + token,
            }
            return updated
          })
        },
        onDone: ({ fullResponse, error }) => {
          setMessages(prev => {
            const updated = [...prev]
            updated[updated.length - 1] = {
              ...updated[updated.length - 1],
              content: fullResponse || error || 'Something went wrong',
              streaming: false,
            }
            return updated
          })
          // Refresh traces after streaming completes
          getTraces(20).then(({ traces: newTraces }) => setTraces(newTraces)).catch(() => {})
        }
      })

    } catch (err) {
      const msg = err.message?.includes('fetch')
        ? 'Cannot reach the backend. Make sure FastAPI is running on port 8000.'
        : `Something went wrong: ${err.message}`
      setError(msg)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: msg,
        error: true,
        tools_used: [],
      }])
    }

    setLoading(false)
    setLoadingStep('')
  }, [input, loading, activeTools, mode])

  // Load traces when switching to observability tab
  useEffect(() => {
    if (activeTab === 'observability') {
      getTraces(20).then(({ traces }) => setTraces(traces)).catch(() => {})
    }
  }, [activeTab])

  // ── Render ──────────────────────────────────────────────────

  return (
    <div style={styles.root}>
      <style>{css}</style>

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.brand}>
          <div style={styles.logo}>🤖</div>
          <div>
            <div style={styles.brandName}>AgentOS</div>
            <div style={styles.brandSub}>PydanticAI · FastAPI · vLLM</div>
          </div>
          <StatusBadge status={backendStatus} />
        </div>

        <div style={styles.modeToggle}>
          {['beginner', 'expert'].map(m => (
            <button key={m} onClick={() => switchMode(m)} style={{
              ...styles.modeBtn,
              ...(mode === m ? styles.modeBtnActive : {}),
            }}>
              {m === 'beginner' ? '🟢 Simple' : '⚙️ Expert'}
            </button>
          ))}
        </div>

        <nav style={styles.nav}>
          {[
            { id: 'chat', label: '💬 Chat' },
            { id: 'observability', label: '👁️ Traces' },
            { id: 'state', label: '📝 State' },
          ].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              ...styles.navBtn,
              ...(activeTab === tab.id ? styles.navBtnActive : {}),
            }}>{tab.label}</button>
          ))}
        </nav>
      </header>

      <div style={styles.body}>

        {/* Expert sidebar */}
        {mode === 'expert' && (
          <aside style={styles.sidebar}>
            <SidebarSection title="🛠️ Tools & MCP">
              {getAllTools(mcpTools).map(tool => (
                <ToolToggle
                  key={tool.name}
                  tool={tool}
                  active={activeTools.includes(tool.name)}
                  onToggle={() => toggleTool(tool.name)}
                />
              ))}
            </SidebarSection>

            <SidebarSection title="🤖 Model">
              <div style={styles.modelInfo}>
                <div style={{ color: '#a78bfa', fontFamily: 'monospace', fontSize: 12 }}>
                  openai-gpt-4o
                </div>
                <div style={{ color: '#555', fontSize: 11, marginTop: 2 }}>
                  via PydanticAI → FastAPI
                </div>
                <div style={{ color: '#555', fontSize: 10, marginTop: 4, borderTop: '1px solid #1e1e2e', paddingTop: 6 }}>
                  Switch to vLLM: set VLLM_BASE_URL in .env
                </div>
              </div>
            </SidebarSection>
          </aside>
        )}

        {/* Main content */}
        <main style={styles.main}>

          {/* CHAT TAB */}
          {activeTab === 'chat' && (
            <>
              <div style={styles.messages}>
                {mode === 'beginner' && messages.length <= 1 && (
                  <div style={styles.quickPrompts}>
                    <div style={styles.quickPromptsLabel}>Quick start:</div>
                    <div style={styles.quickPromptsGrid}>
                      {BEGINNER_PROMPTS.map(p => (
                        <button key={p.label} onClick={() => handleSend(p.prompt)} style={styles.quickPromptBtn}>
                          <span>{p.icon}</span> {p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((msg, i) => (
                  <MessageBubble key={i} msg={msg} mode={mode} />
                ))}

                {loading && (
                  <div style={styles.loadingBubble}>
                    <div style={styles.avatar}>🤖</div>
                    <div style={styles.loadingText}>
                      <span style={styles.cursor}>▋</span> {loadingStep}
                    </div>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>

              <div style={styles.inputArea}>
                {mode === 'beginner' && (
                  <div style={styles.inputHint}>
                    💡 Just type naturally — no technical knowledge needed
                  </div>
                )}
                <div style={styles.inputRow}>
                  <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && !e.shiftKey && handleSend()}
                    placeholder={mode === 'beginner' ? 'Ask me anything...' : 'Enter prompt...'}
                    disabled={loading}
                    style={styles.input}
                    id="chat-input"
                    name="chat-input"
                    autoComplete="off"
                  />
                  <button
                    onClick={() => handleSend()}
                    disabled={loading || !input.trim()}
                    style={{ ...styles.sendBtn, opacity: loading || !input.trim() ? 0.5 : 1 }}
                  >
                    {loading ? '...' : 'Send →'}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* OBSERVABILITY TAB */}
          {activeTab === 'observability' && (
            <div style={styles.tabContent}>
              <div style={styles.tabHeader}>
                <h2 style={styles.tabTitle}>👁️ Logfire Traces</h2>
                <p style={styles.tabDesc}>
                  Every agent run is recorded end-to-end. Each trace shows the full journey:
                  FastAPI → PydanticAI → Tools → AI Model → Response.
                </p>
              </div>

              {traces.length === 0 ? (
                <div style={styles.emptyState}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📡</div>
                  <div>No traces yet. Send a message to see observability in action.</div>
                  <div style={{ fontSize: 12, color: '#555', marginTop: 8 }}>
                    Traces are saved to <code>agentOS_artifacts.jsonl</code> on the backend.
                  </div>
                </div>
              ) : (
                traces.map(trace => (
                  <TraceCard
                    key={trace.id}
                    trace={trace}
                    expanded={expandedTrace === trace.id}
                    onToggle={() => setExpandedTrace(expandedTrace === trace.id ? null : trace.id)}
                  />
                ))
              )}
            </div>
          )}

          {/* STATE TAB */}
          {activeTab === 'state' && (
            <div style={styles.tabContent}>
              <div style={styles.tabHeader}>
                <h2 style={styles.tabTitle}>📝 Agent State & Context</h2>
                <p style={styles.tabDesc}>
                  PydanticAI injects this context into every agent run. Redis caches session state.
                  PostgreSQL stores long-term history.
                </p>
              </div>

              <div style={styles.stateGrid}>
                <StateCard label="User ID" value={SESSION_USER_ID} icon="👤" mono />
                <StateCard label="Conversation ID" value={SESSION_CONV_ID} icon="💬" mono />
                <StateCard label="Mode" value={mode} icon="🎛️" />
                <StateCard label="Active Tools" value={activeTools.length} icon="🛠️" />
                <StateCard label="Messages" value={messages.length} icon="📨" />
                <StateCard label="Backend" value={backendStatus} icon="🔌" />
              </div>

              {sessionState && (
                <div style={{ marginTop: 16 }}>
                  <div style={styles.sectionLabel}>Session State (Redis)</div>
                  <pre style={styles.codeBlock}>
                    {JSON.stringify(sessionState, null, 2)}
                  </pre>
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <div style={styles.sectionLabel}>
                  Conversation History (Context Window — sent to AI each turn)
                </div>
                <div style={styles.historyList}>
                  {messages.map((m, i) => (
                    <div key={i} style={styles.historyItem}>
                      <span style={{ color: m.role === 'user' ? '#a78bfa' : '#6c63ff', fontFamily: 'monospace', fontSize: 11, flexShrink: 0 }}>
                        [{m.role}]
                      </span>
                      <span style={{ color: '#888', fontSize: 12 }}>
                        {m.content.slice(0, 100)}{m.content.length > 100 ? '…' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <div style={styles.sectionLabel}>MCP Tool Status</div>
                <div style={styles.toolStatusList}>
                  {getAllTools(mcpTools).map(tool => (
                    <div key={tool.name} style={styles.toolStatusRow}>
                      <span style={{ fontSize: 13 }}>{tool.icon} {tool.label}</span>
                      <span style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 4,
                        fontFamily: 'monospace',
                        background: activeTools.includes(tool.name) ? '#22c55e22' : '#1e1e2e',
                        color: activeTools.includes(tool.name) ? '#22c55e' : '#555',
                      }}>
                        {activeTools.includes(tool.name) ? 'ACTIVE' : 'IDLE'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────

function StatusBadge({ status }) {
  const config = {
    connected: { color: '#22c55e', label: 'Backend connected' },
    disconnected: { color: '#ef4444', label: 'Backend offline' },
    checking: { color: '#f59e0b', label: 'Checking...' },
  }[status] || { color: '#555', label: status }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: config.color, display: 'inline-block' }} />
      <span style={{ color: config.color }}>{config.label}</span>
    </div>
  )
}

function SidebarSection({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 10, color: '#555', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', marginBottom: 8 }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function ToolToggle({ tool, active, onToggle }) {
  return (
    <div onClick={onToggle} style={{
      padding: '8px 10px', borderRadius: 8, marginBottom: 5, cursor: 'pointer',
      border: `1px solid ${active ? '#6c63ff44' : '#1e1e2e'}`,
      background: active ? '#6c63ff11' : 'transparent',
      transition: 'all 0.2s',
    }}>
      <div style={{ fontSize: 12, fontWeight: 500 }}>{tool.icon} {tool.label}</div>
      <div style={{ fontSize: 10, color: '#555', marginTop: 2 }}>{tool.desc}</div>
      {active && <div style={{ fontSize: 10, color: '#6c63ff', marginTop: 3 }}>● Active</div>}
    </div>
  )
}

function MessageBubble({ msg, mode }) {
  const isUser = msg.role === 'user'
  return (
    <div className="fade-up" style={{
      display: 'flex', flexDirection: isUser ? 'row-reverse' : 'row',
      alignItems: 'flex-start', gap: 10, marginBottom: 16,
    }}>
      <div style={{
        width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
        background: isUser ? 'linear-gradient(135deg, #a78bfa, #6c63ff)' : 'linear-gradient(135deg, #1e1e2e, #2a2a3e)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14,
      }}>{isUser ? '👤' : '🤖'}</div>

      <div style={{ maxWidth: '70%' }}>
        {msg.tools_used?.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginBottom: 5, flexWrap: 'wrap' }}>
            {msg.tools_used.map(t => (
              <span key={t} style={{
                fontSize: 10, padding: '2px 7px',
                background: '#6c63ff22', color: '#a78bfa',
                borderRadius: 4, border: '1px solid #6c63ff33', fontFamily: 'monospace',
              }}>⚡ {t}</span>
            ))}
          </div>
        )}
        <div style={{
          padding: '10px 14px', lineHeight: 1.6, fontSize: 14,
          background: isUser ? 'linear-gradient(135deg, #6c63ff, #a78bfa)' : '#111118',
          borderRadius: isUser ? '16px 4px 16px 16px' : '4px 16px 16px 16px',
          border: isUser ? 'none' : '1px solid #1e1e2e',
          color: msg.error ? '#f87171' : isUser ? '#fff' : '#e8e8f0',
          whiteSpace: 'pre-wrap',
        }}>
          {msg.content}
          {msg.streaming && <span style={{ animation: 'pulse 1s infinite' }}>▋</span>}
        </div>

        {msg.follow_up_suggestions?.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {msg.follow_up_suggestions.map((s, i) => (
              <div key={i} style={{
                fontSize: 11, color: '#6c63ff', padding: '3px 8px',
                border: '1px solid #6c63ff33', borderRadius: 10, cursor: 'default',
              }}>💡 {s}</div>
            ))}
          </div>
        )}

        {mode === 'expert' && msg.trace_id && (
          <div style={{ fontSize: 10, color: '#444', marginTop: 4, fontFamily: 'monospace' }}>
            trace: {msg.trace_id}
          </div>
        )}
      </div>
    </div>
  )
}

function TraceCard({ trace, expanded, onToggle }) {
  return (
    <div style={{ background: '#0d0d14', border: '1px solid #1e1e2e', borderRadius: 10, marginBottom: 8, overflow: 'hidden' }}>
      <div onClick={onToggle} style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: trace.status === 'success' ? '#22c55e' : '#ef4444', display: 'inline-block' }} />
          <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#6c63ff' }}>{trace.id}</span>
          <span style={{ fontSize: 13, color: '#ccc' }}>{(trace.user_message || '').slice(0, 50)}{(trace.user_message || '').length > 50 ? '…' : ''}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: '#22c55e', fontFamily: 'monospace' }}>{trace.total_time_ms?.toFixed(0)}ms</span>
          <span style={{ fontSize: 11, color: '#555' }}>{trace.timestamp ? new Date(trace.timestamp).toLocaleTimeString() : ''}</span>
          <span style={{ color: '#555' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #1e1e2e' }}>
          <div style={{ paddingTop: 12 }}>
            {(trace.steps || []).map((step, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0', borderBottom: '1px solid #111118' }}>
                <span style={{ color: step.status === 'ok' ? '#22c55e' : '#ef4444', fontSize: 12 }}>
                  {step.status === 'ok' ? '✓' : '✗'}
                </span>
                <span style={{ flex: 1, fontSize: 13, color: '#ccc' }}>{step.label}</span>
                <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#555' }}>{step.time_ms?.toFixed(0)}ms</span>
              </div>
            ))}
          </div>
          {(trace.tools_called || []).length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, color: '#555', marginBottom: 5 }}>Tools called:</div>
              {trace.tools_called.map((tc, i) => (
                <div key={i} style={{ fontSize: 11, fontFamily: 'monospace', color: '#a78bfa', padding: '3px 0' }}>
                  ⚡ {tc.tool}({JSON.stringify(tc.inputs).slice(0, 60)})
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StateCard({ label, value, icon, mono }) {
  return (
    <div style={{ padding: '14px 16px', background: '#0d0d14', border: '1px solid #1e1e2e', borderRadius: 10 }}>
      <div style={{ fontSize: 11, color: '#555', marginBottom: 4 }}>{icon} {label}</div>
      <div style={{ fontFamily: mono ? 'monospace' : 'inherit', fontSize: mono ? 12 : 14, color: '#a78bfa', wordBreak: 'break-all' }}>
        {String(value)}
      </div>
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function getAllTools(mcpTools) {
  const fromBackend = []
  Object.values(mcpTools).forEach(server => {
    (server.tools || []).forEach(tool => {
      fromBackend.push({
        name: tool.name,
        label: tool.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        desc: tool.description,
        icon: { web_search: '🔍', calculator: '🧮', get_datetime: '🕐', database_query: '🗄️', read_file: '📄' }[tool.name] || '🔧',
      })
    })
  })
  if (fromBackend.length > 0) return fromBackend

  // Static fallback when backend is offline
  return [
    { name: 'web_search', label: 'Web Search', desc: 'Search the internet', icon: '🔍' },
    { name: 'calculator', label: 'Calculator', desc: 'Math expressions', icon: '🧮' },
    { name: 'get_datetime', label: 'DateTime', desc: 'Current time', icon: '🕐' },
    { name: 'database_query', label: 'Database MCP', desc: 'Query data', icon: '🗄️' },
  ]
}

// ── Styles ────────────────────────────────────────────────────

const styles = {
  root: { fontFamily: "'DM Sans', 'Segoe UI', sans-serif", background: '#0a0a0f', minHeight: '100vh', color: '#e8e8f0', display: 'flex', flexDirection: 'column' },
  header: { background: '#0d0d14', borderBottom: '1px solid #1e1e2e', padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 100 },
  brand: { display: 'flex', alignItems: 'center', gap: 10 },
  logo: { width: 36, height: 36, background: 'linear-gradient(135deg, #6c63ff, #a78bfa)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 },
  brandName: { fontWeight: 700, fontSize: 15, letterSpacing: '-0.3px' },
  brandSub: { fontSize: 10, color: '#555', fontFamily: 'monospace' },
  modeToggle: { display: 'flex', background: '#111118', borderRadius: 8, padding: 3, border: '1px solid #1e1e2e', gap: 2 },
  modeBtn: { padding: '5px 14px', borderRadius: 6, border: 'none', background: 'transparent', color: '#666', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: "'DM Sans'" },
  modeBtnActive: { background: 'linear-gradient(135deg, #6c63ff, #a78bfa)', color: '#fff' },
  nav: { display: 'flex', gap: 4 },
  navBtn: { padding: '6px 12px', borderRadius: 6, border: '1px solid #1e1e2e', background: 'transparent', color: '#555', fontSize: 12, cursor: 'pointer', fontFamily: "'DM Sans'", fontWeight: 500 },
  navBtnActive: { borderColor: '#6c63ff', background: '#6c63ff22', color: '#a78bfa' },
  body: { display: 'flex', flex: 1, overflow: 'hidden', height: 'calc(100vh - 65px)' },
  sidebar: { width: 220, background: '#0d0d14', borderRight: '1px solid #1e1e2e', padding: 16, overflowY: 'auto', flexShrink: 0 },
  modelInfo: { padding: '10px', background: '#111118', borderRadius: 8, border: '1px solid #1e1e2e' },
  main: { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  messages: { flex: 1, overflowY: 'auto', padding: '20px 24px' },
  quickPrompts: { marginBottom: 20 },
  quickPromptsLabel: { fontSize: 12, color: '#555', marginBottom: 10, textAlign: 'center' },
  quickPromptsGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  quickPromptBtn: { padding: '10px 12px', background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10, color: '#ccc', fontSize: 13, cursor: 'pointer', textAlign: 'left', fontFamily: "'DM Sans'" },
  loadingBubble: { display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16 },
  avatar: { width: 30, height: 30, borderRadius: '50%', background: 'linear-gradient(135deg, #1e1e2e, #2a2a3e)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14 },
  loadingText: { padding: '10px 14px', background: '#111118', border: '1px solid #1e1e2e', borderRadius: '4px 16px 16px 16px', fontSize: 13, color: '#6c63ff', fontFamily: 'monospace' },
  cursor: { animation: 'pulse 1.4s infinite' },
  inputArea: { padding: '12px 20px', borderTop: '1px solid #1e1e2e', background: '#0d0d14' },
  inputHint: { fontSize: 11, color: '#555', marginBottom: 6, textAlign: 'center' },
  inputRow: { display: 'flex', gap: 8 },
  input: { flex: 1, padding: '10px 14px', background: '#111118', border: '1px solid #1e1e2e', borderRadius: 10, color: '#e8e8f0', fontSize: 14, fontFamily: "'DM Sans'", outline: 'none' },
  sendBtn: { padding: '10px 18px', background: 'linear-gradient(135deg, #6c63ff, #a78bfa)', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, cursor: 'pointer', fontFamily: "'DM Sans'", fontWeight: 600 },
  tabContent: { flex: 1, overflowY: 'auto', padding: 24 },
  tabHeader: { marginBottom: 20 },
  tabTitle: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  tabDesc: { fontSize: 13, color: '#555' },
  emptyState: { textAlign: 'center', padding: 60, color: '#444', border: '1px dashed #1e1e2e', borderRadius: 12 },
  stateGrid: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 },
  sectionLabel: { fontSize: 13, color: '#555', marginBottom: 8 },
  codeBlock: { background: '#0d0d14', border: '1px solid #1e1e2e', borderRadius: 10, padding: 16, fontFamily: 'monospace', fontSize: 12, color: '#a78bfa', overflowX: 'auto' },
  historyList: { background: '#0d0d14', border: '1px solid #1e1e2e', borderRadius: 10, padding: 16, maxHeight: 200, overflowY: 'auto' },
  historyItem: { display: 'flex', gap: 8, marginBottom: 6, padding: '4px 8px', background: '#111118', borderRadius: 6 },
  toolStatusList: { background: '#0d0d14', border: '1px solid #1e1e2e', borderRadius: 10, padding: 16 },
  toolStatusRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #111118' },
}

const css = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  ::-webkit-scrollbar { width: 4px; }
  ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
  @keyframes fadeUp { from { opacity:0; transform:translateY(8px);} to { opacity:1; transform:translateY(0);} }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
  .fade-up { animation: fadeUp 0.3s ease forwards; }
`
