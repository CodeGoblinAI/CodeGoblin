// User pass, terminal + browser: UX quirks, word-wrapping, mashing, mouse hit-testing, every slash command,
// live-stream scroll anchoring, and bounding-box overlap checks across desktop & mobile widths.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay, plain } from "./harness.mjs"

const seen = []
const model = await fakeModel(async (sent) => {
  const last = sent.messages.at(-1)
  const said = String(sent.messages.filter((m) => m.role === "user").at(-1)?.content ?? "")
  seen.push({ role: last?.role, said: said.slice(0, 200), rawLast: String(last?.content ?? "").slice(0, 200) })

  if (last?.role === "tool") {
    const toolMsgs = sent.messages.filter((m) => m.role === "tool")
    if (/multistep/.test(said) && toolMsgs.length < 2) {
      await delay(140)
      return { tool: "glob", args: { pattern: "*" }, usage: { prompt_tokens: 2100, completion_tokens: 180 } }
    }
    await delay(120)
    return {
      stream: [
        { reasoning: "Checking the tool output carefully across a long reasoning line so expanded thinking must wrap cleanly inside the viewport instead of getting chopped off at the margin.\n" },
        { text: Array.from({ length: 18 }, (_, i) => `Result line ${i + 1}: verified output from tool call (${String(last.content).slice(0, 40).replace(/\s+/g, " ")}).`).join("\n") },
      ],
      usage: { prompt_tokens: 4800, completion_tokens: 920 },
    }
  }
  if (/ask question/.test(said)) {
    return {
      tool: "question",
      args: {
        question: "Which layout mode should we verify?",
        options: [
          { label: "Compact view", description: "Tighter rows" },
          { label: "Comfortable view", description: "Breathing room" },
        ],
      },
    }
  }
  if (/write sample/.test(said)) {
    return { tool: "write_file", args: { path: "sample-approved.txt", content: "approved via mouse click\n" } }
  }
  if (/multistep/.test(said)) {
    await delay(140)
    return { tool: "list_dir", args: { path: "." }, usage: { prompt_tokens: 1500, completion_tokens: 120 } }
  }
  if (/tall history/.test(said)) {
    return {
      stream: [
        { reasoning: "First reasoning paragraph that is intentionally verbose so we can click thought to expand and fold it cleanly without horizontal truncation in the terminal.\n" },
        { text: Array.from({ length: 45 }, (_, i) => `History paragraph ${i + 1}: enough prose to make the conversation scroll well past one screen height in both terminal and browser.`).join("\n\n") },
      ],
      usage: { prompt_tokens: 6400, completion_tokens: 1850 },
    }
  }
  return {
    text: "Ack: " + said.slice(0, 70).replace(/\s+/g, " "),
    usage: { prompt_tokens: 1200, completion_tokens: 240 },
  }
})

const screenOf = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const composerLinesOf = (t) => {
  const rows = screenOf(t).split("\n")
  const rules = []
  for (let i = 0; i < rows.length; i++) {
    if (/^\s*─{15,}\s*$/.test(rows[i])) rules.push(i)
  }
  if (rules.length < 2) return []
  const top = rules.at(-2)
  const bottom = rules.at(-1)
  return rows
    .slice(top + 1, bottom)
    .filter((line) => /^  \| /.test(line))
    .map((line) => line.slice(4).trimEnd())
}
const waitFor = async (t, pattern, ms = 12000) => {
  for (let waited = 0; waited < ms; waited += 100) {
    if (pattern.test(screenOf(t))) return true
    await delay(100)
  }
  return false
}
const type = async (t, text, gap = 12) => {
  for (const ch of text) {
    t.write(ch)
    if (gap) await delay(gap)
  }
}
const find = (t, text) => {
  const rows = screenOf(t).split("\n")
  const row = rows.findLastIndex((line) => line.includes(text))
  return row < 0 ? undefined : { row: row + 1, col: rows[row].indexOf(text) + 1, line: rows[row] }
}
const click = async (t, col, row, wait = 220) => {
  t.write(`\x1b[<0;${col};${row}M`)
  await delay(40)
  t.write(`\x1b[<0;${col};${row}m`)
  await delay(wait)
}
const broken = (t) =>
  /TypeError|RangeError|ReferenceError|Unhandled|something went wrong|unexpected error|at <anonymous>|\bat .*:\d+:\d+\)/.test(
    plain(t.out),
  )

// ============================================================================
// PART 1: Terminal UX quirks — word-wrap, multi-line Up/Down, mouse clicks, slash sweep
// ============================================================================
const tuiProfile = tempDir("cg-ux-chaos-tui-")
const tuiProject = tempDir("cg-ux-chaos-proj-")
fs.writeFileSync(path.join(tuiProject, "README.md"), "# Chaos Test Project\n")

// Start at 116x32 — the exact dimensions where Shawn spotted "of" splitting across lines!
const t = await tui({ model, cwd: tuiProject, profile: tuiProfile, cols: 116, rows: 32 })
try {
  // 1. Exact screenshot regression: composer word-wrap never splits "of" across lines
  const shawnSentence =
    "Another thing I learned, and I'm putting it over here, is that the text doesn't seem to wrap properly at there of some words, and you can see it right here."
  await type(t, shawnSentence, 8)
  await delay(300)
  const wrappedRows = composerLinesOf(t)
  const joinedWords = wrappedRows.join(" ").replace(/\s+/g, " ").trim()
  const splitOf = wrappedRows.some((r) => /\bo$/.test(r)) || wrappedRows.some((r) => /^f\b/.test(r))
  check(
    "TUI composer word-wraps Shawn's exact sentence cleanly without splitting 'of' across lines",
    wrappedRows.length === 2 && !splitOf && joinedWords === shawnSentence,
    wrappedRows.map((r, i) => `row ${i + 1}: ${JSON.stringify(r)}`).join("\n"),
  )

  // 2. Pressing Up arrow inside a wrapped 2-line prompt moves to row 1 instead of wiping draft with history
  t.write("\x1b[A") // Up arrow -> moves from row 2 to row 1
  await delay(200)
  t.write("!")
  await delay(250)
  const afterUpEdit = composerLinesOf(t)
  check(
    "Up arrow inside a wrapped prompt moves to row 1 and edits in place instead of wiping the draft",
    afterUpEdit.length >= 2 && afterUpEdit[0].includes("!") && afterUpEdit.join(" ").includes("right here."),
    afterUpEdit.join(" / "),
  )

  // Clear and send a message so history is populated, then test multi-line draft preservation across history recall
  t.write("\x15") // Ctrl+U clears composer
  await delay(200)
  await type(t, "first history message", 8)
  t.write("\r")
  await waitFor(t, /Ack: first history message/)

  const unsentDraft =
    "unsent two line draft that wraps onto a second visual row inside the prompt box so up arrow navigates lines first"
  await type(t, unsentDraft, 6)
  await delay(250)
  check("unsent draft wraps onto 2 rows", composerLinesOf(t).length === 2, composerLinesOf(t).join(" | "))
  t.write("\x1b[A") // Row 2 -> Row 1 (still unsentDraft)
  await delay(150)
  check(
    "first Up arrow stays in unsent multi-line draft",
    composerLinesOf(t).join(" ").replace(/\s+/g, " ").trim() === unsentDraft,
  )
  t.write("\x1b[A") // Row 1 -> recalls history ("first history message")
  await delay(200)
  check("second Up arrow from top row recalls previous sent message", /first history message/.test(composerLinesOf(t).join(" ")))
  t.write("\x1b[B") // Down -> restores unsent multi-line draft!
  await delay(200)
  check(
    "Down arrow restores the unsent multi-line draft intact",
    composerLinesOf(t).join(" ").replace(/\s+/g, " ").trim() === unsentDraft,
    composerLinesOf(t).join(" | "),
  )

  // Alt+Enter inserts a literal newline without submitting
  t.write("\x15")
  await delay(150)
  await type(t, "line one", 8)
  t.write("\x1b\r")
  await type(t, "line two", 8)
  await delay(250)
  const explicitLines = composerLinesOf(t)
  check(
    "Alt+Enter inserts an explicit newline without submitting",
    explicitLines.length === 2 && explicitLines[0] === "line one" && explicitLines[1] === "line two",
    explicitLines.join(" / "),
  )
  t.write("\x15")
  await delay(150)

  // 3. One-click toolbar switching & filterable dialog mouse hit-testing (off-by-1 fix + 'esc' click)
  const modelBtn = find(t, "[Model]")
  check("toolbar shows [Model] button", Boolean(modelBtn))
  if (modelBtn) {
    await click(t, modelBtn.col + 2, modelBtn.row, 350)
    check("clicking [Model] opens filterable Choose model dialog", await waitFor(t, /Choose model[\s\S]*type to search/, 4000))

    // One-click switch directly to [Settings] while [Model] is open
    const settingsBtn = find(t, "[Settings]")
    await click(t, settingsBtn.col + 3, settingsBtn.row, 350)
    check(
      "clicking [Settings] while [Model] is open switches dialogs in one click",
      await waitFor(t, /Settings[\s\S]*Reasoning/, 4000) && !/Choose model/.test(screenOf(t)),
    )

    // Click 'esc' in the top-right title bar of the Settings dialog to close it
    const escSpot = find(t, "esc │")
    check("dialog title bar shows clickable 'esc'", Boolean(escSpot))
    if (escSpot) {
      await click(t, escSpot.col + 1, escSpot.row, 300)
      check("clicking 'esc' in dialog border closes the dialog", !/Settings[\s\S]*Reasoning/.test(screenOf(t)))
    }

    // Reopen [Settings], then one-click switch directly to [Usage] overlay, then click [Usage] again to toggle closed
    await click(t, settingsBtn.col + 3, settingsBtn.row, 350)
    const usageBtn = find(t, "[Usage]")
    await click(t, usageBtn.col + 2, usageBtn.row, 350)
    check("clicking [Usage] while [Settings] is open switches to Usage in one click", await waitFor(t, /Usage \(context is estimated\)/, 4000))
    await click(t, usageBtn.col + 2, usageBtn.row, 300)
    check("clicking [Usage] a second time toggles the Usage overlay closed", !/Usage \(context is estimated\)/.test(screenOf(t)))
  }

  // Test filterable dialog row click accuracy (Ctrl+G Actions -> filter to "Status" -> click row 1)
  t.write("\x07") // Ctrl+G opens goblin commands
  await waitFor(t, /goblin commands[\s\S]*type to search/, 4000)
  t.write("\x07") // Ctrl+G again toggles it closed!
  await delay(250)
  check("Ctrl+G toggles Actions closed when pressed a second time", !/goblin commands/.test(screenOf(t)))

  t.write("\x07")
  await waitFor(t, /goblin commands[\s\S]*type to search/, 4000)
  await type(t, "Undo the last", 15)
  await waitFor(t, /Undo the last change/, 3000)
  const undoRow = find(t, "Undo the last change")
  check("filtered Actions dialog shows 'Undo the last change' at row 1", Boolean(undoRow))
  if (undoRow) {
    await click(t, undoRow.col + 3, undoRow.row, 350)
    check(
      "clicking row 1 in a filterable dialog picks that exact row (off-by-1 fixed!)",
      await waitFor(t, /nothing to undo/i, 3000) && !/goblin commands/.test(screenOf(t)),
      screenOf(t).split("\n").slice(-5).join(" | "),
    )
  }

  // 4. Clicking a row in the '/' slash palette
  await type(t, "/vers", 20)
  await waitFor(t, /\/version/, 3000)
  const paletteRow = find(t, "/version")
  if (paletteRow) {
    await click(t, paletteRow.col + 2, paletteRow.row, 350)
    check("clicking a row in the '/' palette executes it", await waitFor(t, /CodeGoblin \d+\.\d+\.\d+/, 4000))
  }

  // 5. Clicking a choice in the question box & approval box
  await type(t, "ask question", 10)
  t.write("\r")
  await waitFor(t, /2\. Comfortable view/, 8000)
  const opt2 = find(t, "2. Comfortable view")
  check("question prompt shows option 2", Boolean(opt2))
  if (opt2) {
    await click(t, opt2.col + 4, opt2.row, 600)
    check(
      "clicking option 2 in question box sends that option to the model",
      await waitFor(t, /Comfortable view/, 8000),
    )
  }

  await type(t, "write sample", 10)
  t.write("\r")
  await waitFor(t, /Allow once/, 8000)
  const allowOnce = find(t, "Allow once")
  check("approval box shows 'Allow once'", Boolean(allowOnce))
  if (allowOnce) {
    await click(t, allowOnce.col + 3, allowOnce.row, 600)
    check(
      "clicking 'Allow once' in approval box executes the tool",
      await waitFor(t, /Result line 1:/, 8000) && fs.existsSync(path.join(tuiProject, "sample-approved.txt")),
    )
  }

  // 6. Clicking '◆ thought' to expand/fold reasoning & clicking folded answer under /fold
  await type(t, "tall history", 10)
  t.write("\r")
  await waitFor(t, /History paragraph 45:/, 12000)
  await delay(300)
  // Scroll up if needed or find ◆ thought (let's wheel up to see the top of the answer if needed)
  for (let i = 0; i < 20 && !find(t, "◆ thought"); i++) {
    t.write("\x1b[<64;40;10M")
    await delay(80)
  }
  const thoughtSpot = find(t, "◆ thought")
  check("folded reasoning line '◆ thought' is visible", Boolean(thoughtSpot))
  if (thoughtSpot) {
    await click(t, thoughtSpot.col + 3, thoughtSpot.row, 350)
    check(
      "clicking '◆ thought' expands reasoning and word-wraps it cleanly",
      await waitFor(t, /thinking · click or ctrl\+o folds/, 3000),
    )
    const foldSpot = find(t, "thinking · click or ctrl+o folds")
    if (foldSpot) {
      await click(t, foldSpot.col + 4, foldSpot.row, 350)
      check("clicking expanded thinking header folds it back", await waitFor(t, /◆ thought/, 3000))
    }
  }
  t.write("\x1b[1;5F") // Ctrl+End back to bottom
  await delay(250)

  // /fold folds long answers, and clicking one unfolds it
  await type(t, "/fold", 10)
  t.write("\r")
  await waitFor(t, /more lines - click or \/fold unfolds/, 4000)
  const moreLinesSpot = find(t, "more lines - click or /fold unfolds")
  check("/fold collapses tall answers with a clickable notice", Boolean(moreLinesSpot))
  if (moreLinesSpot) {
    await click(t, moreLinesSpot.col + 4, moreLinesSpot.row, 350)
    check(
      "clicking a folded answer unfolds that answer in place",
      await waitFor(t, /History paragraph 3:/, 4000) && !/more lines - click or \/fold unfolds/.test(screenOf(t)),
    )
  }
  await type(t, "/fold", 10)
  t.write("\r")
  await delay(250)

  // 7. Exhaustive TUI slash command sweep (zero crashes, zero "unknown command" on advertised commands)
  const tuiCommands = [
    "/version",
    "/upgrade",
    "/update",
    "/status",
    "/memory add chaos note",
    "/memory",
    "/memory clear",
    "/mcp",
    "/browser off",
    "/browser",
    "/plan",
    "/plan",
    "/boost",
    "/boost",
    "/timestamps",
    "/timestamps",
    "/thinking",
    "/thinking",
    "/agents default",
    "/diff",
    "/undo",
    "/redo",
    "/local",
    "/open",
    "/terminal",
    "/voice cancel",
    "/variants",
    "/plugins",
    "/market",
    "/warp",
    "/widget",
    "/widget-settings",
    "/org",
    "/orgs",
    "/rename TUI Chaos Session",
    "/copy last",
    "/export",
    // Dialog-opening commands (send command, then Esc to close cleanly)
    ["/help", "esc"],
    ["/help search", "esc"],
    ["/shortcuts", "esc"],
    ["/skills", "esc"],
    ["/usage", "esc"],
    ["/settings", "esc"],
    ["/approvals", "esc"],
    ["/mode", "esc"],
    ["/theme", "esc"],
    ["/timeline", "esc"],
    ["/search paragraph", "esc"],
    ["/favourite", "esc"],
    ["/jobs", "esc"],
    ["/effort", "esc"],
    ["/agents", "esc"],
    ["/connect", "esc"],
    ["/disconnect", "esc"],
    ["/resume", "esc"],
    "/fork",
    "/compact",
    "/clear",
  ]
  let unknownInTui = []
  for (const entry of tuiCommands) {
    const cmd = Array.isArray(entry) ? entry[0] : entry
    const closeWithEsc = Array.isArray(entry)
    t.write("\x15")
    await delay(40)
    await type(t, cmd, 4)
    t.write("\r")
    await delay(closeWithEsc ? 260 : 200)
    if (/unknown command:/i.test(screenOf(t))) unknownInTui.push(cmd)
    if (closeWithEsc) {
      t.write("\x1b")
      await delay(140)
    }
  }
  check(
    `all ${tuiCommands.length} TUI slash commands ran with zero 'unknown command' errors and zero crashes`,
    unknownInTui.length === 0 && !broken(t),
    unknownInTui.length ? "unknown: " + unknownInTui.join(", ") : "",
  )

  // Prompt commands expand and reach the model cleanly
  await type(t, "/verify quick check", 6)
  t.write("\r")
  check(
    "/verify prompt command expands and is answered by the model",
    await waitFor(t, /Ack: Verify the current changes/, 8000) && !broken(t),
  )

  // Narrow resize check with spend visible: cost digits never clip and lines never overflow
  for (const cols of [116, 84, 62, 44]) {
    t.term.resize(cols, 28)
    await delay(280)
    const lines = screenOf(t).split("\n")
    const maxLen = Math.max(...lines.map((l) => l.length))
    check(`TUI at ${cols} cols: zero horizontal line overflow`, maxLen <= cols + 1, `max=${maxLen}`)
  }
} catch (error) {
  check("TUI chaos pass", false, error.message + "\n" + screenOf(t).slice(-800))
} finally {
  t.kill()
}

// ============================================================================
// PART 2: Browser Web UI — live-stream scroll anchoring, slash sweep, mashing, bounding-box non-overlap
// ============================================================================
const webProfile = tempDir("cg-ux-chaos-web-")
const webProject = tempDir("cg-ux-chaos-webproj-")
fs.writeFileSync(path.join(webProject, "README.md"), "# Web Chaos Test\n")

const w = await web({ model, cwd: webProject, profile: webProfile, viewport: { width: 1280, height: 800 } })
try {
  // Switch to full access via the mode picker so multi-step read tools run uninterrupted
  await w.page.click("#mode-btn")
  await w.page.waitForTimeout(80)
  await w.page.click("#mode-option-2")
  await w.page.waitForTimeout(150)

  // 1. Live-stream scroll anchoring: reading the top of the thread during a multi-tool turn MUST NOT yank to bottom
  await w.send("tall history", 1500)
  await w.page.waitForFunction(() => {
    const el = document.querySelector("#thread")
    const busy = document.querySelector("#send")?.dataset.busy === "1" || document.body.classList.contains("busy")
    return el && el.scrollHeight > el.clientHeight + 300 && !busy && el.innerText.includes("History paragraph 45:")
  }, null, { timeout: 12000 })
  await w.page.waitForTimeout(250)

  // Trigger a multi-step slow turn AND immediately scroll to top (scrollTop = 0)
  await w.box.focus()
  await w.box.fill("multistep check while scrolled up")
  await w.box.press("Enter")
  await w.page.evaluate(() => {
    const el = document.querySelector("#thread")
    el.scrollTop = 0
    el.dispatchEvent(new Event("scroll"))
  })

  // Sample scrollTop repeatedly while tool_start, tool_end, thinking, text, and worked arrive
  const samples = []
  for (let i = 0; i < 14; i++) {
    await w.page.waitForTimeout(80)
    samples.push(await w.page.evaluate(() => document.querySelector("#thread").scrollTop))
  }
  await w.page.waitForFunction(
    () => document.querySelector("#thread")?.innerText.includes("Result line 18:"),
    null,
    { timeout: 12000 },
  )
  const finalScrollTop = await w.page.evaluate(() => document.querySelector("#thread").scrollTop)
  const jumpVisible = await w.page.evaluate(() => {
    const btn = document.querySelector("#jump-bottom")
    return Boolean(btn && !btn.hidden && /New output/i.test(btn.textContent || ""))
  })
  check(
    "Web UI does NOT yank scroll to bottom during multi-step tool + reasoning + streaming turn when user scrolled up",
    samples.every((s) => s === 0) && finalScrollTop === 0,
    `samples=${JSON.stringify(samples)}, final=${finalScrollTop}`,
  )
  check("Web UI shows '#jump-bottom' pill ('New output · jump to bottom') when new output arrives below", Boolean(jumpVisible))
  await w.page.click("#jump-bottom")
  await w.page.waitForTimeout(300)

  // 2. Web '/search' command (previously missing handler!) & Ctrl+O global fold/expand
  await w.send("/search History paragraph 12", 400)
  const searchOpen = await w.page.evaluate(() => {
    const dlg = document.querySelector("dialog[open]")
    return Boolean(dlg && /Search this conversation/i.test(dlg.innerText) && /History paragraph 12/.test(dlg.innerText))
  })
  check("Web UI '/search <query>' opens Search conversation dialog with matching turns", Boolean(searchOpen))
  await w.page.keyboard.press("Escape")
  await w.page.waitForTimeout(150)

  // Ctrl+O toggles thinking/tool blocks open and closed in Web UI
  await w.page.keyboard.press("Control+o")
  await w.page.waitForTimeout(150)
  const openedCount = await w.page.evaluate(() => document.querySelectorAll("#thread .tool.open, #thread .thinking.open").length)
  await w.page.keyboard.press("Control+o")
  await w.page.waitForTimeout(150)
  const closedCount = await w.page.evaluate(() => document.querySelectorAll("#thread .tool.open, #thread .thinking.open").length)
  check("Web UI Ctrl+O expands and folds all tool & reasoning blocks", openedCount > 0 && closedCount === 0, `open=${openedCount} -> ${closedCount}`)

  // 3. Exhaustive Web UI slash command sweep (zero "unknown command:" on any advertised command!)
  const webCommands = [
    "/version",
    "/upgrade",
    "/update",
    "/status",
    "/usage",
    "/memory add web chaos note",
    "/memory",
    "/memory clear",
    "/mcp",
    "/browser off",
    "/browser",
    "/skills",
    "/plan",
    "/plan",
    "/boost",
    "/boost",
    "/fold",
    "/fold",
    "/timestamps",
    "/timestamps",
    "/thinking",
    "/thinking",
    "/effort",
    "/agents default",
    "/diff",
    "/undo",
    "/redo",
    "/jobs",
    "/local",
    "/timeline",
    "/search",
    "/favourite",
    "/worktree",
    "/branch",
    "/approvals",
    "/mode",
    "/settings",
    "/theme",
    "/connect",
    "/disconnect",
    "/account",
    "/open README.md",
    "/terminal",
    "/terminal",
    "/voice cancel",
    "/voice hold",
    "/voice hold",
    "/variants",
    "/plugins",
    "/market",
    "/warp",
    "/widget",
    "/widget-settings",
    "/org",
    "/orgs",
    "/help",
    "/shortcuts",
    "/rename This Is A Very Long Session Title To Stress Header Layout Against Spend Readout Cents",
  ]
  const webUnknowns = []
  for (const cmd of webCommands) {
    await w.send(cmd, 180)
    const lastNote = await w.note()
    if (/^unknown command:/i.test(lastNote)) webUnknowns.push(`${cmd} -> ${lastNote}`)
    // Close any modal dialog or picker menu opened by the command
    for (let attempt = 0; attempt < 3; attempt++) {
      const hasModal = await w.page.evaluate(() => Boolean(document.querySelector("dialog[open]")))
      if (!hasModal) break
      await w.page.keyboard.press("Escape")
      await w.page.waitForTimeout(80)
    }
  }
  check(
    `all ${webCommands.length} Web UI slash commands ran with zero 'unknown command' notes`,
    webUnknowns.length === 0,
    webUnknowns.join("; "),
  )

  // 4. Rapid UI button mashing in Browser
  for (const sel of ["#mode-btn", "#mode-btn", "#provider-btn", "#provider-btn", "#settings-btn", "#fold-btn", "#fold-btn", "#plan-btn", "#plan-btn"]) {
    const visible = await w.page.locator(sel).isVisible().catch(() => false)
    if (!visible) continue
    await w.page.click(sel)
    await w.page.waitForTimeout(50)
    if (await w.page.evaluate(() => Boolean(document.querySelector("dialog[open]")))) {
      await w.page.keyboard.press("Escape")
      await w.page.waitForTimeout(50)
    }
  }
  check("rapid Web UI button mashing produced zero console/page errors", w.errors.length === 0, w.errors.join(" | "))

  // 5. Bounding-box overlap & cost-cents non-clipping audit across Desktop, Tablet & Mobile widths
  // Populate usage readout with realistic spend string too so we test exact dollar+cent protection
  await w.page.evaluate(() => {
    const u = document.querySelector("#usage-readout")
    if (u && !u.textContent.includes("$")) u.textContent = "18.4k tok · ~14% · $0.04"
  })

  for (const [vw, vh] of [
    [1280, 800],
    [820, 700],
    [600, 750],
    [390, 844],
  ]) {
    await w.page.setViewportSize({ width: vw, height: vh })
    await w.page.waitForTimeout(180)
    const layout = await w.page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel)
        if (!el) return null
        const s = getComputedStyle(el)
        if (s.display === "none" || s.visibility === "hidden") return null
        const r = el.getBoundingClientRect()
        return r.width === 0 && r.height === 0 ? null : { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, clientW: el.clientWidth, scrollW: el.scrollWidth, text: el.textContent.trim() }
      }
      const overlaps = (a, b) => {
        if (!a || !b) return false
        const horiz = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const vert = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        return horiz > 1.5 && vert > 1.5
      }
      const title = rect("#session-title")
      const usage = rect("#usage-readout")
      const mode = rect("#mode")
      const prov = rect("#provider-btn")
      const send = rect("#send")
      return {
        titleOverlapsUsage: overlaps(title, usage),
        usageClipped: usage ? usage.scrollW > usage.clientW + 2 : false,
        usageText: usage?.text ?? "",
        modeOverlapsProv: overlaps(mode, prov),
        provOverlapsSend: overlaps(prov, send),
        provTallWrap: prov ? prov.height > 44 : false,
        docOverflow: document.documentElement.scrollWidth > window.innerWidth + 2,
      }
    })
    check(
      `Web UI layout at ${vw}x${vh}: zero header/composer overlap, zero cost clipping, zero horizontal page overflow`,
      !layout.titleOverlapsUsage &&
        !layout.usageClipped &&
        !layout.modeOverlapsProv &&
        !layout.provOverlapsSend &&
        !layout.provTallWrap &&
        !layout.docOverflow,
      JSON.stringify(layout),
    )
  }
} catch (error) {
  check("Web chaos pass", false, error.message)
} finally {
  await w.close()
}

model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
if (process.platform === "win32") process.kill(process.pid)
process.exit(failed() ? 1 : 0)
