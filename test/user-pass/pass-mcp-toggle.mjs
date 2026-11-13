// User pass: per-conversation MCP toggle with a real stdio MCP server (the repo fixture), TUI and web.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, web, delay } from "./harness.mjs"

let tools = []
const model = await fakeModel((sent) => { tools = (sent.tools ?? []).map((t) => t.function.name); return { text: "ok" } })
const project = tempDir("cg-mcp-project-")
const profileWithMcp = () => {
  const profile = tempDir("cg-mcp-profile-")
  fs.mkdirSync(path.join(profile, "config"), { recursive: true })
  fs.writeFileSync(path.join(profile, "config", "codegoblin.jsonc"), JSON.stringify({ mcp: { fixture: { type: "local", command: [process.execPath.replace(/node\.exe$/i, "bun.exe").includes("bun") ? "bun" : "bun", "C:/Users/shawn/code/CG-Next/test/fixtures/mcp-fixture-server.ts"] } } }))
  return profile
}

// --- TUI ---
{
  const t = await tui({ model, cwd: project, profile: profileWithMcp() })
  try {
    await delay(2500)
    t.write("first\r"); await t.until((s) => /ok/.test(s), 15000, "first")
    check("TUI: the fixture server's tools are offered", tools.includes("mcp__fixture__echo"), tools.filter((t) => t.startsWith("mcp")).join(","))
    t.clear(); t.write("/mcp\r"); await delay(800)
    check("TUI: /mcp offers to turn the server off for this conversation", /Turn off fixture for this conversation/.test(t.screen()))
    t.write("\x1b[B\r"); await delay(800)
    check("TUI: choosing it marks the server off", /off in this conversation/.test(t.screen()), t.screen().split("\n").filter((l) => /fixture/.test(l)).slice(-2).join("\n"))
    t.write("\x1b"); await delay(300)
    const before = model.seen.length
    t.write("second\r"); await t.until(() => model.seen.length > before, 15000, "second"); await delay(300)
    check("TUI: its tools are gone for this conversation", !tools.some((t) => t.startsWith("mcp__fixture")), tools.join(","))
    const system = model.seen.at(-1).messages.find((m) => m.role === "system")?.content ?? ""
    check("TUI: and the model is told why", /switched these MCP servers off for this conversation: fixture/.test(system))
    t.clear(); t.write("/clear\r"); await delay(500)
    const again = model.seen.length
    t.write("third\r"); await t.until(() => model.seen.length > again, 15000, "third"); await delay(300)
    check("TUI: a new conversation has it back", tools.includes("mcp__fixture__echo"))
  } catch (error) { check("TUI pass", false, error.message) } finally { t.kill() }
}

// --- Web ---
{
  const w = await web({ model, cwd: project, profile: profileWithMcp() })
  try {
    await w.page.waitForTimeout(2000)
    await w.send("first", 1500)
    check("web: the fixture server's tools are offered", tools.includes("mcp__fixture__echo"))
    await w.send("/mcp off fixture", 600)
    check("web: /mcp off says so", /Turned off fixture for this conversation/.test(await w.note()), await w.note())
    await w.send("second", 1500)
    check("web: its tools are gone for this conversation", !tools.some((t) => t.startsWith("mcp__fixture")), tools.join(","))
    await w.send("/mcp", 800)
    check("web: the dialog shows it off, with a way back on", /off in this conversation/.test(await w.page.locator("dialog").innerText()) && /Turn on fixture/.test(await w.page.locator("dialog").innerText()))
    await w.page.getByRole("button", { name: "Turn on fixture for this conversation" }).click(); await w.page.waitForTimeout(800)
    await w.page.keyboard.press("Escape")
    await w.send("third", 1500)
    check("web: turned back on, the tools return", tools.includes("mcp__fixture__echo"))
    check("web: no console errors", w.errors.length === 0, w.errors.join(" | "))
  } catch (error) { check("web pass", false, error.message) } finally { await w.close() }
}
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
