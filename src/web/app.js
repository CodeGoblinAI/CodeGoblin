const thread = document.getElementById("thread")
const input = document.getElementById("input")
const sendBtn = document.getElementById("send")
const stopBtn = document.getElementById("stop")
/**
 * The model picker.
 *
 * A native select cannot be themed and looked exactly like one, so this is a
 * small list borrowing the palette styling. It opens upward because it lives
 * at the bottom of the window, which is where it belongs.
 */
const providerBtn = document.getElementById("provider-btn")
const providerMenu = document.getElementById("provider-menu")
const providerLabel = providerBtn.querySelector(".picker-label")
let modelOptions = []
let currentModel = ""

function renderModelMenu() {
  providerMenu.innerHTML = ""
  let section = null
  for (const option of modelOptions) {
    // A heading each time the section changes, so the list reads as groups
    // rather than as one run of names.
    if (option.section && option.section !== section) {
      section = option.section
      const head = document.createElement("div")
      head.className = "picker-section"
      head.textContent = section
      providerMenu.appendChild(head)
    }
    const row = document.createElement("div")
    // A model with no key is still selectable - the /connect flow is how you
    // fix that - but it should not look identical to one that works. Every
    // model used to, and you found out which was which by sending a prompt
    // and getting "No API key for GLM." back.
    row.className =
      "picker-item" + (option.value === currentModel ? " chosen" : "") + (option.ready ? "" : " unready")
    row.setAttribute("role", "option")
    row.textContent = option.label
    if (!option.ready) {
      const tag = document.createElement("span")
      tag.className = "picker-tag"
      tag.textContent = option.connectionHint ? "setup" : "no key"
      row.appendChild(tag)
      row.title = option.connectionHint || "No API key for this provider yet - add one with /connect"
    }
    row.onclick = () => { setModel(option.value); closeModelMenu() }
    providerMenu.appendChild(row)
  }
}

function setModel(value) {
  const option = modelOptions.find((o) => o.value === value)
  if (!option) return false
  if (deferUntilIdle(() => setModel(value), "switch model")) return true
  if (currentModel !== value) showUsage(sessionUsage ? { spend: sessionUsage.spend } : null)
  currentModel = value
  providerLabel.textContent = option.label
  renderModelMenu()
  return true
}

function closeModelMenu() {
  providerMenu.hidden = true
  providerBtn.setAttribute("aria-expanded", "false")
}

providerBtn.onclick = (event) => {
  event.stopPropagation()
  providerMenu.hidden = !providerMenu.hidden
  providerBtn.setAttribute("aria-expanded", String(!providerMenu.hidden))
}
document.addEventListener("click", (event) => {
  if (!providerMenu.hidden && !providerMenu.contains(event.target)) closeModelMenu()
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModelMenu()
})

/**
 * How much to ask before acting - Codex's three choices. Sent with every
 * message; changes during a turn also update its live permissions. It starts at Ask for
 * approval on every load, so Full access never quietly outlives a reload.
 */
const modeBtn = document.getElementById("mode-btn")
const modeMenu = document.getElementById("mode-menu")
const planTag = document.getElementById("plan-tag")
const boostTag = document.getElementById("boost-tag")
const MODE_CHOICES = [
  { id: "ask", label: "Ask for approval", hint: "ask before changing files, running commands or using the internet" },
  { id: "approve", label: "Approve for me", hint: "only ask for actions that could be unsafe" },
  { id: "full", label: "Full access", hint: "never ask - only the rules in codegoblin.jsonc stop anything" },
]
let currentMode = "ask"
let planning = false
/** /boost: subagents are offered only when asked for - for the session, or once for one request. */
let boost = false
let boostOnce = false

function modeChoices() {
  return paletteData.modes && paletteData.modes.length ? paletteData.modes : MODE_CHOICES
}

function renderModeMenu() {
  modeMenu.innerHTML = ""
  for (const choice of modeChoices()) {
    const row = document.createElement("div")
    row.className = "picker-item" + (choice.id === currentMode ? " chosen" : "")
    row.setAttribute("role", "option")
    row.textContent = choice.label
    const hint = document.createElement("span")
    hint.className = "picker-hint"
    hint.textContent = choice.hint
    row.appendChild(hint)
    row.onclick = () => { setMode(choice.id); closeModeMenu() }
    modeMenu.appendChild(row)
  }
}

async function setMode(id) {
  const choice = modeChoices().find((c) => c.id === id)
  if (!choice) return
  if (busy && sessionId) {
    const result = await fetch("/api/mode", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, mode: id }),
    }).then((response) => response.json()).catch(() => null)
    if (!result?.ok) { note("Could not change the running turn's approval mode. Try again."); return }
  }
  currentMode = id
  modeBtn.querySelector(".picker-label").textContent = choice.label
  modeBtn.classList.toggle("full", id === "full")
  renderModeMenu()
}

function setPlanning(on) {
  planning = on
  planTag.hidden = !on
}

function setBoost(on) {
  boost = on
  boostTag.hidden = !(boost || boostOnce)
}

function closeModeMenu() {
  modeMenu.hidden = true
  modeBtn.setAttribute("aria-expanded", "false")
}

function openModeMenu() {
  renderModeMenu()
  modeMenu.hidden = false
  modeBtn.setAttribute("aria-expanded", "true")
}

modeBtn.onclick = (event) => {
  event.stopPropagation()
  if (modeMenu.hidden) openModeMenu()
  else closeModeMenu()
}
document.addEventListener("click", (event) => {
  if (!modeMenu.hidden && !modeMenu.contains(event.target)) closeModeMenu()
})
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModeMenu()
})

/** After a planned answer: carry it out, keep planning, or stop. Inline, like a permission prompt. */
function planPrompt() {
  const box = document.createElement("div")
  box.className = "plan-box"
  box.innerHTML = '<div class="ptext">Carry out this plan?</div><div class="pactions"></div>'
  const actions = box.querySelector(".pactions")
  const resolve = (label) => {
    actions.innerHTML = ""
    const done = document.createElement("span")
    done.className = "presolved"
    done.textContent = label
    actions.appendChild(done)
  }
  const choices = [
    { label: "Yes, carry it out", kind: "pallow", act: () => { setPlanning(false); resolve("carrying it out"); sendText("Go ahead and carry out the plan.") } },
    { label: "Keep planning", kind: "pallow", act: () => { resolve("still planning - say what to change"); input.focus() } },
    { label: "Stop planning", kind: "pdeny", act: () => { setPlanning(false); resolve("planning off") } },
  ]
  for (const choice of choices) {
    const button = document.createElement("button")
    button.className = choice.kind
    button.textContent = choice.label
    button.onclick = choice.act
    actions.appendChild(button)
  }
  thread.appendChild(box)
  scrollDown()
}

/** Sends text as though it had been typed. */
function sendText(text) {
  input.value = text
  submit()
}
/**
 * Pictures attached to the next message.
 *
 * Three ways in, because people reach for all three: the + button, a paste
 * from the clipboard, and a drop onto the thread. A path typed as @shot.png
 * is a fourth, handled on the server with the other mentions.
 */
const attachedRow = document.getElementById("attached")
const filePicker = document.getElementById("picker")
const attachBtn = document.getElementById("attach")
let attachments = []

/** Matches the server's cap, so nothing is accepted here that is refused there. */
const MAX_IMAGE_BYTES = 5_000_000
const MAX_IMAGES = 10

function renderAttached() {
  attachedRow.innerHTML = ""
  attachedRow.hidden = attachments.length === 0
  attachments.forEach((image, index) => {
    const cell = document.createElement("div")
    cell.className = "shot"
    const thumb = document.createElement("img")
    thumb.src = image.dataUrl
    thumb.alt = image.name
    cell.title = image.name
    cell.appendChild(thumb)
    const drop = document.createElement("button")
    drop.type = "button"
    drop.textContent = "×"
    drop.title = "Remove " + image.name
    drop.onclick = () => { attachments.splice(index, 1); renderAttached() }
    cell.appendChild(drop)
    attachedRow.appendChild(cell)
  })
  // While a turn runs this button is Stop, and a disabled Stop cannot stop anything.
  sendBtn.disabled = !busy && !input.value.trim() && attachments.length === 0
}

/** Whether the model on the picker can actually be shown one. */
function modelSees() {
  const option = modelOptions.find((each) => each.value === currentModel)
  return Boolean(option && option.vision)
}

function addFiles(files) {
  for (const file of files) {
    if (attachments.length >= MAX_IMAGES) { note("at most " + MAX_IMAGES + " images per message"); break }
    if (!file.type.startsWith("image/")) { note(file.name + " is not an image"); continue }
    if (file.size > MAX_IMAGE_BYTES) {
      note(file.name + " is " + Math.round(file.size / 1024) + " KB, over the " + (MAX_IMAGE_BYTES / 1e6) + " MB limit")
      continue
    }
    const reader = new FileReader()
    reader.onload = () => {
      attachments.push({ name: file.name, dataUrl: String(reader.result) })
      renderAttached()
      // Said once, when the picture is added, rather than after it is sent.
      if (!modelSees()) note("the selected model cannot see images - pick a vision model before sending")
    }
    reader.readAsDataURL(file)
  }
}

attachBtn.onclick = () => {
  const modal = makeDialog("Add to the prompt")
  for (const [label, action] of [
    ["Attach an image", () => filePicker.click()],
    ["Mention a project file", () => { input.value += (input.value && !input.value.endsWith(" ") ? " " : "") + "@"; input.focus(); refreshPalette() }],
    ["Browse slash commands", () => { void runCommand("/help") }],
  ]) {
    const button = document.createElement("button")
    button.className = "dialog-action"; button.textContent = label
    button.onclick = () => { modal.close(); action() }
    modal.appendChild(button)
  }
}
filePicker.onchange = () => { addFiles([...filePicker.files]); filePicker.value = "" }

input.addEventListener("paste", (event) => {
  const files = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean)
  // Only swallow the paste when it really was a picture; pasted text still
  // has to reach the composer.
  if (files.length) { event.preventDefault(); addFiles(files) }
})

for (const name of ["dragover", "drop"]) {
  thread.addEventListener(name, (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return
    event.preventDefault()
    if (name === "drop") addFiles([...(event.dataTransfer?.files ?? [])])
  })
}

const hint = document.getElementById("hint")
const sessionList = document.getElementById("session-list")

let sessionId = null
let sessionUsage = null
function showUsage(value) {
  sessionUsage = value
  const used = value?.spend
  const context = value?.context
  const contextLabel = context ? context.limit > 0 ? " · ~" + context.percent + "% context" : " · context window unavailable" : ""
  document.getElementById("usage-readout").textContent = !value
    ? "Usage unavailable until a response"
    : !used
    ? "Tokens/cost unavailable (not zero)" + contextLabel
    : `${used.input.toLocaleString()} in / ${used.output.toLocaleString()} out · ${used.dollars === undefined ? "cost unknown / subscription" : "$" + used.dollars.toFixed(4) + (used.unpriced ? " + unpriced usage" : " estimated")}${contextLabel}`
}
let busy = false
let deferredAction
function deferUntilIdle(action, label) {
  if (!busy) return false
  const replaced = Boolean(deferredAction)
  deferredAction = action
  note((replaced ? "Replaced queued action: " : "Queued until this turn finishes: ") + label)
  return true
}
let controller = null
let lastToolArgs = ""

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|(?:\s*:?-+:?\s*\|)+\s*$/

/**
 * Inline code and bold, on text that is already HTML-escaped.
 *
 * Shared with the table builder. Cells are escaped and lifted out before the
 * line-level passes run, so without this a cell holding `tsc --noEmit` kept
 * its backticks while the same words in a sentence became code.
 */
function inlineMarkdown(escaped) {
  return escaped
    .replace(/`([^`\n]+)`/g, (_, code) => "<code>" + code + "</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
}

/** Cells of one row; an escaped pipe is content, not a boundary. */
function tableCells(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().split("\\|").join("|"))
}

/**
 * Pull markdown tables out as real <table> elements.
 *
 * Models answer with tables constantly and this renderer had no case for
 * them, so they arrived as rows of literal pipes and dashes - the reader
 * doing the aligning that the markup exists to do. They are lifted into the
 * same placeholder list the code fences use, so the line-level passes that
 * follow never see their newlines.
 */
function extractTables(text, blocks) {
  const lines = text.split("\n")
  const out = []

  for (let i = 0; i < lines.length; i++) {
    // A table only starts where the alignment rule sits under the header,
    // otherwise a sentence with two pipes in it would become a grid.
    if (!TABLE_ROW.test(lines[i]) || !TABLE_RULE.test(lines[i + 1] || "")) {
      out.push(lines[i])
      continue
    }

    let end = i
    while (end < lines.length && TABLE_ROW.test(lines[end])) end++

    const header = tableCells(lines[i])
    const align = tableCells(lines[i + 1]).map((spec) =>
      spec.startsWith(":") && spec.endsWith(":") ? "center" : spec.endsWith(":") ? "right" : "left",
    )
    const body = lines.slice(i + 2, end).map(tableCells)
    const columns = Math.max(header.length, ...body.map((row) => row.length), 1)
    const at = (row, column) => inlineMarkdown(escapeHtml(row[column] === undefined ? "" : row[column]))
    const styled = (column) => (align[column] && align[column] !== "left" ? ' style="text-align:' + align[column] + '"' : "")

    let table = '<div class="tablewrap"><table>'
    table += "<thead><tr>"
    for (let c = 0; c < columns; c++) table += "<th" + styled(c) + ">" + at(header, c) + "</th>"
    table += "</tr></thead><tbody>"
    for (const row of body) {
      table += "<tr>"
      for (let c = 0; c < columns; c++) table += "<td" + styled(c) + ">" + at(row, c) + "</td>"
      table += "</tr>"
    }
    table += "</tbody></table></div>"

    blocks.push(table)
    out.push("\u0000BLOCK" + (blocks.length - 1) + "\u0000")
    i = end - 1
  }

  return out.join("\n")
}

/**
 * Small markdown renderer: fenced code, tables, inline code, bold, headings,
 * lists. Agents answer in markdown, so showing it raw makes every reply look
 * broken.
 */
function markdown(text) {
  const blocks = []
  let html = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    blocks.push('<pre class="code"><code>' + escapeHtml(code.replace(/\n$/, "")) + "</code></pre>")
    return "\u0000BLOCK" + (blocks.length - 1) + "\u0000"
  })

  // Tables come out before the line-level passes, because those turn every
  // newline into a <br> and a table's newlines are structure, not spacing.
  // After the fences, so a table drawn inside a code block stays code.
  html = extractTables(html, blocks)

  html = inlineMarkdown(escapeHtml(html))
  html = html.replace(/^### (.+)$/gm, "<h4>$1</h4>")
  html = html.replace(/^## (.+)$/gm, "<h3>$1</h3>")
  html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>")
  html = html.replace(/(<li>[\s\S]*?<\/li>)(?!\s*<li>)/g, "<ul>$1</ul>")
  // A lifted block is already block-level, so wrapping it in <p> would put a
  // <pre> or a <table> inside a paragraph; the browser then closes the <p>
  // early and leaves a stray one behind.
  const lifted = /^\u0000BLOCK\d+\u0000$/
  html = html
    .split("\n\n")
    .map((p) => (p.trim().startsWith("<") || lifted.test(p.trim()) ? p : "<p>" + p + "</p>"))
    .join("")
  html = html.replace(/\n/g, "<br>")

  return html.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)])
}

const atBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 60
const scrollDown = () => { thread.scrollTop = thread.scrollHeight }

function emptyState() {
  thread.innerHTML = '<div class="empty-hint"><h1>What should we work on?</h1><p>Ask about your code, or try <code>/help</code> in the TUI.</p></div>'
}

function turn(kind, text, images) {
  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  const wrap = document.createElement("div")
  wrap.className = "turn " + (kind === "user" ? "user" : "agent")
  wrap.innerHTML = '<div class="who">' + (kind === "user" ? "you" : "goblin") + '</div><div class="body"></div>'
  const body = wrap.querySelector(".body")
  if (kind === "user") body.textContent = text
  else body.innerHTML = markdown(text)
  // The transcript shows what was sent, so a question about a picture still
  // makes sense when the conversation is read back later.
  if (images && images.length) {
    const row = document.createElement("div")
    row.className = "attached"
    for (const image of images) {
      const cell = document.createElement("div")
      cell.className = "shot"
      cell.title = image.name
      const thumb = document.createElement("img")
      thumb.src = image.dataUrl
      thumb.alt = image.name
      cell.appendChild(thumb)
      row.appendChild(cell)
    }
    body.appendChild(row)
  }
  thread.appendChild(wrap)
  scrollDown()
  return body
}

/**
 * The model thinking out loud.
 *
 * The stream has always carried this and the browser dropped it, so the TUI
 * showed its reasoning and this did not. Kept visually quiet - it is context
 * for what follows, not the answer.
 */
function thinkingBlock() {
  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  const wrap = document.createElement("div")
  wrap.className = "thinking"
  wrap.innerHTML = '<div class="tlabel">thinking</div><div class="tbody"></div>'
  thread.appendChild(wrap)
  scrollDown()
  return wrap.querySelector(".tbody")
}

/**
 * The chip a tool-call id belongs to.
 *
 * Falls back to the last one still running, for the case where an id never
 * arrived - better a stale guess than a result that lands nowhere.
 */
function chipFor(id) {
  return (
    (id && thread.querySelector('.tool[data-call="' + id + '"]')) ||
    thread.querySelector(".tool.running:last-of-type") ||
    [...thread.querySelectorAll(".tool.running")].pop()
  )
}

function toolChip(name, args, id) {
  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  const chip = document.createElement("div")
  chip.className = "tool running"
  // Tagged with the model's tool-call id so a result can find its own row.
  // Several tools can be running at once, so "the last running chip" was no
  // longer a safe way to guess which one had just finished.
  if (id) chip.dataset.call = id
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
  box.dataset.permission = event.id
  // Three answers, the same three the TUI offers. "Allow once" first,
  // because the least committal choice should be the easiest to reach.
  const choices = paletteData.decisions || [
    { id: "once", label: "Allow once", hint: "just this one call" },
    { id: "always", label: "Allow for this session", hint: "stop asking about calls like this" },
    { id: "reject", label: "Reject", hint: "refuse, and tell the model so" },
  ]
  box.innerHTML =
    '<div class="ptext">Allow <strong></strong>?<span class="pdetail"></span><span class="pcover"></span></div><div class="pactions"></div>'
  box.querySelector("strong").textContent = event.tool
  // A subagent's question says so: from the conversation alone a person cannot tell which agent is asking.
  if (event.from) box.querySelector(".ptext").insertAdjacentText("afterbegin", event.from + " subagent: ")
  // A shell call is shown as its command rather than the JSON it arrived in.
  let asked = event.detail || ""
  try {
    const parsed = JSON.parse(asked)
    if (parsed && typeof parsed.command === "string") asked = parsed.command
  } catch {
    // Not JSON, so it is shown as it came.
  }
  box.querySelector(".pdetail").textContent = asked.slice(0, 160)
  // What "Allow for this session" would approve. It covers one command now,
  // not the whole tool, so the choice has to say which.
  const always = choices.find((c) => c.id === "always")
  const cover = event.cover ? "stop asking about " + event.cover : ""
  if (always && event.cover) box.querySelector(".pcover").textContent = always.label + " covers " + event.cover

  const actions = box.querySelector(".pactions")
  const answer = async (decision) => {
    const chosen = choices.find((c) => c.id === decision)
    actions.innerHTML = ""
    const done = document.createElement("span")
    done.className = "presolved"
    done.textContent = chosen ? chosen.label.toLowerCase() : decision
    actions.appendChild(done)
    await fetch("/api/permission", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: event.id, decision }),
    })
  }

  for (const choice of choices) {
    const button = document.createElement("button")
    button.className = choice.id === "reject" ? "pdeny" : "pallow"
    button.textContent = choice.label
    button.title = choice.id === "always" && cover ? cover : choice.hint
    button.onclick = () => answer(choice.id)
    actions.appendChild(button)
  }

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
  if (!state && deferredAction) {
    const action = deferredAction
    deferredAction = undefined
    queueMicrotask(action)
  }
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
  if (deferUntilIdle(() => openSession(id), "open conversation")) return
  const data = await fetch("/api/session?id=" + encodeURIComponent(id) + "&model=" + encodeURIComponent(currentModel)).then((r) => r.json()).catch(() => null)
  if (!data || !data.session) return
  sessionId = id
  showUsage({ spend: data.session.spend, context: data.context })
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
/**
 * Repaint from a palette.
 *
 * The stylesheet only ever refers to these custom properties, so a theme is
 * twelve assignments rather than a second stylesheet to keep in step.
 */
function applyPalette(palette) {
  if (!palette) return
  const root = document.documentElement.style
  root.setProperty("--step1", palette.step1)
  root.setProperty("--step2", palette.step2)
  root.setProperty("--step3", palette.step3)
  root.setProperty("--step5", palette.step5)
  root.setProperty("--step7", palette.step7)
  root.setProperty("--step11", palette.step11)
  root.setProperty("--step12", palette.step12)
  root.setProperty("--goblin", palette.green)
  root.setProperty("--goblin-bright", palette.greenBright)
  root.setProperty("--gold", palette.gold)
  root.setProperty("--red", palette.red)
  root.setProperty("--orange", palette.orange)
}

let webSettings = { theme: "goblin", thinking: true }

function makeDialog(title) {
  document.querySelector("dialog")?.close()
  const modal = document.createElement("dialog")
  modal.setAttribute("aria-label", title)
  const heading = document.createElement("h2"); heading.textContent = title; modal.appendChild(heading)
  const close = document.createElement("button"); close.textContent = "Close"; close.onclick = () => modal.close(); modal.appendChild(close)
  modal.addEventListener("close", () => { modal.remove(); input.focus() }, { once: true })
  document.body.appendChild(modal); modal.showModal()
  return modal
}

function openSettingsDialog() {
  const modal = makeDialog("Settings")
  const select = (label, options, current, change) => {
    const row = document.createElement("label"); row.textContent = label
    const field = document.createElement("select")
    for (const [value, text] of options) { const option = document.createElement("option"); option.value = value; option.textContent = text; field.appendChild(option) }
    field.value = current
    field.onchange = async () => { field.disabled = true; try { await change(field.value) } finally { field.disabled = false } }
    row.appendChild(field); modal.appendChild(row)
  }
  select("Theme", paletteData.themes.map((t) => [t.value.slice(7), t.hint]), webSettings.theme, (theme) => saveSettings({ theme }))
  select("Thinking", [["on", "Shown"], ["off", "Hidden"]], webSettings.thinking ? "on" : "off", (value) => saveSettings({ thinking: value === "on" }))
  select("Reasoning effort (supported models)", ["auto", "low", "medium", "high"].map((x) => [x, x]), webSettings.effort || "auto", (effort) => saveSettings({ effort }))
  for (const option of modelSettings()) {
    if (!option.choices?.length) continue
    select(option.label, option.choices.map((c) => [c.id, c.label]), mediaValue(option.id), (value) => runCommand("/settings " + option.id + " " + value))
  }
}

function openHelpDialog(initial = "") {
  const modal = makeDialog("Commands")
  const search = document.createElement("input")
  search.type = "search"
  search.placeholder = "Filter commands"
  search.setAttribute("aria-label", "Filter commands")
  search.value = initial
  const list = document.createElement("div")
  list.className = "command-list"
  const aliases = Object.entries(paletteData.aliases || {}).map(([value, canonical]) => ({
    value,
    hint: "alias for " + canonical,
    alias: true,
  }))
  const entries = [...(paletteData.commands || []), ...aliases]
  const paint = () => {
    list.replaceChildren()
    const query = search.value.trim().toLowerCase()
    for (const command of entries.filter((entry) => !query || (entry.value + " " + entry.hint).toLowerCase().includes(query))) {
      const row = document.createElement("button")
      row.className = "dialog-action command-row"
      const name = document.createElement("code"); name.textContent = command.value; row.appendChild(name)
      const hint = document.createElement("span"); hint.textContent = command.hint; row.appendChild(hint)
      row.onclick = () => {
        modal.close()
        input.value = (command.alias ? paletteData.aliases[command.value] : command.value) + " "
        input.focus()
        refreshPalette()
      }
      list.appendChild(row)
    }
    if (!list.children.length) {
      const empty = document.createElement("p"); empty.textContent = "No matching commands."; list.appendChild(empty)
    }
  }
  search.oninput = paint
  modal.append(search, list)
  paint()
  search.focus()
}

document.getElementById("settings-open").onclick = openSettingsDialog
document.getElementById("help-open").onclick = () => openHelpDialog()
for (const panel of ["sessions", "activity"]) {
  const button = document.getElementById(panel + "-toggle")
  const paint = (hidden) => { document.body.classList.toggle("hide-" + panel, hidden); button.setAttribute("aria-expanded", String(!hidden)) }
  paint(localStorage.getItem("cg-hide-" + panel) === "true" || (innerWidth < 650 && localStorage.getItem("cg-hide-" + panel) === null))
  button.onclick = () => { const hidden = !document.body.classList.contains("hide-" + panel); paint(hidden); localStorage.setItem("cg-hide-" + panel, String(hidden)) }
}

async function saveSettings(change) {
  const result = await fetch("/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  }).then((r) => r.json()).catch(() => null)
  if (!result?.settings) { note("Could not save settings. Please try again."); return null }
  webSettings = result.settings
  applyPalette(result.palette)
  document.body.classList.toggle("hide-thinking", !webSettings.thinking)
  return result
}

/**
 * Show what was generated.
 *
 * A path in a log is not much of a picture. The browser can display the
 * thing it just asked for, so it does - and falls back to naming the file
 * when there is nothing to show, as for a 3D model.
 */
function showMedia(kind, result) {
  if (!result.ok || result.dryRun || !result.output) {
    note(result.message)
    return
  }

  const wrap = document.createElement("div")
  wrap.className = "media"
  const src = "/api/file?path=" + encodeURIComponent(result.output)

  if (kind === "image") {
    const img = document.createElement("img")
    img.src = src
    img.alt = result.output
    wrap.appendChild(img)
  } else if (kind === "audio") {
    const audio = document.createElement("audio")
    audio.controls = true
    audio.src = src
    wrap.appendChild(audio)
  }

  const caption = document.createElement("a")
  caption.className = "media-caption"
  caption.href = src
  caption.target = "_blank"
  caption.textContent = result.output + (result.model ? "  via " + result.model : "")
  wrap.appendChild(caption)

  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  thread.appendChild(wrap)
  scrollDown()
}

/**
 * Ask for a key.
 *
 * A password field, submitted and then cleared - the value never becomes a
 * message, never enters the thread, and is not kept anywhere in the page
 * after it is sent.
 */
function connectForm(provider) {
  if (thread.querySelector(".empty-hint")) thread.innerHTML = ""
  const box = document.createElement("div")
  box.className = "permission"
  box.innerHTML =
    '<div class="ptext">Connect <strong></strong><span class="pdetail"></span></div>' +
    '<div class="pactions"><input class="pkey" type="password" autocomplete="off" spellcheck="false" ' +
    'placeholder="paste the key" /><button class="pallow">Save</button></div>'
  box.querySelector("strong").textContent = provider
  const environment = paletteData.connectable?.find((entry) => entry.id === provider)?.env || (provider === "cursor-api" ? "CURSOR_API_KEY" : provider.toUpperCase().replace(/[^A-Z0-9]/g, "_") + "_API_KEY")
  box.querySelector(".pdetail").textContent = environment + " would also work, without storing anything"

  const field = box.querySelector(".pkey")
  const save = async () => {
    const key = field.value
    field.value = ""
    const result = await fetch("/api/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider, key }),
    }).then((r) => r.json()).catch(() => ({ message: "could not reach the server" }))
    await Promise.all([loadCommands(), loadProviders()])
    box.querySelector(".pactions").innerHTML = '<span class="presolved"></span>'
    box.querySelector(".presolved").textContent = result.message
  }
  box.querySelector(".pallow").onclick = save
  field.addEventListener("keydown", (event) => { if (event.key === "Enter") save() })

  thread.appendChild(box)
  scrollDown()
  field.focus()
}

function openAccountDialog() {
  const modal = makeDialog("Codex account / subscription quotas")
  const body = document.createElement("pre"); body.style.whiteSpace = "pre-wrap"; body.textContent = "Checking official Codex CLI…"
  const refresh = document.createElement("button"); refresh.textContent = "Refresh quotas"
  const login = document.createElement("button"); login.textContent = "Official sign-in"; login.onclick = () => { modal.close(); openCodexLoginDialog() }
  modal.append(body, refresh, login)
  const show = (data) => { body.textContent = data?.rows ? data.rows.map(([label, value]) => label + ": " + value).join("\n") : "Codex account unavailable; check CLI compatibility/sign-in" }
  const update = async () => {
    refresh.disabled = true
    const cached = await fetch("/api/codex/account?cached=1", { cache: "no-store" }).then((r) => r.json()).catch(() => null)
    if (!modal.isConnected) return
    show(cached)
    body.textContent += "\nRefreshing…"
    const data = await fetch("/api/codex/account", { cache: "no-store" }).then((r) => r.json()).catch(() => null)
    if (!modal.isConnected) return
    show(data)
    refresh.disabled = false
  }
  refresh.onclick = () => { void update() }
  void update()
}

function openCodexLoginDialog(source = "codex") {
  const cursor = source === "cursor"
  const endpoint = "/api/" + source + "/login"
  const modal = makeDialog(cursor ? "Cursor SDK / user-plan sign-in" : "Official Codex sign-in")
  const status = document.createElement("p"); status.textContent = cursor ? "SDK login is separate from Cursor CLI login. Completing browser sign-in creates a named SDK API key stored in this CG profile and billed to your Cursor user plan, replacing this profile's existing SDK sign-in. Native SDK tools are disabled; CG-Next owns approvals. For an existing user or service-account key, use /connect cursor-api instead." : "This signs into the official CLI's shared account. CG-Next never copies passwords or tokens. Completing sign-in may change the account used by your other Codex clients."
  const start = document.createElement("button"); start.textContent = "Start official sign-in"
  modal.append(status, start)
  let id
  const cancel = () => { if (id) void fetch(endpoint + "?id=" + encodeURIComponent(id), { method: "DELETE", keepalive: true }).catch(() => {}) }
  modal.addEventListener("close", cancel, { once: true })
  start.onclick = async () => {
    start.disabled = true
    const result = await fetch(endpoint, { method: "POST" }).then((r) => r.json()).catch(() => null)
    id = result?.id
    if (!modal.isConnected) { cancel(); return }
    if (!result?.url) { status.textContent = result?.message || "Could not start official sign-in"; start.disabled = false; return }
    const link = document.createElement("a"); link.href = result.url; link.target = "_blank"; link.rel = "noreferrer"; link.textContent = "Open official sign-in in browser"
    status.textContent = "Complete sign-in using the link. This attempt expires in five minutes; closing this popup cancels an unfinished attempt." + (cursor ? " A completed SDK key stays stored; revoke it from Cursor's account dashboard if needed." : "")
    const check = document.createElement("button"); check.textContent = "Check sign-in"
    check.onclick = async () => {
      const state = await fetch(endpoint + "?id=" + encodeURIComponent(id)).then((r) => r.json()).catch(() => null)
      if (!modal.isConnected) return
      if (state?.state === "complete") { modal.close(); if (cursor) { void loadProviders(); note("Cursor SDK signed in; select /model cursor/default") } else openAccountDialog(); return }
      status.textContent = state?.state === "pending" ? "Still waiting for browser sign-in." : "Sign-in failed, expired or was cancelled; close this popup and try again."
    }
    modal.append(link, check)
    start.remove()
  }
}

async function openImportDialog(selectedId) {
  const modal = makeDialog("Import Codex text conversation")
  const status = document.createElement("p"); status.textContent = "Choose a conversation for this project. A new text-only copy is created; your source and current conversation stay unchanged. Native tools, images, reasoning and hidden prompts are omitted. Continuing the copy sends its text to your selected model."
  const list = document.createElement("div"); modal.append(status, list)
  const choose = (entry) => {
    list.replaceChildren()
    const label = document.createElement("p"); label.textContent = entry.title + " · ID …" + entry.id.slice(-8)
    const confirm = document.createElement("button"); confirm.textContent = "Copy as new conversation"
    confirm.onclick = async () => {
      confirm.disabled = true
      const result = await fetch("/api/codex/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: entry.id, model: currentModel }) }).then((r) => r.json()).catch(() => null)
      if (!modal.isConnected) return
      status.textContent = result?.message || "Import failed; source and current conversation unchanged"
      if (!result?.id) { confirm.disabled = false; return }
      label.textContent = result.title + " · " + result.messages + " messages. Use /resume to open the copy."
      confirm.remove()
      void refreshSessions()
    }
    list.append(label, confirm)
  }
  if (selectedId) { choose({ id: selectedId, title: selectedId }); return }
  const page = async (cursor) => {
    list.textContent = "Reading official CLI session list…"
    const data = await fetch("/api/codex/import" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "")).then((r) => r.json()).catch(() => null)
    if (!modal.isConnected) return
    list.replaceChildren()
    for (const entry of data?.sessions || []) {
      const row = document.createElement("button"); row.className = "dialog-action"
      const time = (entry.updatedAt === undefined ? "" : new Date(entry.updatedAt * 1000).toLocaleString() + " · ") + entry.id.slice(-8)
      row.textContent = entry.title + " · " + time; row.onclick = () => choose(entry); list.appendChild(row)
    }
    if (data?.next) { const more = document.createElement("button"); more.textContent = "More conversations"; more.onclick = () => { void page(data.next) }; list.appendChild(more) }
    if (!list.children.length) list.textContent = data?.message || "No Codex conversations for this project."
  }
  await page()
}

async function runCommand(text) {
  text = text.replace(/^\/[^\s]+/, (name) => paletteData.aliases?.[name] || name)
  const [name, ...rest] = text.split(" ")
  const argument = rest.join(" ").trim()
  if (name === "/account") {
    if (argument && argument !== "codex") { note("Only Codex account telemetry is wired; use /account codex"); return true }
    openAccountDialog(); return true
  }
  if (name === "/login") {
    if (argument === "cursor") { openCodexLoginDialog("cursor"); return true }
    if (argument === "claude" || argument === "claude-code" || argument === "cursor-cli") {
      const source = argument === "cursor-cli" ? "cursor" : "claude"
      const modal = makeDialog("Official " + source + " sign-in handoff")
      const body = document.createElement("pre"); body.textContent = "Loading official command…"; modal.append(body)
      const handoff = await fetch("/api/cli/login?source=" + source, { cache: "no-store" }).then((r) => r.json()).catch(() => null)
      if (!modal.isConnected) return true
      if (!handoff?.command) { body.textContent = "Sign-in handoff unavailable"; return true }
      body.textContent = handoff.warning + "\n\n" + handoff.command + "\n\nCheck afterward: " + handoff.statusCommand
      const copy = document.createElement("button"); copy.textContent = "Copy official sign-in command"
      copy.onclick = async () => { try { await navigator.clipboard.writeText(handoff.command); copy.textContent = "Copied; run in your own terminal" } catch { copy.textContent = "Copy unavailable; select the command above" } }
      modal.append(copy); return true
    }
    if (argument !== "codex") { note("Use /login codex, /login claude or /login cursor"); return true }
    openCodexLoginDialog(); return true
  }
  if (name === "/import") {
    const [source, id, extra] = argument.split(/\s+/)
    if (source !== "codex" || extra) { note("Use /import codex [session-id]; imports are new text-only conversations"); return true }
    await openImportDialog(id); return true
  }
  if (paletteData.pending?.[name]) { note(paletteData.pending[name]); return true }
  if (name === "/quit") { note("Close this browser tab to exit the Web UI; the local server keeps running."); return true }
  if (name === "/mouse") { note("The browser supports mouse selection and Ctrl+C natively."); return true }

  if (name === "/new" || name === "/clear") {
    showUsage(null)
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
    const option = modelOptions.find((o) => o.value === argument)
    if (option) {
      setModel(argument)
      note("switched to " + option.label)
    } else note("unknown model: " + argument)
    return true
  }

  if (name === "/help") {
    openHelpDialog(argument)
    return true
  }

  if (name === "/theme") {
    if (!argument) { input.value = "/theme "; refreshPalette(); return true }
    const known = (paletteData.themes || []).some((t) => t.value === "/theme " + argument)
    if (!known) { note("unknown theme: " + argument + "  (try /theme)"); return true }
    await saveSettings({ theme: argument })
    note("theme: " + argument)
    return true
  }

  if (name === "/thinking") {
    const result = await saveSettings({ thinking: !webSettings.thinking })
    note(result && result.settings.thinking ? "showing the model's reasoning" : "hiding the model's reasoning")
    return true
  }

  if (name === "/effort") {
    const EFFORTS = ["auto", "low", "medium", "high"]
    if (!argument) {
      note("usage: /effort auto|low|medium|high" + String.fromCharCode(10) +
        "auto lets the provider decide. The rest only reach reasoning models." + String.fromCharCode(10) +
        "now: " + (webSettings.effort || "auto"))
      return true
    }
    if (!EFFORTS.includes(argument)) {
      note("unknown effort: " + argument + "  (auto, low, medium, high)")
      return true
    }
    const result = await saveSettings({ effort: argument })
    const level = result ? result.settings.effort : argument
    const model = modelOptions.find((option) => option.value === currentModel)
    const reasons = model && model.effort
    note(
      level === "auto"
        ? "effort: auto - the provider decides"
        : reasons
          ? "effort: " + level
          : "effort: " + level + " (saved; this model does not reason, so it is not sent)",
    )
    return true
  }

  if (name === "/rename") {
    if (!argument) { note("usage: /rename a shorter title"); return true }
    if (!sessionId) { note("nothing to rename yet - say something first"); return true }
    await fetch("/api/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: sessionId, title: argument }),
    }).catch(() => {})
    note("renamed to " + argument)
    refreshSessions()
    return true
  }

  if (name === "/export") {
    const result = await fetch("/api/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    }).then((r) => r.json()).catch(() => ({ message: "could not reach the server" }))
    note(result.message)
    return true
  }

  if (name === "/approvals" || name === "/mode") {
    // After this click or keypress has finished, or the click that sent the
    // command would close the menu straight away.
    setTimeout(openModeMenu, 0)
    return true
  }

  if (name === "/boost") {
    if (!argument) {
      setBoost(!boost)
      note(boost ? "boost on - the model can hand work to subagents" : "boost off")
      return true
    }
    boostOnce = true
    boostTag.hidden = false
    // Sent once this command has finished clearing the composer.
    setTimeout(() => sendText(argument), 0)
    return true
  }

  if (name === "/plan") {
    if (!argument) {
      setPlanning(!planning)
      note(planning ? "planning on - nothing changes until you agree a plan" : "planning off")
      return true
    }
    setPlanning(true)
    // Sent once this command has finished clearing the composer.
    setTimeout(() => sendText(argument), 0)
    return true
  }

  if (name === "/skills") {
    const result = await fetch("/api/skills").then((r) => r.json()).catch(() => null)
    if (!result) { note("could not reach the server"); return true }
    const lines = [
      ...result.commands.map((c) => "/" + c.name + "  command (" + c.scope + ")" + (c.description ? " - " + c.description : "")),
      ...result.skills.map((s) =>
        "/" + s.name + "  skill (" + s.scope + (s.modelInvocable ? "" : ", only you can start it") + (s.userInvocable ? "" : ", only the model can start it") + ")"),
    ]
    note(lines.length
      ? result.skills.length + " skills, " + result.commands.length + " custom commands" + String.fromCharCode(10) + lines.join(String.fromCharCode(10))
      : "no skills or custom commands yet - a skill is a folder with a SKILL.md in ~/.claude/skills")
    return true
  }

  if (name === "/mcp") {
    const result = await fetch("/api/mcp").then((r) => r.json()).catch(() => null)
    if (!result) { note("could not reach the server"); return true }
    if (!result.servers.length) { note('no MCP servers - add them under "mcp" in ' + result.config); return true }
    note(result.servers.map((server) =>
      server.name.padEnd(14) +
      (server.status === "connected"
        ? server.tools.length + " tool" + (server.tools.length === 1 ? "" : "s") + (server.tools.length ? ": " + server.tools.join(", ") : "")
        : server.status + (server.error ? " - " + server.error : ""))
    ).join(String.fromCharCode(10)))
    return true
  }

  if (name === "/usage" || name === "/balance") {
    const provider = name === "/balance" && argument ? argument : currentModel.split("/")[0]
    const modal = makeDialog(name === "/usage" ? "Usage and provider balance" : "Provider balance")
    if (name === "/usage") {
      const session = document.createElement("p")
      session.textContent = document.getElementById("usage-readout").textContent + "\nContext is estimated. Session cost is not a provider bill. Codex subscription quotas: /account codex; other subscriptions not wired yet."
      modal.appendChild(session)
    }
    const status = document.createElement("pre"); status.style.whiteSpace = "pre-wrap"; status.textContent = "Checking " + provider + "…"; modal.appendChild(status)
    const refresh = document.createElement("button"); refresh.textContent = "Refresh balance"; modal.appendChild(refresh)
    const update = async () => {
      refresh.disabled = true
      status.textContent = "Checking " + provider + "…"
      const data = await fetch("/api/balance?provider=" + encodeURIComponent(provider), { cache: "no-store" }).then((response) => response.json()).catch(() => null)
      if (!modal.isConnected) return
      status.textContent = data?.rows ? data.rows.map(([label, value]) => label + ": " + value).join("\n") : (data?.message || "Balance unavailable; try again")
      refresh.disabled = false
    }
    refresh.addEventListener("click", () => { void update() })
    void update()
    return true
  }
  if (name === "/status") {
    const model = modelOptions.find((o) => o.value === currentModel)
    note([
      "model     " + (model ? model.label : currentModel),
      ...(model?.connectionHint ? ["CLI       " + model.connectionHint] : []),
      "session   " + (sessionId || "not started yet"),
      "theme     " + webSettings.theme,
      "thinking  " + (webSettings.thinking ? "shown" : "hidden"),
      "checkpoints  " + (paletteData.checkpoint > 0 ? "ask every " + paletteData.checkpoint + " tool calls" : "off"),
      "files     " + ((paletteData.files || []).length + " known to the @ picker"),
    ].join(String.fromCharCode(10)))
    return true
  }

  if (name === "/settings" || name === "/set") {
    if (!argument) { openSettingsDialog(); return true }
    const NEWLINE = String.fromCharCode(10)
    const [id, ...rest] = argument.split(/\s+/).filter(Boolean)
    // Only what the model on the picker takes. This used to be every setting
    // for every generator, whatever was selected.
    const options = modelSettings()
    const model = modelOptions.find((option) => option.value === currentModel)
    const modelName = model ? model.label : currentModel
    if (!options.length) {
      note(
        model && model.kind === "text"
          ? modelName + " is a chat model, so it has no generation settings - pick an image, voice or 3D model"
          : "nothing on " + modelName + "'s request can be changed from here",
      )
      return true
    }
    if (!id) {
      note(modelName + NEWLINE + options.map((o) => "  " + o.id.padEnd(20) + mediaLabel(o, mediaValue(o.id))).join(NEWLINE))
      return true
    }
    const option = options.find((o) => o.id === id)
    if (!option) {
      note(modelName + " does not take " + id + NEWLINE +
        options.map((o) => "  " + o.id.padEnd(20) + o.about).join(NEWLINE))
      return true
    }
    const value = rest.join(" ").trim() || "default"
    const result = await fetch("/api/media-settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ option: option.id, value, model: currentModel }),
    }).then((r) => r.json()).catch(() => null)
    if (!result || !result.ok) {
      note((result && result.message) || "could not save that")
      return true
    }
    paletteData.media = result.settings
    note(option.label + ": " + mediaLabel(option, value))
    return true
  }
  if (MEDIA_COMMANDS.includes(name)) {
    const kind = name.slice(1) === "model3d" ? "model3d" : name.slice(1)
    if (!argument) {
      note("usage: " + (paletteData.commands.find((c) => c.value === name) || {}).hint)
      return true
    }
    turn("user", text)
    setBusy(true)
    const result = await fetch("/api/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, line: text, model: currentModel }),
    }).then((r) => r.json()).catch(() => ({ ok: false, message: "could not reach the server" }))
    setBusy(false)
    showMedia(kind, result)
    return true
  }

  if (name === "/connect") {
    if (argument === "cursor") { note("Use /login cursor for SDK user-plan sign-in, or /connect cursor-api for an existing key"); return true }
    if (argument) { connectForm(argument); return true }
    const data = await fetch("/api/connect").then((r) => r.json()).catch(() => null)
    if (!data) { note("could not reach the server"); return true }
    const NEWLINE = String.fromCharCode(10)
    note(
      (data.connections.length
        ? data.connections
            .map((c) => c.id.padEnd(18) + c.type.padEnd(7) + c.source + (c.hint ? "  " + c.hint : ""))
            .join(NEWLINE)
        : "nothing connected yet") +
        NEWLINE + NEWLINE + "/connect <provider> to add one - stored in " + data.store,
    )
    return true
  }

  if (name === "/disconnect") {
    if (argument === "cursor") { note("Revoke the SDK user-plan key in Cursor's account dashboard. /disconnect cursor-api only removes a CG-stored API key, not SDK/CLI sign-in."); return true }
    if (!argument) {
      const stored = (paletteData.connectable || []).filter((entry) => entry.connected)
      note(
        stored.length
          ? "which key? " + stored.map((entry) => entry.id).join(", ")
          : "no stored keys to remove",
      )
      return true
    }
    const result = await fetch("/api/connect?provider=" + encodeURIComponent(argument), { method: "DELETE" })
      .then((r) => r.json())
      .catch(() => ({ message: "could not reach the server" }))
    await Promise.all([loadCommands(), loadProviders()])
    note(result.message)
    return true
  }

  if (name === "/memory") {
    const result = await fetch("/api/memory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argument, sessionId }),
    }).then((r) => r.json()).catch(() => ({ message: "could not reach the server" }))
    note(result.message)
    return true
  }

  if (name === "/undo" || name === "/redo") {
    const result = await fetch("/api/undo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, direction: name.slice(1) }),
    }).then((r) => r.json()).catch(() => ({ message: "could not reach the server" }))
    note(result.message)
    refreshSessions()
    return true
  }

  if (name === "/compact") {
    note("compaction runs automatically when the conversation nears the context limit")
    return true
  }

  if (name === "/diff") {
    const selected = sessionId
    const data = await fetch("/api/diff?sessionId=" + encodeURIComponent(selected || "")).then((response) => response.ok ? response.json() : null).catch(() => null)
    if (!data) { note("Could not load the conversation diff."); return true }
    if (sessionId !== selected) return true
    const modal = makeDialog("Conversation changes")
    const summary = document.createElement("p"); summary.textContent = data.message; modal.appendChild(summary)
    for (const file of data.files) {
      const section = document.createElement("details"); section.open = true
      const heading = document.createElement("summary")
      heading.textContent = file.path + " · " + file.status + " · +" + file.added + " −" + file.removed
      section.appendChild(heading)
      if (file.truncated) {
        const warning = document.createElement("p"); warning.textContent = "This file is too large for a full line-by-line diff."; section.appendChild(warning)
      }
      for (const hunk of file.hunks) {
        const header = document.createElement("pre"); header.className = "diff-hunk"
        header.textContent = `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`
        section.appendChild(header)
        for (const line of hunk.lines) {
          const row = document.createElement("pre"); row.className = "diff-line diff-" + line.kind
          row.textContent = String(line.before ?? "").padStart(5) + " " + String(line.after ?? "").padStart(5) + " " + (line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " ") + line.text
          section.appendChild(row)
        }
      }
      modal.appendChild(section)
    }
    return true
  }

  // A custom command or a skill is a message, so it goes to the model.
  if ((paletteData.commands || []).some((c) => c.invocation && c.value === name)) return false

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
  const text = input.value.trim().replace(/^\/[^\s]+/, (name) => paletteData.aliases?.[name] || name)
  if (!text && !attachments.length) return
  if (busy) {
    input.value = ""
    paletteItems = []
    renderPalette()
    if (/^\/(?:approvals|mode|help|status|usage|balance|account|settings|theme|thinking|effort)(?:\s|$)/.test(text)) {
      await runCommand(text)
      return
    }
    const queuedImages = attachments
    attachments = []
    renderAttached()
    deferUntilIdle(() => {
      // Keep any new unsent draft in the composer after submitting the queued turn.
      const draft = input.value
      const draftImages = attachments
      attachments = queuedImages
      sendText(text)
      if (!text.startsWith("/")) {
        input.value = draft
        attachments = draftImages
        renderAttached()
      }
    }, text || "attached images")
    return
  }

  // Commands never reach the model.
  if (text.startsWith("/")) {
    input.value = ""
    paletteItems = []
    renderPalette()
    if (await runCommand(text)) { setBusy(false); return }
  }
  input.value = ""

  // A generation model has no conversation to join, so a plain prompt is a
  // generation request. Picking one and typing is the whole interaction.
  const selected = modelOptions.find((option) => option.value === currentModel)
  if (selected && selected.kind && selected.kind !== "text") {
    turn("user", text)
    setBusy(true)
    const generated = await fetch("/api/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: selected.kind, line: text, model: currentModel }),
    }).then((r) => r.json()).catch(() => ({ ok: false, message: "could not reach the server" }))
    setBusy(false)
    showMedia(selected.kind, generated)
    return
  }

  setBusy(true)
  // Taken now, so removing one mid-flight cannot change what was sent.
  const sending = attachments
  attachments = []
  renderAttached()
  turn("user", text, sending)

  let body = null
  let raw = ""
  let thinking = null
  let thinkingRaw = ""
  controller = new AbortController()

  let response
  try {
    response = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, sessionId, provider: currentModel, images: sending, mode: currentMode, planning, boost: boost || boostOnce }),
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
        if (event.type === "thinking") {
          const stick = atBottom()
          if (!thinking) { thinkingRaw = ""; thinking = thinkingBlock() }
          thinkingRaw += event.delta
          thinking.textContent = thinkingRaw
          if (stick) scrollDown()
        }
        if (event.type === "text") {
          const stick = atBottom()
          // A new answer ends the reasoning that led to it.
          thinking = null
          if (!body) { raw = ""; body = turn("agent", "") }
          raw += event.delta
          body.innerHTML = markdown(raw)
          if (stick) scrollDown()
        }
        if (event.type === "subagent_start") {
          body = null
          note(event.agent + " subagent started: " + event.description)
          runningTools.push(event.agent + " subagent")
          renderActivity()
        }
        if (event.type === "subagent_event") {
          const inner = event.event
          const id = event.task + ":" + inner.id
          if (inner.type === "tool_start") toolChip(event.agent + " > " + inner.name, inner.args, id)
          if (inner.type === "tool_denied") {
            deniedCalls.add(id)
            const chip = chipFor(id)
            if (chip) {
              chip.classList.remove("running")
              chip.classList.add("failed")
              chip.querySelector(".spin").textContent = "✗"
              const why = document.createElement("span")
              why.className = "tdenied"
              why.textContent = inner.label || "refused"
              chip.appendChild(why)
            }
          }
          if (inner.type === "tool_end" && !deniedCalls.has(id)) {
            const chip = chipFor(id)
            if (chip) {
              const failed = String(inner.result || "").startsWith("error:")
              chip.classList.remove("running")
              chip.classList.add(failed ? "failed" : "done")
              chip.querySelector(".spin").textContent = failed ? "✗" : "✓"
            }
          }
        }
        if (event.type === "subagent_end") {
          runningTools = runningTools.filter((name) => name !== event.agent + " subagent")
          const first = String(event.result || "").split(String.fromCharCode(10)).find((line) => line.trim()) || ""
          note(event.agent + " subagent " + (event.status === "done" ? "finished" : event.status) + ": " + first.slice(0, 160))
          renderActivity()
        }
        // The model carries on with what its subagents found, as a new answer.
        if (event.type === "subagents_collected") { body = null; thinking = null }
        if (event.type === "tool_start") {
          body = null
          thinking = null
          toolChip(event.name, event.args, event.id)
          lastToolArgs = event.args
          runningTools.push(event.name)
          renderActivity()
        }
        if (event.type === "attached") note("attached " + event.files.join(", "))
        if (event.type === "usage") showUsage(event)
        if (event.type === "plan") { planItems = event.todos; renderActivity() }
        if (event.type === "permission") { body = null; permissionPrompt(event) }
        if (event.type === "permission_resolved") {
          const box = [...thread.querySelectorAll(".permission")].find((box) => box.dataset.permission === event.id)
          if (box) box.querySelector(".pactions").textContent = event.allowed ? "Allowed by the new approval mode" : "Blocked by current policy"
        }
        if (event.type === "tool_denied") {
          deniedCalls.add(event.id)
          const chip = chipFor(event.id)
          if (chip) {
            chip.classList.remove("running")
            chip.classList.add("failed")
            chip.querySelector(".spin").textContent = "✗"
            // Whose decision it was. Without it, a command a rule stopped looked
            // like one you had turned down.
            const why = document.createElement("span")
            why.className = "tdenied"
            why.textContent = event.label || "refused"
            chip.appendChild(why)
          }
        }
        if (event.type === "tool_end") {
          runningTools = runningTools.filter((n) => n !== event.name)
          const denied = deniedCalls.has(event.id)
          const ok = !denied && !String(event.result || "").startsWith("error:")
          feedItems.push({ label: event.name, ok })
          // A refused write changed nothing, so there is nothing to note.
          if (!denied) noteChange(event.name, lastToolArgs, event.result)
          renderActivity()
        }
        if (event.type === "tool_end") {
          const chip = chipFor(event.id)
          // A refused call was marked when it was refused. Its tool_end carries
          // the refusal text, which does not start with "error:" - so this used
          // to turn a blocked command into a green tick.
          if (chip && !deniedCalls.has(event.id)) {
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
        // The loop ran out of turns with the model still working, so the
        // answer above is unfinished. Saying so beats letting it read as done.
        if (event.type === "limit") {
          note("stopped after " + event.turns + " tool turns - the answer may be unfinished. Ask it to continue.")
        }
        if (event.type === "output_limit") note("The model reached its output-token limit. The answer is unfinished; ask it to continue or increase the server's output budget.")
        if (event.type === "checkpoint") note("paused at the autonomy checkpoint (" + event.toolCalls + " tool calls) - " + (event.stopped ? "stopped; ask it to continue." : "continuing."))
        if (event.type === "error") turn("agent", "**Error:** " + event.message)
        if (event.type === "saved") {
          refreshSessions()
          boostOnce = false
          boostTag.hidden = !boost
          // A planned answer ends with the choice of what happens next.
          if (planning && raw.trim()) planPrompt()
        }
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
// Typing while a turn runs used to disable the button - which is Stop by then.
input.oninput = () => { sendBtn.disabled = !busy && !input.value.trim() && !attachments.length }
input.onkeydown = (e) => {
  // The palette owns enter while it is open, otherwise this would submit the
  // half-typed command the palette was about to complete.
  if (paletteItems.length) return
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit() }
}
document.getElementById("new-session").onclick = () => {
  if (!deferUntilIdle(() => runCommand("/clear"), "new conversation")) void runCommand("/clear")
}

/**
 * The model list, and whether each one has a key behind it.
 *
 * Refetchable, because "ready" goes stale the moment a key is added or
 * removed. It was fetched once at page load, so connecting a provider left
 * its models still labelled "no key" - you could generate an image with a
 * key the picker was insisting you did not have.
 */
async function loadProviders() {
  const data = await fetch("/api/providers").then((r) => r.json()).catch(() => null)
  if (!data) return
  const previous = currentModel
  modelOptions = data.providers.map((p) => ({
    value: p.id,
    label: p.label + (p.reasoning ? " (reasoning)" : ""),
    effort: p.effort,
    kind: p.kind,
    section: p.section,
    ready: p.ready,
    connectionHint: p.connectionHint,
    settings: p.settings || [],
    vision: p.vision,
  }))
  // Open on something that can actually answer, rather than on whichever text
  // model happens to be first and may have no key behind it.
  // Keep what is chosen across a refresh; only fall back on the first load.
  const firstChat =
    modelOptions.find((option) => option.kind === "text" && option.ready) ||
    modelOptions.find((option) => option.kind === "text")
  const keep = previous && modelOptions.some((option) => option.value === previous) ? previous : null
  if (keep) setModel(keep)
  else if (firstChat || modelOptions.length) setModel((firstChat || modelOptions[0]).value)
  const ready = data.providers.filter((p) => p.ready).length
  hint.textContent = ready ? "" : "no API keys found"
}

loadProviders()

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

/** The /word the caret sits in, if it starts a word. Slashes in paths are not commands. */
function slashToken(text, cursor) {
  const before = text.slice(0, cursor)
  const slash = before.lastIndexOf("/")
  if (slash < 0) return undefined
  if (slash > 0 && !/\s/.test(before[slash - 1])) return undefined
  const token = before.slice(slash)
  if (!/^\/[A-Za-z0-9_-]*$/.test(token)) return undefined
  return token
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

const MEDIA_COMMANDS = ["/image", "/audio", "/model3d"]

/**
 * Generation settings, mirrored from the server.
 *
 * Held on paletteData rather than in a variable of its own so a reload of
 * the command list refreshes them too - the terminal writes the same file,
 * and a page that has been open a while should not disagree with it.
 */
/**
 * The value the model on the picker holds for a setting.
 *
 * Keyed provider/model:option, the way media-settings.ts stores it. A value
 * belongs to the model it was chosen on, not to the setting's name.
 */
function mediaValue(id) {
  const value = (paletteData.media || {})[currentModel + ":" + id]
  return value || "default"
}

/** The settings the model on the picker takes, in table order. */
function modelSettings() {
  const model = modelOptions.find((option) => option.value === currentModel)
  const ids = (model && model.settings) || []
  return (paletteData.mediaOptions || []).filter((option) => ids.includes(option.id))
}

function mediaLabel(option, value) {
  const pool = option.dynamic === "voices"
    ? [{ id: "default", label: "account default" }].concat(mediaVoices)
    : option.choices
  const found = pool.find((choice) => choice.id === value)
  return found ? found.label : value
}

/** The account's voices, fetched the first time somebody opens that list. */
let mediaVoices = []
let voicesState = "cold"
let voicesNote = ""
async function loadVoices() {
  if (voicesState !== "cold") return
  voicesState = "loading"
  const result = await fetch("/api/voices").then((r) => r.json()).catch(() => null)
  mediaVoices = (result && result.voices) || []
  voicesNote = result && !result.ok ? result.message : ""
  voicesState = "loaded"
  // The list is open while this lands, so it has to redraw itself.
  paletteItems = itemsFor(input.value, input.selectionStart)
  renderPalette()
}
let paletteData = { commands: [], models: [], sessions: [], files: [], themes: [], connectable: [] }
let paletteItems = []
let paletteIndex = 0

const paletteEl = document.createElement("div")
paletteEl.className = "palette"
paletteEl.hidden = true
document.querySelector(".composer").prepend(paletteEl)

async function loadCommands() {
  paletteData = await fetch("/api/commands").then((r) => r.json()).catch(() => paletteData)
  if (paletteData.settings) {
    webSettings = paletteData.settings
    const chosen = (paletteData.themes || []).find((t) => t.value === "/theme " + webSettings.theme)
    applyPalette(chosen && chosen.palette)
    document.body.classList.toggle("hide-thinking", !webSettings.thinking)
  }
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

  if (!text.startsWith("/")) {
    // A / starting a word mid-prompt completes command names, the way @
    // completes files there. Argument lists stay line-start only.
    const token = slashToken(text, cursor)
    if (!token) return []
    const query = token.toLowerCase()
    return (paletteData.commands || []).filter((c) => c.value.startsWith(query)).slice(0, 8)
  }
  const [head] = text.split(" ")
  const hasArgument = text.includes(" ")

  if (head === "/model" && hasArgument) {
    const q = text.slice(7).trim().toLowerCase()
    return paletteData.models.filter((m) => !q || m.value.toLowerCase().includes(q)).slice(0, 8)
  }
  if (head === "/theme" && hasArgument) {
    const q = text.slice(7).trim().toLowerCase()
    return (paletteData.themes || []).filter((t) => !q || t.value.toLowerCase().includes(q)).slice(0, 8)
  }
  if (head === "/connect" && hasArgument) {
    const q = text.slice(9).trim().toLowerCase()
    return (paletteData.connectable || [])
      .map((entry) => ({
        value: "/connect " + entry.id,
        hint: entry.label + "  " + (entry.connected ? "connected" : entry.about),
      }))
      .filter((item) => !q || item.value.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q))
      .slice(0, 9)
  }
  if ((head === "/settings" || head === "/set") && hasArgument) {
    const options = modelSettings()
    if (!options.length) return [{ value: text, hint: "this model has no settings to change" }]
    const rest = text.slice(text.indexOf(" ") + 1)
    const [word, ...tail] = rest.split(/\s+/)
    const option = options.find((o) => o.id === word)

    // Past the option name: its values.
    if (option && /\s/.test(rest)) {
      if (option.dynamic === "voices") loadVoices()
      const q = tail.join(" ").trim().toLowerCase()
      // Same as the terminal: the default row means the popup is never empty,
      // so "still loading" has to be a row of its own.
      const pending = option.dynamic === "voices" && voicesState !== "loaded"
        ? [{ id: "", label: "loading voices from your account…" }]
        : []
      const pool = option.dynamic === "voices"
        ? [{ id: "default", label: "account default" }].concat(mediaVoices, pending)
        : option.choices
      const current = mediaValue(option.id)
      const rows = pool
        .map((choice) => ({
          value: "/settings " + option.id + " " + choice.id,
          hint: choice.label + (choice.id === current ? "   \u2713 set" : ""),
        }))
        .filter((item) => !q || item.value.toLowerCase().includes(q) || item.hint.toLowerCase().includes(q))
        .slice(0, 9)
      if (!rows.length && option.dynamic === "voices") {
        return [{ value: text, hint: voicesState === "loaded" ? (voicesNote || "no voices on this account") : "loading voices\u2026" }]
      }
      return rows
    }

    const q = word.trim().toLowerCase()
    return options
      .map((entry) => ({ value: "/settings " + entry.id, hint: mediaLabel(entry, mediaValue(entry.id)) }))
      .filter((item) => !q || item.value.toLowerCase().includes(q))
      .slice(0, 9)
  }
  if (head === "/resume" && hasArgument) {
    const q = text.slice(8).trim().toLowerCase()
    return paletteData.sessions.filter((s) => !q || s.hint.toLowerCase().includes(q)).slice(0, 8)
  }
  // Match the whole line, not just the first word, the way the TUI does.
  // Matching only the first word kept the palette open after "/rename a new
  // title", and enter then picked the bare "/rename" item and submitted that
  // instead - so the title the user typed was silently thrown away.
  // The app's own commands first, then skills and custom commands A to Z - the
  // way the terminal lists them. They used to come in whatever order they were
  // found, dozens of skills mixed in with the commands.
  const matching = paletteData.commands.filter((c) => c.value.startsWith(text))
  const own = matching.filter((c) => !c.invocation)
  const invoked = matching.filter((c) => c.invocation).sort((a, b) => a.value.localeCompare(b.value))
  return [...own, ...invoked]
}

function renderPalette() {
  paletteEl.innerHTML = ""
  if (!paletteItems.length) { paletteEl.hidden = true; return }
  paletteEl.hidden = false

  paletteItems.forEach((item, index) => {
    // A heading where the skills start, so the two groups read as two.
    if (item.invocation && (index === 0 || !paletteItems[index - 1].invocation)) {
      const heading = document.createElement("div")
      heading.className = "psection"
      heading.textContent = "skills and custom commands"
      paletteEl.appendChild(heading)
    }
    const row = document.createElement("div")
    row.className = "prow" + (index === paletteIndex ? " active" : "")
    row.innerHTML = '<span class="pvalue"></span><span class="phint"></span>'
    row.querySelector(".pvalue").textContent = item.value
    row.querySelector(".phint").textContent = item.hint
    row.onclick = () => choose(index)
    row.onmouseenter = () => {
      // Update the class directly rather than re-rendering: rebuilding the
      // list under the pointer re-fires mouseenter and flickers.
      paletteIndex = index
      for (const [at, el] of [...paletteEl.querySelectorAll(".prow")].entries()) el.classList.toggle("active", at === index)
      previewTheme(item)
    }
    paletteEl.appendChild(row)
  })
  // The list scrolls now, so the row the arrow keys moved to is kept in sight.
  paletteEl.querySelector(".prow.active")?.scrollIntoView({ block: "nearest" })
}

let paletteSignature = ""

/**
 * Show a theme while it is being considered.
 *
 * Picking colours from a name is guesswork; hovering repaints the page so the
 * choice is made by looking rather than by reading.
 */
function previewTheme(item) {
  if (!item || !item.palette) return
  applyPalette(item.palette)
}

function endPreview() {
  const chosen = (paletteData.themes || []).find((t) => t.value === "/theme " + webSettings.theme)
  if (chosen) applyPalette(chosen.palette)
}

paletteEl.onmouseleave = endPreview

function refreshPalette() {
  const wasTheme = paletteItems.some((item) => item.palette)
  paletteItems = itemsFor(input.value, input.selectionStart ?? input.value.length)
  // Leaving the theme list by typing has to put the colours back too, not
  // only moving the pointer away.
  if (wasTheme && !paletteItems.some((item) => item.palette)) endPreview()
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
  // A command picked mid-prompt is text being written, not a command being
  // run: it completes its own word and the sentence stays.
  if (item.value.startsWith("/") && !input.value.startsWith("/")) {
    const cursor = input.selectionStart ?? input.value.length
    const token = slashToken(input.value, cursor)
    if (token) {
      const start = cursor - token.length
      const caret = start + item.value.length + 1
      input.value = input.value.slice(0, start) + item.value + " " + input.value.slice(cursor)
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
  // Ctrl+S sends the draft now instead of queueing it: stop the running turn
  // first (and swallow the browser's save dialog, which is never what Enter's
  // neighbour meant here). The submit below queues while stopping, and the
  // turn end sends it as soon as the abort lands.
  if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault()
    if (busy && input.value.trim()) { void stopTurn().then(() => submit()) }
    return
  }
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
document.getElementById("review-diff").addEventListener("click", () => { void runCommand("/diff") })
/** Calls that were refused, so their tool_end cannot mark them done. */
const deniedCalls = new Set()

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
