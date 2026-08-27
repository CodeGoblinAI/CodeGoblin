const thread = document.getElementById("thread")
const input = document.getElementById("input")
const sendBtn = document.getElementById("send")
const stopBtn = document.getElementById("stop")
const providerSelect = document.getElementById("provider")
const hint = document.getElementById("hint")
const sessionList = document.getElementById("session-list")

let sessionId = null
let busy = false
let controller = null

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * Small markdown renderer: fenced code, inline code, bold, headings, lists.
 * Agents answer in markdown, so showing it raw makes every reply look broken.
 */
function markdown(text) {
  const blocks = []
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push('<pre class="code"><code>' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>")
    return "\u0000BLOCK" + (blocks.length - 1) + "\u0000"
  })

  html = escapeHtml(html)
  html = html.replace(/`([^`\n]+)`/g, (_, code) => "<code>" + code + "</code>")
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>")
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>")
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>")
  html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
  html = html.split("\n\n").map((p) => (p.trim().startsWith("<") ? p : "<p>" + p + "</p>")).join("")
  html = html.replace(/\n/g, "<br>")

  return html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)])
}

const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60
const scrollDown = () => { thread.scrollTop = thread.scrollHeight }

function emptyState() {
  thread.innerHTML = '<div class="empty-hint"><h1>What should we work on?</h1><p>Ask about your code, or try <code>/help</code> in the TUI.</p></div>'
}

function turn(kind, text) {
  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  const wrap = document.createElement("div")
  wrap.className = "turn " + (kind === "user" ? "user" : "agent")
  wrap.innerHTML = '<div class="who">' + (kind === "user" ? "you" : "goblin") + '</div><div class="body"></div>'
  const body = wrap.querySelector(".body")
  if (kind === "user") body.textContent = text
  else body.innerHTML = markdown(text)
  thread.appendChild(wrap)
  scrollDown()
  return body
}

function toolChip(name, args) {
  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  const chip = document.createElement("div")
  chip.className = "tool running"
  chip.innerHTML = '<span class="spin"></span><span class="tname"></span><span class="targs"></span>'
  chip.querySelector(".tname").textContent = name
  chip.querySelector(".targs").textContent = (args || "").slice(0, 70)
  thread.appendChild(chip)
  scrollDown()
  return chip
}

function setBusy(state) {
  busy = state
  sendBtn.disabled = state || !input.value.trim()
  stopBtn.hidden = !state
  input.placeholder = state ? "goblin is working…" : "Ask the goblin…  / for commands, @ for context"
}

async function refreshSessions() {
  const data = await fetch("/api/sessions").then((r) => r.json()).catch(() => ({ sessions: [] }))
  sessionList.innerHTML = ""
  for (const s of data.sessions) {
    const row = document.createElement("div")
    row.className = "row" + (s.id === sessionId ? " active" : "")
    const label = document.createElement("span")
    label.className = "label"
    label.textContent = s.title
    row.appendChild(label)
    row.onclick = () => openSession(s.id)
    sessionList.appendChild(row)
  }
}

async function openSession(id) {
  const data = await fetch("/api/session?id=" + encodeURIComponent(id)).then((r) => r.json()).catch(() => null)
  if (!data || !data.session) return
  sessionId = id
  thread.innerHTML = ""
  for (const m of data.session.messages) {
    if (m.role === "user") turn("user", m.content)
    else if (m.role === "assistant" && m.content) turn("agent", m.content)
  }
  if (!thread.children.length) emptyState()
  refreshSessions()
}

async function submit() {
  const text = input.value.trim()
  if (!text || busy) return
  input.value = ""
  setBusy(true)
  turn("user", text)

  let body = null
  let raw = ""
  controller = new AbortController()

  let response
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId, provider: providerSelect.value }),
      signal: controller.signal,
    })
  } catch {
    turn("agent", "_request cancelled_")
    setBusy(false)
    return
  }

  if (!response.ok || !response.body) {
    const err = await response.json().catch(() => ({}))
    turn("agent", err.error || "request failed")
    setBusy(false)
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split("\n\n")
      buffer = parts.pop() || ""

      for (const part of parts) {
        const line = part.trim()
        if (!line.startsWith("data:")) continue
        let event
        try { event = JSON.parse(line.slice(5).trim()) } catch { continue }

        if (event.type === "session") sessionId = event.id
        if (event.type === "text") {
          const stick = atBottom()
          if (!body) { raw = ""; body = turn("agent", "") }
          raw += event.delta
          body.innerHTML = markdown(raw)
          if (stick) scrollDown()
        }
        if (event.type === "tool_start") { body = null; toolChip(event.name, event.args) }
        if (event.type === "tool_end") {
          const chip = thread.querySelector(".tool.running:last-of-type") || [...thread.querySelectorAll(".tool.running")].pop()
          if (chip) {
            chip.classList.remove("running")
            chip.classList.add(event.result.startsWith("error:") ? "failed" : "done")
            chip.querySelector(".spin").textContent = event.result.startsWith("error:") ? "\u2717" : "\u2713"
          }
        }
        if (event.type === "error") turn("agent", "**Error:** " + event.message)
        if (event.type === "saved") refreshSessions()
      }
    }
  } catch {
    turn("agent", "_stopped_")
  }

  setBusy(false)
  controller = null
}

sendBtn.onclick = submit
stopBtn.onclick = () => { if (controller) controller.abort() }
input.oninput = () => { sendBtn.disabled = busy || !input.value.trim() }
input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() }
}
document.getElementById("new-session").onclick = () => {
  sessionId = null
  emptyState()
  refreshSessions()
}

fetch("/api/providers").then((r) => r.json()).then((data) => {
  for (const p of data.providers) {
    const option = document.createElement("option")
    option.value = p.id
    option.textContent = p.label + " \u00b7 " + p.model
    providerSelect.appendChild(option)
  }
  const ready = data.providers.filter((p) => p.ready).length
  hint.textContent = ready ? "" : "no API keys found"
})

emptyState()
setBusy(false)
refreshSessions()
