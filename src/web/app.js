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
let lastToolArgs = ""

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

/**
 * Asks before a tool that changes things runs. Rendered inline in the
 * thread so the request sits next to the work that caused it.
 */
function permissionPrompt(event) {
  const box = document.createElement("div")
  box.className = "permission"
  box.innerHTML =
    "<div class=\"ptext\">Allow <strong></strong>?<span class=\"pdetail\"></span></div>" +
    "<div class=\"pactions\"><button class=\"pallow\">Allow</button><button class=\"pdeny\">Deny</button></div>"
  box.querySelector("strong").textContent = event.tool
  box.querySelector(".pdetail").textContent = (event.detail || "").slice(0, 120)

  const answer = async (decision) => {
    box.querySelector(".pactions").innerHTML =
      "<span class=\"presolved\">" + (decision === "allow" ? "allowed" : "denied") + "</span>"
    await fetch("/api/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: event.id, decision }),
    })
  }
  box.querySelector(".pallow").onclick = () => answer("allow")
  box.querySelector(".pdeny").onclick = () => answer("deny")

  thread.appendChild(box)
  scrollDown()
}

function setBusy(state) {
  busy = state
  // The send button becomes stop while a turn runs. A separate small button
  // was there before and was easy to miss, especially on fast models where
  // it appears for barely a second.
  sendBtn.classList.toggle("stopping", state)
  sendBtn.textContent = state ? "■" : "↑"
  sendBtn.title = state ? "Stop" : "Send"
  sendBtn.disabled = state ? false : !input.value.trim()
  stopBtn.hidden = true
  input.placeholder = state ? "goblin is working…" : "Ask the goblin…  / for commands, @ for context"
  try { activityBusy(state) } catch { /* panel not built yet during startup */ }
}

function relativeTime(ms) {
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return Math.round(seconds / 60) + "m"
  if (seconds < 86400) return Math.round(seconds / 3600) + "h"
  return Math.round(seconds / 86400) + "d"
}

/** Today / Yesterday / Older, so a long list stays scannable. */
function groupOf(ms) {
  const day = 86400000
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (ms >= startOfToday) return "Today"
  if (ms >= startOfToday - day) return "Yesterday"
  return "Older"
}

async function refreshSessions() {
  const data = await fetch("/api/sessions").then((r) => r.json()).catch(() => ({ sessions: [] }))
  sessionList.innerHTML = ""

  let lastGroup = null
  for (const s of data.sessions) {
    const group = groupOf(s.updated)
    if (group !== lastGroup) {
      const header = document.createElement("div")
      header.className = "group"
      header.textContent = group
      sessionList.appendChild(header)
      lastGroup = group
    }

    const row = document.createElement("div")
    row.className = "row session" + (s.id === sessionId ? " active" : "")

    const label = document.createElement("span")
    label.className = "label"
    label.textContent = s.title
    label.title = s.title

    const when = document.createElement("span")
    when.className = "when"
    when.textContent = relativeTime(s.updated)

    const actions = document.createElement("span")
    actions.className = "actions"

    const renameBtn = document.createElement("button")
    renameBtn.className = "icon"
    renameBtn.title = "Rename"
    renameBtn.textContent = "✎"
    renameBtn.onclick = async (e) => {
      e.stopPropagation()
      const next = prompt("Rename session", s.title)
      if (next === null) return
      await fetch("/api/session", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: s.id, title: next }),
      })
      refreshSessions()
    }

    const deleteBtn = document.createElement("button")
    deleteBtn.className = "icon danger"
    deleteBtn.title = "Delete"
    deleteBtn.textContent = "×"
    deleteBtn.onclick = async (e) => {
      e.stopPropagation()
      if (!confirm("Delete \"" + s.title + "\"?")) return
      await fetch("/api/session?id=" + encodeURIComponent(s.id), { method: "DELETE" })
      if (s.id === sessionId) { sessionId = null; emptyState() }
      refreshSessions()
    }

    actions.append(renameBtn, deleteBtn)
    row.append(label, when, actions)
    row.onclick = () => openSession(s.id)
    sessionList.appendChild(row)
  }

  if (!data.sessions.length) {
    const none = document.createElement("div")
    none.className = "row muted"
    none.textContent = "No sessions yet"
    sessionList.appendChild(none)
  }
}

async function openSession(id) {
  const data = await fetch("/api/session?id=" + encodeURIComponent(id)).then((r) => r.json()).catch(() => null)
  if (!data || !data.session) return
  sessionId = id
  thread.innerHTML = ""
  for (const m of data.session.messages) {
    if (m.role === "user") turn("user", m.display || m.content)
    else if (m.role === "assistant" && m.content) turn("agent", m.content)
  }
  if (!thread.children.length) emptyState()
  refreshSessions()
}

/**
 * Slash commands run here rather than being posted to the model.
 *
 * Without this the browser sent "/resume <id>" as a prompt and the model
 * politely tried to answer it, which is not what picking a conversation from
 * a list should do.
 */
async function runCommand(text) {
  const [name, ...rest] = text.split(" ")
  const argument = rest.join(" ").trim()

  if (name === "/new") {
    sessionId = null
    emptyState()
    activityReset()
    refreshSessions()
    return true
  }

  if (name === "/resume" || name === "/sessions" || name === "/continue") {
    if (argument) await openSession(argument)
    else {
      input.value = name + " "
      refreshPalette()
    }
    return true
  }

  if (name === "/model") {
    if (!argument) { input.value = "/model "; refreshPalette(); return true }
    const option = [...providerSelect.options].find((o) => o.value === argument)
    if (option) {
      providerSelect.value = argument
      note("switched to " + option.textContent)
    } else note("unknown model: " + argument)
    return true
  }

  if (name === "/help") {
    note(paletteData.commands.map((c) => c.value + "  -  " + c.hint).join(String.fromCharCode(10)))
    return true
  }

  if (name === "/compact") {
    note("compaction runs automatically when the conversation nears the context limit")
    return true
  }

  if (name.startsWith("/")) {
    note("unknown command: " + name)
    return true
  }

  return false
}

/** A short system line in the thread, styled like a tool row. */
function note(text) {
  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  const row = document.createElement("div")
  row.className = "tool done note"
  row.innerHTML = "<span class=\"spin\">ℹ</span>"
  const body = document.createElement("span")
  body.className = "tname"
  body.style.whiteSpace = "pre-wrap"
  body.textContent = text
  row.appendChild(body)
  thread.appendChild(row)
  scrollDown()
}

async function submit() {
  const text = input.value.trim()
  if (!text || busy) return

  // Commands never reach the model.
  if (text.startsWith("/")) {
    input.value = ""
    paletteItems = []
    renderPalette()
    if (await runCommand(text)) { setBusy(false); return }
  }
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
        if (event.type === "tool_start") {
          body = null
          toolChip(event.name, event.args)
          lastToolArgs = event.args
          runningTools.push(event.name)
          renderActivity()
        }
        if (event.type === "attached") note("attached " + event.files.join(", "))
        if (event.type === "plan") { planItems = event.todos; renderActivity() }
        if (event.type === "permission") { body = null; permissionPrompt(event) }
        if (event.type === "tool_denied") {
          const chip = [...thread.querySelectorAll(".tool.running")].pop()
          if (chip) { chip.classList.remove("running"); chip.classList.add("failed"); chip.querySelector(".spin").textContent = "✗" }
        }
        if (event.type === "tool_end") {
          runningTools = runningTools.filter((n) => n !== event.name)
          const ok = !String(event.result || "").startsWith("error:")
          feedItems.push({ label: event.name, ok })
          noteChange(event.name, lastToolArgs, event.result)
          renderActivity()
        }
        if (event.type === "tool_end") {
          const chip = thread.querySelector(".tool.running:last-of-type") || [...thread.querySelectorAll(".tool.running")].pop()
          if (chip) {
            chip.classList.remove("running")
            chip.classList.add(event.result.startsWith("error:") ? "failed" : "done")
            chip.querySelector(".spin").textContent = event.result.startsWith("error:") ? "\u2717" : "\u2713"
          }
        }
        if (event.type === "compacted") {
          const note = document.createElement("div")
          note.className = "tool done"
          note.innerHTML = "<span class=\"spin\">✓</span><span class=\"tname\">compacted</span>"
          note.append(" " + event.before + " → " + event.after + " messages")
          thread.appendChild(note)
          scrollDown()
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

sendBtn.onclick = () => (busy ? stopTurn() : submit())
async function stopTurn() {
  // Tell the server first: aborting only the fetch leaves the agent running
  // and still spending tokens on a turn nobody will see.
  if (sessionId) {
    await fetch("/api/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {})
  }
  if (controller) controller.abort()
}
stopBtn.onclick = stopTurn
input.oninput = () => { sendBtn.disabled = busy || !input.value.trim() }
input.onkeydown = (e) => {
  // The palette owns enter while it is open, otherwise this would submit the
  // half-typed command the palette was about to complete.
  if (paletteItems.length) return
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
    option.textContent = p.label + (p.reasoning ? " (reasoning)" : "")
    providerSelect.appendChild(option)
  }
  const ready = data.providers.filter((p) => p.ready).length
  hint.textContent = ready ? "" : "no API keys found"
})

emptyState()
setBusy(false)
refreshSessions()

/* ------------------------------------------------------------------ *
 * Slash palette
 *
 * Typing "/" opened nothing in the browser, so commands only existed in
 * the TUI. The command set comes from the server so the two surfaces
 * cannot drift apart.
 * ------------------------------------------------------------------ */

/**
 * What counts as a mention.
 *
 * Mirrored from findMention in src/core/mention.ts. This file is served to
 * the browser as a plain script rather than bundled, so it cannot import the
 * real one - test/mention.test.ts runs both against the same cases so the
 * copy cannot quietly drift away from the original.
 */
// Char codes rather than escapes: this line has been mangled by tooling before.
const MENTION_SPACE = new Set([" ", String.fromCharCode(9), String.fromCharCode(10), String.fromCharCode(13)])
const mentionIsSpace = (char) => char === undefined || MENTION_SPACE.has(char)

function findMention(text, cursor) {
  const caret = Math.max(0, Math.min(cursor, text.length))
  let start = -1
  for (let index = caret - 1; index >= 0; index--) {
    const char = text[index]
    if (mentionIsSpace(char)) return undefined
    if (char === "@") { start = index; break }
  }
  if (start < 0) return undefined
  if (start > 0 && !mentionIsSpace(text[start - 1])) return undefined
  let end = caret
  while (end < text.length && !mentionIsSpace(text[end])) end++
  return { start, end, query: text.slice(start + 1, caret) }
}

/** Basename matches first, then the shortest path. Same ranking as the TUI. */
function rankFiles(query) {
  const files = paletteData.files || []
  if (!query) return files.slice(0, 8)
  const needle = query.toLowerCase()
  const scored = []
  for (const file of files) {
    const lower = file.toLowerCase()
    const base = lower.slice(lower.lastIndexOf("/") + 1)
    const score = base.startsWith(needle) ? 0 : base.includes(needle) ? 1 : lower.includes(needle) ? 2 : -1
    if (score >= 0) scored.push({ file, score })
  }
  return scored.sort((a, b) => a.score - b.score || a.file.length - b.file.length).slice(0, 8).map((e) => e.file)
}

let paletteData = { commands: [], models: [], sessions: [], files: [] }
let paletteItems = []
let paletteIndex = 0

const paletteEl = document.createElement("div")
paletteEl.className = "palette"
paletteEl.hidden = true
document.querySelector(".composer").prepend(paletteEl)

async function loadCommands() {
  paletteData = await fetch("/api/commands").then((r) => r.json()).catch(() => paletteData)
}

function itemsFor(text, cursor) {
  // @ opens the file picker wherever the caret is; / only starts a command.
  const mention = findMention(text, cursor)
  if (mention) {
    return rankFiles(mention.query).map((file) => ({
      value: "@" + file,
      hint: file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "in this folder",
    }))
  }

  if (!text.startsWith("/")) return []
  const [head] = text.split(" ")
  const hasArgument = text.includes(" ")

  if (head === "/model" && hasArgument) {
    const q = text.slice(7).trim().toLowerCase()
    return paletteData.models.filter((m) => !q || m.value.toLowerCase().includes(q)).slice(0, 8)
  }
  if (head === "/resume" && hasArgument) {
    const q = text.slice(8).trim().toLowerCase()
    return paletteData.sessions.filter((s) => !q || s.hint.toLowerCase().includes(q)).slice(0, 8)
  }
  return paletteData.commands.filter((c) => c.value.startsWith(text.split(" ")[0]))
}

function renderPalette() {
  paletteEl.innerHTML = ""
  if (!paletteItems.length) { paletteEl.hidden = true; return }
  paletteEl.hidden = false

  paletteItems.forEach((item, index) => {
    const row = document.createElement("div")
    row.className = "prow" + (index === paletteIndex ? " active" : "")
    row.innerHTML = '<span class="pvalue"></span><span class="phint"></span>'
    row.querySelector(".pvalue").textContent = item.value
    row.querySelector(".phint").textContent = item.hint
    row.onclick = () => choose(index)
    paletteEl.appendChild(row)
  })
}

let paletteSignature = ""

function refreshPalette() {
  paletteItems = itemsFor(input.value, input.selectionStart ?? input.value.length)
  // Same rule as the TUI: a new list starts at the top.
  const signature = paletteItems.map((item) => item.value).join("|")
  if (signature !== paletteSignature) {
    paletteSignature = signature
    paletteIndex = 0
  } else {
    paletteIndex = Math.min(paletteIndex, Math.max(0, paletteItems.length - 1))
  }
  renderPalette()
}

/** Picking a bare command that takes an argument expands it; anything else runs. */
function choose(index) {
  const item = paletteItems[index]
  if (!item) return

  // A file mention is part of a question, not the whole of one: drop the path
  // in and leave the composer open to ask about it.
  if (item.value.startsWith("@")) {
    const cursor = input.selectionStart ?? input.value.length
    const mention = findMention(input.value, cursor)
    if (mention) {
      const before = input.value.slice(0, mention.start)
      const caret = before.length + item.value.length + 1
      input.value = before + item.value + " " + input.value.slice(mention.end)
      input.setSelectionRange(caret, caret)
    }
    refreshPalette()
    input.focus()
    return
  }
  const expands = paletteData.commands.find((c) => c.value === item.value && c.expands)
  if (expands) {
    input.value = item.value + " "
    refreshPalette()
    input.focus()
    return
  }
  input.value = item.value
  paletteItems = []
  renderPalette()
  submit()
}

input.addEventListener("input", refreshPalette)
// The caret can move without the text changing - clicking into the middle of a
// mention should offer to complete it.
input.addEventListener("click", refreshPalette)
const PALETTE_KEYS = ["ArrowDown", "ArrowUp", "Escape", "Tab", "Enter"]

input.addEventListener("keydown", (event) => {
  if (!paletteItems.length || !PALETTE_KEYS.includes(event.key)) return

  // The palette owns these keys outright while it is open, and preventDefault
  // alone does not give it them: the composer's own keydown handler sits on
  // this same element and still ran, so completing a file mention with enter
  // filled the path in and then immediately sent the half-written question.
  event.preventDefault()
  event.stopImmediatePropagation()

  if (event.key === "ArrowDown") { paletteIndex = Math.min(paletteItems.length - 1, paletteIndex + 1); renderPalette() }
  if (event.key === "ArrowUp") { paletteIndex = Math.max(0, paletteIndex - 1); renderPalette() }
  if (event.key === "Escape") { paletteItems = []; renderPalette() }
  if (event.key === "Tab" || event.key === "Enter") choose(paletteIndex)
}, true)

loadCommands()

/* ------------------------------------------------------------------ *
 * Activity panel
 *
 * Sections follow the original: Plan, Running, Activity, Changes. All of
 * it is driven by events the agent already emits, so nothing here needs
 * its own bookkeeping on the server.
 * ------------------------------------------------------------------ */

/**
 * Looked up on first use rather than at load.
 *
 * setBusy runs during startup, before this block is evaluated, so a const
 * here sat in its temporal dead zone and threw - which took the whole script
 * down and left the thread empty.
 */
let actCache = null
function panel() {
  if (actCache) return actCache
  actCache = {
    state: document.getElementById("act-state"),
    empty: document.getElementById("act-empty"),
    plan: { box: document.getElementById("act-plan"), list: document.getElementById("plan-list"), count: document.getElementById("plan-count") },
    running: { box: document.getElementById("act-running"), list: document.getElementById("running-list") },
    feed: { box: document.getElementById("act-feed"), list: document.getElementById("feed-list") },
    changes: { box: document.getElementById("act-changes"), list: document.getElementById("changes-list"), count: document.getElementById("changes-count") },
  }
  return actCache
}

let planItems = []
let runningTools = []
let feedItems = []
let changedFiles = new Map()

const MARK = { pending: "\u25cb", in_progress: "\u25b8", completed: "\u2713" }

function row(mark, text, cls) {
  const el = document.createElement("div")
  el.className = "act-row " + (cls || "")
  el.innerHTML = '<span class="mark"></span><span class="txt"></span>'
  el.querySelector(".mark").textContent = mark
  el.querySelector(".txt").textContent = text
  el.querySelector(".txt").title = text
  return el
}

function renderActivity() {
  const anything = planItems.length || runningTools.length || feedItems.length || changedFiles.size
  panel().empty.hidden = !!anything

  panel().plan.box.hidden = !planItems.length
  panel().plan.list.innerHTML = ""
  if (planItems.length) {
    const done = planItems.filter((t) => t.status === "completed").length
    panel().plan.count.textContent = done + "/" + planItems.length
    for (const todo of planItems) {
      panel().plan.list.appendChild(
        row(MARK[todo.status] || "\u25cb", todo.content, todo.status === "completed" ? "done" : todo.status === "in_progress" ? "active" : ""),
      )
    }
  }

  panel().running.box.hidden = !runningTools.length
  panel().running.list.innerHTML = ""
  for (const name of runningTools) panel().running.list.appendChild(row("\u25b8", name, "active"))

  // Newest first: the last thing that happened is what you are looking for.
  panel().feed.box.hidden = !feedItems.length
  panel().feed.list.innerHTML = ""
  for (const item of feedItems.slice(-12).reverse()) {
    panel().feed.list.appendChild(row(item.ok ? "\u2713" : "\u2717", item.label, item.ok ? "done" : "failed"))
  }

  panel().changes.box.hidden = !changedFiles.size
  panel().changes.list.innerHTML = ""
  panel().changes.count.textContent = String(changedFiles.size)
  for (const [file, detail] of changedFiles) panel().changes.list.appendChild(row("\u00b1", file + "  " + detail, "done"))
}

function activityBusy(state) {
  panel().state.textContent = state ? "Working" : "Idle"
  panel().state.classList.toggle("busy", state)
}

function activityReset() {
  planItems = []
  runningTools = []
  feedItems = []
  changedFiles = new Map()
  renderActivity()
}

/** Pull a file and its diff counts out of an edit or write result. */
function noteChange(name, args, result) {
  if (name !== "edit_file" && name !== "write_file") return
  let path = ""
  try { path = JSON.parse(args || "{}").path || "" } catch { /* leave blank */ }
  if (!path) return
  const counts = /\+(\d+)\s*-(\d+)/.exec(result || "")
  changedFiles.set(path, counts ? "+" + counts[1] + " -" + counts[2] : "written")
}
