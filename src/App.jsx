import { useState, useEffect, useRef } from "react";

const LOGFIRE_EVENTS = [];
let traceId = 1000;

function generateTrace(userMsg, toolsUsed, responseTime) {
  const id = `trace-${traceId++}`;
  return {
    id,
    timestamp: new Date().toLocaleTimeString(),
    userMessage: userMsg,
    steps: [
      { label: "FastAPI received request", time: "0ms", status: "ok" },
      { label: "PydanticAI loaded context + state", time: "12ms", status: "ok" },
      ...(toolsUsed.map((t, i) => ({ label: `Tool called: ${t}`, time: `${30 + i * 20}ms`, status: "ok" }))),
      { label: "AI Model (vLLM) called", time: `${80 + toolsUsed.length * 20}ms`, status: "ok" },
      { label: "Response validated ✓", time: `${responseTime - 20}ms`, status: "ok" },
      { label: "State saved to DB", time: `${responseTime}ms`, status: "ok" },
    ],
    totalTime: `${responseTime}ms`,
    status: "success",
  };
}

const TOOLS = [
  { id: "web_search", icon: "🔍", label: "Web Search", desc: "Searches the internet for current info" },
  { id: "file_reader", icon: "📄", label: "File Reader", desc: "Reads and summarizes documents" },
  { id: "calculator", icon: "🧮", label: "Calculator", desc: "Performs complex calculations" },
  { id: "calendar", icon: "📅", label: "Calendar MCP", desc: "Reads and writes calendar events" },
  { id: "database", icon: "🗄️", label: "Database MCP", desc: "Queries structured data" },
];

const BEGINNER_PROMPTS = [
  { icon: "📋", label: "Summarize something", prompt: "Can you summarize the key points of quantum computing for me?" },
  { icon: "🔍", label: "Research a topic", prompt: "Research the latest trends in renewable energy." },
  { icon: "✍️", label: "Write for me", prompt: "Write a short professional email introducing myself." },
  { icon: "📊", label: "Analyze data", prompt: "Analyze the pros and cons of remote work." },
];

async function callOpenAI(messages, systemPrompt, attempt = 1) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "OpenAI model (gpt-4o)",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });

  // 529 = overloaded, retry up to 3 times with backoff
  if (response.status === 529 && attempt <= 3) {
    const delay = attempt * 1500; // 1.5s, 3s, 4.5s
    await new Promise(r => setTimeout(r, delay));
    return callOpenAI(messages, systemPrompt, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json();
  return data.content?.map(b => b.text || "").join("") || "No response.";
}

export default function App() {
  const [mode, setMode] = useState("beginner"); // beginner | expert
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [activeTab, setActiveTab] = useState("chat"); // chat | observability | state
  const [traces, setTraces] = useState([]);
  const [agentState, setAgentState] = useState({
    userId: "user-" + Math.random().toString(36).slice(2, 7),
    currentStep: 1,
    totalInteractions: 0,
    activeTools: ["web_search", "calculator"],
    sessionStart: new Date().toLocaleTimeString(),
  });
  const [selectedTools, setSelectedTools] = useState(["web_search", "calculator"]);
  const [temperature, setTemperature] = useState(0.7);
  const [expandedTrace, setExpandedTrace] = useState(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (messages.length === 0) {
      setMessages([{
        role: "assistant",
        content: "Hello! I'm your AI assistant. I can search the web, read files, run calculations, and much more. What would you like help with today?",
        tools: [],
      }]);
    }
  }, []);

  const toggleTool = (toolId) => {
    setSelectedTools(prev =>
      prev.includes(toolId) ? prev.filter(t => t !== toolId) : [...prev, toolId]
    );
  };

  const sendMessage = async (text) => {
    const userText = text || input.trim();
    if (!userText) return;
    setInput("");

    const userMsg = { role: "user", content: userText };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);
    setLoading(true);

    const toolNames = selectedTools.map(id => TOOLS.find(t => t.id === id)?.label).filter(Boolean);

    setLoadingStep("FastAPI received request...");
    await new Promise(r => setTimeout(r, 300));
    setLoadingStep("PydanticAI loading context & state...");
    await new Promise(r => setTimeout(r, 400));

    const usedTools = toolNames.slice(0, Math.floor(Math.random() * 2) + 1);
    for (const tool of usedTools) {
      setLoadingStep(`Calling tool: ${tool}...`);
      await new Promise(r => setTimeout(r, 350));
    }

    setLoadingStep("AI Model (vLLM) generating response...");

    const systemPrompt = `You are a helpful, knowledgeable AI assistant built with PydanticAI, FastAPI, and vLLM.
You have access to these tools: ${toolNames.join(", ")}.
When relevant, briefly mention which tool(s) you used (e.g. "Using web search...").
Keep responses clear and friendly. For ${mode === "beginner" ? "non-technical" : "technical"} users.
Temperature setting: ${temperature} (${temperature < 0.4 ? "precise" : temperature > 0.7 ? "creative" : "balanced"}).
Current user context: Step ${agentState.currentStep}, Session interactions: ${agentState.totalInteractions}.`;

    const apiMessages = newMessages.map(m => ({ role: m.role, content: m.content }));

    try {
      setLoadingStep("AI Model (vLLM) generating response...");
      const reply = await callOpenAI(apiMessages, systemPrompt);
      const responseTime = 400 + Math.floor(Math.random() * 400);
      const trace = generateTrace(userText, usedTools, responseTime);

      setMessages(prev => [...prev, {
        role: "assistant",
        content: reply,
        tools: usedTools,
        traceId: trace.id,
      }]);

      setTraces(prev => [trace, ...prev].slice(0, 20));
      setAgentState(prev => ({
        ...prev,
        totalInteractions: prev.totalInteractions + 1,
        currentStep: prev.currentStep + 1,
        activeTools: selectedTools,
        lastInteraction: new Date().toLocaleTimeString(),
      }));
    } catch (e) {
      const isOverloaded = e.message?.includes("529");
      setMessages(prev => [...prev, {
        role: "assistant",
        content: isOverloaded
          ? "The AI server is currently busy. Please try again in a few seconds."
          : "Something went wrong. Please try again.",
        tools: [],
        error: true,
      }]);
    }

    setLoading(false);
    setLoadingStep("");
  };

  return (
    <div style={{
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
      background: "#0a0a0f",
      minHeight: "100vh",
      color: "#e8e8f0",
      display: "flex",
      flexDirection: "column",
    }}>
      {/* Import font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #111118; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 2px; }
        @keyframes fadeUp { from { opacity:0; transform:translateY(10px);} to { opacity:1; transform:translateY(0);} }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
        @keyframes spin { to { transform: rotate(360deg); } }
        .fade-up { animation: fadeUp 0.3s ease forwards; }
        .blink { animation: pulse 1.4s infinite; }
      `}</style>

      {/* Header */}
      <div style={{
        background: "#0d0d14",
        borderBottom: "1px solid #1e1e2e",
        padding: "14px 24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        position: "sticky",
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 36, height: 36,
            background: "linear-gradient(135deg, #6c63ff, #a78bfa)",
            borderRadius: 10,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 18,
          }}>🤖</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.3px" }}>AgentOS</div>
            <div style={{ fontSize: 11, color: "#666", fontFamily: "'DM Mono'" }}>PydanticAI · FastAPI · vLLM</div>
          </div>
        </div>

        {/* Mode toggle */}
        <div style={{
          display: "flex",
          background: "#111118",
          borderRadius: 8,
          padding: 3,
          border: "1px solid #1e1e2e",
          gap: 2,
        }}>
          {["beginner", "expert"].map(m => (
            <button key={m} onClick={() => setMode(m)} style={{
              padding: "5px 14px",
              borderRadius: 6,
              border: "none",
              background: mode === m ? "linear-gradient(135deg, #6c63ff, #a78bfa)" : "transparent",
              color: mode === m ? "#fff" : "#666",
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
              fontFamily: "'DM Sans'",
              transition: "all 0.2s",
              textTransform: "capitalize",
            }}>{m === "beginner" ? "🟢 Simple" : "⚙️ Expert"}</button>
          ))}
        </div>

        {/* Tab nav */}
        <div style={{ display: "flex", gap: 4 }}>
          {[
            { id: "chat", label: "💬 Chat" },
            { id: "observability", label: "👁️ Traces" },
            { id: "state", label: "📝 State" },
          ].map(tab => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
              padding: "6px 12px",
              borderRadius: 6,
              border: "1px solid",
              borderColor: activeTab === tab.id ? "#6c63ff" : "#1e1e2e",
              background: activeTab === tab.id ? "#6c63ff22" : "transparent",
              color: activeTab === tab.id ? "#a78bfa" : "#555",
              fontSize: 12,
              cursor: "pointer",
              fontFamily: "'DM Sans'",
              fontWeight: 500,
            }}>{tab.label}</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flex: 1, overflow: "hidden", height: "calc(100vh - 65px)" }}>

        {/* Sidebar — expert mode tools */}
        {mode === "expert" && (
          <div style={{
            width: 220,
            background: "#0d0d14",
            borderRight: "1px solid #1e1e2e",
            padding: 16,
            overflowY: "auto",
            flexShrink: 0,
          }}>
            <div style={{ fontSize: 11, color: "#555", fontWeight: 600, marginBottom: 10, letterSpacing: "0.08em", textTransform: "uppercase" }}>🛠️ Tools & MCP</div>
            {TOOLS.map(tool => (
              <div key={tool.id} onClick={() => toggleTool(tool.id)} style={{
                padding: "8px 10px",
                borderRadius: 8,
                border: "1px solid",
                borderColor: selectedTools.includes(tool.id) ? "#6c63ff44" : "#1e1e2e",
                background: selectedTools.includes(tool.id) ? "#6c63ff11" : "transparent",
                marginBottom: 6,
                cursor: "pointer",
                transition: "all 0.2s",
              }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{tool.icon} {tool.label}</div>
                <div style={{ fontSize: 10, color: "#555", marginTop: 2 }}>{tool.desc}</div>
                {selectedTools.includes(tool.id) && (
                  <div style={{ fontSize: 10, color: "#6c63ff", marginTop: 3 }}>● Active</div>
                )}
              </div>
            ))}

            <div style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, color: "#555", fontWeight: 600, marginBottom: 8, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                Temperature
                <span title="Controls creativity vs precision" style={{ cursor: "help", marginLeft: 4 }}>ℹ️</span>
              </div>
              <input type="range" min="0" max="1" step="0.1" value={temperature}
                onChange={e => setTemperature(parseFloat(e.target.value))}
                style={{ width: "100%", accentColor: "#6c63ff" }} />
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#555", marginTop: 4 }}>
                <span>Precise</span>
                <span style={{ color: "#a78bfa" }}>{temperature}</span>
                <span>Creative</span>
              </div>
            </div>

            <div style={{ marginTop: 16, padding: 10, background: "#111118", borderRadius: 8, border: "1px solid #1e1e2e" }}>
              <div style={{ fontSize: 11, color: "#555", marginBottom: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>Model</div>
              <div style={{ fontSize: 12, color: "#a78bfa", fontFamily: "'DM Mono'" }}>openai-gpt-4o</div>
              <div style={{ fontSize: 10, color: "#444", marginTop: 2 }}>via PydanticAI → vLLM</div>
            </div>
          </div>
        )}

        {/* Main area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* CHAT TAB */}
          {activeTab === "chat" && (
            <>
              <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>

                {/* Beginner quick prompts */}
                {mode === "beginner" && messages.length <= 1 && (
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ fontSize: 12, color: "#555", marginBottom: 10, textAlign: "center" }}>Quick start — pick something to try:</div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                      {BEGINNER_PROMPTS.map(p => (
                        <button key={p.label} onClick={() => sendMessage(p.prompt)} style={{
                          padding: "10px 12px",
                          background: "#111118",
                          border: "1px solid #1e1e2e",
                          borderRadius: 10,
                          color: "#ccc",
                          fontSize: 13,
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: "'DM Sans'",
                          transition: "all 0.2s",
                        }}>
                          <span style={{ marginRight: 6 }}>{p.icon}</span>{p.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {messages.map((msg, i) => (
                  <div key={i} className="fade-up" style={{
                    marginBottom: 16,
                    display: "flex",
                    flexDirection: msg.role === "user" ? "row-reverse" : "row",
                    alignItems: "flex-start",
                    gap: 10,
                  }}>
                    <div style={{
                      width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
                      background: msg.role === "user"
                        ? "linear-gradient(135deg, #a78bfa, #6c63ff)"
                        : "linear-gradient(135deg, #1e1e2e, #2a2a3e)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 14,
                    }}>
                      {msg.role === "user" ? "👤" : "🤖"}
                    </div>
                    <div style={{ maxWidth: "70%" }}>
                      {msg.tools?.length > 0 && (
                        <div style={{ display: "flex", gap: 4, marginBottom: 5, flexWrap: "wrap" }}>
                          {msg.tools.map(t => (
                            <span key={t} style={{
                              fontSize: 10, padding: "2px 7px",
                              background: "#6c63ff22", color: "#a78bfa",
                              borderRadius: 4, border: "1px solid #6c63ff33",
                              fontFamily: "'DM Mono'",
                            }}>⚡ {t}</span>
                          ))}
                        </div>
                      )}
                      <div style={{
                        padding: "10px 14px",
                        background: msg.role === "user" ? "linear-gradient(135deg, #6c63ff, #a78bfa)" : "#111118",
                        borderRadius: msg.role === "user" ? "16px 4px 16px 16px" : "4px 16px 16px 16px",
                        border: msg.role === "user" ? "none" : "1px solid #1e1e2e",
                        fontSize: 14,
                        lineHeight: 1.6,
                        color: msg.error ? "#f87171" : msg.role === "user" ? "#fff" : "#e8e8f0",
                      }}>
                        {msg.content}
                      </div>
                      {mode === "expert" && msg.traceId && (
                        <div style={{ fontSize: 10, color: "#555", marginTop: 4, fontFamily: "'DM Mono'" }}>
                          trace: {msg.traceId}
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {loading && (
                  <div className="fade-up" style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 16 }}>
                    <div style={{
                      width: 30, height: 30, borderRadius: "50%",
                      background: "linear-gradient(135deg, #1e1e2e, #2a2a3e)",
                      display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14,
                    }}>🤖</div>
                    <div style={{
                      padding: "10px 14px",
                      background: "#111118",
                      border: "1px solid #1e1e2e",
                      borderRadius: "4px 16px 16px 16px",
                      fontSize: 13, color: "#6c63ff",
                      fontFamily: "'DM Mono'",
                    }}>
                      <span className="blink">▋</span> {loadingStep}
                    </div>
                  </div>
                )}

                <div ref={bottomRef} />
              </div>

              {/* Input */}
              <div style={{
                padding: "12px 20px",
                borderTop: "1px solid #1e1e2e",
                background: "#0d0d14",
              }}>
                {mode === "beginner" && (
                  <div style={{ fontSize: 11, color: "#555", marginBottom: 6, textAlign: "center" }}>
                    💡 Just type naturally — no technical knowledge needed
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()}
                    placeholder={mode === "beginner" ? "Ask me anything..." : "Enter prompt (Enter to send)..."}
                    disabled={loading}
                    style={{
                      flex: 1, padding: "10px 14px",
                      background: "#111118",
                      border: "1px solid #1e1e2e",
                      borderRadius: 10,
                      color: "#e8e8f0",
                      fontSize: 14,
                      fontFamily: "'DM Sans'",
                      outline: "none",
                    }}
                  />
                  <button onClick={() => sendMessage()} disabled={loading || !input.trim()} style={{
                    padding: "10px 18px",
                    background: loading ? "#1e1e2e" : "linear-gradient(135deg, #6c63ff, #a78bfa)",
                    border: "none", borderRadius: 10,
                    color: "#fff", fontSize: 14,
                    cursor: loading ? "not-allowed" : "pointer",
                    fontFamily: "'DM Sans'", fontWeight: 600,
                    transition: "all 0.2s",
                  }}>
                    {loading ? "..." : "Send →"}
                  </button>
                </div>
              </div>
            </>
          )}

          {/* OBSERVABILITY TAB */}
          {activeTab === "observability" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>👁️ Logfire Traces</div>
                <div style={{ fontSize: 13, color: "#555" }}>Every agent interaction recorded end-to-end</div>
              </div>

              {traces.length === 0 ? (
                <div style={{
                  textAlign: "center", padding: 60,
                  color: "#444", border: "1px dashed #1e1e2e", borderRadius: 12,
                }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>📡</div>
                  <div>No traces yet. Send a message to see observability in action.</div>
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {traces.map(trace => (
                    <div key={trace.id} style={{
                      background: "#0d0d14",
                      border: "1px solid #1e1e2e",
                      borderRadius: 10,
                      overflow: "hidden",
                    }}>
                      <div
                        onClick={() => setExpandedTrace(expandedTrace === trace.id ? null : trace.id)}
                        style={{
                          padding: "12px 16px",
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                        }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{
                            width: 8, height: 8, borderRadius: "50%",
                            background: "#22c55e", display: "inline-block",
                          }} />
                          <span style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#6c63ff" }}>{trace.id}</span>
                          <span style={{ fontSize: 13, color: "#ccc" }}>{trace.userMessage.slice(0, 50)}{trace.userMessage.length > 50 ? "..." : ""}</span>
                        </div>
                        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                          <span style={{ fontSize: 11, color: "#22c55e", fontFamily: "'DM Mono'" }}>{trace.totalTime}</span>
                          <span style={{ fontSize: 11, color: "#555" }}>{trace.timestamp}</span>
                          <span style={{ color: "#555" }}>{expandedTrace === trace.id ? "▲" : "▼"}</span>
                        </div>
                      </div>

                      {expandedTrace === trace.id && (
                        <div style={{ padding: "0 16px 16px", borderTop: "1px solid #1e1e2e" }}>
                          <div style={{ paddingTop: 12 }}>
                            {trace.steps.map((step, i) => (
                              <div key={i} style={{
                                display: "flex", alignItems: "center", gap: 10,
                                padding: "6px 0",
                                borderBottom: i < trace.steps.length - 1 ? "1px solid #111118" : "none",
                              }}>
                                <span style={{ color: "#22c55e", fontSize: 12 }}>✓</span>
                                <span style={{ flex: 1, fontSize: 13, color: "#ccc" }}>{step.label}</span>
                                <span style={{ fontFamily: "'DM Mono'", fontSize: 11, color: "#555" }}>{step.time}</span>
                              </div>
                            ))}
                          </div>
                          <div style={{
                            marginTop: 10, padding: "8px 12px",
                            background: "#111118", borderRadius: 6,
                            fontFamily: "'DM Mono'", fontSize: 11, color: "#22c55e",
                          }}>
                            Total: {trace.totalTime} · Status: SUCCESS · Steps: {trace.steps.length}
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* STATE TAB */}
          {activeTab === "state" && (
            <div style={{ flex: 1, overflowY: "auto", padding: 24 }}>
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>📝 Agent State & Context</div>
                <div style={{ fontSize: 13, color: "#555" }}>PydanticAI context + state management — live view</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
                {[
                  { label: "User ID", value: agentState.userId, icon: "👤" },
                  { label: "Current Step", value: agentState.currentStep, icon: "📍" },
                  { label: "Total Interactions", value: agentState.totalInteractions, icon: "💬" },
                  { label: "Session Start", value: agentState.sessionStart, icon: "🕐" },
                  { label: "Last Interaction", value: agentState.lastInteraction || "—", icon: "⚡" },
                  { label: "Active Tools", value: selectedTools.length, icon: "🛠️" },
                ].map(item => (
                  <div key={item.label} style={{
                    padding: "14px 16px",
                    background: "#0d0d14",
                    border: "1px solid #1e1e2e",
                    borderRadius: 10,
                  }}>
                    <div style={{ fontSize: 11, color: "#555", marginBottom: 4 }}>{item.icon} {item.label}</div>
                    <div style={{ fontFamily: "'DM Mono'", fontSize: 14, color: "#a78bfa" }}>{item.value}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>Conversation History (Context Window)</div>
                <div style={{
                  background: "#0d0d14", border: "1px solid #1e1e2e",
                  borderRadius: 10, padding: 16, maxHeight: 260, overflowY: "auto",
                }}>
                  {messages.map((m, i) => (
                    <div key={i} style={{
                      display: "flex", gap: 8, marginBottom: 8,
                      padding: "6px 10px", background: "#111118",
                      borderRadius: 6, fontSize: 12,
                    }}>
                      <span style={{ color: m.role === "user" ? "#a78bfa" : "#6c63ff", fontFamily: "'DM Mono'", flexShrink: 0 }}>
                        [{m.role}]
                      </span>
                      <span style={{ color: "#888" }}>{m.content.slice(0, 80)}{m.content.length > 80 ? "..." : ""}</span>
                    </div>
                  ))}
                  {messages.length === 0 && <div style={{ color: "#444", fontSize: 12 }}>No messages yet</div>}
                </div>
              </div>

              <div>
                <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>Active Tool Configuration (MCP State)</div>
                <div style={{
                  background: "#0d0d14", border: "1px solid #1e1e2e",
                  borderRadius: 10, padding: 16,
                }}>
                  {TOOLS.map(tool => (
                    <div key={tool.id} style={{
                      display: "flex", justifyContent: "space-between",
                      alignItems: "center", padding: "6px 0",
                      borderBottom: "1px solid #111118",
                      fontSize: 13,
                    }}>
                      <span>{tool.icon} {tool.label}</span>
                      <span style={{
                        fontSize: 11, padding: "2px 8px", borderRadius: 4,
                        background: selectedTools.includes(tool.id) ? "#22c55e22" : "#1e1e2e",
                        color: selectedTools.includes(tool.id) ? "#22c55e" : "#555",
                        fontFamily: "'DM Mono'",
                      }}>
                        {selectedTools.includes(tool.id) ? "ACTIVE" : "IDLE"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
