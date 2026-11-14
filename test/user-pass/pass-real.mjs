// Real-model user pass (a few cents): the terminal app on DeepSeek V4.1 Flash through Experiential Labs, the model
// Shawn uses. Covers what fake models got wrong before: reasoning display, one answer per turn, output under tool
// rows, @file and @image mentions, ! shell mode, an approval, a queued message and the cost readout.
// The key is read from the store into the child's environment only and never printed. The profile is a throwaway.
//   node test/user-pass/pass-real.mjs [model-id]        SHOW=1 prints every final screen
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { check, failed, tempDir, tui, delay, plain } from "./harness.mjs"

const modelId = process.argv[2] ?? "deepseek-v4.1-flash-1017"
const home = os.homedir()
const store = JSON.parse(fs.readFileSync(path.join(home, ".local", "share", "codegoblin", "auth.json"), "utf8"))
const key = store.explabs?.type === "api" ? store.explabs.key : undefined
if (!key) { console.log("no Experiential Labs key stored - skipped"); process.exit(0) }

const profile = tempDir("cg-real-profile-")
// The live model list is cached per profile; copy the last good copy so the model is known at startup.
fs.mkdirSync(path.join(profile, "state"), { recursive: true })
try { fs.copyFileSync(path.join(home, ".local", "state", "codegoblin", "explabs-models.json"), path.join(profile, "state", "explabs-models.json")) } catch {}
const project = tempDir("cg-real-project-")
fs.writeFileSync(path.join(project, "README.md"), "# Zebra Tracker\n\nCounts zebras.\n")
fs.writeFileSync(path.join(project, "a.md"), "a\n"); fs.writeFileSync(path.join(project, "b.md"), "b\n")

/** A solid-colour PNG, to ask a vision model about. */
function png(width, height, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([len, body, sum]) }
  const head = Buffer.alloc(13); head.writeUInt32BE(width, 0); head.writeUInt32BE(height, 4); head[8] = 8; head[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())])
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))])
}
fs.writeFileSync(path.join(project, "swatch.png"), png(64, 64, [220, 20, 20]))

const frame = (t) => plain(t.out.split("\x1b[2J").at(-1)).replace(/\r/g, "")
const show = (label, t) => { if (process.env.SHOW) console.log("\n===== " + label + " =====\n" + frame(t).split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n")) }
/** Waits until the turn is over: no working line for a moment. */
let asked = 0
async function settle(t, ms = 90000) {
  await delay(1500)
  const end = Date.now() + ms
  let quiet = 0
  while (Date.now() < end && quiet < 4) {
    if (/Allow once/.test(frame(t))) { asked++; t.write("\x1b"); await delay(600); continue }
    quiet = /esc twice|esc again|esc esc stop/.test(frame(t)) ? 0 : quiet + 1; await delay(400)
  }
  if (quiet < 4) throw new Error("turn did not finish\n" + frame(t).slice(-1500))
}

const t = await tui({ model: { url: "http://127.0.0.1:9/v1" }, cwd: project, profile, cols: 120, rows: 40, args: ["--model", "explabs/" + modelId], extraEnv: { EXPLABS_API_KEY: key } })
try {
  check("starts on the real model", new RegExp(modelId.replace(/[.-]/g, ".").slice(0, 14), "i").test(frame(t)) || /deepseek/i.test(frame(t)), frame(t).split("\n").slice(-4).join(" | "))

  // 1. A plain turn: one answer, reasoning folded into one line.
  t.write("just testing - reply with one short sentence\r"); await settle(t); show("plain turn", t)
  let f = frame(t)
  const heads = f.split("\n").filter((line) => /^\s*(experiential labs|deepseek)/i.test(line) && line.trim().length < 60).length
  check("plain turn: one answer heading", heads === 1, heads + " headings")
  check("plain turn: at most one reasoning line", (f.match(/thought for/g) ?? []).length <= 1, (f.match(/thought for/g) ?? []).length + " thought lines")
  check("plain turn: a cost shows", /\$0\.\d+/.test(f), f.split("\n").slice(-3).join(" | "))

  // 2. A file mention.
  t.write("@README.md what animal does this project count? one word\r"); await settle(t); show("@file", t)
  f = frame(t)
  check("@file: the file is attached and the answer uses it", /attached README\.md/.test(f) && /zebra/i.test(f))

  // 3. An image mention, to a model that takes pictures.
  t.write("@swatch.png what single colour is this picture? one word\r"); await settle(t); show("@image", t)
  f = frame(t)
  check("@image: the picture reaches the model, which answers without reaching for a tool", /\bred\b/i.test(f) && asked === 0, f.split("\n").filter((l) => l.trim()).slice(-8).join(" | "))

  // 4. Shell mode, then a question about what it printed.
  t.write("!echo plum-4471\r"); await delay(2500); show("! shell", t)
  check("! runs the command and shows its output", /plum-4471/.test(frame(t).replace(/!echo plum-4471/g, "")))
  t.write("what did the command I just ran print? answer with only that text\r"); await settle(t); show("after shell", t)
  check("the model knows what the command printed", (frame(t).match(/plum-4471/g) ?? []).length >= 2)

  // 5. A read tool, with its output under the row.
  t.write("use the glob tool once with pattern *.md, then tell me only how many files matched\r"); await settle(t); show("tool", t)
  f = frame(t)
  check("tool: a row for the search and the right count", /\*\.md/.test(f) && /\b(3|three)\b/i.test(f.split("\n").slice(-14).join("\n")), f.split("\n").filter((l) => l.trim()).slice(-10).join(" | "))

  // 6. A write that asks first.
  t.write("create a file called note.txt containing exactly: hi\r")
  await t.until(() => /allow|approve|yes|\(y\)/i.test(frame(t)) && /note\.txt/.test(frame(t)), 60000, "approval prompt"); await delay(400); show("approval", t)
  check("write: asks before writing", !fs.existsSync(path.join(project, "note.txt")))
  t.write("\r"); await delay(1500); await settle(t); show("after approval", t)
  check("write: the file is written once allowed", fs.existsSync(path.join(project, "note.txt")) && /hi/.test(fs.readFileSync(path.join(project, "note.txt"), "utf8")))

  // 7. A message typed while the model is working is queued and then answered.
  t.write("count from 1 to 30, one number per line\r"); await delay(1200)
  t.write("then say only the word: finished-queue\r"); await delay(500); show("queued", t)
  check("queue: the second message waits", /queued/i.test(frame(t)))
  await t.until(() => (frame(t).match(/finished-queue/g) ?? []).length >= 2, 90000, "the queued message to be answered").catch(() => {}); await settle(t); show("after queue", t)
  check("queue: it is sent afterwards", (frame(t).match(/finished-queue/g) ?? []).length >= 2)

  t.write("/status\r"); await delay(1200); show("status", t)
  const spent = /spent\s+(\$\d+\.\d+[^│]*)/.exec(frame(t))
  console.log("spent so far, as the app shows it: " + (spent?.[1]?.trim() ?? "unknown"))
} catch (error) { check("real pass", false, error.message) } finally { t.kill() }
console.log(failed() ? `\n${failed()} failed` : "\nall passed")
process.exit(0)
