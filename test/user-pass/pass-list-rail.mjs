// User pass, terminal: pin and rename from the conversation list, and the changed-files list in the side panel.
import fs from "node:fs"
import path from "node:path"
import { check, failed, fakeModel, tempDir, tui, delay, plain } from "./harness.mjs"
const model = await fakeModel((sent) => {
  const last = sent.messages.at(-1)
  if (last?.role === "tool") return { text: "done" }
  if (/write/.test(String(last?.content))) return { tool: "write_file", args: { path: "src/notes.md", content: "# Notes\n\none\ntwo\n" } }
  return { text: "hello there" }
})
const project = tempDir("cg-list-project-")
const profile = tempDir("cg-list-profile-")
const screen = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const show = (label, t) => { if (process.env.SHOW) console.log("\n===== " + label + " =====\n" + screen(t).split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n")) }
const key = async (t, keys, wait = 500) => { t.write(keys); await delay(wait) }
try {
  // Two conversations, the older one first.
  let t = await tui({ model, cwd: project, profile, cols: 170, rows: 40 })
  await key(t, "older talk about zebras\r", 1500)
  await key(t, "/new\r", 600)
  await key(t, "newer talk about plums\r", 1500)
  await key(t, "/sessions\r", 800); show("list", t)
  const order = () => screen(t).split("\n").filter((line) => /talk about/.test(line) && /│/.test(line)).map((line) => /zebras/.test(line) ? "zebras" : "plums")
  check("the list starts newest first", order().join(",") === "plums,zebras", order().join(","))
  await key(t, "\x1b[B", 200); await key(t, "\x10", 900); show("pinned", t)
  check("ctrl+p pins: it moves to the top with a star", order().join(",") === "zebras,plums" && /★ older talk/.test(screen(t)), order().join(","))
  await key(t, "\x12", 600); show("renaming", t)
  check("ctrl+r puts the name in the prompt to edit", /older talk about zebras/.test(screen(t).split("\n").slice(-6).join("\n")) && /enter saves/.test(screen(t)))
  await key(t, " and stripes\r", 900); show("renamed", t)
  check("Enter saves the new name and returns to the list", /★ older talk about zebras and stripes/.test(screen(t)))
  await key(t, "\x1b", 300)
  t.kill(); await delay(500)
  // A restart keeps both.
  t = await tui({ model, cwd: project, profile, cols: 170, rows: 40 })
  await key(t, "/sessions\r", 800); show("after restart", t)
  check("the pin and the name survive a restart", /★ older talk about zebras and stripes/.test(screen(t)) && order()[0] === "zebras")
  await key(t, "\x10", 900)
  check("ctrl+p again unpins", !/★/.test(screen(t)) && order().join(",") === "plums,zebras", order().join(","))
  await key(t, "\x1b", 300)

  // The side panel lists what the conversation changed.
  await key(t, "write the notes\r", 0)
  await t.until(() => /Allow once/.test(screen(t)), 10000, "approval"); await key(t, "\r", 1800); show("rail", t)
  const rail = screen(t).split("\n").map((line) => line.slice(-36))
  check("the side panel lists the changed file with its line count", rail.some((line) => /changed files/.test(line)) && rail.some((line) => /notes\.md\s+\+4/.test(line)), rail.filter((line) => /changed|notes/.test(line)).join(" | "))
  t.kill()
} catch (error) { check("list pass", false, error.message) }
model.close()
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
