// Screenshots of CG-Next's web app (home, chat, settings) and a TUI screen dump, on the fixture model only.
import fs from "node:fs"
import path from "node:path"
import { fakeModel, tempDir, tui, web, delay } from "./harness.mjs"
const out = path.join(import.meta.dirname, "../../output/shots"); fs.mkdirSync(out, { recursive: true })
const reply = "Here is what I found.\n\n## Plan\n\n1. Read `src/core/agent.ts`\n2. Add the guard\n\n```ts\nexport function guard(n: number) {\n  return n > 0\n}\n```\n\n| File | Change |\n| --- | --- |\n| agent.ts | guard added |\n\nDone: **1 file** changed."
let n = 0
const model = await fakeModel(() => (++n === 1 ? { tool: "glob", args: { pattern: "*.md" } } : { text: reply }))
const project = tempDir("cg-shots-project-")
fs.writeFileSync(path.join(project, "README.md"), "# demo\n")
const w = await web({ model, cwd: project })
try {
  await w.send("/clear", 800)
  await w.page.screenshot({ path: path.join(out, "next-home.png") })
  await w.page.locator("#provider-btn").click(); await w.page.waitForTimeout(400)
  await w.page.screenshot({ path: path.join(out, "next-home-models.png") })
  await w.page.keyboard.press("Escape")
  await w.box.fill("/"); await w.page.waitForTimeout(400)
  await w.page.screenshot({ path: path.join(out, "next-home-palette.png") })
  await w.box.fill("")
  await w.send("Add a guard to the agent loop", 3500)
  await w.page.screenshot({ path: path.join(out, "next-chat.png") })
  await w.box.fill("/"); await w.page.waitForTimeout(400)
  await w.page.screenshot({ path: path.join(out, "next-palette.png") })
  await w.box.fill(""); await w.send("/settings", 800)
  await w.page.screenshot({ path: path.join(out, "next-settings.png") })
  await w.page.keyboard.press("Escape")
  await w.page.locator("#activity-toggle").click(); await w.page.waitForTimeout(300)
  await w.page.screenshot({ path: path.join(out, "next-activity.png") })
  await w.page.locator("#activity-toggle").click()
  await w.page.setViewportSize({ width: 390, height: 844 }); await w.page.waitForTimeout(400)
  await w.page.screenshot({ path: path.join(out, "next-phone.png") })
  console.log("web errors:", w.errors.length)
} finally { await w.close() }
n = 0
const t = await tui({ model, cwd: project, cols: 120, rows: 36 })
try {
  fs.writeFileSync(path.join(out, "next-tui-home.txt"), t.screen())
  t.clear(); t.write("Add a guard to the agent loop\r"); await delay(4000)
  fs.writeFileSync(path.join(out, "next-tui-chat.ansi"), t.out)
} finally { t.kill() }
model.close()
console.log("done")
process.exit(0)
